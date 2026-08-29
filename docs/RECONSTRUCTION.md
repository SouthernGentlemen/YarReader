# Historical reconstruction

## Declaration

This public repository history is reconstructed from the existing YarReader repository and its
three source commits. Historical implementation is decomposed into reviewable controlled changes
in dependency order.

**The reconstructed commit structure does not assert that each public commit originally existed
as an independent Git commit.**

The source implementation, source dates, tests, and final trees remain the evidence. Original
source SHAs and dates are recorded in `docs/history/CHANGE-MAP.csv` rather than being fabricated as
the author dates of commits created during reconstruction.

## Mapping types

| Type | Meaning |
| --- | --- |
| `direct` | One source concern maps to one public controlled change. |
| `decomposed` | One oversized source commit contributes to several dependency-ordered public changes. |
| `consolidated` | Several source concerns are inseparable in one coherent public change. |
| `privacy-transformed` | Architecture is preserved while private runtime/library data is excluded from all public objects. |

## Method

Oversized source commits are split along the module dependency graph. A test arrives with the
earliest change that contains every dependency the test exercises. Every intermediate tree is
type-checked and built; tests are run when a test suite exists. Release boundaries are derived from
verified architectural milestones, not from invented historical release events.

The reconstruction contains application source and synthetic fixtures only. Runtime catalogs,
media, generated work/exports, acquired covers, credentials, absolute personal paths, device
identifiers, and the private source-library inventory are intentionally excluded.
