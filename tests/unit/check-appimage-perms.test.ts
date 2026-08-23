/**
 * Unit tests for the AppImage permission audit (scripts/check-appimage-perms.mjs).
 *
 * Why this exists at all: linuxdeploy writes the wrapped launcher into the
 * AppDir as `0770 root:root`, and the AppImage runtime hides that from the one
 * case everybody tests. A type-2 AppImage mounts its squashfs through FUSE
 * privately to the invoking user, and a private FUSE mount skips the kernel's
 * permission check - so double-clicking works no matter what the recorded mode
 * says. The moment the same bytes are read with real permission checks (an
 * extracted AppDir owned by another uid, a container running as non-root, or
 * firejail's `--appimage` mount, which is what AppImageHub's review CI uses)
 * `AppRun` cannot exec `AppRun.wrapped` and the app dies with a bare
 * `Permission denied`.
 *
 * Measured on the released 0.13.2 artifact: `-rwxrwx--- root/root
 * AppRun.wrapped`, reproduced as uid 1000 over root-owned files, and fixed by
 * the same file at 0755.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { auditAppDirPermissions, formatOffenders } from "../../scripts/check-appimage-perms.mjs";

/** Build a throwaway AppDir. `entries` maps a relative path to its octal mode. */
const appDir = (entries: Record<string, number>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appdir-perms-"));
  for (const [rel, mode] of Object.entries(entries)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "x");
    fs.chmodSync(target, mode);
  }
  return root;
};

describe("auditAppDirPermissions", () => {
  test("passes an AppDir whose files are all world-readable", () => {
    const root = appDir({ AppRun: 0o755, "usr/bin/app": 0o755, "usr/share/icon.png": 0o644 });
    expect(auditAppDirPermissions(root)).toEqual([]);
  });

  test("reports an owner-executable file that is not world-executable", () => {
    // The exact shape of the defect: 0770 executes for the builder's uid and
    // nobody else.
    const root = appDir({ AppRun: 0o755, "AppRun.wrapped": 0o770 });
    const offenders = auditAppDirPermissions(root);
    expect(offenders).toEqual([{ path: "AppRun.wrapped", mode: "0770", reason: "not world-executable" }]);
  });

  test("reports a plain file that is not world-readable", () => {
    const root = appDir({ "usr/share/data.json": 0o640 });
    expect(auditAppDirPermissions(root)).toEqual([
      { path: "usr/share/data.json", mode: "0640", reason: "not world-readable" },
    ]);
  });

  test("walks nested directories and returns offenders in a stable order", () => {
    const root = appDir({
      "usr/lib/b.so": 0o640,
      "usr/bin/a": 0o770,
      AppRun: 0o755,
    });
    expect(auditAppDirPermissions(root).map((o) => o.path)).toEqual(["usr/bin/a", "usr/lib/b.so"]);
  });

  test("ignores a symlink rather than reporting the mode of its own inode", () => {
    // .DirIcon is a symlink in every AppImage this repo builds, and a symlink's
    // own mode is 0777 on Linux and meaningless - what matters is its target,
    // which is walked on its own.
    const root = appDir({ "usr/share/icons/hicolor/32x32/apps/app.png": 0o644 });
    fs.symlinkSync("usr/share/icons/hicolor/32x32/apps/app.png", path.join(root, ".DirIcon"));
    expect(auditAppDirPermissions(root)).toEqual([]);
  });

  test("throws when the directory does not exist, rather than reporting a clean audit", () => {
    // A silent pass on a mistyped path would turn this gate into decoration.
    expect(() => auditAppDirPermissions(path.join(os.tmpdir(), "appdir-perms-absent-xyz"))).toThrow(/not a directory/);
  });
});

describe("formatOffenders", () => {
  test("renders one line per offender with its mode and reason", () => {
    expect(formatOffenders([{ path: "AppRun.wrapped", mode: "0770", reason: "not world-executable" }])).toBe(
      "  0770 AppRun.wrapped (not world-executable)",
    );
  });

  test("renders an empty string for a clean audit", () => {
    expect(formatOffenders([])).toBe("");
  });
});
