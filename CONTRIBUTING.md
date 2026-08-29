# Contributing

## Change flow

```text
requirement → permanent YR ID → branch → implementation → pull request → CI
            → review → merge → release
```

Use a branch such as `yr/YR-038-short-slug` and a commit or pull-request title
such as `[YR-038] [FIX] Correct archive recovery state`.

Every controlled change body records `Change`, `Reason`, `Impact`, `Risk`,
`Controls`, `Validation`, `Evidence`, `Source`, and `Release`. Include
`Rollback` for persistence, migration, archive, activation, schema, or other
high-risk changes. A corrective change identifies the earlier change in its
notes or a `Corrects:` trailer.

Before opening a pull request, run:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Do not commit runtime media, catalogs, generated work or exports, downloaded
covers, credentials, private URLs, or a real series-curation inventory.
Published release tags are immutable. Reverts and corrections move forward
under new YR IDs.
