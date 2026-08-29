# Baseline verification

## Milestone correspondence

| Public milestone | Source evidence | Verification |
| --- | --- | --- |
| v0.6.0 | `08e2250` greenfield baseline | Same application modules and 39-test behavior, decomposed in dependency order |
| v0.7.0 | `3cd292c` portable correction | HTML-first reader and real-directory materialization retained as a visible forward fix; 40 tests |
| v0.8.0 | `3661f4e` curated viewer | Viewer, cover, thumbnail, catalog, and 45-test behavior retained; private title inventory transformed into workspace configuration |
| v1.0.0 | Current verified public baseline | v0.8 behavior plus public documentation, CI, release controls, provenance, and safety gates |
| v1.0.1 | Public governance correction | Removes automated version-update PRs that cannot carry assigned YR IDs; repository security alerts remain enabled |

## Preserved guarantees

- Stable discovery never activates partial input.
- Classification ambiguity remains explicit and AI proposals remain schema validated.
- Normalization is derived and verified; `work/` is not authority.
- Archive mutation follows a prepared transaction and supports EXDEV recovery.
- Failed export activation never replaces the last valid generation.
- A real portable directory can be materialized from the active generation.
- Root navigation and every page remain represented in static HTML without JavaScript.
- Progressive viewer assets are local and contain no network dependency.
- Actual media, runtime state, and private curation never enter public history.

Source and public tests use generated synthetic publications in isolated
temporary workspaces. No result in this record was inferred from a real user
library.
