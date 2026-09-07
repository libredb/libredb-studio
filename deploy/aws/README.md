# AWS Marketplace — free AMI product

LibreDB Studio ships to AWS Marketplace as a **free AMI-based product**: the
buyer launches one EC2 instance from our image and pays AWS only for the
instance, the volume and data transfer. There is no metering, no contract and no
software charge.

Same shape as the DigitalOcean droplet and the Azure VM image: Ubuntu 24.04, the
published container pinned by digest, run by a systemd unit, credentials
generated on the buyer's own instance at first boot.

Listed since 7 September 2026:
<https://aws.amazon.com/marketplace/pp/prodview-tsahkrgdqpnws> — product
`prod-jq7wwg5ifhcfe`, first published version 0.14.1.

## Layout

| Path | What it is |
|---|---|
| `ami/template.pkr.hcl` | Packer `amazon-ebs` build, us-east-1, IMDSv2-only |
| `ami/scripts/01-install.sh` | Docker plus the digest-pinned image pre-pull |
| `ami/scripts/02-configure.sh` | Installs units and MOTD hook, substitutes build-time tokens, asserts the effective sshd config |
| `ami/scripts/90-cleanup.sh` | Marketplace compliance step — runs LAST, and asserts its own invariants |
| `ami/files/` | Everything that ships inside the image |
| `listing/` | Every portal field, the description, and the usage instructions |
| `../../.github/workflows/aws-ami-build.yml` | The build: resolves the digest, runs Packer, prints the AMI ID |

`90-cleanup.sh` is ours. The DigitalOcean build downloads its `90-cleanup.sh`
from `digitalocean/marketplace-partners` at a pinned commit; **AWS publishes no
equivalent script** — its analogue is the server-side scan you trigger with
`Test 'Add version'`, which runs in AWS's account. There is no `MP_SHA` here to
keep in sync.

## Build

Through the **AWS AMI Build** workflow: Actions -> AWS AMI Build -> Run
workflow. The channel is live, so an empty version falls back to the
`package.json` version at the ref and builds; name a version to ship anything
else. (While the channel was pending, naming a version was what marked a run as
a person's rather than a machine's - the listing gate below - and an empty run
stood down.) The run resolves the tag to a digest, waits for the image if the
push is still in flight, assumes the OIDC build role and prints the AMI ID, the
base image and the next portal steps in the job summary.

The workflow also declares `release: published`, but that trigger fires only
when a human publishes a draft by hand: `release-artifacts.yml` publishes with
`GITHUB_TOKEN`, and a GITHUB_TOKEN-created event starts no workflow. Making
every release build an AMI means adding `gh workflow run aws-ami-build.yml
--ref "refs/tags/$TAG"` to that file's `dispatch-downstream` job. That is safe to
add only with that consequence in mind: the channel is live and the three
repository variables were set for the first build, so a chained run would build
and register a marketplace AMI on every release, and nothing in this repository
ever deregisters one. It is left out because it edits the release pipeline, and
because registering an AMI per release is a decision rather than a default.

