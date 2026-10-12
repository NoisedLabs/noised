//! Owned programs and their encoders (feature `alloc`), for clients, tools
//! and tests. Encoding writes the fields as given, valid or not (tests build
//! invalid programs with it); [`crate::RuleSet::verify`] and
//! [`crate::Graph::verify`] decide validity.

use alloc::vec::Vec;

use crate::graph::{self, GNode, Graph, Recipient};
use crate::rules::{self, Rule, RuleSet};
use crate::vm::Node;
use crate::Error;

/// A count does not fit its one-byte header field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CountOverflow;

impl core::fmt::Display for CountOverflow {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("a count does not fit in one byte")
    }
}

impl core::error::Error for CountOverflow {}

fn count(n: usize) -> Result<u8, CountOverflow> {
    u8::try_from(n).map_err(|_| CountOverflow)
}

/// A PXR1 rule set.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct RulesProgram {
    /// Keys the masks refer to.
    pub keys: Vec<[u8; 32]>,
    /// Rules in evaluation order.
    pub rules: Vec<Rule>,
    /// Condition nodes.
    pub nodes: Vec<Node>,
}

impl RulesProgram {
    /// The PXR1 bytes (version 1, reserved zero).
    pub fn encode(&self) -> Result<Vec<u8>, CountOverflow> {
        let (n_keys, n_rules, n_nodes) = (
            count(self.keys.len())?,
            count(self.rules.len())?,
            count(self.nodes.len())?,
        );
        let mut out = Vec::with_capacity(rules::encoded_len(n_keys, n_rules, n_nodes));
        out.extend_from_slice(&rules::MAGIC);
        out.extend_from_slice(&[rules::VERSION, n_keys, n_rules, n_nodes, 0, 0, 0, 0]);
        for key in &self.keys {
            out.extend_from_slice(key);
        }
        for rule in &self.rules {
            out.extend_from_slice(&rule.to_bytes());
        }
        for node in &self.nodes {
            out.extend_from_slice(&node.to_bytes());
        }
        Ok(out)
    }

    /// Decode bytes that pass [`RuleSet::parse`] (layout only).
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        RuleSet::parse(bytes).map(|set| Self::from_set(&set))
    }

    /// Copy a rule set.
    pub fn from_set(set: &RuleSet<'_>) -> Self {
        Self {
            keys: set.keys().to_vec(),
            rules: (0..set.rule_count()).filter_map(|i| set.rule(i)).collect(),
            nodes: (0..set.node_count()).filter_map(|i| set.node(i)).collect(),
        }
    }
}

/// A PXG1 graph.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct GraphProgram {
    /// Flags ([`graph::FLAG_HAS_OPERATOR`]).
    pub flags: u8,
    /// Operator key (zero if none).
    pub operator: [u8; 32],
    /// DISTRIBUTE_SOL payees.
    pub recipients: Vec<Recipient>,
    /// Graph nodes.
    pub nodes: Vec<GNode>,
    /// Condition nodes.
    pub cond: Vec<Node>,
}

impl GraphProgram {
    /// The PXG1 bytes (version 1, reserved zero).
    pub fn encode(&self) -> Result<Vec<u8>, CountOverflow> {
        let (n_recipients, n_nodes, n_cond) = (
            count(self.recipients.len())?,
            count(self.nodes.len())?,
            count(self.cond.len())?,
        );
        let mut out = Vec::with_capacity(graph::encoded_len(n_recipients, n_nodes, n_cond));
        out.extend_from_slice(&graph::MAGIC);
        out.extend_from_slice(&[
            graph::VERSION,
            n_recipients,
            n_nodes,
            n_cond,
            self.flags,
            0,
            0,
            0,
        ]);
        out.extend_from_slice(&self.operator);
        for r in &self.recipients {
            out.extend_from_slice(&r.to_bytes());
        }
        for node in &self.nodes {
            out.extend_from_slice(&node.to_bytes());
        }
        for node in &self.cond {
            out.extend_from_slice(&node.to_bytes());
        }
        Ok(out)
    }

    /// Decode bytes that pass [`Graph::parse`] (layout only).
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let g = Graph::parse(bytes)?;
        Ok(Self {
            flags: g.flags(),
            operator: *g.operator_field(),
            recipients: (0..g.recipient_count())
                .filter_map(|i| g.recipient(i))
                .collect(),
            nodes: (0..g.node_count()).filter_map(|i| g.node(i)).collect(),
            cond: (0..g.cond_count()).filter_map(|i| g.cond_node(i)).collect(),
        })
    }
}
