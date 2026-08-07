# Azure Marketplace (Azure Application → solution template)

LibreDB Studio's Microsoft Marketplace channel: a free ("Get It Now")
solution template that deploys one Ubuntu 24.04 LTS VM running the
`ghcr.io/libredb/libredb-studio` container behind a Caddy reverse proxy with
automatic HTTPS. The listing texts Partner Center needs are in
[`listing/listing-fields.md`](listing/listing-fields.md).

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
3. A real deployment in our own subscription — acceptance criteria below.

## Acceptance criteria for a real deployment

- Deployment reports `Succeeded`, CustomScript extension included (typical ~5 min).
- `applicationUrl` opens and presents a **valid** HTTPS certificate.
- Sign in with the credentials typed into the wizard, then **reload the page** — the
  session must survive. This is not a formality: on plain HTTP the app marks its auth
  cookie `Secure` for any non-loopback host, the browser discards it, and login loops
  back silently while every health probe still passes. The installer writes
  `AUTH_COOKIE_SECURE=false` only for the `:80` deployment; verify with
  `sudo grep AUTH_COOKIE_SECURE /etc/libredb-studio.env` (HTTPS → absent, `:80` → `false`).
- `GET https://<fqdn>/api/db/health` → `{"status":"healthy",…}`.
- Port 3000 closed from outside and open on the VM; port 22 closed when
  `sshSourceAddressPrefix` is empty; `/etc/libredb-studio.env` mode `0600`.
- The two secret-bearing directories are private — `stat -c '%a %n' /opt/libredb/data
  /opt/libredb/caddy/data` → `700` for both. The SQLite store holds connection records
  with plaintext passwords, and the Caddy data directory holds the TLS private keys; the
  files inside are created with the containers' umask (`0644`), so the directory mode is
  what keeps them away from other local accounts.
- `enableHttps=false` + a `/32` source range: reachable only from that address, login
  still survives a reload.
- `authenticationType=password`, and a second region, both deploy cleanly.
- **TLS fallback.** Add a `DenyAcme` NSG rule blocking port 80, then deploy with a
  **fresh** `dnsLabelPrefix`. Expected: deployment still `Succeeded`; `curl -fsSk
  https://<fqdn>/api/db/health` works while the same probe without `-k` fails (Caddy's
  internal CA); no `Caddyfile.https` / `Caddyfile.fallback` exists, because nothing
  rewrites the config; `/etc/libredb-studio.info` explains the warning and offers no
  restore procedure. Then delete the NSG rule and `systemctl restart libredb-caddy` — a
  trusted certificate arrives on its own, with no manual step.
  > Let's Encrypt limits **failed** validations per hostname (5/hour today), so never
  > retry this on a hostname that already burned the budget; use a fresh DNS label.
- VM restart: the app comes back (`systemctl is-enabled libredb-studio`) with data intact.
- Delete every resource group you created — each holds a running VM, a static public IP
  and a managed disk.

## Update runbook (per release worth shipping)

1. Verify the new tag exists on ghcr, then run the CI workflow with
   `version` = app version and `packageVersion` = last published + 1
   (also bump `package-version.txt` in the same PR).
2. Deploy the fresh zip into a test subscription; re-run the acceptance criteria above.
3. Partner Center → offer → plan → Technical configuration: raise Version,
   upload the zip → Review and publish → after certification, **Go live**
   (human only). Customers keep getting the old package until Go live —
   there is no outage window.

Cadence: every minor release and every security patch.
