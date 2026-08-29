# Release management

YarReader releases are annotated semantic-version tags. A tag identifies a
complete buildable and testable product state; tags are not moved or deleted.

Before tagging a release:

1. Install exactly from the lockfile with `npm ci`.
2. Run `npm run typecheck`, `npm test`, and `npm run build`.
3. Run the repository safety and history-control checks.
4. Confirm the release notes and provenance map.
5. Create and push the annotated tag only after `main` is protected and green.

The v0.x tags document reconstructed architectural milestones. v1.0.0 is the
current verified public baseline. Source dates remain provenance metadata and
are not used to backdate reconstructed commits or releases.
