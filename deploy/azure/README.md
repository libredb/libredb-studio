# Azure Marketplace (Azure Application → solution template)

LibreDB Studio's Microsoft Marketplace channel: a free ("Get It Now")
solution template that deploys one Ubuntu 24.04 LTS VM running the
`ghcr.io/libredb/libredb-studio` container behind a Caddy reverse proxy with
automatic HTTPS. Full context, certification rules, risks and the Partner
Center walkthrough live in [AZURE_MARKETPLACE_PLAN.md](AZURE_MARKETPLACE_PLAN.md).

## Layout

| Path | What it is |
|---|---|
| `src/mainTemplate.json` | ARM template *source* — `__INSTALL_SCRIPT_B64__` is filled at build time |
| `src/createUiDefinition.json` | Azure portal wizard definition (shipped verbatim) |
| `src/install.sh` | First-boot installer *source* — image refs filled at build time |
| `package-version.txt` | Partner Center package version (single source of truth; bump every publish) |
| `listing/` | Listing texts + media requirements (`listing-fields.md`, `description.html`) |

## Build the package

```bash
node scripts/build-azure-package.mjs                # pins package.json version
node scripts/build-azure-package.mjs --version 0.9.66 --package-version 1.0.1
```

Output: `dist/azure/libredb-studio-azure-<packageVersion>.zip` — exactly two
files at the zip root, images pinned by manifest digest. The build fails if an
`apiVersion` in the template is ≥700 days old (certification rejects at 730;
warnings start at 540) — refresh values against `az provider show` when it
warns.

In CI: run the **Azure Marketplace Package** workflow (workflow_dispatch),
which also validates the output with `Test-AzMarketplacePackage` (arm-ttk) and
uploads the zip as an artifact.

## Validate before submitting

1. arm-ttk marketplace suite — zero red (the CI workflow does this).
2. Portal sandbox for the wizard: paste `src/createUiDefinition.json` into
   <https://portal.azure.com/#view/Microsoft_Azure_CreateUIDef/SandboxBlade>.
3. A real deployment in our own subscription — acceptance criteria in plan §6.2.

## Update runbook (per release worth shipping)

1. Verify the new tag exists on ghcr, then run the CI workflow with
   `version` = app version and `packageVersion` = last published + 1
   (also bump `package-version.txt` in the same PR).
2. Deploy the fresh zip into a test subscription; re-run plan §6.2 checks.
3. Partner Center → offer → plan → Technical configuration: raise Version,
   upload the zip → Review and publish → after certification, **Go live**
   (human only). Customers keep getting the old package until Go live —
   there is no outage window.

Cadence: every minor release and every security patch (plan §10).
