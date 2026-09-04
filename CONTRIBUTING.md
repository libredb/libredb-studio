# Contributing to LibreDB Studio

First off, thank you for considering contributing to LibreDB Studio! It's people like you that make LibreDB Studio such a great tool.

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Language

**Open an issue or a pull request in Chinese (中文) or Japanese (日本語) if that is easier for you.** You do not need fluent English to report a bug or propose a change, and a report we have to translate is far better than one you did not send. Maintainers will usually reply in English; say so if that does not work for you.

This applies to the conversation, not to the repository. Everything that lands in the tree stays in English: code, comments, commit messages, documentation and the pull request title. The exceptions are the translated READMEs themselves ([README_zh.md](README_zh.md), [README_ja.md](README_ja.md)), which are maintained in their own language.

If you are updating a translated README, note that `bun run readme:check` enforces that its engine table and install commands match [README.md](README.md). Translations may cover fewer install channels, but a command must never be paraphrased - a reader copy-pastes it.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Describe the behavior you observed and what you expected**
- **Include screenshots if possible**
- **Include your environment details** (OS, browser, Node.js version)

### Suggesting Features

Feature suggestions are welcome! Please provide:

- **A clear and descriptive title**
- **A detailed description of the proposed feature**
- **Explain why this feature would be useful**
- **Include mockups or examples if applicable**

### Pull Requests

1. **Start from an issue.** Open one or comment on an existing one before you write code, and
   reference it from the PR (`Closes #123`). A PR with no linked issue is hard to review and, during
   Hacktoberfest, does not count.
2. **Fork the repository** and create your branch from `main`.
3. **Write the failing test first, then the fix.** Every change that adds or alters executable
   lines lands with its tests in the same PR. The CI gate is 100% line coverage
   (`scripts/check-coverage.mjs` fails the required `Unit & Integration Tests` job below it), so a
   PR without tests cannot merge no matter how small the change.
4. **Run the local gate before pushing.** It mirrors the required CI checks:

   ```bash
   bun run format && bun run lint && bun run typecheck && bun run knip \
     && bun run readme:check && bun run chart:check && bun run channels:showcase:check \
     && bun run security:check && bun run test && bun run build
   ```

   Always `bun run test`, never bare `bun test`: component tests need the isolated execution groups
   the script sets up. `bun run test:coverage && bun run coverage:check` prints the exact uncovered
   `file:line` ranges.
5. **Keep the provider triad in lockstep.** Anything under `src/lib/db/providers/**` has a matching
   `docs/providers/<type-id>.md` and `tests/integration/db/<type-id>-provider.test.ts`; a change to
   one moves the other two in the same PR.
6. **Localized READMEs are guarded.** `README_zh.md` and `README_ja.md` must list the same engines
   as `README.md` and quote install commands verbatim; `bun run readme:check` enforces it.
7. **Follow the coding style**, write clear commit messages, and update documentation with the code.

### Hacktoberfest

LibreDB Studio takes part in Hacktoberfest each October. The repository carries the `hacktoberfest`
topic, and the issues we have vetted for outside pickup are labeled
[`hacktoberfest`](https://github.com/libredb/libredb-studio/issues?q=is%3Aissue+is%3Aopen+label%3Ahacktoberfest):
each states what is wrong, where to look, and what "done" looks like, and none needs a live database
cluster or a cloud account. `good first issue` marks the small ones, `help wanted` the medium ones.

- **Claim before you start.** Comment on the issue so two people do not build the same fix. If a
  claimed issue shows no activity for two weeks it is open again.
- **What counts.** A PR that references its issue, includes tests, and passes the gate above. We
  label accepted PRs `hacktoberfest-accepted` once merged.
- **What does not count.** PRs that only reformat, rename, fix a typo without an issue, add a
  trailing comment, or bump a version are closed with the `spam` or `invalid` label, which also
  excludes them from Hacktoberfest's count. Machine-generated PRs that do not run the tests fall in
  the same bin.
- **Pick from the labeled list.** Entries in `docs/BACKLOG.md` that are not labeled have not been
  vetted for outside pickup; ask in an issue first if one of them interests you.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) (recommended) or Node.js 24+
- Git

### Getting Started

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/libredb-studio.git
cd libredb-studio

# Install dependencies
bun install

# Copy environment example
cp .env.example .env.local

# Start development server
bun dev
```

### Environment Variables

None are required: `bun dev` starts with an empty `.env.local` and the app's
zero-config first run generates the admin credentials and the JWT secret, printing
the password once to the dev-server output. Set them to pin known values instead
(`USER_PASSWORD` additionally creates the optional non-admin account, which is
never generated):
```env
ADMIN_PASSWORD=admin123
USER_PASSWORD=user123
JWT_SECRET=your_32_character_random_string_here
```

Optional (for AI features):
```env
LLM_PROVIDER=gemini
LLM_API_KEY=your_api_key
LLM_MODEL=gemini-2.5-flash
```

### Development Database

We provide a ready-to-use PostgreSQL setup with sample data for testing:

```bash
# Start PostgreSQL with sample e-commerce data
docker compose -f docker/postgres.yml up -d

# Connect with:
# Host: localhost, Port: 5432, Database: libredb_dev
# User: postgres, Password: postgres
```

**Includes:**
- PostgreSQL 17 with `pg_stat_statements` enabled
- E-commerce sample schema (customers, products, orders)
- 100+ records across multiple tables
- Pre-built views for reporting

> This is especially useful for testing the **Monitoring Dashboard** features.

### Project Structure

```
src/
├── app/              # Next.js App Router
│   ├── api/          # API routes
│   ├── admin/        # Admin pages
│   └── login/        # Login page
├── components/       # React components
├── hooks/            # Custom React hooks
└── lib/
    ├── db/           # Database providers (Strategy Pattern)
    ├── llm/          # LLM providers (Strategy Pattern)
    └── ...           # Utilities
