/**
 * Initialize the launchpad's Protocol on DEVNET, exactly as the program
 * defines it (programs/noised-launchpad/src/instructions/initialize_protocol.rs):
 *
 * 1. the treasury: a wSOL PQ vault opened from a devnet TEST phrase
 *    (secrets/treasury-phrase.txt under NOISED_DEVNET_DIR; vault account 0,
 *    genesis key derived for "devnet"). `initialize_protocol` refuses anything
 *    else, so noised_vault must be deployed first;
 * 2. `initialize_protocol(platform_fee_bps)` signed by the launchpad's
 *    upgrade authority (the devnet deployer). There is no update instruction:
 *    on devnet this is a test value, never a mainnet one.
 *
 *   NOISED_DEVNET_DIR=<run state dir, outside the repo> NOISED_DEVNET_DEPLOYER=<keypair> \
 *   [PLATFORM_FEE_BPS=1000] node scripts/devnet/10-init-protocol.mjs
 */
import { check, deployer, ledgerRow, legacyTx, log, runMain, saveState, sdk, sdkIx, send, testMaster } from "./lib.mjs";

await runMain("init", async (ctx) => {
  const { conn } = ctx;
  const P = sdk.PROGRAM_IDS;
  const d = deployer(ctx);
  await ledgerRow(ctx, "start", { deployer: d.publicKey });

  // Every program the protocol needs, deployed and executable.
  for (const [name, id] of Object.entries({ launchpad: P.launchpad, hook: P.hook, autopilot: P.autopilot, vault: P.vault })) {
    const acc = await conn.getAccountInfo(id, "confirmed");
    if (acc === null || !acc.executable) {
      throw new Error(`noised_${name} (${id.toBase58()}) is not deployed: initialize_protocol needs the launchpad and a wSOL PQ vault of noised_vault as its treasury`);
    }
  }
  const programData = sdk.programDataAddress(P.launchpad);
  // ProgramData: u32 tag (3), u64 slot, Option<Pubkey> upgrade authority (tag byte at 12, key at 13..45).
  const pdAcc = await conn.getAccountInfo(programData, "confirmed");
  if (pdAcc === null || pdAcc.data[12] !== 1) throw new Error("the launchpad has no upgrade authority: initialize_protocol can never run");
  const authorityKey = Buffer.from(pdAcc.data.subarray(13, 45)).toString("hex");
  if (authorityKey !== Buffer.from(d.publicKey.toBytes()).toString("hex")) throw new Error("the deployer is not the launchpad's upgrade authority");

  const existing = await sdk.fetchProtocol(conn);
  if (existing !== null) {
    log(ctx, `Protocol already initialized: treasury ${existing.treasury.toBase58()}, platform_fee_bps ${existing.platformFeeBps}`);
    ctx.state.protocol = { address: existing.publicKey.toBase58(), treasury: existing.treasury.toBase58(), platformFeeBps: existing.platformFeeBps };
    saveState(ctx);
    return;
  }

  // 1. The treasury vault (wSOL), from the devnet test treasury phrase.
  const master = testMaster(ctx, "treasury-phrase");
  try {
    const vault = await sdk.prepareFeeVault(conn, { master: master.master, cluster: "devnet", payer: d.publicKey, account: 0 });
    log(ctx, `treasury vault ${vault.vault.toBase58()} (wSOL), token account ${vault.tokenAccount.toBase58()}, opened: ${vault.opened}`);
    if (vault.openTx !== null) await send(ctx, "open_vault (protocol treasury, wSOL)", vault.openTx, [d]);
    const info = await sdk.fetchVault(conn, vault.vault);
    check(ctx, "treasury vault is a version-4 wSOL PQ vault", info !== null && sdk.isPqVaultOf(await rawAccount(conn, vault.vault), sdk.WSOL_MINT), `vault ${vault.vault.toBase58()}`);
    await ledgerRow(ctx, "open treasury vault", { deployer: d.publicKey });

    // 2. initialize_protocol, by the upgrade authority.
    const platformFeeBps = Number(process.env.PLATFORM_FEE_BPS ?? "1000");
    const ix = sdkIx.buildInstruction(
      sdk.idlCodecs().launchpad,
      P.launchpad,
      "initialize_protocol",
      { authority: d.publicKey, protocol: sdk.protocolAddress(), treasury: vault.vault, program: P.launchpad, programData },
      { platformFeeBps },
    );
    await send(ctx, `initialize_protocol (platform_fee_bps ${platformFeeBps})`, await legacyTx(ctx, d.publicKey, [ix]), [d], { finalized: true });
    const p = await sdk.fetchProtocol(conn);
    check(ctx, "Protocol account", p !== null && p.treasury.equals(vault.vault) && p.platformFeeBps === platformFeeBps && p.version === 1, `Protocol ${sdk.protocolAddress().toBase58()}: treasury ${p?.treasury.toBase58()}, platform_fee_bps ${p?.platformFeeBps}, version ${p?.version}`);
    ctx.state.protocol = { address: sdk.protocolAddress().toBase58(), treasury: vault.vault.toBase58(), treasuryTokenAccount: vault.tokenAccount.toBase58(), platformFeeBps };
    saveState(ctx);
    await ledgerRow(ctx, "initialize_protocol", { deployer: d.publicKey });
  } finally {
    sdk.pqIdentity.wipeMaster(master);
  }
});

async function rawAccount(conn, address) {
  const a = await conn.getAccountInfo(address, "confirmed");
  return a === null ? null : { address, owner: a.owner, data: new Uint8Array(a.data), lamports: BigInt(a.lamports), executable: a.executable };
}
