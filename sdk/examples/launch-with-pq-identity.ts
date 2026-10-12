/**
 * Launch a token whose creation is attested by the creator's post-quantum
 * (LMS) identity, end to end: fee vault -> plan -> create_launch ->
 * publish_metadata -> attest_launch -> wait for the window -> launch.
 *
 *   RPC_URL=https://api.devnet.solana.com NOISED_CLUSTER=devnet \
 *   CREATOR_KEYPAIR=~/.config/solana/id.json PQ_PHRASE_FILE=./pq-phrase.txt \
 *   TOKEN_NAME="Example" TOKEN_SYMBOL=EXMPL \
 *   TOKEN_DESCRIPTION="A fair-launched token." ICON_PNG_FILE=./icon-32.png \
 *   node examples/launch-with-pq-identity.ts
 *
 * Optional: TOKEN_DESCRIPTION (at most 500 bytes), ICON_PNG_FILE (a PNG of
 * at most 64x64 pixels; a 32x32 one with 16 colours keeps the record small:
 * apps can make it with `encodeIndexedPng`), WEBSITE_URL, X_URL,
 * TELEGRAM_URL (https links, shown as text), STATE_DIR (default
 * ./.noised-launch: the leaf ledger, the tree cache, the plan and the
 * throwaway fee payer, so a re-run resumes where it stopped), OPEN_IN_SECS
 * (default 600), CU_PRICE_MICROLAMPORTS (priority fee).
 *
 * What protects what:
 * - The creator's wallet (Ed25519) signs create_launch, which names the
 *   identity. Only that identity's LMS signature over this exact
 *   configuration, metadata record and window lets the launch go live: a
 *   quantum attacker who recovers the wallet key cannot launch as this
 *   creator.
 * - The token's name, symbol, description, icon and links are a record on
 *   chain (`TokenMeta`) at the address of its own hash, which the identity
 *   signs. The mint gets the record's name and symbol and an empty uri:
 *   wallets show the name and symbol; the icon shows in Noised and any
 *   reader of the record. Nothing is hosted anywhere.
 * - The identity comes from a separate 24-word PQ phrase (never from the
 *   wallet). Each of its 1,024 leaves signs ONE message ever; the leaf
 *   ledger in STATE_DIR records every leaf before its signature exists. Keep
 *   that directory (and a backup of it) for as long as the identity is used,
 *   and never use the identity from two machines with separate ledgers (move
 *   the records first: leafLedger.exportLeafRecords on one machine,
 *   leafLedger.importLeafRecords on the other, or use another identity index).
 * - A throwaway fee payer (kept in STATE_DIR until it is swept) publishes the
 *   record and lands the attestation: the wallet signs neither.
 * - Inside the window ANYONE may send `launch`, and the first one to land
 *   wins; this script sends it as soon as the window opens. If nobody
 *   launched in time, a re-run signs a new opening time (the window passed,
 *   so the new attestation replaces the old one).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import {
  buildFundThrowawayPayerTx,
  buildMetadataDoc,
  buildPlannedAttestTx,
  buildPlannedCreateLaunchTx,
  buildPlannedLaunchTx,
  buildPlannedPublishTx,
  buildSweepPayerTx,
  clusterUnixTime,
  confirmAttestation,
  getLaunchFlowStatus,
  leafLedger,
  planLaunch,
  prepareFeeVault,
  pqIdentity,
  replanLaunchWindow,
  sendAndConfirm,
  sendAttestLaunchTx,
  sendPublishMetadataTx,
  throwawayPayerFunding,
  waitForLaunchWindow,
  waitForTokenMeta,
  type LaunchPlan,
  type PqIdentity,
} from "@noisedlabs/sdk";

import {
  clusterFromEnv,
  computeUnitPriceFromEnv,
  connectionFromEnv,
  fileLeafLedgerStore,
  fileTreeCacheStore,
  fromHex,
  loadKeypair,
  optionalEnv,
  readSecretFile,
  replaceDurably,
  requireEnv,
  simulateSignSend,
  toHex,
} from "./shared.ts";

/** The identity index of the phrase this example uses (move to the next one when its 1,024 leaves run out). */
const IDENTITY_INDEX = 0;

/** An optional environment variable, `undefined` when unset. */
const maybeEnv = (name: string): string | undefined => {
  const v = optionalEnv(name, "");
  return v === "" ? undefined : v;
};

