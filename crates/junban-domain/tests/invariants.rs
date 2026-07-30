//! Structural invariant coverage that does not require storage access.

use std::collections::BTreeSet;

use junban_domain::{
    TaskId, blocks_edge_creates_cycle, validate_parent_chain, validate_reorder_permutation,
    validate_unique_bulk_ids,
};
use proptest::prelude::*;

#[test]
fn parent_chain_detects_cycles_and_allows_trees() {
    let a = TaskId::new();
    let b = TaskId::new();
    let c = TaskId::new();
    let edges = vec![(b, a), (c, b)];
    assert!(validate_parent_chain(a, Some(c), &edges).is_err());
    assert!(validate_parent_chain(TaskId::new(), Some(c), &edges).is_ok());
    assert!(validate_parent_chain(a, Some(a), &[]).is_err());
}

#[test]
fn reorder_requires_complete_permutation() {
    let a = TaskId::new();
    let b = TaskId::new();
    let c = TaskId::new();
    assert!(validate_reorder_permutation(&[a, b, c], &[c, a, b]).is_ok());
    assert!(validate_reorder_permutation(&[a, b, c], &[a, b]).is_err());
    assert!(validate_reorder_permutation(&[a, b, c], &[a, b, b]).is_err());
    assert!(validate_reorder_permutation(&[a, b, c], &[a, b, TaskId::new()]).is_err());
}

#[test]
fn blocks_cycle_detection() {
    let a = TaskId::new();
    let b = TaskId::new();
    let c = TaskId::new();
    let edges = vec![(a, b), (b, c)];
    assert!(blocks_edge_creates_cycle(&edges, c, a));
    assert!(!blocks_edge_creates_cycle(&edges, a, c));
    assert!(blocks_edge_creates_cycle(&edges, a, a));
}

proptest! {
    #[test]
    fn reorder_permutation_property(size in 0usize..40usize, seed in any::<u64>()) {
        let scope: Vec<TaskId> = (0..size).map(|_| TaskId::new()).collect();
        let mut ordered = scope.clone();
        // Deterministic shuffle from seed.
        if size > 1 {
            let mut state = seed;
            for i in (1..size).rev() {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1);
                let j = (state as usize) % (i + 1);
                ordered.swap(i, j);
            }
        }
        prop_assert!(validate_reorder_permutation(&scope, &ordered).is_ok());

        if size > 0 {
            let mut broken = ordered.clone();
            broken[0] = TaskId::new();
            prop_assert!(validate_reorder_permutation(&scope, &broken).is_err());
        }
        if size > 1 {
            let mut dup = ordered.clone();
            dup[1] = dup[0];
            prop_assert!(validate_reorder_permutation(&scope, &dup).is_err());
        }
    }

    #[test]
    fn blocks_cycle_property(chain_len in 1usize..20) {
        let nodes: Vec<TaskId> = (0..=chain_len).map(|_| TaskId::new()).collect();
        let edges: Vec<(TaskId, TaskId)> = nodes
            .windows(2)
            .map(|pair| (pair[0], pair[1]))
            .collect();
        // Closing the chain must cycle; extending forward must not.
        prop_assert!(blocks_edge_creates_cycle(
            &edges,
            nodes[chain_len],
            nodes[0]
        ));
        let extra = TaskId::new();
        prop_assert!(!blocks_edge_creates_cycle(
            &edges,
            nodes[chain_len],
            extra
        ));
    }

    #[test]
    fn unique_id_sets_reject_duplicates(size in 1usize..30) {
        let ids: Vec<TaskId> = (0..size).map(|_| TaskId::new()).collect();
        prop_assert!(validate_unique_bulk_ids(&ids).is_ok());
        let mut dup = ids.clone();
        dup.push(ids[0]);
        prop_assert!(validate_unique_bulk_ids(&dup).is_err());
        let unique: BTreeSet<_> = ids.iter().copied().map(TaskId::as_uuid).collect();
        prop_assert_eq!(unique.len(), size);
    }
}
