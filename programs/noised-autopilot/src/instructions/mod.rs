//! One module per instruction: its accounts and constraints in Anchor's
//! order (each check with an `[A]` comment naming the constraint of the
//! Anchor build, kept verbatim in `anchor/instructions/`), then the handler
//! and the exit.

pub mod bind_mint;
pub mod bind_pool;
pub mod governance;
pub mod init_autopilot;
pub mod publish_graph;
pub mod run;
pub mod update_price;