async function main(): Promise<void> {
  const conn = connectionFromEnv();
  const { cluster, allowLocalnet } = clusterFromEnv();
  const creator = loadKeypair(requireEnv("CREATOR_KEYPAIR"));
  const computeUnitPrice = computeUnitPriceFromEnv();
  const stateDir = optionalEnv("STATE_DIR", "./.noised-launch");
  mkdirSync(stateDir, { recursive: true });

  // The token's document: compact JSON in a fixed key order (the same input gives the same bytes, so the same hash).
  const name = requireEnv("TOKEN_NAME");
  const symbol = requireEnv("TOKEN_SYMBOL");
  const iconFile = maybeEnv("ICON_PNG_FILE");
  const doc = buildMetadataDoc({
    name,
    symbol,
    description: maybeEnv("TOKEN_DESCRIPTION"),
    iconPng: iconFile === undefined ? undefined : new Uint8Array(readFileSync(iconFile)),
    links: { website: maybeEnv("WEBSITE_URL"), x: maybeEnv("X_URL"), telegram: maybeEnv("TELEGRAM_URL") },
  });
  // flags 0 (the default): the mint's uri stays empty, so every wallet lists the token by its name and symbol.
  const metadata = { name, symbol, doc };

  // The PQ root secret: a 24-word phrase kept apart from any wallet. (A web
  // app can use a passkey instead: pqIdentity.deriveMasterFromPasskeyAssertion.)
  const secret = pqIdentity.importMaster(readSecretFile(requireEnv("PQ_PHRASE_FILE")));
  let identity: PqIdentity | null = null;
  try {
    // 1. The identity: 1,024 one-time leaves under one public key. The first
    //    derivation builds the tree (about a second); later runs load it from
    //    the authenticated cache.
    identity = await pqIdentity.deriveIdentity(secret.master, cluster, IDENTITY_INDEX, {
      cache: fileTreeCacheStore(join(stateDir, "tree-cache")),
      onProgress: (done, total) => process.stdout.write(`\rderiving the PQ identity: ${done}/${total} leaves`),
    });
    console.log(`\nPQ identity ${toHex(identity.identityId)}`);
    const id = identity;

    // 2. The creator's wSOL PQ vault: creator fees are paid into post-quantum custody.
    const feeVault = await prepareFeeVault(conn, { master: secret.master, cluster, payer: creator.publicKey, allowLocalnet });
    if (feeVault.openTx !== null) await simulateSignSend(conn, feeVault.openTx, [creator], "open the fee vault");

    // 3. The plan fixes everything the identity will sign. It is saved so
    //    that a re-run rebuilds the same launch instead of creating another.
    const planFile = join(stateDir, "plan.json");
    let plan = await loadOrMakePlan(conn, planFile, (opensAt, launchSeed, nowSecs) =>
      planLaunch({ creator: creator.publicKey, identity: id, preset: "fair", feeVault: feeVault.vault, metadata, opensAt, launchSeed, nowSecs }),
    );
    for (const w of plan.warnings) console.warn(`warning: ${w}`);
    console.log(`launch ${plan.launch.toBase58()}, record ${plan.tokenMeta.toBase58()}, window ${plan.window.notBefore}..${plan.window.notAfter} (unix seconds)`);

    const flowStatus = () => getLaunchFlowStatus(conn, plan.launch, { expectedMessageHash: plan.messageHash, expectedMetadataHash: plan.metadataHash });
    let status = await flowStatus();

    // 4. create_launch (the wallet signs). The identity signs only a FINALIZED launch.
    if (status.step === "create") {
      const created = await buildPlannedCreateLaunchTx(conn, plan, { computeUnitPrice });
      for (const w of created.warnings) console.warn(`warning: ${w}`);
      await simulateSignSend(conn, created.tx, [creator], "create_launch", { finalized: true });
      status = await flowStatus();
    }

    // The window passed without a launch: the identity signs a new opening time (same launch, same record).
    if (status.step === "window-missed") {
      const now = await clusterUnixTime(conn);
      plan = replanLaunchWindow(plan, { opensAt: now + BigInt(optionalEnv("OPEN_IN_SECS", "600")), nowSecs: now });
      savePlan(planFile, plan);
      console.log(`${status.summary}\nnew window ${plan.window.notBefore}..${plan.window.notAfter}`);
    }

    // 5. publish_metadata, then attest_launch, both from one throwaway fee payer (no wallet signature in either).
    if (status.step === "publish" || status.step === "attest" || status.step === "window-missed") {
      const payer = loadOrMakeThrowawayPayer(join(stateDir, "throwaway-payer.json"));
      const ledger = leafLedger.createLeafLedger(fileLeafLedgerStore(join(stateDir, "leaf-ledger")));
      const unlanded = await leafLedger.pendingSignatures(ledger, id.identityId);
      if (unlanded.length > 0) console.warn(`warning: ${unlanded.length} recorded signature(s) of this identity never landed (leaves ${unlanded.map((r) => r.leaf).join(", ")})`);

      // Fund the payer for what is still missing: the record's rent and fee, the identity's and attestation's rents, the attest fee.
      const funding = await throwawayPayerFunding(conn, {
        metadata: plan.metadata,
        launch: plan.launch,
        lmsPublicKey: id.publicKey,
        publish: { computeUnitPrice },
        attest: { computeUnitPrice },
      });
      const held = BigInt(await conn.getBalance(payer.publicKey, "confirmed"));
      if (held < funding.lamports) {
        const fund = await buildFundThrowawayPayerTx(conn, creator.publicKey, payer.publicKey, { lamports: funding.lamports - held });
        await simulateSignSend(conn, fund.tx, [creator], `fund the throwaway payer (${fund.lamports} lamports)`);
      }

      // The record first, and FINALIZED before the identity signs: a record lost in a dropped fork would turn the attestation into a burn.
      const published = await buildPlannedPublishTx(conn, plan, payer, { computeUnitPrice });
      if (published.status === "ready") {
        await sendPublishMetadataTx(conn, published);
        console.log(`publish_metadata: ${published.signature} (${published.sizeBytes} bytes)`);
      }
      await waitForTokenMeta(conn, plan.launch, plan.metadataHash);

      // The identity signs the plan's message at a leaf the ledger reserved first.
      const built = await buildPlannedAttestTx(conn, plan, { identity: id, ledger, allowLocalnet, computeUnitPrice, payer });
      for (const w of built.warnings) console.warn(`warning: ${w}`);
      if (built.status === "ready") {
        const outcome = await sendAttestLaunchTx(conn, built, { ledger });
        if (outcome.status !== "attested") throw new Error(`the attestation did not attest (${outcome.status}): ${outcome.detail}`);
        console.log(`attested by leaf ${outcome.leaf} in slot ${outcome.slot}`);
      } else if (built.status === "leaf-landed") {
        // This message's signature already landed: never re-send or re-sign, just find out what it did.
        const outcome = await confirmAttestation(conn, plan.launch, plan.messageHash, { leaf: built.leaf, lmsPublicKey: built.lmsPublicKey, message: built.message, ledger });
        if (outcome.status !== "attested") throw new Error(`leaf ${built.leaf}: ${outcome.detail}`);
      }

      // What is left on the throwaway payer goes back to the creator.
      const sweep = await buildSweepPayerTx(conn, payer, creator.publicKey);
      if (sweep !== null) console.log(`swept ${sweep.lamports} lamports back: ${await sendAndConfirm(conn, sweep.tx)}`);
      status = await flowStatus();
    }
    if (status.attestedMessageMatches === false) throw new Error("the launch is attested by another message than this plan's: launch it inside that attestation's window");

    // 6. Wait for the attested window, on the CLUSTER clock.
    if (status.step === "wait-for-window") {
      console.log(`waiting ${status.secondsUntilWindowOpens} s for the launch window`);
      status = await waitForLaunchWindow(conn, plan.launch);
    }

    // 7. launch: anyone may send it inside the window; the first to land wins. It takes no metadata: the record is on chain.
    if (status.step === "launch") {
      const baseMint = Keypair.generate();
      const { tx } = await buildPlannedLaunchTx(conn, plan, creator.publicKey, baseMint, { computeUnitPrice });
      await simulateSignSend(conn, tx, [creator], "launch");
      console.log(`live: mint ${baseMint.publicKey.toBase58()} (check it with examples/verify-mint.ts)`);
      return;
    }
    console.log(`nothing to do at step "${status.step}": ${status.summary}`);
  } finally {
    identity?.keyPair.wipe();
    pqIdentity.wipeMaster(secret);
  }
}