```

### Available Scripts

```bash
bun dev                  # development server (Turbopack)
bun run build            # production build
bun start                # production server
bun run format           # Biome formatter check (format:fix to write)
bun run lint             # oxlint, then ESLint 9
bun run typecheck        # TypeScript strict
bun run knip             # unused files, exports and dependencies
bun run test             # every test layer; never bare `bun test`
bun run test:coverage    # coverage report (merged lcov)
bun run coverage:check   # enforce 100% line coverage on the merged lcov
bun run readme:check     # localized README drift guard
bun run chart:check      # Helm chart version sync guard
bun run security:check   # security posture drift guard
bun run build:lib        # @libredb/studio package dist (after changing anything under src/exports/)
```

### Security Scanning

Two checks run against every pull request. Both are reproducible locally, and
reproducing them is faster than waiting for CI.

**Committed secrets.** This one can fail your pull request. It scans only the
commits your branch adds:

```bash
docker run --rm -v "$PWD:/repo:ro" -w /repo \
  zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
  git --no-banner --redact --config /repo/.gitleaks.toml \
      --log-opts="--diff-merges=first-parent origin/main..HEAD"
```

If it reports a real credential, rotate it first — the value is already in every
clone. If it reports a fixture or placeholder, copy the finding's own
`Fingerprint` (`commit:file:rule:startline`, printed in the JSON report the
command above can produce with `--report-format json`) into `.gitleaksignore`
with a comment explaining why; that suppresses exactly this one finding, so a
real secret added later — even the same fabricated literal, in a new commit —
is still reported. `.gitleaks.toml`'s `[[allowlists]]` is for the narrower case
of a whole rule being unconditionally noisy for a reviewable reason, not for a
single fixture; an allowlist that names no `targetRules` is rejected by
`tests/unit/gitleaks-config.test.ts`, because it would exempt that path from
every rule the scanner has.

**Vulnerable dependencies.** This one reports on pull requests and never fails
them. The quickest local view needs no container:

```bash
bun audit
```

`bun audit` reports every severity and does not tell you whether a fix exists, so
expect a long list; it is a starting point, not a verdict. The scan CI actually
runs covers the npm, Rust and Go ecosystems together (`bun.lock`,
`desktop/src-tauri/Cargo.lock`, the launcher's `go.mod`) and includes the
fixed-version column `bun audit` lacks:

```bash
docker run --rm -v "$PWD:/repo:ro" -w /repo \
  aquasec/trivy@sha256:7cced7cae583819fc7806d4cbc0dbbc7cad18b99f7d3e235192e6da8c091045c \
  fs --scanners vuln --ignorefile /repo/.trivyignore.yaml \
     --skip-dirs node_modules --skip-dirs .next --skip-dirs dist --skip-dirs coverage .
```

Only a CRITICAL finding with an available fix gates anything, and only outside
pull requests. If you hit one, take the fix and commit `bun.lock`. Suppressing it
in `.trivyignore.yaml` is the last resort and requires a justification and an
expiry date.

### Helm Chart Changes

Touching anything packaged under `charts/libredb-studio/` pulls in two invariants
that CI enforces and that nothing in the chart itself hints at. Both are checked
by one command, and running it locally is faster than reading a CI log:

```bash
bun run chart:check
```

**The operator carries a verbatim copy.** `operator/helm-charts/libredb-studio/`
is a byte-for-byte mirror of the source chart, because the OLM operator embeds
the chart rather than fetching it. Never hand-edit the copy — change the source
chart and regenerate:

```bash
bun run chart:bump
```

**An already-released chart version cannot be re-published.** Chart releases are
immutable: re-publishing a version that already has a `libredb-studio-<version>`
tag would mutate the released index entry and the OCI digest that existing users
resolve (#167). So when the current `version:` in `Chart.yaml` is already tagged,
raise it by hand — both `version:` in `Chart.yaml` and the `--version` example in
`charts/libredb-studio/README.md`.

`chart:bump` deliberately will *not* raise `version:` for you while `appVersion`
is already in sync with `package.json`, so this step is easy to miss; `chart:check`
is what catches it. `appVersion` tracks the app's `package.json` version and is
the one field `chart:bump` does maintain.

Finally, the chart should lint clean:

```bash
helm dependency build charts/libredb-studio
helm lint charts/libredb-studio --strict
```

CI's test and lint lanes run Helm 4.1.3, so that is the client to develop against.
That is not the chart's floor: the chart README states Helm >= 3.12, and CI's only
Helm 3 evidence is 3.16.0. The release workflow's `ct install` job stays on Helm 3.16
deliberately, so a Helm 3 client keeps installing the chart source - see
`tests/unit/helm-pin-matrix.test.ts`, and R1 in `docs/BACKLOG.md` for what that
still does not cover.

## Coding Guidelines

### TypeScript

- Use TypeScript for all new code
- Define proper types/interfaces
- Avoid `any` type when possible

### React

- Use functional components with hooks
- Follow the existing component patterns
- Keep components focused and small

### Styling

- Use Tailwind CSS for styling
- Follow the existing design patterns
- Use Shadcn/UI components when applicable

### Commits

- Use clear, descriptive commit messages
- Reference issues in commits when applicable (e.g., `Fix #123`)
- Keep commits focused on a single change

## Questions?

Feel free to open an issue with your question or reach out to the maintainers.

Thank you for contributing!
