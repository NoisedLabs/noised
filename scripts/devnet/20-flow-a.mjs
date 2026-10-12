/**
 * Flow A on DEVNET: a Quick launch whose fees go back into the token,
 * through graduation and an autopilot buyback.
 *
 *   planQuickLaunch (fees "buyback-burn": 100% of the creator share to the
 *   launch's autopilot treasury; daily buyback-and-burn graph) with the
 *   smallest graduation threshold the policy allows (1 SOL, MIN_THRESHOLD in
 *   programs/noised-launchpad/src/constants.rs; the curve re-designed for
 *   it), a one-minute batch and the shortest guard (open delay + 600 s)
 *   -> create_launch -> fund the throwaway payer -> publish_metadata ->
 *   attest_launch (v3) -> autopilot: init_autopilot, publish_graph,
 *   pq_authorize (kind 1), activate, apply_pending -> sweep -> launch at
 *   not_before (keeper) -> bind_mint -> commit -> execute_batch -> claim ->
 *   DBC buy + sell during the guard (keeper) -> after the guard, buy to
 *   graduation -> DBC migration_damm_v2 (done by us if Meteora's keeper has
 *   not) -> claim_fees, claim_surplus, a DAMM v2 buy + sell, claim_lp_fees,
 *   distribute -> bind_pool -> keeper: update_price, wait 60 s, run the
 *   buyback -> check that every bought token was burned -> checkQsl1 +
 *   verifyLaunch -> sell what is left and sweep the test wallets back.
 *
 *   NOISED_DEVNET_DIR=<state dir> NOISED_DEVNET_DEPLOYER=<keypair> node scripts/devnet/20-flow-a.mjs
 *
 * Funding comes in two stages: the creator gets FLOW_A_FUND_LAMPORTS
 * (default 200,000,000) and the keeper 80,000,000 for everything up to the
 * guard-time trades; right before the graduation buy both are topped up to
 * what graduation, migration, the fees and the buyback need (about 1.07 SOL
 * for the creator). When that top-up would take the deployer below the
 * reserve, the flow stops BEFORE the graduation buy, records where, sweeps
 * the test wallets back and exits; re-running it after a top-up resumes there.
 *
 * Optional: FLOW_A_STOP_BEFORE_GRADUATION=1 (stop there anyway),
 * MIGRATION_WAIT_SECS (how long to leave Meteora's keeper to migrate before
 * doing it ourselves, default 60), OPEN_IN_SECS (default 180).
 */
import { check, deployer, landed, lamports, ledgerRow, legacyTx, log, note, runMain, saveState, sdk, sdkIx, send, sendV1, sleep, sol, splToken, sweep, testIdentity, testIcon, testMaster, testWallet, topUp, waitForClusterTime, web3 } from "./lib.mjs";
import { batchPhase, checkLaunched, launchPhase, loadOrMakePlan, swap } from "./launch-steps.mjs";
import { verifyMint } from "./verify-steps.mjs";

const { Keypair, PublicKey, SystemProgram } = web3;

