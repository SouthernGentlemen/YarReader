# YarReader

YarReader is a local, crash-recoverable ingestion pipeline for comics and other
page-oriented publications. It turns an unstructured inbox into a verified,
content-addressed archive and a portable static reader that works directly from
local storage.

This is a greenfield implementation. It has one TypeScript package, one `yar`
CLI, one path authority, and one catalog. It does not import or depend on any
legacy YarReader code or runtime state.

## Requirements

- Node.js 22.12 or newer
- `pdfinfo` and `pdftoppm` for PDF inputs
- Enough free space for normalized WebP pages and staged export generations

RAR/CBR extraction is provided by the bundled WebAssembly implementation in
`node-unrar-js`. ZIP, CBZ, EPUB, loose images, individual images, and PDF are
supported by explicit adapters.

## Install and run

```sh
npm install
npm test
npm run build
npm link
yar paths
```

The default runtime workspace is `~/Documents/media`. Override it per command
with `--workspace` or set `YAR_WORKSPACE`:

```sh
yar --workspace /path/to/isolated/media init
yar --workspace /path/to/isolated/media update --stable-seconds 0
```

Runtime data is never stored in the repository:

```text
media/
  source/                 drainable inbox
  archive/                content-addressed originals
  state/catalog.json      authoritative catalog and transaction journal
  work/                   reproducible extraction and normalized pages
  export/library-001      atomic symlink to the active static generation
```

## Pipeline

The normal operational command is:

```sh
yar update
```

It performs stable discovery, inspection, classification, normalization,
archive transactions, staged export, validation, and atomic activation. The
stages can also be run separately:

```sh
yar paths
yar init
yar scan
yar classify
yar review
yar normalize
yar archive
yar export
yar portable /path/to/usb/YarReader
yar validate
yar build
yar update
yar rebaseline
yar migrate
yar audit-legacy
```

`scan` ignores `.part`, `.crdownload`, `.download`, `.!qB`, `.partial`, and
temporary names. By default a candidate must be observed unchanged for ten
seconds. Unsupported, corrupt, changing, ambiguous, rejected, and failed inputs
remain in `source/`.

Classification uses this precedence:

1. Embedded ComicInfo, EPUB, and PDF metadata
2. Archive structure and contained filenames
3. Original filename and inbox-relative provenance
4. Existing catalog candidates
5. Content/page evidence exposed to classifier implementations
6. Schema-validated AI proposals
7. Human review

Collection manifests are also first-class inputs. A root `manifest.json` can
split one archive or loose directory into independently identified chapters;
root cover art is not counted as a chapter page. Standard, fractional, and
special/prologue sequences retain a stable canonical order.

View pending proposals with `yar review`. Human actions are explicit:

```sh
yar review --accept '<source-sha256>:<unit-key>'
yar review --reject '<source-sha256>:<unit-key>'
yar review --correct '{"selector":"<source-sha256>:root","proposal":{...}}'
yar review --retype '{"seriesSlug":"example","fromUnitType":"chapter","unitType":"issue"}'
yar review --select-release '{"unitId":"series/issue-0001","sourceId":"<sha256>","unitKey":"root"}'
```

Complete proposals are schema validated. AI decisions are persisted under the
full source SHA-256 and logical-unit key, so unchanged inputs are never sent for
the same decision twice. The TypeScript `AiClassifier` interface can be backed
by any local or remote model without coupling the catalog to that service.

## Acquisition

All acquisition adapters finish in `source/`; none may write into archive,
normalized work, or export:

```sh
yar acquire file /path/to/completed.cbz
yar acquire browser /path/to/completed-browser-download.cbz
yar acquire http https://example.test/book.cbz --name book.cbz
yar acquire pages /path/to/pages-manifest.json
```

A page manifest is JSON:

```json
{
  "name": "Example Chapter 12",
  "series": "Example",
  "number": 12,
  "pages": [
    { "url": "https://example.test/001.jpg", "sha256": "optional-full-sha256" },
    { "path": "./002.jpg" }
  ]
}
```

Page collectors stage under `work/acquire/<job>/`, verify each image, create a
durable CBZ, reopen it, and only then activate it in `source/`. Durable job
manifests live in the catalog under `state/`.

## Archive and recovery

Every source occurrence has full SHA-256 identity. Identical bytes at different
physical paths remain separate occurrence records and converge on the same
source record. Multiple logical units per source and alternate releases per
logical unit are first-class.

Archive locations are collision-safe:

