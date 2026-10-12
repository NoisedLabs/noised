/**
 * The fee recipients' check (audit round 3, F3: `checkFeeRecipients`, the
 * same refusals `create_launch` makes) in plain words for the wizard. The
 * SDK's sentences stay the source: an unknown one is shown as it is.
 */
export function plainRecipientProblem(reason: string): string {
  if (/^a PQ vault of another mint/.test(reason)) {
    return "This is a quantum vault for another token. A vault can only ever move its own token, so its share of the fees would be stuck forever. Use a wallet, or your quantum vault for SOL.";
  }
  if (/^an account of the PQ vault program that is not a vault/.test(reason)) {
    return "This address belongs to the vault program but is not a vault, so nothing could ever move the fees sent to it.";
  }
  if (/^a token account or mint is not a wallet/.test(reason)) return "This is a token account, not a wallet: fees sent here could never be moved. Use the wallet's own address.";
  if (/^a program is not a wallet/.test(reason)) return "This is a program, not a wallet.";
  if (/^an off-curve address with no account/.test(reason)) {
    return "Nobody holds a key for this address (an unopened vault, a closed account or a typo). Use a wallet address, or open the vault first.";
  }
  if (/^the all-zero address/.test(reason)) return "This empty address belongs to nobody.";
  if (/^an off-curve account of/.test(reason)) {
    return "Only a program can move what this address receives (for example a multisig). Make sure that is what you want.";
  }
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}
