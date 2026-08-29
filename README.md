# YarReader

YarReader is a local ingestion pipeline and portable static reader for comics and other page-oriented publications. It converts mixed source files into a content-addressed archive and verified offline library.

**[Architecture](ARCHITECTURE.md)** · **[Release management](docs/RELEASE-MANAGEMENT.md)**

## Run locally

```bash
npm ci
npm run build
npm link
yar paths
```

The default workspace is `~/Documents/media`. Override it with `--workspace` or `YAR_WORKSPACE`:

```bash
yar --workspace /path/to/media init
yar --workspace /path/to/media update --stable-seconds 0
```

## Verify

```bash
npm run typecheck
npm test
```

## Structure

- `src/` contains the CLI, adapters, catalog, archive, and export pipeline.
- `src/viewer/` contains the static reader source.
- `src/domain.ts` contains the validated data contracts.
- `test/` contains pipeline, recovery, and reader tests.
- `scripts/` contains build and repository checks.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Change management](docs/CHANGE-MANAGEMENT.md)
- [Release management](docs/RELEASE-MANAGEMENT.md)
- [Engineering record](docs/RECONSTRUCTION.md)

## Deployment

YarReader does not deploy a server. `yar update` activates a verified static library generation, and `yar portable /path/to/destination` copies it into a self-contained directory for offline use.
