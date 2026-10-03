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
`scripts/generate-db2-node-notices.sh` writes it from the upstream `Cargo.lock` at the 1.0.22 gitHead (68264e06), with the crate set Cargo links into the addon for the eight targets the package ships; it is never edited by hand.
`decnumber-sys` vendors IBM's decNumber C library, which is where the ICU terms come from.
Apache-2.0 section 4(d) would require carrying any NOTICE file an Apache-licensed crate ships; none of the 62 does, and the generator fails if one starts to.
The CycloneDX SBOM the release workflow publishes is built from the npm dependency graph and cannot see these crates, so this file and the notices file are the only places they are declared.

See `docs/BACKLOG.md` entry C8 for the broader, not-yet-generated NOTICE this file is a manual
precursor to.
