/**
 * Threat: type errors reaching a published artifact.
 *
 * `typescript.ignoreBuildErrors` was true in this repository for a long time.
 * Removing it was measured first rather than assumed: with the flag off, a full
 * production build exits 0 today, and a deliberately injected
 * `const x: number = "s"` does fail it - so the check is both green and real.
 *
 * What the removal actually buys is narrow and worth naming, because a future
 * reader will otherwise assume it is redundant with `bun run typecheck`: both
 * read the same tsconfig.json, but `next build` REGENERATES .next/types from the
 * current route tree before checking, while `tsc --noEmit` reads whatever the
 * last build left on disk. After a route is added, renamed or deleted, typecheck
 * can pass against stale generated types where the build would not.
 *
 * This test exists because the flag is two lines and comes back easily during a
 * debugging session, and nothing else in the repository would notice.
 *
 * Sibling of tests/security/image-proxy.test.ts, which guards the same file's
 * `images` key for the same reason.
 */
import { describe, expect, test } from "bun:test";
import nextConfig from "../../next.config";

describe("next build type checking", () => {
  test("declares no typescript configuration at all", () => {
    // Not `ignoreBuildErrors === false` - the absent block IS the default, and
    // asserting absence also catches `tsconfigPath` being pointed somewhere
    // laxer.
    expect(nextConfig.typescript).toBeUndefined();
  });
});
