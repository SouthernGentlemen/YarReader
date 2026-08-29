# Change management

YarReader uses permanent `YR-###` identifiers and controlled commit titles:

```text
[YR-038] [TYPE] Imperative title
```

Allowed primary types are `INIT`, `FEAT`, `FIX`, `TEST`, `DOCS`, `BUILD`,
`CI`, `SEC`, `PERF`, `REFACTOR`, and `CHORE`. One change has one primary type.

Each commit body records the change, reason, impact boundary, Low/Medium/High
risk, controls, validation actually performed, exact evidence, source
provenance, and target release. High-risk persistence and filesystem changes
also state rollback. A failed validation is never represented as successful.

The reconstruction map in `docs/history/CHANGE-MAP.csv` connects each controlled
change to the audited source commit. New work after v1.0.0 uses `direct` mapping
to its own pull request and design evidence rather than historical provenance.
