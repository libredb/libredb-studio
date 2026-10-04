/**
 * Unit tests for the DigitalOcean 1-Click Droplet build (deploy/digitalocean/droplet).
 *
 * Nothing here reaches DigitalOcean. These assert the invariants whose violation is
 * invisible in a green Packer build and only surfaces on a buyer's Droplet: an
 * environment file written without the flag that makes plain-HTTP login work, a
 * secret that stopped being generated per instance, or an env file that stopped
 * being written with a restrictive mode.
 *
 * The AWS sibling is guarded the same way in aws-ami-descriptor.test.ts. The two
 * images ship the same shape - a bare VM reached over plain HTTP at :3000 with no
 * name of its own - so they need the same invariants held.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MISSING_POSIX_FILE_MODES, missingPosixShell, posixShell, testIf } from "../helpers/posix-tools";

const DROPLET = path.join(__dirname, "../../deploy/digitalocean/droplet");
const read = (relative: string): string => fs.readFileSync(path.join(DROPLET, relative), "utf8");

const firstBoot = read("files/var/lib/cloud/scripts/per-instance/99-libredb-first-boot.sh");
const unit = read("files/etc/systemd/system/libredb-studio.service");
const configure = read("scripts/02-configure.sh");
const template = read("template.pkr.hcl");
const motd = read("files/etc/update-motd.d/99-libredb-studio");

/**
 * The script with its full-line comments stripped. The comment above the heredoc
 * names "umask 077", the temp file and the move in prose, so an assertion that
 * indexes the whole script can be satisfied by the comment alone: deleting the
 * code and keeping the prose would still pass. Only the code may prove these
 * properties, so every write-discipline assertion below indexes this copy. The
 * heredoc body holds no line starting with '#', so the strip is safe.
 */
const code = firstBoot
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/**
 * The body of the heredoc that becomes /etc/libredb-studio.env, and nothing else.
 * Asserting against the whole script would match the explanatory comments above it,
 * which name the same variables: a test that passes because of a comment is worse
 * than no test.
 */
const OPEN = "cat > /etc/libredb-studio.env.tmp <<EOF\n";
const envFile = (() => {
  const start = firstBoot.indexOf(OPEN);
  if (start < 0) throw new Error("the first-boot script no longer writes the env file with a heredoc");
  const body = firstBoot.slice(start + OPEN.length);
  const end = body.indexOf("\nEOF");
  if (end < 0) throw new Error("the heredoc that writes the env file is not terminated");
  return body.slice(0, end);
})();

describe("DigitalOcean Droplet first boot", () => {
  test("credentials are generated per instance", () => {
    expect(firstBoot).toMatch(/JWT_SECRET=\$\(openssl rand -base64 48\)/);
    expect(firstBoot).toMatch(/ADMIN_PASSWORD=\$\(openssl rand -hex 12\)/);
    expect(firstBoot).toMatch(/USER_PASSWORD=\$\(openssl rand -hex 12\)/);
  });

  test("the environment file carries AUTH_COOKIE_SECURE=false", () => {
    // The Droplet is reached at http://<ip>:3000, which is plain HTTP on a host
    // that is not loopback. Without this line the auth cookie is marked Secure,
    // the browser discards it, and login loops back to the sign-in page while
    // /api/db/health keeps answering healthy. The AWS AMI writes the same line
    // for the same reason; src/lib/auth.ts holds the rule that decides it.
    expect(envFile.split("\n")).toContain("AUTH_COOKIE_SECURE=false");
  });

  test("the environment file is never created world-readable", () => {
    // cloud-init runs per-instance scripts with umask 0022, so a plain redirect
    // would create the file 0644 with live secrets in it and only narrow the
    // mode afterwards. The AWS image writes the env file under umask 077 into a
    // temp file and moves it into place; this is the same shape. The assertions
    // index the comment-stripped script: the comment above the heredoc contains
    // "umask 077" too, and a test that could match it would pass with the code
    // deleted.
    const umaskAt = code.indexOf("umask 077");
    const heredocAt = code.indexOf("cat > /etc/libredb-studio.env.tmp");
    expect(umaskAt).toBeGreaterThan(0);
    expect(umaskAt).toBeLessThan(heredocAt);
    // Ordering alone is not the property: `( umask 077 )` closed before the
    // heredoc restores the world-readable window while keeping the order.
    expect(code.slice(umaskAt, heredocAt)).not.toContain(")");
  });

  test("the environment file is installed atomically with a restrictive mode", () => {
    expect(code).not.toContain("cat > /etc/libredb-studio.env <<EOF");
    // Presence is not the property either: with chmod after the move, the temp
    // file is gone by the time chmod runs, set -e kills the script before the
    // unit is ever enabled, and both lines are still in the file. The mode fix
    // has to land on the temp file before the move makes it visible.
    const chmodAt = code.indexOf("chmod 600 /etc/libredb-studio.env.tmp");
    const mvAt = code.indexOf("mv /etc/libredb-studio.env.tmp /etc/libredb-studio.env");
    expect(chmodAt).toBeGreaterThan(0);
    expect(mvAt).toBeGreaterThan(chmodAt);
  });

  test("no comment leaks into the environment file", () => {
    // The heredoc is copied verbatim into /etc/libredb-studio.env, which systemd
    // reads as KEY=value. A '#' line inside it would be written to the file.
    for (const line of envFile.split("\n").filter((l) => l.trim() !== "")) {
      expect(line).toMatch(/^[A-Z_][A-Z0-9_]*=/);
    }
  });
});

