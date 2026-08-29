# Audited source history

The reconstruction was derived from three commits in the original YarReader
repository. Dates below are source provenance, not reconstructed commit dates.

| Source commit | Source date | Subject | Audited concern | Source tests |
| --- | --- | --- | --- | --- |
| `08e2250` | 2026-08-20 | Build greenfield YarReader | Foundation, workspace, schemas, adapters, discovery, classification, normalization, archive, export, acquisition, rebuild, rebaseline, migration, CLI, and tests | 39/39 |
| `3cd292c` | 2026-08-27 | Fix USB/tablet portable export (#1) | HTML-first fallback and real-directory portable materialization | 40/40 |
| `3661f4e` | 2026-08-27 | Add curated portable comic viewer | Series metadata, covers, compiled viewer, thumbnails, export integration, and tests | 45/45 |

The source history contained no tracked runtime catalog, media archive, export,
credential file, or secret. The final source commit did contain a hard-coded
personal series and cover-source inventory in `src/series-metadata.ts`. That
inventory and its title-specific fixtures were excluded from every public
object. The public implementation retains the behavior through a strict
workspace-owned curation schema and synthetic fixtures, recorded as
`privacy-transformed` in the change map.
