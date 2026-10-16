# Netopeer2, built from source

The NETCONF fixture for the `netconf` provider (issue #1724). It serves NETCONF over SSH on 830,
with three read-only accounts, the NACM rule-list the provider doc recommends as the device
profile, and an `ietf-interfaces` list to read.

It is built rather than pulled because the published images are older than the release this pins:
on Docker Hub `sysrepo/netopeer2` has one tag, `latest`, last pushed 2025-05-16, and
`sysrepo/sysrepo-netopeer2` was last pushed 2023-02-01, both read on 2026-10-13.
Everything here is a throwaway for acceptance: the account passwords, the client keys the setup
script generates and the host key the build generates. The port binds to loopback and the image
must never be exposed or reused outside acceptance.

## The four sources

| Project | Tag | Published |
|---|---|---|
| CESNET/libyang | v5.8.6 | 2026-06-22 |
| CESNET/libnetconf2 | v4.4.10 | 2026-06-22 |
| sysrepo/sysrepo | v5.1.0 | 2026-06-22 |
| CESNET/netopeer2 | v2.8.7 | 2026-06-22 |

All four were the current release on 2026-10-13, the day their sha256 sums were recorded in
`SHA256SUMS`, which the build checks before it unpacks anything. Moving a version means recording
its sum in the same change, the way `docker/minio` moves a commit.

## Four facts the build and the setup depend on

Each was measured on 2026-10-13 while this directory was written, and each breaks the fixture in
a different way if it is dropped. Two of them break it without an error at build time.

1. **`cmake --install` needs the `openssl` executable.** netopeer2's install step runs
   `merge_hostkey.sh`, which generates the server's host key. With `libssl-dev` alone the step
   exits 1 with `Unable to find mbedtls nor openssl executable`.
2. **`netopeer2-server` installs into `/usr/local/sbin`.** A multi-stage image that copies only
   `/usr/local/bin` builds and tags cleanly, and then fails at `docker run` with
   `executable file not found in $PATH`.
3. **`iana-if-type` is not in sysrepo after a bare install.** Loading `ietf-interfaces` data
   without installing it first fails with
   `Invalid identityref "ianaift:ethernetCsmacd" value - unable to map prefix to YANG schema`.
   `setup.sh` installs it with `sysrepoctl -i` before it writes any interface.
4. **Without the NACM rule-list the read-only accounts are not read-only.** Under the RFC 8341
   defaults a user with no rule still gets `lock`, `unlock`, `discard-changes`, `validate` and
   `copy-config` on this server. The rule-list in `setup.sh` is what makes the eleven non-read
   operations answer `access-denied`.

## Why multi-stage

The toolchain stays in the build stage. Measured on 2026-10-13 on an arm64 host: the server image
is 38.0 MB, where a single-stage image of the same sources is about 552 MB, and a cold build of
all four sources took 62 seconds on 18 cores. At 38 MB building the fixture per CI run is a real
option; at 552 MB it is not.

## The accounts

| Account | Login | Why it exists |
|---|---|---|
| `ro-pass` | password `fixture-password`, from `LIBREDB_NETCONF_RO_PASSWORD` | the password path |
| `ro-key` | the ed25519 key at `/fixture/ro-key` | the public-key path, and what `verify.mjs` uses |
| `ro-passphrase` | the ed25519 key at `/fixture/ro-passphrase`, passphrase `fixture-passphrase`, from `LIBREDB_NETCONF_KEY_PASSPHRASE` | the passphrase path, which fails in the CLIENT rather than on the wire when the passphrase is missing or wrong |
| `root` | keyboard-interactive, system password `fixture-root`, from `LIBREDB_NETCONF_ROOT_PASSWORD` | the keyboard-interactive path, through PAM |

The first three are in the `readonly` NACM group. `root` is not: it is the recovery user and can
write, which is what makes it useful for staging data and dangerous to connect Studio with.

A read-only account here is read-only, not blind: measured on 2026-10-13, the same account can
read the `$6$` password hash and the keystore entries out of the running datastore. Nothing that
reads this fixture should log or export what it reads.

## Running it

```sh
docker build -t libredb-fixture/netconf:2.8.7 docker/netconf
docker run -d --name libredb-netconf -p 127.0.0.1:1830:830 \
  -e LIBREDB_NETCONF_RO_PASSWORD=fixture-password \
  -e LIBREDB_NETCONF_ROOT_PASSWORD=fixture-root \
  -e LIBREDB_NETCONF_KEY_PASSPHRASE=fixture-passphrase \
  libredb-fixture/netconf:2.8.7
docker exec libredb-netconf cat /fixture/ro-key > /tmp/ro-key && chmod 600 /tmp/ro-key
```

THE THREE CREDENTIAL VARIABLES ARE REQUIRED AND HAVE NO DEFAULTS. `setup.sh` holds none of the
values, so that no commit adding it can carry one past a secret scanner, and it refuses by name
rather than inventing one: a default would quietly give an account an empty password on a device
that accepts logins. The same three are set by `compose-service.yml`, `ci-step.yml` and
`verify.sh`, which are the other three ways this fixture is started.

`LIBREDB_NETCONF_INTERFACES` sets how many interfaces the fixture loads; it defaults to 5000,
the size the provider's read sizes were measured at.
The host key is generated when the image is built, so a check that pins it reads the fingerprint
out of band with `docker exec`, the way a live check against a real device would.
`/fixture/.ready` appears once the accounts, the rule-list and the interfaces are all in the
datastore, and the compose healthcheck waits for it rather than for the port.

## Checking it

```sh
./docker/netconf/verify.sh        # builds, starts, checks, removes
```

`verify.mjs` reads the server with ssh2, the library the provider itself dials with, and asserts
the three things a silently broken fixture gets wrong: the server answers at all, a session opens
and the hello carries a session-id, and the read-only account answers `access-denied` to each of
`lock`, `unlock`, `edit-config`, `copy-config`, `delete-config`, `commit`, `validate`,
`discard-changes`, `kill-session` and `create-subscription`, while `get-config` and `get-schema`
still return data.

## The address it dials, and the branch that leaves unmeasured

`verify.mjs` dials the literal `127.0.0.1`, not the name `localhost`, because `verify.sh` publishes
the port on `127.0.0.1` alone: `localhost` resolves to `::1` first on macOS, where nothing is
listening, so a name here would fail for a reason that has nothing to do with the server.

That means this fixture never exercises the egress rule's name branch, where the lookup checks the
DNS answers rather than a literal. Those two cases are measured instead in
`tests/unit/db/netconf/dial.test.ts`, against the real egress policy and both states of
`DB_HTTP_BLOCK_PRIVATE_HOSTS`. The branch is covered; it is just not covered here.

## Not here yet

The compose service lives in `compose-service.yml` until the provider PR merges it into
`database-compose.yml`. That file is one every new provider edits, so merging it here would
collide with the other providers in flight.
