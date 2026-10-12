/**
 * Flow B on DEVNET: a custom launch with a small set of creator rules.
 *
 *   publish_rules + attest_launch (v3, rules_hash) -> launch -> certificate
 *   v4 with RULES_BOUND (checks 8,191) and the hook policy holding exactly
 *   the rules -> a small fair-open batch -> during the guard: a
 *   wallet-to-wallet transfer the rule refuses (must fail with RuleDenied,
 *   hook error 6011), one under the rule's cap (passes), and a sell of the
 *   same wallet (passes: sells are never blocked) -> checkQsl1 + verifyLaunch.
 *
 * The rules (PXR1, text DSL):
 *   rules v1
 *   guard 30m
 *   always: deny when p2p and amount > 1000 tokens code P2P
 *
 *   NOISED_DEVNET_DIR=<state dir> NOISED_DEVNET_DEPLOYER=<keypair> node scripts/devnet/30-flow-b.mjs
 *
 * Optional: FLOW_B_COMMIT_LAMPORTS (default 3,000,000 per committer),
 * FLOW_B_FUND_LAMPORTS (creator wallet target, default 150,000,000),
 * OPEN_IN_SECS (launch window opens this long after planning, default 180).
 */
import { check, deployer, ledgerRow, legacyTx, log, runMain, saveState, sdk, send, splToken, sweep, testIdentity, testIcon, testMaster, testWallet, topUp } from "./lib.mjs";
import { batchPhase, checkLaunched, ensureAta, launchPhase, loadOrMakePlan, swap } from "./launch-steps.mjs";
import { verifyMint } from "./verify-steps.mjs";

const GUARD_SECS = 1800;
const RULES_TEXT = ["rules v1", "guard 30m", "always: deny when p2p and amount > 1000 tokens code P2P", ""].join("\n");