/** Save the plan's inputs (launch seed and opening time): a re-run rebuilds exactly this plan. */
function savePlan(file: string, plan: LaunchPlan): void {
  replaceDurably(file, JSON.stringify({ launch: plan.launch.toBase58(), launchSeed: toHex(plan.launchSeed), opensAt: plan.window.notBefore.toString() }, null, 2));
}

/** The saved plan inputs, or new ones. */
async function loadOrMakePlan(
  conn: ReturnType<typeof connectionFromEnv>,
  file: string,
  make: (opensAt: bigint, launchSeed: Uint8Array, nowSecs: bigint | undefined) => LaunchPlan,
): Promise<LaunchPlan> {
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { launchSeed: string; opensAt: string };
    // Re-planning a saved launch: its window was checked against the clock when it was first planned.
    return make(BigInt(saved.opensAt), fromHex(saved.launchSeed), undefined);
  }
  const now = await clusterUnixTime(conn); // the cluster's clock, in SECONDS
  const opensAt = now + BigInt(optionalEnv("OPEN_IN_SECS", "600"));
  const plan = make(opensAt, crypto.getRandomValues(new Uint8Array(32)), now);
  savePlan(file, plan);
  return plan;
}

/**
 * The throwaway fee payer, kept in a file until it is swept: an interrupted
 * run finds the lamports it was funded with. It holds no authority over the
 * launch; it only pays.
 */
function loadOrMakeThrowawayPayer(file: string): Keypair {
  if (existsSync(file)) return loadKeypair(file);
  const payer = Keypair.generate();
  replaceDurably(file, JSON.stringify(Array.from(payer.secretKey)));
  return payer;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
