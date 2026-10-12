/**
 * The launch steps both devnet flows share, on the SDK's PQ v2 flow:
 * create_launch -> fund the throwaway payer -> publish_metadata
 * [-> publish_rules] -> attest_launch (v3) [-> extra v1 steps the caller
 * adds, e.g. the autopilot's approval] -> sweep the payer -> wait for the
 * window -> launch (from a keeper key, not the creator), then the fair-open
 * batch: commit -> execute_batch -> claim. Every step checks the chain first,
 * so a re-run resumes where the last one stopped.
 */
import { check, landed, ledgerRow, log, saveState, sdk, send, splToken, testWallet, waitForClusterTime, web3 } from "./lib.mjs";

const { Keypair, PublicKey } = web3;

/** The plan, rebuilt from the saved inputs (launch seed, opening time) or made fresh and saved. */
export async function loadOrMakePlan(ctx, make) {
  const saved = ctx.state.plan;
  if (saved !== undefined) return make(BigInt(saved.opensAt), Uint8Array.from(Buffer.from(saved.launchSeed, "hex")), undefined);
  const now = await sdk.clusterUnixTime(ctx.conn);
  const opensAt = now + BigInt(process.env.OPEN_IN_SECS ?? "180");
  const plan = make(opensAt, crypto.getRandomValues(new Uint8Array(32)), now);
  ctx.state.plan = { launch: plan.launch.toBase58(), launchSeed: Buffer.from(plan.launchSeed).toString("hex"), opensAt: plan.window.notBefore.toString() };
  saveState(ctx);
  return plan;
}

/**
 * create -> publish -> attest -> launch. `beforeSweep(payer)` runs while the
 * throwaway payer is still funded (`extraPayerLamports` more than the
 * attestation needs). Returns the plan (replanned if its window was missed)
 * and the mint.
 */
