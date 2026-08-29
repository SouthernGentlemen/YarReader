# Architecture

## Product invariant

Complexity is confined to ingestion. The activated reader is a dumb,
self-contained directory that can be copied anywhere and opened with `file://`.

```text
acquire/manual drop
  -> stable scan
  -> adapter inspection
  -> deterministic / AI proposal
  -> review or acceptance
  -> normalize and verify every release
  -> prepared archive transaction
  -> verified archive commit
  -> staged static export
  -> full validation
  -> atomic generation activation
```

## Boundaries

- `src/paths.ts` is the only runtime path authority. It rejects repository
  overlap, overlapping runtime roots, escape paths, and symlinked roots.
- `src/domain.ts` defines every durable and external schema with Zod.
- `src/catalog.ts` is the only catalog persistence implementation. Writes use a
  sibling temporary file, file sync, rename, and directory sync.
- Adapter code never chooses durable identity. Classification never extracts
  pages. Export never interprets source formats.
- Tests use a fresh temporary workspace and never point at real media.

## Catalog model

`state/catalog.json` is a normalized document model designed to map directly to
future SQLite tables:

- `sources`: full-SHA-256 content identities, adapter inspections, logical-unit
  descriptors, and structured decisions
- `occurrences`: every physical inbox occurrence, original filename,
  inbox-relative provenance, and final archive location
- `units`: canonical logical identity, alternate releases, selected release,
  and release-specific normalization verification
- `scanCandidates`: unchanged-observation state for stable-input detection
- `aiDecisions`: source-hash and logical-unit keyed proposals
- `archiveTransactions`: prepared/completed two-phase filesystem transactions
- `exportBuilds`: generation membership, validation, and activation journal
- `acquisitions`: typed adapter manifests and verified inbox results
- `seriesMetadata`: derived or workspace-curated reading mode and genre facets

No field depends on a package path or an absolute repository path. Catalog
revision increments are monotonic. Every load and save validates the complete
schema.

Private curation is loaded from the workspace-owned
`state/series-curation.json`, never from a built-in title inventory. Its strict
schema supports reading modes, genres, optional cover-page URLs, and explicit
series merges. Missing curation is an empty safe default. Acquired cover images
and generated thumbnails are reproducible runtime state outside the repository.

## Source adapters

The adapter contract converges every format on:

```ts
interface Inspection {
  adapter: string;
  format: SourceFormat;
  metadata: EmbeddedMetadata;
  units: InspectionUnit[];
  warnings: string[];
}

interface InspectionUnit {
  key: string;
  label: string;
  entryNames: string[];
  pageCount: number;
  metadata: EmbeddedMetadata;
  warnings: string[];
}
```

ZIP-family formats use lazy central-directory reading and streamed entry
extraction. RAR/CBR uses WebAssembly extraction. PDF delegates rasterization to
`pdftoppm`, keeping native renderer state out of the application process. EPUB
container and OPF metadata are parsed before filename inference. Loose
directories are hashed from ordered relative names, sizes, and bytes.

A collection `manifest.json` may define multiple nested logical units in one
source. The manifest supplies explicit ordering and page membership, so a root
cover is not mistaken for a chapter page and special/prologue sequences remain
distinct from ordinary numbered chapters.

Archive path traversal, absolute entry names, backslashes, symbolic media
inputs, and changing hash snapshots are rejected.

## Identity and alternates

A source ID is the complete lowercase SHA-256, never a truncated fingerprint.
An occurrence ID hashes source ID plus normalized inbox-relative provenance.
One inspection may declare several logical units. Accepted proposals converge
on canonical IDs such as `series/issue-0004`; multiple distinct sources then
become releases of that logical unit. Exactly one release is selected for
export, while every accepted release must normalize and verify before its
source can archive.

## Normalization

Adapters extract into a disposable per-release build directory. `sharp`
auto-orients and converts each page to the versioned `reader-webp-v1` profile.
Every output records relative filename, full SHA-256, byte size, width, and
height. The build directory is renamed into place only after all pages verify.

Normalization records are reproducible cache descriptions, not authority. If a
file is absent or its size, hash, or dimensions differ, the release is rebuilt
from its archived source.

Release normalization is bounded to eight concurrent releases and eight Sharp
workers. Catalog checkpoints are durable after every completed release, so an
interruption only repeats verification or unfinished work.

## Legacy migration

Rebaseline is a read-only inventory and discrepancy report. Migration consumes
that evidence by copying stable originals into `source/`, preserving loose
originals in deterministic stored bundles, and creating clearly marked
recovery bundles only where the old original is already absent. The old
catalog and each migration record are retained under `state/`; migration never
uses a move or delete operation against a legacy path.

## Archive transaction

The durable sequence is:

1. Rehash the inbox source and verify the accepted complete unit set.
2. Reverify every normalized release page.
3. Persist a prepared transaction.
4. For a directory, build and reopen a deterministic stored CBZ.
5. Rename on the same filesystem; on `EXDEV`, copy to a transaction-named
   incoming file, sync, full-hash verify, and rename.
6. Reopen/hash the destination.
7. Remove only the corresponding inbox occurrence.
8. Persist archive location and completed status.

On restart, an incoming file, final destination, source, or any valid
combination is reconciled from the prepared transaction. The catalog never
claims a destination before filesystem verification.

## Export transaction

Each export has a monotonic generation. All reader files and selected pages are
written under `.library-001.staging-gNNNNNN`. A manifest contains complete file
membership and SHA-256 hashes. Validation rejects missing/unlisted files,
changed hashes, absolute machine paths, and network/runtime APIs.

Complete static links and page images are emitted before the bundled viewer is
added. The viewer progressively enhances those pages with library filtering and
multi-mode reading, but it cannot make the static fallback incomplete. Viewer
scripts and styles are compiled locally and contain no network dependency.

After validation, staging is renamed to immutable
`.library-001.gNNNNNN`. A relative temporary symlink is created and atomically
renamed over `library-001`. Prior generations are retained. A validated but
interrupted build is resumed before a new generation is attempted.

## Dependencies

- `commander`: the single CLI surface
- `zod`: schema validation at persistence, AI, acquisition, and report boundaries
- `yauzl` / `yazl`: streaming ZIP reads and deterministic ZIP writes
- `fast-xml-parser`: ComicInfo and EPUB metadata
- `sharp`: image validation and normalized WebP output
- `node-unrar-js`: RAR/CBR extraction
- TypeScript and Node type declarations as development-only dependencies

There are no nested packages, compatibility shims, servers, databases, Python
components, or runtime links to the legacy repository.
