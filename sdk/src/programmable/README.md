# Programmable launches (SDK module)

Launch **rules** (PXR1) and **autopilot** graphs (PXG1): build them with blocks, a canvas, TypeScript or text; every form
compiles to the same small byte formats the chain verifies (`crates/noised-rules`). This module mirrors that crate:
same byte layouts, same verifier checks in the same order, same error names (`VERIFY_ERRORS`), same evaluation.

What can never happen, whatever a creator writes:

- A rule can only **refuse** a transfer, never allow or move anything. Sells, the opening batch, claims and zero-amount
  transfers are decided before rules run, so no rule can block them. Every rule ends with the launch guard (72 h max).
- Rules never apply to holders using the Noised vault or shield directly (`RULES_SKIPPED_PROGRAMS`: the transaction's
  current top-level instruction is the vault's or the shield's); the built-in launch guard still does. The flip side:
  a transfer routed through them also escapes anti-bot rules (never the built-in guard), and a call into them made
  by another program still has that program on top, so the rules apply to it.
- An autopilot graph can only buy back and burn, burn, and pay the recipients it declares (plus a small capped keeper
  tip). It never sells the token, never touches the locked liquidity, never mints or freezes. An operator (for example
  an AI agent) only picks timing and amount inside the node's on-chain limits.

## Code

```ts
import { rules, when, graph, every, after, buybackBurn, burn } from "./index.js";

const bytes = rules({ guardSecs: 3600 })
  .key("team", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")
  .deny(when.buy().and(when.timeLt("2m")).and(when.txIxCountGt(10)), "BOT")
  .capAmount("0.5%", when.buy(), { code: "WHALE", first: "10m" })
  .deny(when.buy().and(when.toIn("team")), "TEAM")
  .compile();

const g = graph()
  .node("buyback", every("1d"), when.treasurySolGte(1), buybackBurn({ maxIn: 0.5, maxPremiumBps: 300 }), { budgetPerEpoch: 2 })
  .node("burn-rest", after("buyback"), null, burn({ maxTokens: 1_000_000 }))
  .compile();
```

Numbers are human amounts (SOL, whole tokens); `bigint`s are raw (lamports, raw units). Percentages are shares of
supply (`"0.5%"`, `"25bps"`). Durations are `"90s"`, `"2m"`, `"1h30m"`, `"1d"` or seconds.

## Rules text DSL

```
rules v1
guard 1h
key team = 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin

first 2m: deny when buy and instructions > 10 code BOT
first 10m: max amount 0.5% when buy code WHALE
always: max balance 2% code WHALE
always: deny when buy and to in {team} code TEAM
```

Grammar (one statement per line; `#` starts a comment; an indented line continues the previous statement):

```
file      := ["rules v1"] { guard | decimals | key | rule }
guard     := "guard" DURATION                      the launch guard (must match the launch's, if given)
decimals  := "decimals" INT                        token decimals for "tokens" amounts (default 6)
key       := "key" NAME "=" ADDRESS                names a wallet or program; every key must be used
rule      := WINDOW ":" EFFECT ["when" COND] ["code" (NAME | 0..63)]
WINDOW    := "always" | "first" DURATION | "until" DURATION | "after" DURATION
           | "from" DURATION "to" (DURATION | "end")
EFFECT    := "deny" | "block"
           | ("max" | "cap") "amount" AMOUNT        refuse a single transfer above AMOUNT
           | ("max" | "cap") "balance" AMOUNT       refuse if the receiver would hold more than AMOUNT
COND      := OR ; OR := AND {"or" AND} ; AND := UNARY {"and" UNARY} ; UNARY := "not" UNARY | "(" COND ")" | LEAF
LEAF      := "true" | "false" | "buy" | "p2p"
           | "time" ("<" | ">=") DURATION           time since the launch opened
           | "amount" ">" AMOUNT | "balance" ">" AMOUNT
           | ("to" | "from" | "program") "in" ("{" NAME {"," NAME} "}" | NAME)
           | "instructions" ">" INT                 top-level instructions in the transaction
AMOUNT    := NUMBER "%" | INT "bps" | NUMBER "tokens" | INT "units"
DURATION  := e.g. 90s, 2m, 1h30m, "1 hour 30 minutes", 1d, 1w
NAME      := letter {letter | digit | "_" | "-"}
```

