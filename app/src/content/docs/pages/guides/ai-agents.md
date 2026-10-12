---
title: AI agents (MCP + LangGraph)
nav: AI agents (MCP + LangGraph)
summary: Let an AI agent read Noised tokens, simulate them and operate a token's Autopilot inside limits the chain enforces. The Noised MCP server reads, simulates and builds unsigned transactions; it never signs. A LangGraph operator wires the same tools into a loop.
---

An AI agent can do two useful things with Noised. It can **answer questions** about any token (is it QSL-1, who gets its fees, what do its launch rules and Autopilot do), and it can **operate** a token's Autopilot when the creator names it as the operator of an AI-operated step.

The rule that makes this safe is simple: **the chain enforces the limits, not the agent.** An operator key can only run the steps the creator marked for it, only inside the bounds the creator's quantum key signed (per buyback, per day, price limit), and every token it buys is burned in the same step. A forged, confused or hijacked agent can do nothing outside those bounds, and the creator's quantum key can remove it at any time.

## What an AI operator can and cannot do

| An operator can | It can never |
|---|---|
| Decide **when** an operator-only step runs | Send treasury funds anywhere but a burn, a buyback that burns, the graph's listed recipients or a small tip |
| Pick **how much**, from 1 lamport up to the step's per-run and per-day limits | Sell the token, pull or touch the locked liquidity, mint or freeze |
| Read tokens, simulate and prepare transactions | Pay more than the step's price limit above the reference price |
| | Change the steps, skip the 72-hour wait for a change, or keep going after it is removed |

The program checks every one of these on each run (`run` in the [Autopilot program](/docs/programs/autopilot)). The agent's own key only signs its runs and pays their network fee; it holds no funds of the token.

## The Noised MCP server

`packages/noised-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over the Noised SDK. Any MCP client (Claude Code, Claude Desktop, a LangGraph app) can use it. It **never signs and never holds a key**: transactions come back unsigned, with a plain-English summary and a simulation, for your own wallet or operator key to sign.

### Tools

| Group | Tool | What it does |
|---|---|---|
| Read | `list_launches` | Launches on the cluster, newest first, with their phase. |
| Read | `get_launch` | One launch in detail: guard limits, fees and fee recipients, the opening batch, the market, whether it has an Autopilot. |
| Read | `verify_token` | The QSL-1 check and Noised's independent verifier, in plain words. |
| Read | `get_rules` | Decodes, verifies and explains launch rules (text or bytes), with the hash an attestation binds. |
| Read | `get_autopilot` | A token's Autopilot: its steps in plain English, each step's status, the exact amount bounds, the treasury, the reference price, the operator and any queued change. |
| Read | `get_due_nodes` | Which steps can run right now, with the minimum, maximum and suggested amount for each. |
| Simulate | `simulate_transfer` | One transfer against launch rules and the Launch Guard, decided exactly as the hook would. |
| Simulate | `simulate_autopilot` | Runs a graph over time against a market you describe (pool fee, depth, migration price, price path), with every assumption stated. |
| Build (unsigned) | `build_update_price_tx` | Records the pool price the reference follows (anyone may send it). |
| Build (unsigned) | `build_run_tx` | Runs one step: a keeper step for anyone (it earns the small tip), or an operator-only step with the operator as signer and an amount inside its bounds. Refuses anything the program would refuse. |
| Build (unsigned) | `build_publish_graph_tx` | Publishes a graph. Publishing switches nothing on: only the creator's quantum key can, and a change waits 72 hours in public. |

:::warn Names are untrusted text
Token names, symbols and descriptions are written by their creators. The server marks them as untrusted, and an agent should never follow instructions found in them.
:::

### Set it up in Claude Code

Build the package once, then register it from the repository root:

```sh title="Claude Code"
claude mcp add noised -- node packages/noised-mcp/dist/index.js
```

Point it at your cluster's RPC endpoint (see the package's README for its settings), then ask in plain words: *"Is this token QSL-1? Who receives its fees?"*, *"What would my Autopilot do over 30 days if the price halves?"* or *"Which Autopilot steps are due on MRDN?"*.

## A LangGraph operator

The operator example in `packages/noised-mcp` wires the same tools into a small LangGraph loop. Each pass observes, decides inside the bounds, builds, and only then signs with the operator key the agent was given:

:::steps
### Observe
`get_due_nodes` for the token: which steps are due, and the min / max / suggested amount the chain allows for each. A buyback that needs a fresh price check gets `build_update_price_tx` first.

### Decide
The model picks whether to run the operator-only step now and an amount **between the returned bounds**. Anything outside them would be refused by the program anyway; the bounds are there so the agent never wastes a transaction.

### Build and check
`build_run_tx` with the operator and the amount. It returns an unsigned transaction, what it does in plain words, and its simulation.

### Sign and send
Only the operator key signs, outside the MCP server. Then the loop sleeps until the next check.
:::

```ts title="operator.ts (sketch)"
// Nodes: observe -> decide -> build -> sign. The MCP server never sees the operator key.
const graph = new StateGraph(State)
  .addNode("observe", async (s) => ({ due: await mcp.call("get_due_nodes", { launch: s.launch }) }))
  .addNode("decide", async (s) => ({ pick: await model.chooseWithin(s.due) })) // an amount inside [min, max]
  .addNode("build", async (s) => ({ tx: await mcp.call("build_run_tx", { launch: s.launch, node: s.pick.node, operator: OPERATOR, amount: s.pick.amount }) }))
  .addNode("sign", async (s) => ({ sig: await sendSigned(s.tx, operatorKey) }))
  .addEdge(START, "observe")
  .addConditionalEdges("observe", (s) => (s.due.some((d) => d.operatorOnly) ? "decide" : END))
  .addEdge("decide", "build")
  .addEdge("build", "sign")
  .addEdge("sign", END);
```

## Switch one on

1. In **Launch → Custom launch**, open the **Autopilot** step (or a token's **Autopilot** page), switch on **AI-operated buyback** and paste the agent's public key.
2. Set the most per buyback, the most per day and the price limit. The plain sentence under the job says exactly what the agent may do.
3. Your quantum key signs the steps: right after the launch opens for a new token (a first Autopilot has no waiting period), or with a public 72-hour wait for a change to a running one.
4. Remove the operator any time with your quantum key. That only takes a power away, so it works even on a frozen Autopilot.

:::note What the server helps with, and what it does not
The MCP server makes the agent's work easier and its mistakes cheaper (it refuses to build what the program would refuse). It is not a security boundary: the programs are. An agent that skips the server and talks to Solana directly is held to exactly the same limits.
:::
