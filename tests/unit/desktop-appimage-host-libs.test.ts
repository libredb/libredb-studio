/**
 * Unit test for the host-only libwayland-client of the desktop AppImage (issue #1222).
 *
 * linuxdeploy bundles libwayland-client from the build host, and AppRun.wrapped puts the AppDir's
 * usr/lib ahead of the host's. The host's Mesa EGL driver links libwayland-client and is built
 * against the host's copy, so a newer Mesa cannot load against the bundled one.
 * Measured on the 0.17.0 x64 AppImage (built on Ubuntu 22.04) in an Ubuntu 26.04 container
 * (Mesa 26.0.8, libwayland 1.24.0) under Xvfb: libEGL_mesa.so.0 fails with "undefined symbol:
 * wl_fixes_interface", WebKit's web process aborts with "Could not create default EGL display:
 * EGL_BAD_PARAMETER" and the window stays white. With the bundled libwayland-client removed the
 * workspace renders. Removing all four libwayland libraries instead made the app fail to start
 * there with "libwayland-server.so.0: cannot open shared object file", because only WebKitGTK pulls
 * libwayland-server onto a host, while Mesa's EGL package depends on libwayland-client.
 *
 * Asserted as text, as `tests/unit/desktop-appimage-payload-prune.test.ts` does, because a real
 * AppImage build is out of reach in a unit test; the runtime proof is the smoke step itself, which
 * the Flatpak Smoke workflow runs on every change to the script.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(import.meta.dir, "../../scripts/build-desktop-appimage.sh"), "utf8");
const PRUNE = 'rm -f "$PERM_DIR"/squashfs-root/usr/lib/libwayland-client.so.*';
const EXTRACT = '(cd "$PERM_DIR" && "$BUILT" --appimage-extract > /dev/null)';

describe("the AppImage ships without the build host's libwayland-client", () => {
  test("the extracted AppDir has libwayland-client removed", () => {
    expect(script).toContain(PRUNE);
  });

  test("the removal runs after the bundler's image is extracted and before it is repacked", () => {
    const pruneIndex = script.indexOf(PRUNE);
    expect(pruneIndex).toBeGreaterThan(script.indexOf(EXTRACT));
    expect(pruneIndex).toBeLessThan(script.indexOf("mksquashfs"));
  });

  test("the image is repacked unconditionally, not only when the permission audit fails", () => {
    // Inside the `if [ "$DEB_ONLY" != "true" ]` block, so two spaces deep. A repack nested in the
    // permission audit's branch would sit four deep and ship the bundled libwayland-client whenever the
    // bundler happened to leave every mode readable.
    expect(script).toMatch(/\n {2}mksquashfs "\$PERM_DIR\/squashfs-root"/);
  });

  test("no other libwayland library is removed, since a host without WebKitGTK has no libwayland-server", () => {
    expect(script).not.toContain("usr/lib/libwayland-*");
  });

  test("the smoke step fails when the shipped AppImage still carries libwayland-client", () => {
    const smokeIndex = script.indexOf('echo "==> Smoke: extracting the AppImage"');
    const checkIndex = script.indexOf("find \"$APPDIR/usr/lib\" -maxdepth 1 -name 'libwayland-client.so*'");
    expect(checkIndex).toBeGreaterThan(smokeIndex);
  });
});