Codes: `RULE` (0), `BOT`, `SNIPER`, `WHALE`, `TEAM`, `ALLOWLIST`, `BLOCKLIST`, `P2P`, `EARLY`, `ROUTER`, or a number
0..63. The printer writes the canonical form: `always` / `first` / `after` / `from..to` windows, `max amount` /
`max balance`, the fewest parentheses that keep the tree, `code` only when not 0. `always`, `after D` and
`from D to end` stay open-ended (`to: null`: they last until the guard ends, whatever its length); `first D` and
`from D to E` keep their explicit end even when it equals the guard, so a "first 6h" rule never silently becomes
"always" (and never grows with a longer guard). Compiling resolves open ends to the guard; decompiled bytes carry
explicit ends. `parseRules(printRules(s))` is `normalizeRules(s, { keepOpenEnds: true })`; `printRules(parseRules(t))`
is idempotent.

## Autopilot text DSL

```
autopilot v1
operator = <address>                     # only when some node is operator-gated
recipient team = <address> 70%
recipient dao = <address> 30%

node buyback: every 1d
  when graduated and treasury_sol >= 1 SOL
  do buyback 0.5 SOL premium 3%
  budget 2 SOL per 1d
  max 4 runs

node share: after buyback
  do distribute 0.2 SOL
  budget 0.2 SOL per 1d
  max 1 run
  operator decides
```

```
file      := ["autopilot v1"] { decimals | operator | recipient | node }
operator  := "operator" "=" ADDRESS
recipient := "recipient" NAME "=" ADDRESS PERCENT                shares add up to 100%
node      := "node" NAME ":" TRIGGER  followed by indented lines:
               "when" COND                                       (required for "whenever")
               "do" ACTION                                       (required)
               "budget" (SOL | TOKENS) "per" DURATION            default: per-run max x runs, per 1d
               "max" INT ("runs" | "run")                        default: epoch / every, else 1
               "operator decides"                                only the operator may run it
TRIGGER   := "every" DURATION (>= 10m) | "after" NAME | "on graduation" | "whenever"
ACTION    := "buyback" SOL "premium" PERCENT                     buy back and burn; PERCENT <= 20%
           | "burn" TOKENS | "distribute" SOL
LEAF      := "true" | "false" | "graduated"
           | "treasury_sol" ">=" SOL | "treasury_tokens" ">=" TOKENS
           | "price" ("<=" | ">=") (NUMBER "SOL" | INT "q64")    SOL per token (the reference and every recently observed price)
           | "now" (">=" | "<") (YYYY-MM-DD | YYYY-MM-DDTHH:MM:SSZ | unix)
           | "runs" "(" NAME ")" "<" INT                         runs of a node in its current epoch
SOL       := NUMBER "SOL" | INT "lamports" ;  TOKENS := NUMBER "tokens" | INT "units"
PERCENT   := NUMBER "%" | INT "bps"
```

Prices print as the shortest decimal that maps back to the exact on-chain sqrt price.

## Errors

- `DslError { message, line, col, offset, length, hint }` — `tryParseRules` / `tryParseGraph` return every error
  (one per statement), sorted, so an editor can underline them all; a node with a broken line is not checked further.
- `ProgError { code, message, at }` — verifier codes are the crate's `noised_rules::Error` names; model codes
  (`UnknownKey`, `WrongContext`, ...) come from builders and compile. `at.rule` / `at.node` / `at.key` say which
  rule, graph node or key / recipient it is about, so an editor can point at it.
- Nothing ever throws anything else for bad input: absurdly nested text, huge trees, `NaN` prices and the like all get
  a `DslError` or `ProgError` (tested), never a `RangeError`.

## What the bytes say is what the model says

