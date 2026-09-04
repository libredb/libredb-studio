# Third-Party Licenses

LibreDB Studio itself is distributed under the MIT License (see [`LICENSE`](../LICENSE)). One direct
production dependency carries different terms:

| Package | License | Used at |
| --- | --- | --- |
| [`elkjs`](https://github.com/kieler/elkjs) `^0.12.0` | [EPL-2.0](https://www.eclipse.org/legal/epl-2.0/) | `src/components/schema-diagram/elk.worker.ts`, unmodified, for the schema diagram's layered orthogonal layout |

EPL-2.0 is a file-level reciprocal license with a patent-retaliation clause. `elkjs` is used
unmodified, which is the case the license is comfortable with, so nothing beyond disclosure is
required — but the distributed bundle is MIT-plus-EPL-2.0 rather than pure MIT, and that is worth
stating openly rather than leaving implicit.

See `docs/BACKLOG.md` entry C8 for the broader, not-yet-generated NOTICE this file is a manual
precursor to.