```text
archive/<series-slug>/<full-source-sha256>/<original-filename>
archive/_bundles/<full-source-sha256>/<original-directory>.cbz
archive/_unresolved/<full-source-sha256>/<original-filename>
```

An archive transaction is durably recorded as `prepared` before filesystem
mutation. Same-filesystem handoffs use rename. `EXDEV` performs copy, file
sync, full-hash verification, atomic rename, and only then inbox removal. Every
interruption boundary is idempotently resumed. Loose directories become
deterministic stored CBZs that preserve every relative filename and metadata
file without recompressing image payloads.

## Portable export

Exports are built into a sibling staging directory. YarReader hashes and
validates every staged file, syncs it, renames it to an immutable generation,
then atomically replaces the internal `library-001` symlink. A failed stage or
activation leaves the previous export active.

The generated reader is intentionally HTML-first. Library navigation and every
reader page image are emitted as ordinary relative `<a>` and `<img>` markup at
build time. Critical CSS is inline. The exported reader does not require
JavaScript, fetch, a server, a network connection, a database, a package
runtime, browser persistence, or absolute machine paths.

The internal `export/library-001` symlink is for crash-safe generation switching
on the workstation and should not be copied to removable media. Materialize a
real directory for a USB drive or tablet instead:

```sh
yar portable /Volumes/YARR/YarReader
```

The destination must not already exist. YarReader copies the active immutable
generation into a normal directory, validates the copied manifest and hashes,
and leaves the result self-contained. The intended removable-media layout is:

```text
YarReader/
  index.html
  manifest.json
  library/
    <series>/
      <unit>/
        index.html
        pages/
          000001.webp
          000002.webp
          ...
```

Open `index.html` from the removable drive. Browsers and mobile file managers
that allow normal sibling-file traversal can read the library without running
JavaScript. Some Android file-provider/browser combinations expose a selected
HTML document through an isolated `content://` URI and deny access to sibling
files; that is an Android document-provider restriction, not something an HTML
file can mark as trusted. In that environment the same materialized directory
should be opened through an app/WebView that has user-granted directory-tree
access rather than by weakening WebView file security.

Deleting `work/` and `export/` is safe. Run `yar build`; normalized pages are
recreated from `archive/` and `state/catalog.json`, then a fresh export is
activated.

## Read-only rebaseline audit

Inventory legacy originals without copying or modifying them:

```sh
yar rebaseline \
  --input /path/to/legacy-sources /path/to/legacy-loose-pages \
  --legacy-catalog /path/to/legacy/catalog.json \
  --output /tmp/yarreader-rebaseline.json
```

The report contains path, provenance, byte size, SHA-256, format, logical-unit
and page counts, duplicate identity, proposed inbox destination, old-catalog
differences, and cleanup candidates. Cleanup candidates are advisory only;
YarReader never deletes legacy originals.

## Recoverable migration

After reviewing a rebaseline report, copy stable legacy originals into the new
inbox without changing the legacy tree:

```sh
yar migrate \
  --legacy-catalog /path/to/legacy/catalog.json \
  --normalized-root /path/to/legacy/normalized \
  --original-root /path/to/legacy-originals /path/to/newly-downloaded-originals \
  --execute
```

Migration backs up the legacy catalog under `state/rebaseline-backup/`, records
the operation under `state/migration-records/`, copies byte-identical originals,
and losslessly bundles loose original directories. When an old catalog points
to an already-missing original but a verified normalized page set survives,
YarReader creates an explicitly labeled recovery CBZ instead of pretending it
is the original. Nothing in the legacy tree is deleted or rewritten.

After the greenfield catalog is classified and normalized, `yar audit-legacy`
produces a per-unit comparison of logical identity, page count, and every old
curated metadata field. Matching is explicit (`seriesSlug + sequence`), and
unmatched, ambiguous, and greenfield-only units remain visible in the report.

```sh
yar audit-legacy \
  --legacy-catalog /path/to/legacy/catalog.json \
  --output /path/to/state/migration-records/legacy-comparison.json
```

## Verification

`npm test` compiles the application and runs isolated temporary-workspace tests
covering path and symlink safety, stable recursive discovery, duplicate and
multi-unit identity, deterministic and mock-AI classification, human review,
normalization, archive preparation/recovery/EXDEV, loose bundles, atomic export
recovery, static no-JavaScript portable HTML, materialized removable-media
exports, all acquisition families, and rebuild from archive plus state.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the state model and invariants.