- Encoding is strict: a value that does not fit its field (a negative or 2^64-wide budget, a 70,536 bps share, a
  31-byte key) is refused with `ProgError` (`BadAmount` with its node / recipient from the model, `BadModel` from the
  raw encoders). Nothing is truncated or wrapped, so a budget of `-1n` can never become an unlimited `u64::MAX`.
- Every compile ends with the same verifier the chain runs, and `decompile(compile(x))` is the canonical form of `x`.
- Limits outside the formats: the launch guard is whole seconds and at most 72 h (`checkGuardSecs`); a condition tree
  has at most `MAX_TREE_NODES` (512) nodes before any walk; DSL conditions nest at most `MAX_NESTING` (128) levels;
  `simulateGraph` runs at most `MAX_SIM_STEPS` (10,000) steps.
- Before the merge into the SDK, a scripted mutation check broke each check in turn (verifiers, evaluators, runtime,
  simulator, encoders, DSL printer) and required a test to fail every time (241 of 241 killed).

## Parity with the on-chain crate

The verifiers, evaluators and runtime mirror `crates/noised-rules` check for check, with the same error names
(`VERIFY_ERRORS`, `NOT_DUE`). Two test suites prove it, on copies of the crate's files in
`test/vectors/programmable` (pinned by SHA-256; SDK tests never read outside `sdk/`):

- `vectors.test.ts` runs the crate's parity vectors: hashes, encodings, errors (and the stage that raises them),
  evaluations, conditions, schedules, caps, epochs and shares.
- `differential.test.ts` regenerates the crate's seeded differential run (`test/programmable/differential.ts` mirrors
  `tests/differential.rs` draw for draw): 3,000 rule sets and 3,000 graphs, valid and mutated, including the
  unverified paths. Every result must match the crate's: verdicts, evaluations, conditions, schedules, caps, epochs,
  shares and thresholds.

The autopilot program's own decisions are ported too (`autopilot/logic.ts`: `planRun`, `runAmount`, `recordRunRaw`,
`takeTipRaw`, `checkActivation`, `checkFresh`, `checkApply`, the authorization payload hashes) along with its price
bounds (`graph/reference.ts`: observations, the window, the reference, `buybackMinOut`). `autopilot.vectors.test.ts`
replays vectors the program's Rust functions wrote (`test/vectors/programmable/autopilot.json`, generator
`autopilot.gen.rs`): 4,000 price-bound cases, 100 observation histories (2,094 observations), 3,370 logic cases and 2,400 complete
`plan_run` decisions, all identical.

The raw mirrors behave like the crate on unverified input too: `threshold` saturates at `u64::MAX`; `graphShares`
gives 0 for a share that does not fit in a u64; `verifyRules` takes `guardSecs` as a u32 and throws `BadModel` for
anything else.

## Simulators

- `simulateTransfer(rules, { kind, at, amount, ... })` → `{ allowed, rule, code, codeName, stage, refusal?, why }`,
  in the hook's own order (`built_ins`, then `creator_rules`): sell, guard over, snipe shield, zero amount, the batch
  buy, `MutableOwner`, claims (`protocol`), p2p lock, max buy, max wallet, then the custom rules. Pass
  `builtin: { snipeShieldSecs, maxBuyBps, maxWalletBps, p2pLocked }` (the launch params) to switch on the launch's
  shield, lock and caps. `toImmutableOwner: false` (default true: every Token-2022 associated token account has a
  fixed owner) tries a receiving account whose owner can be changed: refused during the guard (`MutableOwner`, stage
  `mutableOwner`), claims included, unless it is a sell, a zero amount or the batch buy. A `program` that is the
  Noised vault or shield skips the custom rules (stage `holderExit`) after every built-in check.
- `ruleWarnings(bytes, { guardSecs, supply?, tokenDecimals?, buysOpenAt? })` → what a holder should be warned about,
  most serious first, each with a plain sentence: `insiderBuying` (only listed wallets can buy, and for how long),
  `buysBlocked`, `transferLimits` (wallet-to-wallet), `longRule` (on for more than an hour), `noOpRule` (can never
  refuse anything), `complexRule`. Every rule is tried with the hook's own evaluation on each case that can change its
  outcome. QSL-1 shows these next to the "programmable" tag; a creator UI can show them before publishing.
