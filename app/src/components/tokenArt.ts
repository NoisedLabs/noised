/**
 * Hand-made 32 x 32 pixel icons for the demo tokens (the simulated chain, VITE_NOISED_MOCK=1), so the demo's
 * launch cards each carry their own crisp icon, as real launches will once Noised stores the icon a creator
 * draws in the create wizard. Six greys on transparent (monochrome, like the rest of the site); drawn on a dark
 * tile in both themes. Live builds never show these: `demoTokenIcon` returns null outside the demo.
 *
 * Legend: W white, L light silver, M silver, D grey, S graphite, B near black, "." transparent.
 * Source: gen.py, a generator kept outside the repository by the maintainers (generated, then frozen here).
 */
import { ADAPTER_MODE } from "../lib/noised";
import { TRANSPARENT, type PixelIcon } from "../fx/pixel/quantize";

const LEGEND = "WLMDSB";
const PALETTE = ["#ffffff", "#d6d6d6", "#a0a0a0", "#666666", "#3a3a3a", "#1e1e1e"];

const ART: Record<string, readonly string[]> = {
  // Aegis: a heater shield with a quartered face and a boss
  AEGS: [
    "................................",
    "................................",
    "................................",
    ".....WWWWWWWWWWWWWWWWWWWWWL.....",
    ".....WBWWBBBBBBBBBBBBBBBBBS.....",
    ".....WWLLLLLLLLLLLLLLLLLLBS.....",
    ".....WBLSSSSSBSSSBSBSBSBMBS.....",
    ".....WBLBSBSBSBLLSBSBBBSMBS.....",
    ".....WBLSSSSSSSLLBSBSBSBMBS.....",
    ".....WBLBSBSBSBWLSBSBSBBMBS.....",
    ".....WBLSBSSSWWMMWLBSBSBMBS.....",
    ".....WBLBSBSBWMWMMDSBBBBMBS.....",
    ".....WBLLLLLWMWWMMMLMMMMMBS.....",
    ".....WBLLLLLLMMMMMMDMMMMMBS.....",
    ".....WBLSBSBSWMMMMDBSBSBMBS.....",
    ".....WBLBSBSBLDMMDDBBBBBMBS.....",
    ".....LBLSBSBSBSLDBSBSBBBMBS.....",
    "......WBLSBSBSBMMBBBBBBMBS......",
    "......WBLBSBSBSMMBSBBBBMBS......",
    "......WBLBBSBBBMMBBBBBBMBS......",
    "......LBLBSBSBSMMBBBSBBMBS......",
    ".......LBMBBBBBMMBBBBBMBS.......",
    "........LBMBSBSMMBBBBMBS........",
    ".........LBMBBBMMBBBMBS.........",
    "..........LBMBBMMBBMBS..........",
    "...........LBMMMMMMBS...........",
    "............LBBMMBBS............",
    ".............LSBBSS.............",
    "...............LS...............",
    "................................",
    "................................",
    "................................",
  ],
  // Ember: a flame with two side tongues and sparks
  EMBR: [
    "................................",
    "................................",
    "....................M...........",
    "....................D...........",
    "...........D........D...........",
    "...................LS...L.......",
    "..................LDS..W........",
    ".................LDDS...........",
    ".........L......LDDDS...........",
    "...............LDDDDDD..........",
    "...............LMDMDMS..........",
    "..............LDDDDDDS.....M....",
    ".............LMDMMLDMDD.........",
    "............LMDDDLMDDMS..D......",
    ".......D....LDMDLMLDMDS.DD......",
    ".......DD..LDDDLMLMLDDSDD.......",
    "........D..LMDMMLLLMMDMDD.......",
    "........DDLMDMMLMLMLDMDS........",
    "........DDLDMLLLLLLLLDMS........",
    ".........LDMDLMLWWMLMMDS........",
    ".........LMMLLLLWWLLLMMS........",
    ".........LDMLLLWWWLLLLDS........",
    ".........LMMLLLWWWWLLLMS........",
    ".........DDLLLWWWWWLLLS.........",
    "..........LMLLWWWWWLLMS.........",
    "..........DMLLWWWWWLLS..........",
    "...........DMLWWWWWLS...........",
    "............DSLWWWSS............",
    "..............DSSS..............",
    "................................",
    "........SDSSDSSDSSDSSDSSD.......",
    "..........BBBBBBBBBBBBB.........",
  ],
  // Bastion: a brick tower with battlements, a gate and a flag
  BSTN: [
    "...............LWWWW............",
    "...............LWWWWW...........",
    "...............LLLL.............",
    "...............L................",
    "...............L................",
    "...............L................",
    ".......WW...WW...WW...MDD.......",
    ".......LL...LL...LL...MDD.......",
    ".......LLLLLLLLLLLLMMMMDD.......",
    ".......LLLLLLLLLLLLMMMMDD.......",
    ".......SSSSSSSSSSSSSSSSSS.......",
    ".........LMMMMMMMMDDDSS.........",
    ".........LMMSMMMMMBDDSS.........",
    ".........LMMSMMSSMBDDSS.........",
    ".........LSSSSSBBSBBBBS.........",
    ".........LMMMMMBBMDDDBS.........",
    ".........LMMMMMDDMDDDBS.........",
    ".........LSSSSSBBSBBBBS.........",
    ".........LMMSMMMMMBDDSS.........",
    ".........LMMSMMMMMBDDSS.........",
    ".........LSSSSSSSSBBBBS.........",
    ".........LMMMMMSMMDDDBS.........",
    ".........LMMMMBBBBDDDBS.........",
    ".........LSSSBBBBBBBBBS.........",
    ".........LMMSBBBBBBDDSS.........",
    ".........LMMSBSSSSBDDSS.........",
    ".........LSSSBBBBBBBBBS.........",
    ".........LMMMBSSSSBDDBS.........",
    ".........LMMMBBBBBBDDBS.........",
    ".........LMMMBSSSSBDDSS.........",
    ".....SSSSSSSSSSSSSSSSSSSSSS.....",
    ".......BBBBBBBBBBBBBBBBBB.......",
  ],
  // Lantern: a hanging lantern with a lit flame
  LNTN: [
    "...............LL...............",
    ".............LLLLLM.............",
    "............LL....MM............",
    "............L......M............",
    "............L......M............",
    "............L......M............",
    "............LL....MM............",
    "..........LWWWWWWWWWW...........",
    ".........LLLLLLLLLLMMM..........",
    "........LLLLLLLLLLLMMMM.........",
    ".......LLLLLLLLLLLLMMMMM........",
    ".......DDDDDDDDDDDDDDDDDDD......",
    "........LMSSDSDSLSDDDSSD........",
    ".....S..LMSSDDSDSDSDSSSD..S.....",
    "........LMDSDSLDLSLDDSSD........",
    "........LMSDDLSWWLSDSSSD........",
    "........LMLSDLLWWLLDLSSD........",
    "........LMSDDLWWWWDDSDSD........",
    "...DM...LMLDDLWWWWLDLSSD...MD...",
    "........LMSLDLWWWWDDSSSD........",
    "........LMLSDLWWWWLDLSSD........",
    "........LMSDDLSLDLSDSDSD........",
    "........LMDSDSLDLSLDDSSD........",
    ".....S..LMSSDSSDSDSDSSSD..S.....",
    "........LMSSDSDSLSDDDSSD........",
    ".......LLLLLLLLLLLLLLLLLLL......",
    "........LLLLLLMMMMMMMDDD........",
    "........LLLLLLMMMMMMMDDD........",
    "................................",
    "..........DDDDDDDDDDDDD.........",
    "...........SSSSSSSSSSS..........",
    "................................",
  ],
  // Meridian: a compass rose in a lit ring
  MRDN: [
    "................................",
    "..............WWWW..............",
    "..........WWWWWWWWWLLL..........",
    "........WWWWWWWWWWWLLLLL........",
    ".......WWWWWSSSBSBSBLLLLL.......",
    "......WWWWBDBSBLBSBSDSLLLL......",
    ".....WWWSBSSSBSWLBSBSBSBLLD.....",
    "....WWWSBSBSBSBWLSBSBBBBBDDD....",
    "...WWWSSDSSSSSSWLSSBSBSDSBDDD...",
    "...WWWBSBSBSSSBWLSBSBSBBBBDDD...",
    "..WWWBSSSSSSSSWWLLSBSBSBSBSDDD..",
    "..WWWDBSBSSSBSWWLLBSBSBSBBDDDD..",
    "..WWSSSSSSSSSSWWLLSBSBSBSBSBDD..",
    "..WWBSBSBSBSSSWWLLBSBSBBBBBBDD..",
    ".WWWSBSSSSSSSWWMMLLBSBSBSBSBSSS.",
    ".WWWBSBSBMMMMWMWMMLMMMMSBBBBSSS.",
    ".WWWSLSBSDDDDDMMMMSDDDDBSBLBSSS.",
    ".WWWBSBSBSBSBDDMMSSSBSBBBBBBSSS.",
    "..WWSBSBSBSSSBDDSSSBSBSBSBSBSS..",
    "..LLBBBSBSBSBSDDSSBSBBBBBBBBSS..",
    "..LLLDSBSBSBSBDDSSSBSBSBSBDSSS..",
    "..LLLSBSBSBSBSDDSSBBBBBBBBBSSS..",
    "...LLLSBSBSBSBSDSBSBSBSBBBSSS...",
    "...LLLBBDBBSBBBDSBBBBBBDBBSSS...",
    "....LLLBSBSBSBSDSBSBSBBBSSSS....",
    ".....LDDBBBBBBBDSBBBBBBBSSS.....",
    "......DDDDSDSBSBLBSBDBSSSS......",
    ".......DDDDDBBBBBBBBSSSSS.......",
    "........DDDDDDSSSSSSSSSS........",
    "..........DDDDSSSSSSSS..........",
    "..............SSSS..............",
    "................................",
  ],
  // Cinder: a coal lump with glowing cracks and rising embers
  CNDR: [
    "................................",
    ".......................S........",
    ".................D..............",
    ".....................M..........",
    "....................W...........",
    ".............M..................",
    "............L...................",
    ".........................M......",
    ".........D......................",
    "...............MMMD.............",
    "............MMMSDSDMMMD.........",
    "..........MMSSSDSSMMSSSD........",
    ".........MDSDSDSMDLLDSSSD.......",
    "........MDSDSDSDLDDDSSSSSD......",
    "........MSDSDSDDWMDSSSSSSBD.....",
    ".......MSSSDSSSSDWDSSSSSBSBD....",
    "......MSDMMSDSDSMLDSDSSBSBSB....",
    "......MDDLLMMSSDLDSSSSBMBSBB....",
    ".....MDSDDDLLMMSDSSSSMMLDBSB....",
    ".....MSDSSSDDWWMMSSMMLLDBSBB....",
    ".....MDSDSDSDDDWWMMLLDDBSBB.....",
    ".....MSSSSSSSSDLDWWDLMBSBSB.....",
    ".....MDSDSDSSSMLDDDBDLDBSBB.....",
    ".....DSSSSSSSDLDBSBSDLMSBSB.....",
    "......DSDSSSDMLDSBSBSDLDSB......",
    ".......DSSSSDLDSBSBSBSDBB.......",
    "........DSSSSDSBSBSBSBB.........",
    ".........DBBBBBSBSBSBB..........",
    "...............DBBBBB...........",
    "................................",
    "................................",
    "................................",
  ],
  // Quarry: a pickaxe over a rock
  QRY: [
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "..................WWWWWWW.......",
    "................WWLLLMMLWWW.....",
    "...............WLLDDLDDDLLWW....",
    "..............WLDDDLMS..DDLWW...",
    ".............WLDD.LMSSS...DLWW..",
    "............WLDD..LMS......DLWW.",
    "............DDD..LMS........DDW.",
    "...........WDD..LMS..........DDW",
    "...........D...LMS.............D",
    "..............LMS...............",
    "..............LMS...............",
    ".............LMS................",
    "...........MLMSMD...............",
    ".......MMMMLMSDSDMMMD...........",
    "......MDSDLMSDSDSDSSSMMD........",
    ".....MDDDSLMSSDSDSDSDSDSD.......",
    "....MDSDSLMSSDSDSSSDSSSSSD......",
    "...MDDDSLMSSDSDSDSSSDSDSDSD.....",
    "...MSDSLMSSSSDSSSDSSSSSSSSSD....",
    "...MDSLMSSDSDSDSDSDSDSSSSSDSD...",
    "...DSDLMSDSDSSSDSSSSSSSSSSSSB...",
    "....MDDSDSDSDSDSDSDSDSDSDSSB....",
    "....DBBBBBBBBBBBBBBBBBBBBBBB....",
    "................................",
    "................................",
  ],
};

const cache = new Map<string, PixelIcon>();

function build(rows: readonly string[]): PixelIcon {
  const size = rows.length;
  const pixels = new Uint8Array(size * size).fill(TRANSPARENT);
  rows.forEach((row, y) => {
    for (let x = 0; x < size; x++) {
      const i = LEGEND.indexOf(row[x] ?? ".");
      if (i >= 0) pixels[y * size + x] = i;
    }
  });
  return { size, palette: PALETTE, pixels };
}

/** The demo token's own pixel icon by symbol (demo build only; null for any other token or in a live build). */
export function demoTokenIcon(symbol: string | undefined | null): PixelIcon | null {
  if (ADAPTER_MODE !== "mock" || !symbol) return null;
  const rows = ART[symbol];
  if (!rows) return null;
  let icon = cache.get(symbol);
  if (!icon) {
    icon = build(rows);
    cache.set(symbol, icon);
  }
  return icon;
}
