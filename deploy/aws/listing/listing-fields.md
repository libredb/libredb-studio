# AWS Marketplace listing fields

Every value a human pastes into the AWS Marketplace Management Portal for the
free AMI product. The portal is the only place these exist, so this file is the
source of truth for what was entered and the reason a reviewer can be answered
without re-deriving it.

`tests/unit/aws-listing-fields.test.ts` reads the `<!-- limit:N -->` markers and
enforces them, along with the character set the portal accepts (ASCII 0-126 plus
(R), (C), (TM) and currency symbols). The engine count is checked against the
code by the repo-wide catalog gate, not by a number kept here.

<!-- engines:16 -->

## Product title

<!-- limit:72 -->

LibreDB Studio

## Product description

Held in `description.md` so the AMI's own `ami_description` can repeat its first
sentence verbatim, which is what the AMI product checklist asks for.

## Product highlights

<!-- limit:3 -->

- Sixteen engines behind one interface, among them PostgreSQL, MySQL, Oracle, SQL Server, MongoDB, Redis, ClickHouse and Trino.
- AI query assistance using your own model key, or run it with no AI at all.
- Self-hosted on a single instance: connections, query history and results stay in your account.

## Search keywords

<!-- limit:3 --> <!-- total:250 -->

- SQL IDE
- database client
- PostgreSQL

## Categories

Developer Tools; Database. Pick the closest subcategories the portal offers.

## Region availability

Thirty-three of the 36 Regions the portal lists. The two GovCloud Regions are
excluded because they need a separately verified account, and me-central-1
because t3.small does not exist there - a Region carrying none of the listed
instance types fails the submission with INSTANCE_TYPES_NOT_AVAILABLE. Automatic
enrolment in future Regions is off, because a new Region can open without
t3.small and would fail the same way.

## Pricing

Free. The buyer pays only for the EC2 instance, EBS storage and data transfer
they use. No software charges, no metering, no contract.

## Version fields

| Field | Value |
|---|---|
| Version title | The app version being shipped - `0.14.1` for the initial listing |
| AMI ID | From the AWS AMI Build job summary; must exist in us-east-1 in the seller account with an unencrypted snapshot |
| IAM access role ARN | The AMI ingestion role, published by the build job summary from the `AWS_AMI_INGESTION_ROLE_ARN` repository variable - one source, so the two cannot drift |
| Operating system | Ubuntu 24.04 |
| OS user name | `ubuntu` (Canonical's default; the field states reality, not AWS's `ec2-user` recommendation) |
| Scanning port | `22` |
| Endpoint URL | protocol `http`, relative URL `/`, port `3000` |
| Release notes | Link to the GitHub release plus a one-line summary, labelled Critical, Important or Optional |

## Instance types

Recommended: `t3.small` (2 vCPU / 2 GiB). Also enable `t3.medium`, `t3.large`
and a couple of `m5`/`c5` sizes. Do not enable 1 GiB types: the app requests
256 MiB and is capped at 512 MiB in the Helm defaults, but Docker plus the Node
runtime on 1 GiB is a support burden rather than a saving.

`t3.small` is burstable on purpose. This is an interactive IDE that idles
between queries, which is the workload T-family credits exist for. A buyer who
drives sustained CPU (very large result sets, continuous imports) should pick an
`m5`/`c5` size. No model inference runs on the instance: AI assistance calls
whatever endpoint `LLM_API_URL` names, so it costs an HTTP request, not CPU.

## Security group recommendations

| Protocol | Port | Source |
|---|---|---|
| TCP | 3000 | The buyer's own CIDR - never 0.0.0.0/0 |
| TCP | 22 | The buyer's own CIDR |

The standalone AMI serves plain HTTP, so the session cookie travels in
cleartext. The usage instructions say this in the same words, and say that
fronting the instance with a load balancer or CloudFront is how a buyer gets
TLS today.

## Usage instructions

Held in `usage-instructions.md`. AWS's own guide for this field states the
mandatory content but no character limit, so there is no `<!-- limit:N -->`
marker to enforce - check the portal's own counter when pasting.

## Support

| Field | Value |
|---|---|
| Support email | The address in the `AWS_SUPPORT_EMAIL` repository variable - the same mailbox the build prints into every buyer's banner, so the two cannot drift |
| Support phone | The number on the seller-account profile |
| Support website | https://github.com/libredb/libredb-studio/issues |

## EULA and refunds

EULA: the Standard Contract for AWS Marketplace (SCMP), chosen for the initial
listing. The MIT licence text is the alternative and remains available through an
update request - which of the two carries less risk for a free product is a legal
decision, not an engineering one.

Refund policy: the product is free and incurs no software charges, so no
refunds apply. AWS infrastructure charges are handled by AWS.