export async function launchPhase(ctx, o) {
  const { conn } = ctx;
  let { plan } = o;
  const { creator, keeper, identity, ledger, wallets } = o;
  const cb = { computeUnitPrice: ctx.computeUnitPrice };
  const flowStatus = () => sdk.getLaunchFlowStatus(conn, plan.launch, { expectedMessageHash: plan.messageHash, expectedMetadataHash: plan.metadataHash });
  let st = await flowStatus();
  log(ctx, `launch ${plan.launch.toBase58()}: step "${st.step}" (${st.summary})`);

  if (st.step === "create") {
    const created = await sdk.buildPlannedCreateLaunchTx(conn, plan, cb);
    for (const w of created.warnings) log(ctx, `warning: ${w}`);
    await send(ctx, "create_launch", created.tx, [creator], { finalized: true });
    await ledgerRow(ctx, "create_launch", wallets);
    st = await flowStatus();
  }
  if (st.step === "window-missed") {
    const now = await sdk.clusterUnixTime(conn);
    plan = sdk.replanLaunchWindow(plan, { opensAt: now + BigInt(process.env.OPEN_IN_SECS ?? "180"), nowSecs: now });
    ctx.state.plan.opensAt = plan.window.notBefore.toString();
    saveState(ctx);
    log(ctx, `window missed: new window ${plan.window.notBefore}..${plan.window.notAfter}`);
  }
  if (st.step === "publish" || st.step === "attest" || st.step === "window-missed") {
    const payer = testWallet(ctx, `throwaway-${ctx.flow}`);
    const funding = await sdk.throwawayPayerFunding(conn, {
      metadata: plan.metadata,
      rules: plan.rules,
      launch: plan.launch,
      lmsPublicKey: identity.publicKey,
      publish: cb,
      attest: cb,
      publishRules: cb,
    });
    const need = funding.lamports + (o.extraPayerLamports ?? 0n);
    const held = BigInt(await conn.getBalance(payer.publicKey, "confirmed"));
    log(ctx, `throwaway payer ${payer.publicKey.toBase58()}: needs ${need} lamports (record ${funding.tokenMetaRent}, rules ${funding.rulesRent}, identity ${funding.identityRent}, attestation ${funding.attestationRent}, fees, extra ${o.extraPayerLamports ?? 0n}), holds ${held}`);
    if (held < need) {
      const fund = await sdk.buildFundThrowawayPayerTx(conn, creator.publicKey, payer.publicKey, { lamports: need - held });
      await send(ctx, "fund the throwaway payer", fund.tx, [creator]);
    }
    const published = await sdk.buildPlannedPublishTx(conn, plan, payer, cb);
    if (published.status === "ready") {
      await sdk.sendPublishMetadataTx(conn, published);
      await landed(ctx, "publish_metadata", published.signature, `v1 ${published.sizeBytes} B, record rent ${published.rentLamports}`);
    }
    const meta = await sdk.waitForTokenMeta(conn, plan.launch, plan.metadataHash);
    check(ctx, "TokenMeta record published", meta !== null, `record ${plan.tokenMeta.toBase58()} (${plan.metadata.doc?.length ?? 0}-byte document)`);
    if (plan.rules !== null) {
      const r = await sdk.buildPlannedPublishRulesTx(conn, plan, payer, cb);
      if (r !== null && r.status === "ready") {
        await sdk.sendPublishRulesTx(conn, r);
        await landed(ctx, "publish_rules", r.signature, `v1, ${plan.rules.length}-byte PXR1 rules`);
      }
      const rec = await sdk.waitForLaunchRules(conn, plan.launch, plan.rulesHash);
      check(ctx, "LaunchRules record published", rec !== null && Buffer.from(rec.bytes).equals(Buffer.from(plan.rules)), `record ${plan.rulesRecord.toBase58()}`);
    }
    const built = await sdk.buildPlannedAttestTx(conn, plan, { identity, ledger, computeUnitPrice: ctx.computeUnitPrice, payer });
    for (const w of built.warnings ?? []) log(ctx, `warning: ${w}`);
    if (built.status === "ready") {
      const outcome = await sdk.sendAttestLaunchTx(conn, built, { ledger });
      await landed(ctx, `attest_launch (v3, leaf ${built.leaf})`, built.signature, `v1 ${built.sizeBytes} B`);
      if (outcome.status !== "attested") throw new Error(`the attestation did not attest (${outcome.status}): ${outcome.detail}`);
    } else if (built.status === "leaf-landed") {
      const outcome = await sdk.confirmAttestation(conn, plan.launch, plan.messageHash, { leaf: built.leaf, lmsPublicKey: built.lmsPublicKey, message: built.message, ledger });
      if (outcome.status !== "attested") throw new Error(`leaf ${built.leaf}: ${outcome.detail}`);
    }
    if (o.beforeSweep !== undefined) await o.beforeSweep(payer);
    const sw = await sdk.buildSweepPayerTx(conn, payer, creator.publicKey);
    if (sw !== null) await landed(ctx, `sweep the throwaway payer (${sw.lamports} lamports back)`, await sdk.sendAndConfirm(conn, sw.tx));
    await ledgerRow(ctx, "publish + attest", wallets);
    st = await flowStatus();
  }
  const att = await sdk.fetchAttestation(conn, plan.launch);
  check(
    ctx,
    "Attestation v3",
    att !== null && att.version === 3 && att.attested && Buffer.from(att.messageHash).equals(Buffer.from(plan.messageHash)) && Buffer.from(att.rulesHash).equals(Buffer.from(plan.rulesHash)),
    `version ${att?.version}, attested ${att?.attested}, window ${att?.notBefore}..${att?.notAfter}, rules_hash ${Buffer.from(att?.rulesHash ?? []).toString("hex").slice(0, 16)}...`,
  );

  if (st.step === "wait-for-window") {
    log(ctx, `waiting ${st.secondsUntilWindowOpens} s for the launch window`);
    st = await sdk.waitForLaunchWindow(conn, plan.launch);
  }
  if (st.step === "launch") {
    const baseMint = Keypair.generate();
    const { tx } = await sdk.buildPlannedLaunchTx(conn, plan, keeper.publicKey, baseMint, cb);
    ctx.state.mint = baseMint.publicKey.toBase58();
    saveState(ctx);
    await send(ctx, "launch (keeper, inside the attested window)", tx, [keeper]);
    await ledgerRow(ctx, "launch", wallets);
  }
  const l = await sdk.fetchLaunch(conn, plan.launch);
  if (l === null || l.status !== "live") throw new Error(`the launch is not live (step ${(await flowStatus()).step})`);
  ctx.state.mint = l.baseMint.toBase58();
  saveState(ctx);
  return { plan, mint: l.baseMint, launch: l };
}