- `simulateGraph(graph, { epochs, migrationPrice, poolFeeBps, poolSol, priceFn, feeInflowFn, ... })` → a timeline
  of treasury SOL / tokens, burns, runs, tips and blocked reasons, plus the market `assumptions` in plain English.
  Every run is decided by the program's own logic (`planRun`) on the state the program keeps: the reference starts
  at the migration price (required), rises at most 5% an hour from an allowance only real rises spend and falls at
  once; a buyback needs observations spanning a minute, the pool within its premium over min(reference, lowest
  observed price), and a swap that returns the program's minimum out. The market is explicit: `poolFeeBps` (required;
  `MIGRATION_FEE_TIERS_BPS[migrationFeeOption]`) and `poolSol` (required: the pool's depth for price impact, or
  `"none"` for an upper bound). Keepers call `update_price` every tick and size a buyback down to what the pool fills
  (at least 1% of its SOL): such a partial buyback leaves the step due for the rest of its run (`RunEvent.partial`; the
  rest must be the whole remainder or at least 1% of the pool's SOL) and earns its share of one tip.
  `sim.differential.test.ts` replays 400 seeded timelines through an independent chain model:
  the simulator never shows a run the program would refuse, and never leaves out a run a keeper could make.
- Keepers: `nodeStatuses(graph, state, env)` gives every node's status in one pass (`findDueNodes` uses it), decided
  by `planRun`. A buyback needs a price check (`update_price`, mirrored by `observePrice`) at least a minute old and
  at most 30 minutes old. With `env.poolFeeBps` (and `env.poolSol`) the status also says whether the swap can fill
  (`premiumBelowFee`, `swapShortfall`) and the amount to run with (`amount`: the largest that fills, at least
  `minAmount`, 1% of the pool's SOL; `cap` is what the step's run may still move, `partial` whether `amount` is less,
  audit round 4). Tips are at most a tenth of what a run moves; a burn's tokens are valued at `burnPrice` (none before
  graduation, then the lower of the reference and the lowest observed price). On chain, `fetchDueNodes` (from the
  package root) reads all of it, `AutopilotState.partialSpent` included.

## Templates

Rules: `fair-start`, `anti-bot`, `whale-cap`, `team-cant-buy` (`ruleTemplate(id, params)`, combine several with
`mergeRuleSets`). Autopilot: `daily-buyback-burn`, `burn-on-graduation`, `revenue-share`, `ai-buyback`
(`graphTemplate(id, params)`). Each numeric parameter has a `range { min, max, step }` for a slider (durations in
seconds, shares in bps, SOL, whole tokens, counts); every value in range builds something that compiles and verifies
(the other parameters at their defaults).

The rule templates fit real launches (`templates.test.ts` tries each with ordinary and bot-like buys on the
fair / community / turbo timings): pass the launch's `guardSecs` and `openDelaySecs` (its batch window). Rule times
count from the launch's open, but nobody can buy from the pool before the batch has run (at most 10 minutes after
the batch window), so a time window starts at the batch window's end and covers at least its length of open trading
(`tradingWindow`); a guard that ends before trading is sure to be open is refused. The anti-bot limit counts every
top-level instruction of the buy's transaction and is at least `MIN_TX_IX_COUNT_THRESHOLD` (10, also the default):
ordinary buys use 4 to 8 (`ORDINARY_BUY_MAX_INSTRUCTIONS`), and wallets add a few of their own (compute budget,
Lighthouse safety checks, Jito tips).

## Canvas

`graphToCanvas` / `canvasToGraph` convert between graphs and the editor model (nodes with `x`, `y`; an edge
`source -> target` is the AFTER trigger of `target`). `compileCanvas(canvas)` and `decompileCanvas(bytes, { ids,
positions })` go straight to and from PXG1 bytes (positions and names are not on-chain).