/**
 * The optional DigitalOcean Managed Database (marketplace-partners README, section 5). The
 * helper's own behaviour is executed in digitalocean-dbaas-seed.test.ts; these hold the wiring
 * around it, where a break is just as silent: a seed file Studio never sees because the mount
 * and SEED_CONFIG_PATH disagree, or a helper the image cannot execute.
 */
describe("DigitalOcean Droplet managed database wiring", () => {
  test("the seed file first boot writes is the one the container is pointed at", () => {
    const seedFile = /^SEED_FILE=(\S+)$/m.exec(code)?.[1];
    const mount = /-v (\S+):(\S+):ro/.exec(unit);
    const configPath = /SEED_CONFIG_PATH=(\S+?)\\n/.exec(code)?.[1];
    expect(seedFile).toBeDefined();
    expect(mount).not.toBeNull();
    expect(path.posix.dirname(seedFile!)).toBe(mount![1]);
    expect(configPath).toBe(path.posix.join(mount![2], path.posix.basename(seedFile!)));
  });

  test("without the credentials file nothing is added to the environment", () => {
    // The helper runs only under the file test, and the extra env lines are written only
    // when it succeeded, so a Droplet created without a database boots exactly as before.
    const guardAt = code.indexOf('if [ -f "$DBAAS_CREDENTIALS" ]; then');
    const helperAt = code.indexOf("/usr/local/sbin/libredb-do-dbaas-seed");
    expect(guardAt).toBeGreaterThan(0);
    expect(helperAt).toBeGreaterThan(guardAt);
    const appendAt = code.indexOf('if [ -n "$DBAAS_ENV" ]; then');
    expect(appendAt).toBeGreaterThan(code.indexOf(OPEN));
    expect(code.indexOf("SEED_CONFIG_PATH=")).toBeGreaterThan(appendAt);
    expect(envFile).not.toContain("SEED_CONFIG_PATH");
  });

  test("the password lines are appended inside the umask, before the mode fix and the move", () => {
    const umaskAt = code.indexOf("umask 077");
    const appendAt = code.indexOf("printf '%s\\n' \"$DBAAS_ENV\" >> /etc/libredb-studio.env.tmp");
    const closeAt = code.indexOf(")", appendAt);
    expect(appendAt).toBeGreaterThan(umaskAt);
    expect(code.slice(umaskAt, appendAt)).not.toMatch(/^\)/m);
    expect(closeAt).toBeLessThan(code.indexOf("chmod 600 /etc/libredb-studio.env.tmp"));
  });

  test("every run starts from a clean seed and status, so an old claim cannot survive", () => {
    // per-instance runs again on a Droplet created from a customer's own snapshot. If the
    // credentials file is gone by then, the guard below skips the helper, and a seed file
    // and a "connected" status left from the first instance would make the MOTD promise a
    // database Studio no longer loads.
    const cleanAt = code.indexOf('rm -f "$SEED_FILE" "$DBAAS_STATUS"');
    expect(cleanAt).toBeGreaterThan(0);
    expect(cleanAt).toBeLessThan(code.indexOf('if [ -f "$DBAAS_CREDENTIALS" ]; then'));
    expect(/^DBAAS_STATUS=(\S+)$/m.exec(code)?.[1]).toBe("/var/lib/libredb-studio/dbaas.status");
    expect(motd).toContain("DBAAS_STATUS=/var/lib/libredb-studio/dbaas.status");
  });

  test("the seed file is handed to the container group, never to everyone", () => {
    expect(code).toContain('chown root:libredb-studio "$SEED_FILE"');
    expect(code).toContain('chmod 640 "$SEED_FILE"');
    expect(configure).toContain("install -d -m 0750 -o root -g libredb-studio /etc/libredb-studio/seed");
  });

  test("the container's group id is reserved by name on the host", () => {
    // The image runs the app as nextjs:nodejs, gid 1001. On the host that id has no name, so
    // the second human login adduser creates would get group 1001 and read the seed
    // directory. Reserving it first makes adduser pick another id, and ls shows a name.
    const groupAt = configure.indexOf("groupadd --system --gid 1001 libredb-studio");
    expect(groupAt).toBeGreaterThan(0);
    expect(groupAt).toBeLessThan(configure.indexOf("install -d -m 0750 -o root -g libredb-studio"));
  });

  test("the image ships the helper and can execute it", () => {
    expect(template).toMatch(/source\s*=\s*"files\/usr\/"/);
    expect(configure).toContain("chmod +x /usr/local/sbin/libredb-do-dbaas-seed");
    expect(fs.existsSync(path.join(DROPLET, "files/usr/local/sbin/libredb-do-dbaas-seed"))).toBe(true);
  });
});

