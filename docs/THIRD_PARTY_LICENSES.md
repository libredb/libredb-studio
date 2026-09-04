# Third-Party Licenses

LibreDB Studio itself is distributed under the MIT License (see [`LICENSE`](../LICENSE)). One direct
production dependency carries different terms:

| Package | License | Used at |
| --- | --- | --- |
| [`elkjs`](https://github.com/kieler/elkjs) | [EPL-2.0](https://www.eclipse.org/legal/epl-2.0/) (offered as `EPL-2.0 OR GPL-3.0-or-later`; this project takes it under EPL-2.0) | `src/components/schema-diagram/elk.worker.ts`, unmodified, for the schema diagram's layered orthogonal layout |

EPL-2.0 is a file-level reciprocal license with a patent-retaliation clause. elkjs is used
unmodified. Its license text ships with the package at `node_modules/elkjs/LICENSE.md`; the source
is at the repository linked above. The distributed bundle is therefore MIT plus EPL-2.0, not pure
MIT.

See `docs/BACKLOG.md` entry C8 for the broader, not-yet-generated NOTICE this file is a manual
precursor to.
