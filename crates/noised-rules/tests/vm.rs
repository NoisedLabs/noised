//! The condition VM through both contexts: truth tables, operand order,
//! stack limits and per-context leaf sets.

mod common;

use common::*;
use noised_rules::graph::{action, trigger};
use noised_rules::vm::{MAX_STACK, NODE_LEN};
use noised_rules::{op, Error, Graph, Node, RuleSet};

/// Evaluate `cond` as a rules condition (no keys) on the default transfer.
fn rules_value(cond: &[Node]) -> Result<bool, Error> {
    let bytes = enc(&rules_prog(&[], &[deny(0, 10, 1, cond)]));
    let set = RuleSet::verify(&bytes, GUARD)?;
    Ok(set.condition(0, &ctx()).expect("verified"))
}

/// Evaluate `cond` as a graph condition.
fn graph_value(cond: &[Node]) -> Result<bool, Error> {
    let bytes = genc(&graph_prog(
        None,
        &[],
        &[(gnode(trigger::WHEN, 0, action::BURN, 1, 0), cond.to_vec())],
    ));
    let g = Graph::verify(&bytes)?;
    Ok(g.condition(0, &gctx()).expect("verified"))
}

fn both(cond: &[Node]) -> Result<bool, Error> {
    let r = rules_value(cond);
    assert_eq!(r, graph_value(cond), "{cond:?}");
    r
}

#[test]
fn constants_and_truth_tables() {
    assert_eq!(NODE_LEN, 10);
    assert_eq!(MAX_STACK, 16);
    assert_eq!(
        (op::TRUE, op::FALSE, op::AND, op::OR, op::NOT),
        (0, 1, 2, 3, 4)
    );
    assert_eq!(both(&[T]), Ok(true));
    assert_eq!(both(&[F]), Ok(false));
    for (x, y) in [(T, T), (T, F), (F, T), (F, F)] {
        let (bx, by) = (x == T, y == T);
        assert_eq!(both(&[x, y, AND]), Ok(bx && by));
        assert_eq!(both(&[x, y, OR]), Ok(bx || by));
        assert_eq!(both(&[x, NOT]), Ok(!bx));
    }
    assert_eq!(both(&[T, NOT, NOT]), Ok(true));
}

#[test]
fn not_applies_to_the_top_value() {
    assert_eq!(both(&[T, F, NOT, AND]), Ok(true));
    assert_eq!(both(&[T, NOT, F, OR]), Ok(false));
    assert_eq!(both(&[F, T, NOT, OR]), Ok(false));
    // (T AND F) OR (NOT F) = T; T AND (F OR NOT F) = T; NOT(T AND (F OR F)) = T.
    assert_eq!(both(&[T, F, AND, F, NOT, OR]), Ok(true));
    assert_eq!(both(&[T, F, F, OR, AND, NOT]), Ok(true));
    // Combinators pop the two topmost values only.
    assert_eq!(both(&[F, T, T, AND, AND]), Ok(false));
    assert_eq!(both(&[T, F, F, OR, OR]), Ok(true));
    assert_eq!(both(&[F, T, F, AND, OR]), Ok(false));
}

#[test]
fn stack_depth_limits() {
    let deep = |n: usize| [vec![T; n], vec![AND; n - 1]].concat();
    assert_eq!(both(&deep(16)), Ok(true));
    assert_eq!(both(&deep(17)), Err(Error::StackOverflow));
    // A false value at the bottom of a full stack survives to the end.
    let mut c = deep(16);
    c[0] = F;
    assert_eq!(both(&c), Ok(false));
    // Depth goes back down, so long shallow chains are fine.
    let mut long = vec![F];
    for _ in 0..30 {
        long.extend([T, AND]);
    }
    assert_eq!(both(&long), Ok(false));
    assert_eq!(both(&[T, AND]), Err(Error::StackUnderflow));
    assert_eq!(both(&[NOT]), Err(Error::StackUnderflow));
    assert_eq!(both(&[T, T]), Err(Error::LeftoverValues));
    assert_eq!(both(&[T, T, T, AND]), Err(Error::LeftoverValues));
}

#[test]
fn leaves_belong_to_one_context() {
    for o in 0x10..=0x19u8 {
        let n = Node::new(o, 0, 0);
        if (0x16..=0x18).contains(&o) {
            continue; // key masks need keys; covered in the rules tests
        }
        assert!(rules_value(&[n]).is_ok(), "{o:#x}");
        assert_eq!(graph_value(&[n]), Err(Error::UnknownOp), "{o:#x}");
    }
    for o in 0x20..=0x27u8 {
        let n = Node::new(o, 0, 0);
        assert!(graph_value(&[n]).is_ok(), "{o:#x}");
        assert_eq!(rules_value(&[n]), Err(Error::UnknownOp), "{o:#x}");
    }
    for o in (0x05..=0x0F).chain(0x1A..=0x1F).chain(0x28..=0xFF) {
        let n = Node::new(o, 0, 0);
        assert_eq!(rules_value(&[n]), Err(Error::UnknownOp), "{o:#x}");
        assert_eq!(graph_value(&[n]), Err(Error::UnknownOp), "{o:#x}");
    }
}

#[test]
fn combinators_take_no_operands() {
    for o in [op::TRUE, op::FALSE] {
        assert_eq!(both(&[Node::new(o, 0, 1)]), Err(Error::NonZeroOperand));
        assert_eq!(both(&[Node::new(o, 1, 0)]), Err(Error::NonZeroOperand));
    }
    for o in [op::AND, op::OR] {
        assert_eq!(
            both(&[T, T, Node::new(o, 0, 1 << 63)]),
            Err(Error::NonZeroOperand)
        );
        assert_eq!(
            both(&[T, T, Node::new(o, 0x80, 0)]),
            Err(Error::NonZeroOperand)
        );
    }
    assert_eq!(
        both(&[T, Node::new(op::NOT, 0, 1)]),
        Err(Error::NonZeroOperand)
    );
}

/// Random conditions: the VM agrees with a reference `Vec<bool>` stack
/// machine, in both contexts.
#[test]
fn random_conditions_match_the_reference() {
    let mut rng = Rng::new(7);
    for _ in 0..20_000 {
        let len = 1 + rng.below(64) as usize;
        let cond = gen_cond(&mut rng, len, &mut |r| if r.coin() { T } else { F });
        let expected = ref_eval(&cond, &|_| None).expect("constants only");
        assert_eq!(rules_value(&cond), Ok(expected), "{cond:?}");
        if cond.len() <= 96 {
            assert_eq!(graph_value(&cond), Ok(expected), "{cond:?}");
        }
    }
}