describe("DigitalOcean Droplet MOTD", () => {
  const SHELL = posixShell("bash");
  const CANNOT_RUN = missingPosixShell("bash") ?? MISSING_POSIX_FILE_MODES;

  /** The MOTD as pam_motd runs it, against a status file in a fixture and a curl that fails. */
  function render(status: string | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "do-motd-"));
    try {
      const statusPath = path.join(dir, "dbaas.status");
      if (status !== null) fs.writeFileSync(statusPath, status);
      const hook = path.join(dir, "99-libredb-studio");
      fs.writeFileSync(hook, motd.split("/var/lib/libredb-studio/dbaas.status").join(statusPath));
      fs.writeFileSync(path.join(dir, "curl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const run = Bun.spawnSync([SHELL!, hook], {
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
      });
      expect(run.exitCode).toBe(0);
      return new TextDecoder().decode(run.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  testIf(CANNOT_RUN, "says nothing about a database when none was created", () => {
    expect(render(null)).not.toContain("Database:");
  });

  testIf(CANNOT_RUN, "names the connection the admin will find in the sidebar", () => {
    const out = render(
      "DBAAS=connected\nDBAAS_CONNECTION=DigitalOcean Managed PostgreSQL: database defaultdb, user doadmin\n",
    );
    expect(out).toContain("admin role only");
    expect(out).toContain("DigitalOcean Managed PostgreSQL: database defaultdb, user doadmin");
  });

  testIf(CANNOT_RUN, "says plainly when the database was not added, and why", () => {
    const out = render('DBAAS=error\nDBAAS_DETAIL=db_protocol "mongodb" is not an engine this image connects\n');
    expect(out).toContain("NOT added to Studio");
    expect(out).toContain('db_protocol "mongodb"');
    expect(out).toContain("/root/.digitalocean_dbaas_credentials");
  });
});