await runMain("flow-b", async (ctx) => {
  const { conn } = ctx;
  const d = deployer(ctx);
  const creator = testWallet(ctx, "creator");
  const keeper = testWallet(ctx, "keeper");
  const wallets = { deployer: d.publicKey, creator: creator.publicKey, keeper: keeper.publicKey };
  await ledgerRow(ctx, "start", wallets);
  const protocol = await sdk.fetchProtocol(conn);
  if (protocol === null) throw new Error("the Protocol is not initialized: run 10-init-protocol.mjs first");

  await topUp(ctx, "fund creator (flow B)", creator.publicKey, BigInt(process.env.FLOW_B_FUND_LAMPORTS ?? "150000000"));
  await topUp(ctx, "fund keeper", keeper.publicKey, 40_000_000n);
  await ledgerRow(ctx, "funded", wallets);

  const master = testMaster(ctx);
  const { identity, ledger } = await testIdentity(ctx, master, 0);
  try {
    log(ctx, `PQ identity ${Buffer.from(identity.identityId).toString("hex")} (devnet, index 0)`);
    // Custom parameters: the Fair preset's shape with the smallest threshold the policy allows (1 SOL),
    // a one-minute batch and a 30-minute guard, no wallet or buy caps (the rules are the test).
    const threshold = sdk.POLICY.LAMPORTS_PER_SOL;
    const { sqrtStartPrice, curve } = sdk.designCurve(6, "0.00000003", "0.0000004", threshold);
    const fair = sdk.PRESETS.fair.params;
    const params = {
      ...fair,
      sqrtStartPrice,
      curve,
      migrationQuoteThreshold: threshold,
      baseFee: { ...fair.baseFee },
      dynamicFee: { ...fair.dynamicFee },
      openDelaySecs: 60,
      guardSecs: GUARD_SECS,
      maxWalletBps: 0,
      maxBuyBps: 0,
      p2pLocked: false,
      batchWalletCap: 0n,
      batchTotalCap: 0n,
    };
    const rules = sdk.compileRules(sdk.parseRules(RULES_TEXT), { guardSecs: GUARD_SECS });
    const iconPng = await testIcon(1);
    // The name and symbol of the mint this flow launched on devnet before the rename to Noised: kept as they are,
    // because a re-run rebuilds the plan from these inputs and must match the attested metadata.
    const doc = sdk.buildMetadataDoc({ name: "Phalanx Devnet B", symbol: "PXDB", description: "Devnet test token (Flow B: custom launch with launch rules). Not a real asset.", iconPng });
    let plan = await loadOrMakePlan(ctx, (opensAt, launchSeed, nowSecs) =>
      sdk.planLaunch({
        creator: creator.publicKey,
        identity,
        params,
        recipients: [{ wallet: creator.publicKey, bps: 10_000 }],
        metadata: { name: "Phalanx Devnet B", symbol: "PXDB", doc },
        rules,
        opensAt,
        launchSeed,
        nowSecs,
      }),
    );
    for (const w of plan.warnings) log(ctx, `warning: ${w}`);
    log(ctx, `plan: launch ${plan.launch.toBase58()}, window ${plan.windowIso.notBefore}..${plan.windowIso.notAfter}, rules ${rules.length} bytes:\n  ${plan.rulesExplanation.join("\n  ")}`);

    const r = await launchPhase(ctx, { plan, creator, keeper, identity, ledger, wallets });
    plan = r.plan;
    const mint = r.mint;
    log(ctx, `live: mint ${mint.toBase58()}`);
    await checkLaunched(ctx, plan, mint);

    const commitLamports = BigInt(process.env.FLOW_B_COMMIT_LAMPORTS ?? "3000000");
    const l = await batchPhase(ctx, {
      launch: plan.launch,
      committers: [{ name: "creator", kp: creator, lamports: commitLamports }],
      keeper,
      wallets,
    });

    // The rule, during the guard.
    const now = await sdk.clusterUnixTime(conn);
    check(ctx, "still inside the launch guard", now < l.guardEndTs, `now ${now}, guard ends ${l.guardEndTs}`);
    const unit = 10n ** BigInt(l.tokenDecimal);
    const held = await sdk.getTokenBalance(conn, creator.publicKey, mint);
    log(ctx, `creator holds ${held} base units (${Number(held) / Number(unit)} tokens)`);
    const keeperAta = await ensureAta(ctx, "create the keeper's token account", keeper, keeper.publicKey, mint);
    const creatorAta = splToken.getAssociatedTokenAddressSync(mint, creator.publicKey, false, splToken.TOKEN_2022_PROGRAM_ID);
    const transferTx = async (amount) => {
      const ix = await splToken.createTransferCheckedWithTransferHookInstruction(conn, creatorAta, mint, keeperAta, creator.publicKey, amount, l.tokenDecimal, [], "confirmed", splToken.TOKEN_2022_PROGRAM_ID);
      return legacyTx(ctx, creator.publicKey, [ix]);
    };
    // The refusal must land on-chain (a failed transaction with RuleDenied), not only fail in simulation.
    if (!ctx.state.ruleDenied) {
      const big = 2000n * unit;
      if (held > big) {
        const neg = await send(ctx, "p2p transfer of 2,000 tokens (rule: deny p2p above 1,000 tokens)", await transferTx(big), [creator], { expectError: /RuleDenied|0x177b|refused the transfer/i });
        check(ctx, "RuleDenied on the refused transfer", neg.ok, `logs: ${(neg.details?.logs ?? neg.sim.logs ?? []).filter((x) => /rule|Rule|0x177b/.test(x)).join(" | ")}`);
        if (neg.ok) {
          ctx.state.ruleDenied = true;
          saveState(ctx);
        }
      } else check(ctx, "enough tokens for the rule test", false, `the creator holds only ${held} base units`);
    }
    if (!ctx.state.ruleTested && !ctx.state.ruleAllowed) {
      await send(ctx, "p2p transfer of 500 tokens (under the cap: passes)", await transferTx(500n * unit), [creator]);
      ctx.state.ruleAllowed = true;
      saveState(ctx);
    }
    // The same wallet sells (rules never block a sell).
    const toSell = await sdk.getTokenBalance(conn, creator.publicKey, mint);
    if (toSell > 0n && !ctx.state.sold) {
      await swap(ctx, "sell on DBC by the same wallet (passes)", creator, mint, "sell", toSell / 2n, 2000);
      ctx.state.sold = true;
      saveState(ctx);
    }
    await ledgerRow(ctx, "rule test + sell", wallets);

    await verifyMint(ctx, "flow B", mint, { expectProgrammable: true });

    // Return what is left to the deployer (devnet budget).
    if (process.env.KEEP_WALLETS !== "1") {
      await sweep(ctx, "sweep keeper back to the deployer", keeper, d.publicKey);
      await sweep(ctx, "sweep creator back to the deployer", creator, d.publicKey);
    }
    await ledgerRow(ctx, "end", wallets);
  } finally {
    identity.keyPair.wipe();
    sdk.pqIdentity.wipeMaster(master);
  }
});
