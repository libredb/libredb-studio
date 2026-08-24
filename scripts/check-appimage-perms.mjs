#!/usr/bin/env node
/**
 * Audit an extracted AppImage AppDir for file modes that only its builder can use.
 *
 * linuxdeploy writes the wrapped launcher as `0770 root:root`, and the AppImage
 * runtime hides that from the only case anyone tests: a type-2 AppImage mounts
 * its squashfs through FUSE privately to the invoking user, and a private FUSE
 * mount skips the kernel permission check, so double-clicking works whatever the
 * recorded mode says. Read the same bytes with real permission checks - an
 * extracted AppDir owned by another uid, a container running as non-root, or
 * firejail's `--appimage` mount, which is what AppImageHub's review CI uses -
 * and `AppRun` cannot exec `AppRun.wrapped`: the app dies with a bare
 * `Permission denied` and never opens a window.
 *
 * So the artifact needs a gate no user-facing symptom would give us in time.
 * `scripts/build-desktop-appimage.sh` runs this over the extracted AppDir, and
 * repacks the image with the offending modes widened when it fails.
 *
 * Usage:
 *   node scripts/check-appimage-perms.mjs <extracted-appdir>
 *
 * Exit 0 when every regular file is world-readable, and world-executable
 * wherever its owner can execute it. Exit 1 listing the offenders otherwise.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * Walk `root` and return the regular files whose mode would deny a user who is
 * not the owner. Symlinks are skipped: their own mode is 0777 on Linux and says
 * nothing, and their target is walked on its own.
 *
 * @param {string} root
 * @returns {{path: string, mode: string, reason: string}[]} offenders, sorted by path
 */
export function auditAppDirPermissions(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`check-appimage-perms: ${root} is not a directory`);
  }
  const offenders = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const mode = fs.statSync(full).mode & 0o7777;
      const rel = path.relative(root, full);
      const printed = `0${(mode & 0o777).toString(8)}`;
      // Executability is reported first on purpose: 0770 fails both checks, and
      // the failure a user actually hits is the exec of AppRun.wrapped.
      if ((mode & 0o100) !== 0 && (mode & 0o001) === 0) {
        offenders.push({ path: rel, mode: printed, reason: "not world-executable" });
      } else if ((mode & 0o004) === 0) {
        offenders.push({ path: rel, mode: printed, reason: "not world-readable" });
      }
    }
  };
  walk(root);
  return offenders.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * @param {{path: string, mode: string, reason: string}[]} offenders
 * @returns {string} one indented line per offender, empty for a clean audit
 */
export function formatOffenders(offenders) {
  return offenders.map((o) => `  ${o.mode} ${o.path} (${o.reason})`).join("\n");
}

/** @param {string[]} argv */
function main(argv) {
  const [root] = argv;
  if (!root) {
    console.error("Usage: node scripts/check-appimage-perms.mjs <extracted-appdir>");
    process.exit(2);
  }
  const offenders = auditAppDirPermissions(root);
  if (offenders.length > 0) {
    console.error(`check-appimage-perms: ${offenders.length} file(s) are unusable for anyone but the owner:`);
    console.error(formatOffenders(offenders));
    process.exit(1);
  }
  console.log("check-appimage-perms: OK - every bundled file is world-readable");
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