await runMain("flow-a", async (ctx) => {
  const { conn } = ctx;
  const d = deployer(ctx);
  const creator = testWallet(ctx, "creator-a");
  const keeper = testWallet(ctx, "keeper-a");
  const wallets = { deployer: d.publicKey, creator: creator.publicKey, keeper: keeper.publicKey };
  const cb = { computeUnitPrice: ctx.computeUnitPrice };
  await ledgerRow(ctx, "start", wallets);
  const protocol = await sdk.fetchProtocol(conn);
  if (protocol === null) throw new Error("the Protocol is not initialized: run 10-init-protocol.mjs first");

  const stopBeforeGraduation = process.env.FLOW_A_STOP_BEFORE_GRADUATION === "1";
  if (!ctx.state.funded) {
    // Stage 1: the launch, the autopilot, the batch and the guard-time trades (graduation is funded later).
    await topUp(ctx, "fund creator (flow A, up to the guard-time trades)", creator.publicKey, BigInt(process.env.FLOW_A_FUND_LAMPORTS ?? "200000000"));
    await topUp(ctx, "fund keeper (flow A)", keeper.publicKey, 80_000_000n);
    ctx.state.funded = true;
    saveState(ctx);
    await ledgerRow(ctx, "funded", wallets);
  }

  const master = testMaster(ctx);
  const { identity, ledger } = await testIdentity(ctx, master, 0);
  try {
    // 1. The Quick plan (fees back into the token), then the smallest threshold the policy allows.
    const iconPng = await testIcon(2);
    // The name and symbol of the mint this flow launched on devnet before the rename to Noised: kept as they are,
    // because a re-run rebuilds the plan from these inputs and must match the attested metadata (it resumes there).
    const quickFor = (launchSeed) =>
      sdk.planQuickLaunch({
        name: "Phalanx Devnet A",
        symbol: "PXDA",
        description: "Devnet test token (Flow A: quick launch, fees back into the token). Not a real asset.",
        iconPng,
        feeBps: 100,
        feeDestination: "buyback-burn",
        creator: creator.publicKey,
        identity,
        launchSeed,
        // The smallest buyback the template allows, with no treasury minimum (devnet fees are tiny).
        buyback: { solPerBuyback: 0.01, premiumBps: 300, minTreasurySol: 0 },
      });
    const threshold = sdk.POLICY.LAMPORTS_PER_SOL; // MIN_THRESHOLD = 1 SOL
    const { sqrtStartPrice, curve } = sdk.designCurve(6, "0.00000003", "0.0000004", threshold);
    let quick = null;
    let plan = await loadOrMakePlan(ctx, (opensAt, launchSeed, nowSecs) => {
      quick = quickFor(launchSeed);
      const base = quick.launchInput.params;
      const params = { ...base, sqrtStartPrice, curve, migrationQuoteThreshold: threshold, openDelaySecs: 60, guardSecs: 60 + 600 };
      return sdk.planLaunch({ ...quick.launchInput, params, opensAt, nowSecs });
    });
    log(ctx, `quick plan: ${quick.summary.join(" ")}`);
    for (const w of [...quick.warnings, ...plan.warnings]) log(ctx, `warning: ${w}`);
    const graphBytes = quick.graph.bytes;
    log(ctx, `launch ${plan.launch.toBase58()}, treasury ${quick.treasury.toBase58()}, graph ${graphBytes.length} bytes (${quick.graph.publishVia}): ${quick.graph.explanation.join(" ")}`);
    log(ctx, `params: threshold ${plan.params.migrationQuoteThreshold}, fee option ${plan.params.migrationFeeOption}, batch ${plan.params.openDelaySecs} s, guard ${plan.params.guardSecs} s, max wallet ${plan.params.maxWalletBps} bps, max buy ${plan.params.maxBuyBps} bps, recipients ${plan.params.recipients.map((r) => `${r.wallet.toBase58()}:${r.bps}`).join(",")}`);

    // 2. Autopilot setup while the throwaway payer is funded (pq_authorize lands from it, in a v1 transaction).
    const graphHash = sdk.graphHash(graphBytes);
    const sameHash = (a, b) => Buffer.from(a).equals(Buffer.from(b));
    // A saved plan rebuilt as planGraphActivation made it (that function refuses a start time that has passed).
    const savedGraphPlan = (activateAt) => {
      const autopilot = sdk.autopilotAddress(plan.launch);
      const payloadHash = sdk.activationPayload(autopilot, graphHash, activateAt);
      return { launch: plan.launch, autopilot, graphHash, graphBytes, activateAt, activateAtIso: sdk.unixToIso(activateAt), payloadHash, kind: 1, authorization: sdk.authorizationAddress(plan.launch, 1, payloadHash), firstGraph: true, earliestActivateAt: activateAt, earliestActivateAtIso: sdk.unixToIso(activateAt), explanation: [], warnings: [] };
    };
    const autopilotSetup = async (payer) => {
      let ap = await sdk.fetchAutopilot(conn, plan.launch);
      if (ap === null) {
        await send(ctx, "init_autopilot", await sdk.buildInitAutopilotTx(conn, creator.publicKey, plan.launch, cb), [creator]);
        ap = await sdk.fetchAutopilot(conn, plan.launch);
      }
      for (let attempt = 0; attempt < 2 && !(ap.hasActiveGraph && sameHash(ap.activeGraph, graphHash)); attempt++) {
        let gplan;
        if (ctx.state.graphPlan === undefined) {
          // A first graph may start at once: activate_at = now + 45 s leaves time for the approval to land.
          gplan = await sdk.planGraphActivation(conn, plan.launch, graphBytes, { marginSecs: 45n });
          ctx.state.graphPlan = { activateAt: gplan.activateAt.toString() };
          saveState(ctx);
          log(ctx, `graph activation planned: activate_at ${gplan.activateAtIso}; ${gplan.explanation.join(" ")}`);
        } else gplan = savedGraphPlan(BigInt(ctx.state.graphPlan.activateAt));
        for (let i = 0; i < 10; i++) {
          const next = await sdk.buildNextGraphActivationTx(conn, plan.launch, gplan, { payer: creator.publicKey, throwaway: payer, identity, ledger, creator: creator.publicKey, computeUnitPrice: ctx.computeUnitPrice });
          if (next === null) {
            const s = await sdk.getGraphActivationStatus(conn, plan.launch, gplan);
            if (s.next === "wait") {
              await waitForClusterTime(ctx, s.applyAt, "the graph's activate_at");
              continue;
            }
            log(ctx, `autopilot: ${s.stage} (${s.plain})`);
            if (s.stage === "superseded") delete ctx.state.graphPlan;
            break;
          }
          log(ctx, `autopilot step ${next.step}: ${next.status.plain}`);
          if (next.step === "init-autopilot" || next.step === "activate" || next.step === "apply-pending") {
            const label = next.step === "activate" ? `activate (graph ${Buffer.from(graphHash).toString("hex").slice(0, 12)}..., activate_at ${gplan.activateAt})` : next.step.replace("-", "_");
            await send(ctx, label, next.result, [creator]);
          } else if (next.step === "publish-graph") {
            const r = next.result;
            if (r.status === "ready" && r.tx instanceof web3.Transaction) await send(ctx, `publish_graph (${graphBytes.length} bytes, legacy)`, r.tx, [creator]);
            else if (r.status === "ready") {
              await sdk.sendAndConfirm(conn, r.tx, { lastValidBlockHeight: r.lastValidBlockHeight });
              await landed(ctx, "publish_graph (v1)", r.signature);
            }
          } else if (next.step === "authorize") {
            const r = next.result;
            if (r.status === "ready") {
              const outcome = await sdk.sendPqAuthorizeTx(conn, r, { ledger });
              await landed(ctx, `pq_authorize (kind 1 = GRAPH_ACTIVATE, leaf ${r.leaf})`, r.signature, `v1 ${r.tx.length} B`);
              if (outcome.status !== "authorized") throw new Error(`pq_authorize did not authorize (${outcome.status}): ${outcome.detail ?? ""}`);
            } else if (r.status === "leaf-landed") throw new Error(`pq_authorize: leaf ${r.leaf} already landed without an authorization: investigate before signing again`);
          }
        }
        ap = await sdk.fetchAutopilot(conn, plan.launch);
      }
      check(ctx, "autopilot runs the quick-launch graph", ap.hasActiveGraph && sameHash(ap.activeGraph, graphHash), `active graph ${Buffer.from(ap.activeGraph).toString("hex").slice(0, 16)}..., activated at ${ap.activatedAt}, active auth ${ap.activeAuthOrNull?.toBase58()}`);
    };
    const extraPayerLamports = (await sdk.fundingLamportsForAuthorize(conn, cb)) + (graphBytes.length > sdk.PUBLISH_GRAPH_LEGACY_MAX_BYTES ? 20_000_000n : 0n);

    const r = await launchPhase(ctx, { plan, creator, keeper, identity, ledger, wallets, beforeSweep: autopilotSetup, extraPayerLamports });
    plan = r.plan;
    const mint = r.mint;
    log(ctx, `live: mint ${mint.toBase58()}`);
    await checkLaunched(ctx, plan, mint);
    {
      const ap0 = await sdk.fetchAutopilot(conn, plan.launch);
      if (ap0 === null || !(ap0.hasActiveGraph && sameHash(ap0.activeGraph, graphHash))) {
        // Resumed after the payer was swept: fund it again for the approval.
        const payer = testWallet(ctx, `throwaway-${ctx.flow}`);
        const need = extraPayerLamports - (await lamports(ctx, payer.publicKey));
        if (need > 0n) await send(ctx, "fund the throwaway payer (autopilot approval)", (await sdk.buildFundThrowawayPayerTx(conn, creator.publicKey, payer.publicKey, { lamports: need })).tx, [creator]);
        await autopilotSetup(payer);
        const sw = await sdk.buildSweepPayerTx(conn, payer, creator.publicKey);
        if (sw !== null) await landed(ctx, "sweep the throwaway payer", await sdk.sendAndConfirm(conn, sw.tx));
      }
    }

    // 3. bind_mint (once live).
    let ap = await sdk.fetchAutopilot(conn, plan.launch);
    if (ap !== null && !ap.mintBound) {
      await send(ctx, "bind_mint", await sdk.buildBindMintTx(conn, creator.publicKey, plan.launch, cb), [creator]);
      ap = await sdk.fetchAutopilot(conn, plan.launch);
    }
    check(ctx, "autopilot bound to the mint", ap?.mintBound === true && ap.mint.equals(mint), `mint ${ap?.mint?.toBase58()}`);

    // 4. The fair-open batch.
    let l = await batchPhase(ctx, { launch: plan.launch, committers: [{ name: "creator", kp: creator, lamports: 3_000_000n }], keeper, wallets });

    // 5. Trading during the guard (keeper: a fresh wallet, under max-buy and max-wallet).
    if (!ctx.state.guardTrades) {
      const now = await sdk.clusterUnixTime(conn);
      if (now < l.guardEndTs) {
        await swap(ctx, "DBC buy 0.001 SOL during the guard (keeper)", keeper, mint, "buy", 1_000_000n, 1000);
        const got = await sdk.getTokenBalance(conn, keeper.publicKey, mint);
        await swap(ctx, "DBC sell half during the guard (keeper)", keeper, mint, "sell", got / 2n, 2000);
      } else log(ctx, "the guard already ended: guard-time trades skipped");
      ctx.state.guardTrades = true;
      saveState(ctx);
      await ledgerRow(ctx, "guard-time trades", wallets);
    }
    // 6. Buy to graduation once the guard is over (stage 2 of the funding first, within the reserve).
    l = await sdk.fetchLaunch(conn, plan.launch);
    if (!l.market.curveComplete && !l.market.migrated) {
      const missing = l.migrationQuoteThreshold - l.market.quoteReserve;
      const amount = (missing * 103n) / 100n + 2_000_000n; // fee (1% + dynamic) and margin; PartialFill stops at the threshold
      // The creator also pays the migration (rent of the DAMM v2 positions) and the buyback's wSOL donation.
      const creatorNeed = amount + 60_000_000n;
      const keeperNeed = 60_000_000n;
      const [dBal, cBal, kBal] = [await lamports(ctx, d.publicKey), await lamports(ctx, creator.publicKey), await lamports(ctx, keeper.publicKey)];
      const shortfall = (creatorNeed > cBal ? creatorNeed - cBal : 0n) + (keeperNeed > kBal ? keeperNeed - kBal : 0n);
      const afterFunding = dBal - shortfall - 20_000n;
      const where = `curve quote reserve ${l.market.quoteReserve} of ${l.migrationQuoteThreshold} lamports (${sol(missing)} SOL missing); the graduation buy would put in ${sol(amount)} SOL; creator holds ${sol(cBal)}, keeper ${sol(kBal)}; funding them needs ${sol(shortfall)} SOL from the deployer, which holds ${sol(dBal)} (reserve ${sol(ctx.reserveLamports)})`;
      if (stopBeforeGraduation || afterFunding < ctx.reserveLamports) {
        note(ctx, "STOPPED BEFORE GRADUATION", `${stopBeforeGraduation ? "FLOW_A_STOP_BEFORE_GRADUATION=1" : `the deployer would end at ${sol(afterFunding)} SOL, below the reserve`}: ${where}. Re-run 20-flow-a.mjs after a top-up of at least ${sol(ctx.reserveLamports - afterFunding > 0n ? ctx.reserveLamports - afterFunding : 0n)} SOL to resume here.`);
        await verifyMint(ctx, "flow A (before graduation)", mint, { expectProgrammable: true });
        if (process.env.KEEP_WALLETS !== "1") {
          // The tokens stay in the test wallets' token accounts; their SOL goes back until the run resumes.
          await sweep(ctx, "sweep keeper back to the deployer (paused before graduation)", keeper, d.publicKey);
          await sweep(ctx, "sweep creator back to the deployer (paused before graduation)", creator, d.publicKey);
        }
        await ledgerRow(ctx, "stopped before graduation", wallets);
        return;
      }
      log(ctx, `graduation funding: ${where}`);
      await topUp(ctx, "fund creator (flow A, graduation)", creator.publicKey, creatorNeed);
      await topUp(ctx, "fund keeper (flow A, after graduation)", keeper.publicKey, keeperNeed);
      await ledgerRow(ctx, "funded for graduation", wallets);
      await waitForClusterTime(ctx, l.guardEndTs, "the launch guard to end (max-wallet / max-buy)");
      log(ctx, `curve: ${l.market.quoteReserve} of ${l.migrationQuoteThreshold} lamports; buying with ${amount}`);
      await swap(ctx, `DBC buy to graduation (${sol(amount)} SOL, PartialFill)`, creator, mint, "buy", amount, 2000);
      l = await sdk.fetchLaunch(conn, plan.launch);
      await ledgerRow(ctx, "graduation buy", wallets);
    }
    check(ctx, "curve complete (DBC revoked the hook)", l.market.curveComplete && !l.market.hookActive, `quote reserve ${l.market.quoteReserve}, hook active ${l.market.hookActive}, migrated ${l.market.migrated}`);

    // 7. Migration to DAMM v2.
    const dammConfig = sdk.DAMM_V2_MIGRATION_CONFIGS[l.migrationFeeOption];
    const dammPool = sdk.dammV2PoolAddress(dammConfig, mint, sdk.WSOL_MINT);
    if (!l.market.migrated) {
      const wait = Number(process.env.MIGRATION_WAIT_SECS ?? (ctx.rehearsal ? "0" : "60"));
      for (let t = 0; t < wait && !(await sdk.fetchLaunch(conn, plan.launch)).market.migrated; t += 10) {
        log(ctx, `waiting for Meteora's migration keeper (${t}/${wait} s)`);
        await sleep(10_000);
      }
      l = await sdk.fetchLaunch(conn, plan.launch);
      if (!l.market.migrated) {
        const ix = migrationInstruction(mint, l, dammConfig, dammPool, creator.publicKey, ctx.state);
        saveState(ctx);
        const nft1 = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(ctx.state.migrationNfts[0], "hex")));
        const nft2 = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(ctx.state.migrationNfts[1], "hex")));
        await sendV1(ctx, "DBC migration_damm_v2 (by us, permissionless)", creator, [ix], [nft1, nft2], { computeUnitLimit: 800_000 });
        l = await sdk.fetchLaunch(conn, plan.launch);
      } else log(ctx, "migrated by someone else (Meteora's keeper)");
      await ledgerRow(ctx, "migration", wallets);
    }
    check(ctx, "migrated to DAMM v2", l.market.migrated && l.market.dammPool !== null && l.market.dammPool.equals(dammPool), `DAMM v2 pool ${l.market.dammPool?.toBase58()} (expected ${dammPool.toBase58()})`);

    // 8. Fees: DBC partner fees, surplus, a DAMM v2 round trip for LP fees, the LP fees, distribute.
    if (!ctx.state.feesDone) {
      await trySend(ctx, "claim_fees (DBC partner trading fees)", () => sdk.buildClaimFeesTx(conn, keeper.publicKey, plan.launch, cb), [keeper]);
      await trySend(ctx, "claim_surplus (DBC surplus after the curve)", () => sdk.buildClaimSurplusTx(conn, keeper.publicKey, plan.launch, cb), [keeper]);
      await swap(ctx, "DAMM v2 buy 0.01 SOL (keeper)", keeper, mint, "buy", 10_000_000n, 1000);
      const kt = await sdk.getTokenBalance(conn, keeper.publicKey, mint);
      await swap(ctx, "DAMM v2 sell (keeper)", keeper, mint, "sell", kt, 2000);
      try {
        const lpTxs = await sdk.buildClaimLpFeesTx(conn, keeper.publicKey, plan.launch, cb);
        for (const [i, tx] of lpTxs.entries()) await send(ctx, `claim_lp_fees (position ${i + 1})`, tx, [keeper]);
      } catch (e) {
        check(ctx, "claim_lp_fees", false, `${e.message}`);
      }
      const treasuryWsol = sdk.autopilotPdas(plan.launch).treasuryWsol;
      const before = await sdk.getTokenBalance(conn, quick.treasury, sdk.WSOL_MINT).catch(() => 0n);
      await send(ctx, "distribute (platform share -> treasury vault, creator share -> autopilot treasury)", await sdk.buildDistributeTx(conn, keeper.publicKey, plan.launch, cb), [keeper]);
      const after = await sdk.getTokenBalance(conn, quick.treasury, sdk.WSOL_MINT).catch(() => 0n);
      check(ctx, "distribute paid the autopilot treasury", after > before, `treasury wSOL ${before} -> ${after} (account ${treasuryWsol.toBase58()})`);
      ctx.state.feesDone = true;
      saveState(ctx);
      await ledgerRow(ctx, "fees + distribute", wallets);
    }

    // 9. bind_pool, then the keeper: update_price, wait at least 60 s, run the buyback.
    ap = await sdk.fetchAutopilot(conn, plan.launch);
    if (!ap.graduated) {
      await send(ctx, "bind_pool", await sdk.buildBindPoolTx(conn, keeper.publicKey, plan.launch, cb), [keeper]);
      ap = await sdk.fetchAutopilot(conn, plan.launch);
    }
    check(ctx, "autopilot bound to the DAMM v2 pool (graduated)", ap.graduated === true, `graduated ${ap.graduated}`);
    const pdas = sdk.autopilotPdas(plan.launch, mint);
    let treasurySol = await sdk.getTokenBalance(conn, pdas.treasury, sdk.WSOL_MINT).catch(() => 0n);
    const buybackMax = 10_000_000n;
    if (treasurySol < buybackMax + 1_000_000n) {
      // Devnet fees are tiny: donate wSOL to the treasury so one full buyback (0.01 SOL) and its tip can run.
      const top = buybackMax + 2_000_000n - treasurySol;
      const tx = await legacyTx(ctx, creator.publicKey, [SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: pdas.treasuryWsol, lamports: top }), splToken.createSyncNativeInstruction(pdas.treasuryWsol)]);
      await send(ctx, `donate ${sol(top)} SOL as wSOL to the autopilot treasury`, tx, [creator]);
      treasurySol = await sdk.getTokenBalance(conn, pdas.treasury, sdk.WSOL_MINT);
    }
    if (!ctx.state.buybackDone) {
      const supplyBefore = await sdk.getTokenSupply(conn, mint);
      const treasuryTokensBefore = await sdk.getTokenBalance(conn, pdas.treasury, mint).catch(() => 0n);
      const steps = [];
      const result = await sdk.runKeeper(conn, {
        caller: keeper,
        launch: plan.launch,
        maxSteps: 6,
        computeUnitPrice: ctx.computeUnitPrice,
        send: async (tx) => {
          const s = await send(ctx, `keeper step ${steps.length + 1}`, tx, [keeper]);
          steps.push(s);
          return s.signature;
        },
      });
      for (const s of result.steps) log(ctx, `keeper: ${s.kind}${s.node !== null ? ` node ${s.node}` : ""}: ${s.detail}${s.signature ? ` (${s.signature})` : ""}${s.expectedTipLamports !== null ? `, tip ~${s.expectedTipLamports}` : ""}`);
      log(ctx, `keeper stopped: ${result.stopped} (${result.detail}); cost ${result.costLamports} lamports`);
      const ran = result.steps.filter((s) => s.kind === "run");
      const supplyAfter = await sdk.getTokenSupply(conn, mint);
      const treasuryTokensAfter = await sdk.getTokenBalance(conn, pdas.treasury, mint).catch(() => 0n);
      const events = [];
      for (const s of ran) {
        const det = steps.find((x) => x.signature === s.signature)?.details;
        for (const line of det?.logs ?? []) {
          const m = /^Program data: (.+)$/.exec(line);
          if (m) {
            try {
              const e = sdk.decodeAutopilotEvent(new Uint8Array(Buffer.from(m[1], "base64")));
              if (e !== null) events.push(e);
            } catch {
              /* not an autopilot event */
            }
          }
        }
      }
      log(ctx, `autopilot events: ${JSON.stringify(events, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v))}`);
      check(ctx, "update_price then a buyback ran", result.steps.some((s) => s.kind === "update-price") && ran.length > 0, `steps: ${result.steps.map((s) => s.kind).join(" -> ")}`);
      check(ctx, "every token the buyback bought was burned in the same transaction", ran.length > 0 && supplyAfter < supplyBefore && treasuryTokensAfter === treasuryTokensBefore, `supply ${supplyBefore} -> ${supplyAfter} (burned ${supplyBefore - supplyAfter}); treasury tokens ${treasuryTokensBefore} -> ${treasuryTokensAfter}`);
      ctx.state.buybackDone = true;
      saveState(ctx);
      await ledgerRow(ctx, "buyback", wallets);
    }

    await verifyMint(ctx, "flow A", mint, { expectProgrammable: true });

    // 10. Recover SOL for the devnet budget: sell what the test wallets hold on DAMM v2, sweep them back.
    if (process.env.KEEP_WALLETS !== "1") {
      for (const [name, kp] of [["creator", creator], ["keeper", keeper]]) {
        const t = await sdk.getTokenBalance(conn, kp.publicKey, mint).catch(() => 0n);
        if (t > 0n) await swap(ctx, `DAMM v2 sell everything (${name}, budget recovery)`, kp, mint, "sell", t, 5000);
      }
      await sweep(ctx, "sweep keeper back to the deployer", keeper, d.publicKey);
      await sweep(ctx, "sweep creator back to the deployer", creator, d.publicKey);
    }
    await ledgerRow(ctx, "end", wallets);
  } finally {
    identity.keyPair.wipe();
    sdk.pqIdentity.wipeMaster(master);
  }
});

