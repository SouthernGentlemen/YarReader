# Canonical publication record

## Source-history recovery

Before canonical cutover, the original repository was preserved as a complete
Git bundle outside the public repository.

- Source head: `3661f4e86165ef8311c4733582b49e1324637eef`
- Bundle SHA-256: `2c6c59f5e20619de60257d571124a34bcfdcdc651648ce0d9a641ad3154556ec`
- Bundle verification: complete history with the original main and remote refs

The bundle location is intentionally not embedded in public history. The source
SHAs remain visible in the provenance map, while the private backup remains an
operator-controlled recovery artifact.

## Final-tree parity review

The 41 files tracked by source commit `3661f4e` were compared byte-for-byte with
the reconstructed baseline before cutover:

- 30 files are byte-identical.
- 10 files are intentionally transformed and reviewed.
- `AGENTS.md` is omitted because it was local session procedure, not product
  behavior.

The transformed files are documentation and package governance; explicit Node
type discovery; the workspace curation path; curation loading; cover sources;
synthetic curation tests; and the private title-inventory replacement. Runtime
modules outside that bounded set are byte-identical to the audited source.

## Cutover controls

Canonical replacement is permitted only after all of these checks pass:

1. Lockfile install, typecheck, 45 tests, and build.
2. Sequential controlled-history validation.
3. Every-revision public-safety scan.
4. Tag-object and release-note verification.
5. Exact lease against source head `3661f4e` for the first main update.
6. Public visibility, repository metadata, security reporting, and protected
   main branch verification.
7. Canonical-source link verification from the lean WizardGang case study.

The operational completion evidence is reported from GitHub after these
controls are applied; this document does not pre-claim remote actions.
