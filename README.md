# YarReader

YarReader is a local publication-ingestion pipeline and portable static reader.

This repository history is being reconstructed from the existing YarReader implementation into
reviewable, dependency-ordered controlled changes. The reconstructed commit structure does not
assert that each public commit originally existed independently. Source commits and dates are kept
in `docs/history/CHANGE-MAP.csv`; the method is documented in `docs/RECONSTRUCTION.md`.

At this foundation change the TypeScript package and `yar` command build, but the ingestion
pipeline has not yet been introduced.

```bash
npm ci
npm run typecheck
npm run build
```

MIT — see `LICENSE`.