A preflight job decides whether there is anything to build, on every path, so
that the chain dispatch above behaves like a release rather than like a person:
a dispatch that NAMES a version fails loudly when something is wrong, and every
other path stands down quietly. It refuses to build a chart release, a
prerelease, a tag that disagrees with `package.json`, or anything at all until
these three repository variables are set:
`AWS_SUPPORT_EMAIL` (the monitored mailbox printed in every buyer's banner),
`AWS_AMI_BUILD_ROLE_ARN` (the OIDC role Packer assumes) and
`AWS_AMI_INGESTION_ROLE_ARN` (the role AWS assumes to read the AMI, echoed into
the summary for the portal).

Before any of that, it checks whether the product is on sale at all.
`aws-marketplace` in `distribution/channels.yaml` carries the status of the
listing, and while it is anything but `live` every machine path - a published
release, the chained dispatch above - stands down quietly, so a release can
never register a marketplace AMI for a product nobody can buy. A dispatch that
NAMES a version builds regardless, which is how the AMI for the first
submission was made. Flipping the status to `live` was the whole switch when the
listing went public - nothing in the workflow had to change. What it opens is
this workflow's own `release: published` trigger, which fires only for a draft a
person publishes by hand (see above); no other workflow dispatches this one, so
an ordinary release still builds no AMI.

Locally, against the seller account:

```bash
cd deploy/aws/ami
export AWS_PROFILE=libredb-seller
VERSION=0.14.1
DIGEST=$(docker buildx imagetools inspect ghcr.io/libredb/libredb-studio:$VERSION --format '{{.Manifest.Digest}}')
SUPPORT=$(gh variable get AWS_SUPPORT_EMAIL)   # the same mailbox the workflow uses
packer init .
packer validate -var "version=$VERSION" -var "image_ref=ghcr.io/libredb/libredb-studio@$DIGEST" -var "support_email=$SUPPORT" .
packer build    -var "version=$VERSION" -var "image_ref=ghcr.io/libredb/libredb-studio@$DIGEST" -var "support_email=$SUPPORT" .
```

Without Buildx, resolve the digest with `curl` — ghcr hands anonymous pull
tokens for public repositories, and the two `Accept` headers are what make the
registry answer with the multi-arch index digest rather than one platform's:

```bash
TOKEN=$(curl -sS "https://ghcr.io/token?service=ghcr.io&scope=repository:libredb/libredb-studio:pull" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
DIGEST=$(curl -sSI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://ghcr.io/v2/libredb/libredb-studio/manifests/$VERSION" \
  | awk 'tolower($1) == "docker-content-digest:" { print $2 }' | tr -d '\r')
```

Whichever method you use, assert the value starts with `sha256:` before passing
it to Packer.

> **The scan accepts the pre-pulled layers.** Whether the AWS AMI scanner would
> object to CVEs inside a pre-pulled container image is documented nowhere, so it
> was an open question until the first submission: `ami-08263251d25dc8ced` passed
> and shipped as published version 0.14.1 on 7 September 2026. Pre-pulling stays
> the design - deterministic, no registry dependency at launch. If a later scan
> does fail on container-layer CVEs, the fallback order is: rebuild the app image
> on a freshly patched base and re-pin, then pull at first boot instead (allowed
> only if disclosed in the listing), then ship the standalone `.deb`.

## Rules that are not style preferences

- **The base image must be Canonical's plain server product.** An Ubuntu Pro base
  carries a `billingProducts` code, the code follows the AMI through copies and
  snapshots, and the result cannot be listed at all. The SSM parameter names the
  product as a path segment, so nothing is inferred.
- **Check that EBS encryption by default is OFF in the build account and Region**
  (`aws ec2 get-ebs-encryption-by-default --region us-east-1`). If it is on, the
  snapshot comes out encrypted whatever `encrypted = false` says, and
  "AMIs must not use encrypted EBS snapshots" makes the result unlistable — with
  a perfectly green Packer build to show for it.
- **No unit starts another unit.** `libredb-firstboot` generates credentials,
  `libredb-studio` runs the app, `libredb-banner` publishes the banner; the
  ordering is declared and never imperative. A `systemctl start` inside a unit
  that is ordered before the target sits in the job queue until the oneshot
  exits — five minutes of boot stall and a false "did not become ready" line in
  the buyer's console log, with every other check still green.
- **First-boot logic lives in systemd, not `/var/lib/cloud/scripts/per-instance`.**
  `cloud-init clean` in the cleanup step deletes everything under the cloud dir
  except `seed`, so the DigitalOcean pattern would ship an AMI with no first-boot
  logic at all and a green build.
- **`90-cleanup.sh` runs last and the machine must not reboot after it.**
- **The MOTD hook must never print the password.** `pam_motd` caches hook output
  in `/run/motd.dynamic` under `umask(0022)` — mode 0644 — so printing it
  republishes a live credential world-readable at every login, and keeps showing
  the original password after the buyer rotated it.

## Submission

1. AWS Marketplace Management Portal -> Server products -> Create server product
   -> Amazon Machine Image (AMI) -> licensing type Free. Fill the listing from
   `listing/listing-fields.md`, `listing/description.md` and
   `listing/usage-instructions.md`.
2. `Request changes -> Update versions -> Test 'Add version'` runs the AMI scan
   without creating a version. A product record must exist first — that is the
   ordering trap.
3. Submitting everything moves the product to **Limited**, visible only to the
   seller account and any allowlisted accounts. Validate there against the
   checklist in the tracking issue, then `Update visibility -> Public`.

AWS publishes ranges rather than an SLA: 7-10 business days to publish an
initial version, 2-4 calendar weeks in total, and it asks for a completed
request and AMI **45 days before** any announcement that depends on it.

## Version updates (~30 min plus review)

1. Confirm the new tag exists on `ghcr.io/libredb/libredb-studio`.
2. Run the **AWS AMI Build** workflow with the new version — it rebuilds on a
   freshly patched Ubuntu and re-pins the digest.
3. Launch from the raw AMI and walk the short checklist: health, login, reload
   (the `AUTH_COOKIE_SECURE` trap), rotation, reboot.
4. Portal -> Request changes -> Add new version, with the same ingestion role,
   `ubuntu`, port 22, endpoint `http` `/` `3000`, and the Region set recorded in
   `listing/listing-fields.md` — automatic enrolment in future Regions is off, so
   Regions are chosen per version rather than inherited.
5. Once the new version is live, restrict the previous one. Do **not** deregister
   an AMI or delete its snapshot while a version request is in flight.

Standing obligations: an AMI may not be older than two years, a version
restricted for over two years is archived automatically, and AWS scans listed
products continuously — treat a compliance email as a release-blocking bug.