/** Send a fee-claim step; a refusal because there is nothing to claim is reported, not fatal. */
async function trySend(ctx, step, build, signers) {
  try {
    const tx = await build();
    return await send(ctx, step, tx, signers);
  } catch (e) {
    log(ctx, `NOTE ${step}: ${e.message}`);
    return null;
  }
}

/**
 * DBC `migration_damm_v2` exactly as the launchpad's LiteSVM suite sends it
 * (tests/litesvm/tests/common/lifecycle.rs `migrate`): both position slots
 * offered, the DAMM v2 config as the one remaining account. The two
 * position-NFT keypairs are kept in the run's state so a retry signs the
 * same transaction.
 */
function migrationInstruction(mint, l, dammConfig, dammPool, payer, state) {
  if (state.migrationNfts === undefined) state.migrationNfts = [Keypair.generate(), Keypair.generate()].map((k) => Buffer.from(k.secretKey).toString("hex"));
  const [nft1, nft2] = state.migrationNfts.map((h) => Keypair.fromSecretKey(Uint8Array.from(Buffer.from(h, "hex"))).publicKey);
  const D = sdk.PROGRAM_IDS.dammV2;
  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, D)[0];
  return sdkIx.buildInstruction(
    sdk.idlCodecs().dbc,
    sdk.PROGRAM_IDS.dbc,
    "migration_damm_v2",
    {
      virtualPool: l.pool,
      migrationMetadata: sdk.PROGRAM_IDS.dbc,
      config: l.dbcConfig,
      pool: dammPool,
      firstPositionNftMint: nft1,
      firstPositionNftAccount: sdk.dammV2PositionNftAccountAddress(nft1),
      firstPosition: sdk.dammV2PositionAddress(nft1),
      secondPositionNftMint: nft2,
      secondPositionNftAccount: sdk.dammV2PositionNftAccountAddress(nft2),
      secondPosition: sdk.dammV2PositionAddress(nft2),
      dammPoolAuthority: sdk.KNOWN_ACCOUNTS.dammV2PoolAuthority,
      baseMint: mint,
      quoteMint: sdk.WSOL_MINT,
      tokenAVault: pda([Buffer.from("token_vault"), mint.toBuffer(), dammPool.toBuffer()]),
      tokenBVault: pda([Buffer.from("token_vault"), sdk.WSOL_MINT.toBuffer(), dammPool.toBuffer()]),
      baseVault: sdk.dbcTokenVaultAddress(mint, l.pool),
      quoteVault: sdk.dbcTokenVaultAddress(sdk.WSOL_MINT, l.pool),
      payer,
      tokenBaseProgram: sdk.KNOWN_ACCOUNTS.token2022,
      tokenQuoteProgram: sdk.KNOWN_ACCOUNTS.splToken,
      token2022Program: sdk.KNOWN_ACCOUNTS.token2022,
      dammEventAuthority: sdk.KNOWN_ACCOUNTS.dammV2EventAuthority,
    },
    {},
    [{ pubkey: dammConfig, isSigner: false, isWritable: false }],
  );
}

