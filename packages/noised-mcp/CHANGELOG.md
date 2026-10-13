# Changelog

All notable changes to `@noisedlabs/mcp`. Versions follow [Semantic Versioning](https://semver.org/); while the version is `0.x`, a minor release may change tools, inputs or outputs.

## Unreleased

- Autopilot price conditions follow the program as fixed by review F1 of the framework-free rewrite: a step's price condition must hold for the reference price and every price observed in the last 15 to 30 minutes (the SDK's `planRun` with `observed`), so `get_due_nodes`, `build_run_tx` and `simulate_autopilot` never show a run the program would refuse.
- Autopilot explanations (`get_autopilot`, `build_publish_graph_tx`) carry the SDK's updated price guarantee: the price must have stayed at or above (or at or below) the limit across the last 15 to 30 minutes, and someone willing to pay trading fees can delay a step that waits on the price, never trigger it (follow-up review L-1). The README's limits list says the same.

## 0.2.0 - 2026-10-13 (first public release)

First public release candidate.

- A local MCP server over stdio, built on `@noisedlabs/sdk` 0.9.0. Eleven tools: read launches (`list_launches`, `get_launch`), check a token against QSL-1 (`verify_token`), read and explain launch rules (`get_rules`) and autopilots (`get_autopilot`, `get_due_nodes`), simulate transfers and autopilots (`simulate_transfer`, `simulate_autopilot`), and build **unsigned** autopilot transactions inside the on-chain bounds (`build_update_price_tx`, `build_run_tx`, `build_publish_graph_tx`). See [README.md](README.md#tool-reference).
- It never signs and holds no keys: build tools return an unsigned transaction, a plain-English summary, its costs, the keys that must sign and the RPC's simulation.
- Text written by token creators or returned by the RPC is returned as marked untrusted data, filtered to visible characters and capped in length.
- It refuses an RPC endpoint whose genesis hash is not the configured cluster, and mainnet unless `NOISED_ALLOW_MAINNET=1`.
- `examples/langgraph-operator`: a LangGraph AI operator with human approval, and a keeper with no model (not part of the published package).
