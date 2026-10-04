# Third-Party Licenses

LibreDB Studio itself is distributed under the MIT License (see [`LICENSE`](../LICENSE)).
Two direct production dependencies carry terms beyond the MIT notice their package ships:

| Package | License | Used at |
| --- | --- | --- |
| [`elkjs`](https://github.com/kieler/elkjs) | [EPL-2.0](https://www.eclipse.org/legal/epl-2.0/) (offered as `EPL-2.0 OR GPL-3.0-or-later`; this project takes it under EPL-2.0) | `src/components/schema-diagram/elk.worker.ts`, unmodified, for the schema diagram's layered orthogonal layout |
| [`db2-node`](https://github.com/gurungabit/db2-node) | MIT for the package; its prebuilt `.node` addons statically link 62 Rust crates under MIT, Apache-2.0, ISC, BSD-3-Clause and ICU terms, among them `rustls` (Apache-2.0 OR ISC OR MIT), `rustls-webpki` (ISC), `ring` (Apache-2.0 AND ISC), `untrusted` (ISC), `subtle` (BSD-3-Clause), `dec` (Apache-2.0) and `decnumber-sys` (ICU) | the Db2 provider, loaded at runtime as `node_modules/db2-node/db2-node.<platform>.node` |

EPL-2.0 is a file-level reciprocal license with a patent-retaliation clause. elkjs is used
unmodified. Its license text ships with the package at `node_modules/elkjs/LICENSE.md`; the source
is at the repository linked above. The distributed bundle is therefore MIT plus EPL-2.0, not pure
MIT.

The db2-node npm tarball ships no LICENSE file and no notices for the crates compiled into its addons, so those notices travel in [`THIRD_PARTY_NOTICES.txt`](../THIRD_PARTY_NOTICES.txt) at the repository root.
Every Docker image copies it into `/app`, and the standalone payload carries it at its root, so every tarball, package and desktop bundle built from the payload carries it too.
It holds the db2-node MIT text and, for each crate, the license text it ships: the MIT text where the crate offers MIT among its choices, and every license file otherwise.
`scripts/generate-db2-node-notices.sh` writes it from the upstream `Cargo.lock` at the 1.0.25 gitHead (ae5730e1), with the crate set Cargo links into the addon for the eight targets the package ships; it is never edited by hand.
`decnumber-sys` vendors IBM's decNumber C library, which is where the ICU terms come from.
Apache-2.0 section 4(d) would require carrying any NOTICE file an Apache-licensed crate ships; none of the 62 does, and the generator fails if one starts to.
The CycloneDX SBOM the release workflow publishes is built from the npm dependency graph and cannot see these crates, so this file and the notices file are the only places they are declared.

The Graph tab's canvas library and its layout carry only the MIT notice each package ships, and are recorded here because fcose arrives with two transitive packages that `package.json` does not name:

| Package | Version | License | Reached as |
| --- | --- | --- | --- |
| [`cytoscape`](https://github.com/cytoscape/cytoscape.js) | 3.34.3 | MIT | direct dependency, no runtime dependencies of its own |
| [`cytoscape-fcose`](https://github.com/iVis-at-Bilkent/cytoscape.js-fcose) | 2.2.0 | MIT | direct dependency |
| [`cose-base`](https://github.com/iVis-at-Bilkent/cose-base) | 2.2.0 | MIT | dependency of `cytoscape-fcose` |
| [`layout-base`](https://github.com/iVis-at-Bilkent/layout-base) | 2.0.1 | MIT | dependency of `cose-base` |

Each ships its LICENSE file in the package; all four were read on 2026-10-03.
Only `src/components/results-graph/cytoscape-host.ts` loads them, and only through a dynamic import, so importing that module loads neither package.

The Oxia provider vendors two protocol definitions, unmodified, and ships the descriptor generated from them:

| File | Upstream | License |
| --- | --- | --- |
| `src/lib/db/providers/keyvalue/oxia/proto/client.proto` | [`oxia-db/oxia`](https://github.com/oxia-db/oxia) `common/proto/client.proto` at tag `v0.16.10`, commit `c72b0bfce3fa0058fe200462b64f0d502dd56b02` | Apache-2.0, copyright The Oxia Authors |
| `src/lib/db/providers/keyvalue/oxia/proto/grpc/health/v1/health.proto` | [`grpc/grpc-proto`](https://github.com/grpc/grpc-proto) `grpc/health/v1/health.proto` at commit `2eb777aba6593c31e21f7f69a163486bdc793501` | Apache-2.0, copyright The gRPC Authors |

Each file keeps its upstream license header, and each upstream's `LICENSE` is vendored beside it (`proto/LICENSE`, `proto/grpc/LICENSE`), with Oxia's `NOTICE` (`proto/NOTICE`); `proto/README.md` records every file's SHA-256, which `tests/unit/db/oxia/descriptor.test.ts` holds.
`grpc/grpc-proto` ships no NOTICE file at that commit.
The etcd provider vendors etcd's v3 API definitions from [`etcd-io/etcd`](https://github.com/etcd-io/etcd) at tag `v3.7.2` (commit `68c065e562994b89e333e77b039ad066f933c586`), Apache-2.0, with upstream's `LICENSE` beside them (`src/lib/db/providers/keyvalue/etcd/proto/LICENSE`).
The Milvus provider vendors Milvus's API definitions from [`milvus-io/milvus-proto`](https://github.com/milvus-io/milvus-proto) at tag `go-api/v3.0.2` (commit `9e4f0ebc92af3ecf9e13c12350c6fce13d0893fa`), Apache-2.0, with upstream's `LICENSE` beside them (`src/lib/db/providers/vector/milvus/proto/LICENSE`).

See `docs/BACKLOG.md` entry C8 for the broader, not-yet-generated NOTICE this file is a manual
precursor to.
