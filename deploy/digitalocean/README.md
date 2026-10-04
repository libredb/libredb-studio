# DigitalOcean Marketplace — LibreDB Studio

Build and submission files for the 1-Click Droplet App (Path B of #72).
Base image: **Ubuntu 24.04 LTS** (`ubuntu-24-04-x64`).

## Layout

```
deploy/digitalocean/
├── README.md                          # this file — build guide + submission checklist
├── manifest.yaml                      # Vendor Portal form reference
├── assets/
│   └── description-long.md            # Marketplace long description
└── droplet/
    ├── template.pkr.hcl               # Packer template (manifest post-processor included)
    ├── scripts/
    │   ├── 01-install.sh              # Docker CE + compose plugin, droplet-agent purge, image pre-pull
    │   └── 02-configure.sh            # UFW, exec bits (MOTD + first-boot + DBaaS helper!), seed dir, /app/data, version pinning, application.info
    └── files/
        ├── etc/systemd/system/libredb-studio.service
        ├── etc/update-motd.d/99-libredb-studio
        ├── usr/local/sbin/libredb-do-dbaas-seed   # Managed Database credentials -> seed file (first boot only)
        └── var/lib/cloud/scripts/per-instance/99-libredb-first-boot.sh
```

DO's official `90-cleanup.sh` / `99-img-check.sh` are fetched at build time
from [`digitalocean/marketplace-partners`](https://github.com/digitalocean/marketplace-partners)
— they are not vendored here. Both the workflow and the local build pin the
same reviewed commit (the scripts run as root inside the image build); bump
the pin deliberately, in both places, after reviewing upstream changes.

## Build

**GitHub Actions (recommended):** wait for the Docker publish workflow to finish
for the release, then Actions → "DO Packer Build" → Run workflow → select that
release tag and enter the same bare semver as `version`. The image tag must exist
on `ghcr.io/libredb/libredb-studio`; the input has no default. The snapshot ID
appears in the job summary.
Requires the `DIGITALOCEAN_TOKEN` repo secret (read+write PAT).

The build stays **manual by design**: it consumes DigitalOcean resources, and a
snapshot still needs the Droplet checks below and a Vendor Portal submission.
Every successfully published release adds a **DigitalOcean Marketplace release
checklist** to the `publish-release` job summary, including the released version
and the build, test, submission and listing-verification steps. The reminder is
non-blocking and does not create cloud resources or submit an untested image.
Do not add only a `release: published` trigger: this repo publishes releases with
`GITHUB_TOKEN`, whose release events do not start other workflows.

**Local:**

Set `VERSION` to the released bare semver tag you intend to build before running
these commands; there is no default here either.

```bash
: "${VERSION:?Set VERSION to the released semver tag to build}"
cd deploy/digitalocean/droplet
MP_SHA=b70878804ca27c01d5f5e882d26485defbaba210  # keep in sync with .github/workflows/do-packer-build.yml
curl -fsSLo scripts/90-cleanup.sh   "https://raw.githubusercontent.com/digitalocean/marketplace-partners/${MP_SHA}/scripts/90-cleanup.sh"
curl -fsSLo scripts/99-img-check.sh "https://raw.githubusercontent.com/digitalocean/marketplace-partners/${MP_SHA}/scripts/99-img-check.sh"
export DIGITALOCEAN_TOKEN=dop_v1_...
packer init .
packer validate -var "version=$VERSION" .
packer build -var "version=$VERSION" .
```

## Published version check

`bun run distribution:check` (from the repository root) compares
`package.json.version` with the live listing's `custom_data.version`. It reads the
public Marketplace page, including its escaped Next.js metadata; it does not
treat a local Packer version or a successful snapshot build as publication.
A stale listing reports **DRIFT**; unreadable, missing or ambiguous version
metadata reports **UNKNOWN**, never a silent **SKIP**. As with other remote
catalogs, the report is warn-only, including under `--strict`, and runs weekly in
the Distribution Check workflow. Run it again after DigitalOcean approves an
update and verify the published version matches the submitted snapshot.

## Critical build rules

1. **Never reboot after `90-cleanup.sh`.** Cleanup wipes the cloud-init
   semaphores; a reboot would run the first-boot script on the build droplet
   and bake generated secrets into the snapshot — every customer would get
   the same credentials. The flow is always: cleanup → img-check → snapshot.
2. **The first-boot script and the DBaaS helper must be executable.** cloud-init
   silently skips non-executable files, and the first-boot script runs
   `/usr/local/sbin/libredb-do-dbaas-seed` by path; `02-configure.sh` sets both
   exec bits, so do not remove those lines.
3. **The MOTD file must stay extensionless.** `run-parts --lsbsysinit`
   silently ignores files with a `.sh` suffix.
4. **`environment_vars` is mandatory on every provisioner using `${VERSION}`.**
   Without it, `docker pull` and `sed` silently run with an empty value.
5. **`/opt/digitalocean` must not exist in the snapshot** — `99-img-check.sh`
   fails on it; `01-install.sh` purges the droplet-agent.

## Pre-submission checklist

- [ ] `packer validate` → clean
- [ ] Fresh test Droplet from the snapshot ($6) → MOTD shows up
- [ ] `http://<IP>:3000` loads; `/api/db/health` → `{"status":"healthy",…}`
- [ ] Login works with the credentials from `/etc/libredb-studio.env`
- [ ] `sudo grep AUTH_COOKIE_SECURE /etc/libredb-studio.env` → `false`. The
      Droplet is plain HTTP on a public address, so without it the browser
      discards the auth cookie and login loops while health probes still pass
- [ ] SQLite data survives a Droplet restart (`/app/data`)
- [ ] `ufw status` → active (only 22/tcp LIMIT; port 3000 is published via
      Docker's iptables rules and intentionally absent from the ufw list)
- [ ] `cat /root/.ssh/authorized_keys` → empty/missing (remove your test key!)
- [ ] Without a Managed Database: `/etc/libredb-studio/seed` is empty,
      `/etc/libredb-studio.env` has no `SEED_CONFIG_PATH`, and the MOTD has no
      `Database:` line
- [ ] With a Managed Database (see "Managed Database" below): the MOTD names the
      connection, an account with the admin role sees it locked in the sidebar
      and can query it, and an account with the user role does not see it
- [ ] `bash 99-img-check.sh` on the Droplet → "0 Tests FAILED"
- [ ] A "host key changed" SSH warning on first login is expected — cleanup
      deletes host keys; cloud-init regenerates them

## Managed Database

DigitalOcean can create a Managed Database together with the Droplet when the
listing ticks the managed-database checkboxes in the Vendor Portal
([marketplace-partners README, section 5](https://github.com/digitalocean/marketplace-partners#dbaas-integration)).
The customer then gets `/root/.digitalocean_dbaas_credentials` before the
per-instance scripts run. `99-libredb-first-boot.sh` hands that file to
`libredb-do-dbaas-seed`, which writes `/etc/libredb-studio/seed/connections.yaml`
(root:libredb-studio, 0640, no password in it), adds the password lines and
`SEED_CONFIG_PATH` to `/etc/libredb-studio.env`, and records the result in
`/var/lib/libredb-studio/dbaas.status` for the MOTD. `libredb-studio` is the
host name `02-configure.sh` gives gid 1001, the container's `nodejs` group, so
no later login on the Droplet is handed that id. Every first boot removes the
previous seed file and status before it looks for the credentials file, so a
Droplet created from a customer's snapshot never reports a database it no
longer connects. A Droplet created from a customer's own snapshot that still
holds `/root/.digitalocean_dbaas_credentials` seeds that same cluster again at
first boot; deleting the file before taking the snapshot prevents it. Without
the file nothing else changes.

| `db_protocol` / `keystore_protocol` | Studio type | Connection id | Evidence for the value |
| --- | --- | --- | --- |
| `postgresql` | `postgres` | `do-managed-postgres` | DigitalOcean's Django, Keycloak, Supabase and Airflow 1-Clicks compare against it |
| `mysql` | `mysql` | `do-managed-mysql` | DigitalOcean's WordPress and LAMP 1-Clicks compare against it |
| `redis`, `rediss` or `valkey` (keystore) | `redis` | `do-managed-valkey` | Airflow matches the prefix `redis`; the exact value is not documented |

Every connection is `managed: true`, `roles: ["admin"]` (the credential is the
cluster administrator) and `ssl.mode: require`. Any other protocol, or a field
with an unexpected shape, adds nothing and the MOTD says so.

`tests/unit/digitalocean-dbaas-seed.test.ts` parses the helper's output with the
seed schema of the commit it runs on, while the snapshot runs the image version
Packer pins. Build a snapshot from the tag that matches its pinned version, so
the schema CI checked is the one the Droplet runs.

### Verifying the cluster certificate

`ssl.mode: require` encrypts but does not verify the server certificate, like
the `sslmode=require` string DigitalOcean prints. DigitalOcean signs each
cluster with its own CA, which is not in the system trust store, so the upgrade
is `verify-full` with that CA pasted into the seed file. Download the CA
certificate from the cluster's page in the control panel (or
`doctl databases get-ca <cluster-id>`, whose certificate is base64), then edit
the entry in `/etc/libredb-studio/seed/connections.yaml` so its `ssl` block
reads as below, with the PEM as a block scalar indented under `caCert: |`:

```yaml
    ssl:
      mode: verify-full
      caCert: |
        -----BEGIN CERTIFICATE-----
        MIIEQTCCAqmgAwIBAgIU...
        -----END CERTIFICATE-----
```

Studio reads the seed file again on the first request after its 60-second
cache expires. A YAML or schema mistake rejects the whole file, so every seeded
connection disappears, not just this one. After a minute, reload Studio in the
browser and run `docker logs libredb-studio 2>&1 | grep -i seed`: expect
`Seed config loaded`, not `Failed to load the seed configuration` (its message
says `Invalid seed config` or `Failed to parse seed config`).

Before ticking a checkbox, prove that engine on a real cluster with a Droplet
built from the new snapshot. The credentials file is written by hand through
user data, in the quoted shape DigitalOcean's own images parse:

```bash
doctl databases create libredb-dbaas-pg --engine pg --region nyc3 \
  --size db-s-1vcpu-1gb --num-nodes 1 --wait
doctl databases connection <cluster-id> --output json   # host, port, user, password, database
cat > ud-pg.yaml <<'EOF'
#cloud-config
write_files:
  - path: /root/.digitalocean_dbaas_credentials
    permissions: '0600'
    content: |
      db_protocol="postgresql"
      db_username="doadmin"
      db_password="<password>"
      db_host="<host>"
      db_port="25060"
      db_database="defaultdb"
EOF
doctl compute droplet create libredb-dbaas-pg --image <snapshot-id> \
  --size s-1vcpu-1gb --region nyc3 --ssh-keys <fingerprint> \
  --user-data-file ud-pg.yaml --wait
```

`doctl databases options engines` and `doctl databases options slugs --engine pg`
list the engine and size slugs. Repeat with `mysql` and the Valkey engine (the
keystore keys are `keystore_protocol`, `redis_host`, `redis_port`,
`redis_username` and `redis_password`). Delete every test Droplet and cluster
afterwards (`doctl compute droplet delete -f <id>`, `doctl databases delete -f <id>`).

## Submission

1. [Vendor Portal](https://cloud.digitalocean.com/vendorportal) → New App → snapshot ID
   - Managed databases: tick only the engines proven under "Managed Database"
     above, and make the "Add a Managed Database" section of
     `assets/description-long.md` name exactly those engines.
2. Marketing assets:
   - Logo 128×128 PNG
   - Screenshots (editor + results grid)
   - Short description (≤75 chars): `Open-source SQL IDE with AI — PostgreSQL, MySQL, MongoDB, Redis & more`
   - Long description: `assets/description-long.md`
3. Follow-up: one-clicks-team@digitalocean.com — there is no official review
   SLA; a polite nudge after a couple of weeks is fine.
4. After approval, add the Marketplace link next to the other one-click
   buttons in the root README.
