# Rule packs

There is one pack per jurisdiction and obligation, for example `de/packaging_epr.yaml` and
`eu/gpsr.yaml`. The format is in [`docs/rulebook-format.md`](../docs/rulebook-format.md).

| State | Meaning |
|---|---|
| `draft` | Written by a research agent from official sources, not yet independently checked |
| `verified` | An independent agent re-read every citation and the quotes matched |
| `approved` | Signed off by a named legal reviewer; may drive filings |

Commands:

```bash
pnpm lint:rules
```

```bash
pnpm --filter @oneseat/rulebook cli -- citations ../../rules
```

Audits may use draft and verified packs, and the report says so. Filings use approved packs only.
