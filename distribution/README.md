# Distribution channel inventory

[`channels.yaml`](channels.yaml) is the human-maintained inventory of every place users can
obtain LibreDB Studio - registries, package managers, PaaS catalogs, partner listings - with
each channel's business `category`, update policy, provenance links, and (where measurable)
where its pinned version lives.

Coverage matrix for users, developers and buyers (scorecard + full table): [`docs/CHANNELS.md`](../docs/CHANNELS.md)
(`bun run distribution:matrix` to regenerate; `--check` for freshness).

```bash
bun run distribution:check           # drift table for every live channel
bun run distribution:check --strict  # gates owned every_release pins only
bun run distribution:check --json    # machine-readable rows
bun run distribution:matrix          # refresh docs/CHANNELS.md scorecard + table
bun run distribution:matrix --check
```

The weekly [`distribution-check.yml`](../.github/workflows/distribution-check.yml) workflow
publishes the same table as its Job Summary. The checker only reads the inventory; version
bumps and channel edits are always human commits.

Canonical documentation - schema, tier and SLA definitions, strict-mode semantics, how to add
a channel, `last_bump_pr` maintenance - lives in
[docs/DISTRIBUTION.md, "Channel inventory and drift check"](../docs/DISTRIBUTION.md#channel-inventory-and-drift-check).
Keep this README a pointer; do not duplicate that content here.