/** Certificate, hook policy and mint metadata right after `launch`. */
export async function checkLaunched(ctx, plan, mint) {
  const { conn } = ctx;
  const cert = await sdk.fetchCertificate(conn, mint);
  const withRules = plan.rules !== null;
  const expectChecks = withRules ? sdk.CERTIFICATE_ALL_CHECKS | sdk.CERTIFICATE_RULES_BOUND : sdk.CERTIFICATE_ALL_CHECKS;
  check(ctx, `Certificate v4, checks ${expectChecks}`, cert !== null && cert.version === 4 && cert.checks === expectChecks, `version ${cert?.version}, checks ${cert?.checks}${withRules ? " (RULES_BOUND set)" : ""}, initial supply ${cert?.initialSupply}`);
  const policy = await sdk.fetchHookPolicy(conn, mint);
  check(ctx, "Hook policy holds the attested rules", policy !== null && Buffer.from(policy.rules).equals(Buffer.from(plan.rules ?? new Uint8Array(0))), `${policy?.rules.length ?? "?"}-byte rules in the policy; shield until ${policy?.snipeShieldEndTs}, guard until ${policy?.guardEndTs}`);
  const acc = await conn.getAccountInfo(mint, "confirmed");
  const parsed = sdk.parseMint(acc.owner, new Uint8Array(acc.data));
  const md = sdk.tokenMetadataOf(parsed);
  const text = (b) => new TextDecoder().decode(b);
  check(ctx, "Mint metadata = attested record", md !== null && md.name === text(plan.metadata.name) && md.symbol === text(plan.metadata.symbol) && md.uri === plan.tokenUri, `name "${md?.name}", symbol "${md?.symbol}", uri "${md?.uri}"; mint ${acc.data.length} bytes`);
  return cert;
}

/** commit (each committer) -> execute_batch (keeper) -> claim (each). */
export async function batchPhase(ctx, { launch, committers, keeper, wallets }) {
  const { conn } = ctx;
  const cb = { computeUnitPrice: ctx.computeUnitPrice };
  let l = await sdk.fetchLaunch(conn, launch);
  for (const c of committers) {
    if (l.executed) break;
    const existing = await sdk.fetchCommit(conn, launch, c.kp.publicKey);
    if (existing !== null) continue;
    const now = await sdk.clusterUnixTime(conn);
    if (now >= l.commitEndTs) {
      log(ctx, `commit window closed (${now} >= ${l.commitEndTs}): skipping the commit of ${c.name}`);
      continue;
    }
    const tx = await sdk.buildCommitTx(conn, c.kp.publicKey, launch, c.lamports, cb);
    await send(ctx, `commit ${c.lamports} lamports (${c.name})`, tx, [c.kp]);
  }
  await ledgerRow(ctx, "commits", wallets);
  l = await sdk.fetchLaunch(conn, launch);
  if (!l.executed && l.totalCommitted > 0n) {
    await waitForClusterTime(ctx, l.commitEndTs, "the commit window to close");
    const tx = await sdk.buildExecuteBatchTx(conn, keeper.publicKey, launch, cb);
    await send(ctx, "execute_batch (keeper, top-level)", tx, [keeper]);
    l = await sdk.fetchLaunch(conn, launch);
    const policy = await sdk.fetchHookPolicy(conn, l.baseMint);
    const now = await sdk.clusterUnixTime(conn);
    check(ctx, "execute_batch ended the snipe shield", policy !== null && policy.snipeShieldEndTs <= now, `policy snipe_shield_end_ts ${policy?.snipeShieldEndTs} (now ${now}); batch spent ${l.quoteSpent} lamports for ${l.tokensOut} base units`);
  }
  for (const c of committers) {
    const cm = await sdk.fetchCommit(conn, launch, c.kp.publicKey);
    if (cm === null || cm.claimed) continue;
    const tx = await sdk.buildClaimTx(conn, c.kp.publicKey, launch, c.kp.publicKey, cb);
    await send(ctx, `claim (${c.name})`, tx, [c.kp]);
    const bal = await sdk.getTokenBalance(conn, c.kp.publicKey, l.baseMint);
    log(ctx, `${c.name} holds ${bal} base units after the claim`);
  }
  await ledgerRow(ctx, "execute + claims", wallets);
  return sdk.fetchLaunch(conn, launch);
}

/** Buy or sell through the SDK (DBC while the curve runs, DAMM v2 after migration). */
export async function swap(ctx, step, kp, mint, side, amountIn, slippageBps = 1000) {
  const { tx, quote, warnings } = await sdk.buildSwapTx(ctx.conn, kp.publicKey, mint, side, amountIn, slippageBps, { computeUnitPrice: ctx.computeUnitPrice });
  for (const w of warnings) log(ctx, `warning: ${w}`);
  const r = await send(ctx, step, tx, [kp], { note: `${quote.venue} quote: in ${quote.amountIn}, out ~${quote.expectedOut}, fee ${quote.feeAmount ?? "?"}` });
  return { ...r, quote };
}

/** Token-2022 ATA of `owner` for `mint` (created idempotently by `payer`). */
export async function ensureAta(ctx, step, payer, owner, mint) {
  const ata = splToken.getAssociatedTokenAddressSync(mint, owner, true, splToken.TOKEN_2022_PROGRAM_ID);
  if ((await ctx.conn.getAccountInfo(ata, "confirmed")) !== null) return ata;
  const ix = splToken.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint, splToken.TOKEN_2022_PROGRAM_ID);
  const tx = new web3.Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await ctx.conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  await send(ctx, step, tx, [payer]);
  return ata;
}

export { PublicKey };
