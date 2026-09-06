/**
 * Unit tests for the AWS Marketplace AMI build descriptors (deploy/aws/ami).
 *
 * Nothing here reaches AWS. These assert the invariants whose violation is
 * invisible in a green Packer build and only surfaces on a buyer's instance or
 * in a rejected submission: a build-time token that never got substituted, a
 * first-boot unit that starts a unit ordered after it (five minutes of boot
 * stall), a credential republished world-readable through the MOTD cache, a
 * base image that is silently Ubuntu Pro (unlistable), or an SSH drop-in that
 * became a no-op because Ubuntu's own config already answers the way we want.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const AMI = path.join(__dirname, "../../deploy/aws/ami");
const read = (relative: string): string => fs.readFileSync(path.join(AMI, relative), "utf8");

const template = read("template.pkr.hcl");
const install = read("scripts/01-install.sh");
const configure = read("scripts/02-configure.sh");
const cleanup = read("scripts/90-cleanup.sh");
const firstbootUnit = read("files/etc/systemd/system/libredb-firstboot.service");
const studioUnit = read("files/etc/systemd/system/libredb-studio.service");
const bannerUnit = read("files/etc/systemd/system/libredb-banner.service");
const firstboot = read("files/usr/local/sbin/libredb-firstboot");
const banner = read("files/usr/local/sbin/libredb-banner");
const motd = read("files/etc/update-motd.d/99-libredb-studio");
const sshd = read("files/etc/ssh/sshd_config.d/00-libredb-marketplace.conf");

/** Every file shipped into the image, for the sweeps that must cover all of them. */
const filesDir = path.join(AMI, "files");
const shippedFiles = fs
  .readdirSync(filesDir, { recursive: true, encoding: "utf8" })
  .map((entry) => path.join(filesDir, entry))
  .filter((entry) => fs.statSync(entry).isFile());

describe("AWS AMI Packer template", () => {
  test("builds in us-east-1 and requires IMDSv2", () => {
    // "Source AMIs for AWS Marketplace must be provided in the US East
    // (N. Virginia) Region"; IMDSv2-only is written as a requirement in the
    // best-practices page, so it is not the first knob to loosen.
    expect(template).toMatch(/region\s*=\s*"us-east-1"/);
    expect(template).toMatch(/imds_support\s*=\s*"v2\.0"/);
  });

  test("resolves the Canonical server base image instead of hardcoding an AMI id", () => {
    // A base AMI carrying a billingProducts code (Ubuntu Pro) cannot be
    // re-listed, and the product travels with copies and snapshots. The SSM
    // path names the product as a path segment, so nothing is inferred.
    expect(template).not.toMatch(/source_ami\s*=\s*"ami-/);
    expect(template).toMatch(/canonical\/ubuntu\/server\/24\.04\/stable\/current\/amd64\/hvm\/ebs-gp3\/ami-id/);
    if (template.includes("source_ami_filter")) {
      expect(template).toMatch(/owners\s*=\s*\["099720109477"\]/);
      const filterName = /name\s*=\s*"([^"]*ubuntu[^"]*)"/.exec(template)?.[1] ?? "";
      expect(filterName).not.toMatch(/pro|minimal/);
    }
  });

  test("no provisioner reads a build variable without passing it through", () => {
    // `set -u` aborts on the unset variable, so the failure is loud - but it is
    // a wasted fifteen-minute build either way.
    const blocks = template.split(/provisioner\s+"/).slice(1);
    for (const block of blocks) {
      const body = block.slice(0, block.indexOf("\n  }"));
      const usesVar = /\$\{var\.(image_ref|version|support_email)\}/.test(body);
      const script = /script\s*=\s*"scripts\/(\d+-[a-z]+)\.sh"/.exec(body)?.[1] ?? "";
      const readsVar = /(IMAGE_REF|VERSION|SUPPORT_EMAIL)/.test(script ? read(`scripts/${script}.sh`) : body);
      if (usesVar || readsVar)
        expect({ script, hasEnv: /environment_vars/.test(body) }).toEqual({ script, hasEnv: true });
    }
  });

  test("the cleanup script is the last provisioner and asserts what it removed", () => {
    const lastProvisioner = template.lastIndexOf('provisioner "shell"');
    const cleanupPosition = template.indexOf("90-cleanup.sh");
    expect(cleanupPosition).toBeGreaterThan(0);
    expect(template.slice(lastProvisioner).includes("90-cleanup.sh")).toBe(true);
    expect(cleanup).toMatch(/authorized_keys/);
    expect(cleanup).toMatch(/\/etc\/ssh\/\*_key/);
  });

  test("the AMI name carries a time component and force_deregister stays off", () => {
    // EC2 AMI names are unique per account and Region, and rebuilding the same
    // version on the same day is the normal case (the scan loop does it). The
    // tempting cure - force_deregister - would deregister the AMI a version
    // request may be reading right now.
    expect(template).toMatch(/ami_name\s*=.*formatdate\("YYYYMMDD-hhmmss"/);
    expect(template).not.toMatch(/force_deregister\s*=\s*true/);
  });

  test("ami_description repeats the listing's first sentence verbatim", () => {
    const description = fs.readFileSync(path.join(AMI, "../listing/description.md"), "utf8");
    const firstSentence = description
      .split("\n")
      .filter((line) => !line.trim().startsWith("<!--") && !line.startsWith("#") && line.trim().length > 0)
      .join(" ")
      .trim()
      .split(". ")[0];
    const amiDescription = /ami_description\s*=\s*"([^"]+)"/.exec(template)?.[1] ?? "";
    expect(amiDescription).toContain("LibreDB Studio");
    expect(amiDescription).toContain(firstSentence);
    expect(amiDescription.replace("${var.version}", "0.14.0").length).toBeLessThanOrEqual(255);
  });
});

describe("AWS AMI build-time substitution", () => {
  test("every build-time token is substituted and the survivors fail the build", () => {
    for (const token of ["PINNED_IMAGE", "SUPPORT_CONTACT"]) {
      expect(configure).toContain(token);
      expect(configure).toMatch(new RegExp(`sed -i .*${token}`));
    }
    expect(configure).toMatch(/for token in PINNED_IMAGE SUPPORT_CONTACT/);
    expect(configure).toMatch(/exit 1/);
  });

  test("no shipped file carries an angle-bracket placeholder", () => {
    // `${VAR:-<something>}` is a shell default and legitimate; a bare
    // <placeholder> means a value nobody filled in.
    for (const file of shippedFiles) {
      const body = fs.readFileSync(file, "utf8").replace(/\$\{[^}]*:-<[^>]*>\}/g, "");
      // `<word-with-dashes>`, which is what an unfilled placeholder looks like -
      // not `<<EOF`, and not a `->` arrow that happens to follow an angle bracket.
      expect({ file, placeholder: /<[a-z][a-z0-9-]*>/i.exec(body)?.[0] ?? null }).toEqual({ file, placeholder: null });
    }
  });

  test("the support address is escaped for every metacharacter the template names", () => {
    // The Packer validation is the first lock and this is the second; an earlier
    // revision escaped only `&`, which left `|` - the delimiter - able to close
    // the expression and run a second sed command as root at build time.
    expect(configure).toMatch(/sed -e 's\/\[\\\\&\|\]\/\\\\&\/g'/);
  });

  test("both build variables are constrained by the template itself", () => {
    expect(template).toMatch(/condition\s*=\s*can\(regex\("\^\[A-Za-z0-9\._%\+-\]\+@/);
    expect(template).toMatch(/condition\s*=\s*can\(regex\("\^\[a-z0-9\._\/-\]\+@sha256:/);
  });

  test("the app image is pinned by digest and baked into the image", () => {
    expect(install).toMatch(/docker pull "\$\{IMAGE_REF\}"/);
    expect(template).toMatch(/variable "image_ref"/);
  });
});

describe("AWS AMI first boot", () => {
  test("nothing starts another unit at runtime", () => {
    // A unit ordered After= another cannot be started from inside it: the job
    // sits in the queue until the oneshot exits. Activation belongs to the
    // single `systemctl enable` in 02-configure.sh.
    for (const file of shippedFiles) {
      const body = fs.readFileSync(file, "utf8");
      expect({ file, start: /systemctl\s+(start|enable)/.exec(body)?.[0] ?? null }).toEqual({ file, start: null });
    }
    const enable = /systemctl enable ([^\n]+)/.exec(configure)?.[1] ?? "";
    for (const unit of ["libredb-firstboot.service", "libredb-studio.service", "libredb-banner.service"]) {
      expect(enable).toContain(unit);
    }
  });

  test("the firstboot to studio ordering edge survives", () => {
    // Losing it makes libredb-studio's ConditionPathExists a race whose loss is
    // silent and permanent until the buyer reboots. The plan writes the edge
    // from both ends; one is enough for the guarantee.
    const declared =
      /Before=libredb-studio\.service/.test(firstbootUnit) || /After=[^\n]*libredb-firstboot\.service/.test(studioUnit);
    expect(declared).toBe(true);
  });

  test("each unit runs only when its own input says so", () => {
    expect(firstbootUnit).toMatch(/ConditionPathExists=!\/etc\/libredb-studio\.env/);
    expect(firstbootUnit).toMatch(/Before=libredb-studio\.service/);
    expect(bannerUnit).toMatch(/ConditionPathExists=!\/etc\/libredb-studio\.info/);
    expect(bannerUnit).toMatch(/ConditionPathExists=\/etc\/libredb-studio\.env/);
    expect(bannerUnit).toMatch(/After=libredb-studio\.service/);
  });

  test("the app unit is the DigitalOcean shape with the AWS paths", () => {
    expect(studioUnit).toContain("PINNED_IMAGE");
    expect(studioUnit).toContain("-v /opt/libredb/data:/app/data");
    expect(studioUnit).toContain("--env-file /etc/libredb-studio.env");
    expect(studioUnit).toMatch(/ConditionPathExists=\/etc\/libredb-studio\.env/);
    expect(studioUnit).toMatch(/Wants=[^\n]*docker\.service/);
    expect(studioUnit).not.toMatch(/(Requires|BindsTo)=[^\n]*docker\.service/);
  });

  test("credentials are generated per instance and installed atomically", () => {
    expect(firstboot).toMatch(/openssl rand -base64 48/);
    expect(firstboot).toMatch(/openssl rand -hex 16/);
    expect(firstboot).toContain("AUTH_BOOTSTRAP=off");
    // Plain HTTP: without this the Secure cookie is dropped and login loops
    // while every health probe still passes.
    expect(firstboot).toContain("AUTH_COOKIE_SECURE=false");
    // AI assistance ships unconfigured - that is what keeps the listing clear
    // of the "ongoing external connection" policy.
    expect(firstboot).not.toMatch(/^\s*printf 'LLM_/m);
    expect(firstboot).toMatch(/chmod 600 \/etc\/libredb-studio\.env\.tmp/);
    expect(firstboot).toMatch(/mv \/etc\/libredb-studio\.env\.tmp \/etc\/libredb-studio\.env/);
  });
});

describe("AWS AMI banner and MOTD", () => {
  test("readiness is more than the liveness probe", () => {
    // GET /api/db/health returns a static payload without touching the database,
    // the SQLite store or the auth configuration, so on its own it would report
    // a healthy app that cannot serve a login page.
    expect(banner).toContain("/api/db/health");
    expect(banner).toContain("/login");
    expect(banner).toMatch(/docker inspect -f '\{\{\.State\.Running\}\}'/);
    expect(banner).toMatch(/FATAL: credentials missing/);
  });

  test("the banner file is never created world-readable", () => {
    // systemd runs the unit with UMask=0022, so a plain redirect would create the
    // file 0644 with a live password in it and only narrow the mode afterwards. A
    // kill in between leaves it that way forever, because the unit's own
    // condition stops it from running again.
    const umaskAt = banner.indexOf("umask 077");
    const heredocAt = banner.indexOf("cat > /etc/libredb-studio.info");
    expect(umaskAt).toBeGreaterThan(0);
    expect(umaskAt).toBeLessThan(heredocAt);
    // Ordering alone is not the property: `( umask 077 )` closed before the
    // heredoc restores the world-readable window while keeping the order.
    expect(banner.slice(umaskAt, heredocAt)).not.toContain(")");
  });

  test("the banner holds the password on exactly one line and is root-only", () => {
    const passwordLines = banner.split("\n").filter((line) => /^ {2}Password:/.test(line));
    expect(passwordLines).toHaveLength(1);
    expect(banner).toMatch(/chmod 600 \/etc\/libredb-studio\.info/);
  });

  test("the login greeting points at the file instead of reprinting the password", () => {
    // pam_motd caches hook output in /run/motd.dynamic under umask(0022) - mode
    // 0644 - so printing the value here republishes it world-readable at every
    // interactive login, and keeps showing the ORIGINAL password after rotation.
    expect(motd).toMatch(/sed 's\|\^ {0,2} {2}Password:|sed 's\|\^ {2}Password:/);
    expect(motd).toContain("sudo cat /etc/libredb-studio.info");
    expect(motd).not.toMatch(/ADMIN_PASSWORD/);
    // The address is the one volatile line: a stop/start assigns a new public IP.
    expect(motd).toContain("169.254.169.254/latest/meta-data/public-ipv4");
    expect(motd).toMatch(/--connect-timeout 1 --max-time 3/);
    expect(motd.trimEnd().endsWith("exit 0")).toBe(true);
  });

  test("running the hook against a fixture never prints the password", () => {
    // The assertions above are shape checks, and shape checks passed while the
    // hook could still be made to print the value (a capture group in the sed, or
    // a second grep after it). This runs the real hook.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-motd-"));
    const infoPath = path.join(dir, "libredb-studio.info");
    const secret = "fixture-password-3f9a2c";
    fs.writeFileSync(
      infoPath,
      [
        "LibreDB Studio is running.",
        "",
        "  URL:       http://203.0.113.10:3000",
        "  Sign in:   admin@libredb.org",
        `  Password:  ${secret}`,
        "",
        "  Docs:    https://github.com/libredb/libredb-studio#readme",
        "",
      ].join("\n"),
    );
    const hookPath = path.join(dir, "99-libredb-studio");
    fs.writeFileSync(hookPath, motd.split("/etc/libredb-studio.info").join(infoPath));
    // A curl stub keeps the test hermetic: no metadata service, no timeouts.
    fs.writeFileSync(path.join(dir, "curl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    try {
      const run = Bun.spawnSync(["sh", hookPath], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      const stdout = new TextDecoder().decode(run.stdout);
      expect(run.exitCode).toBe(0);
      expect(stdout).not.toContain(secret);
      expect(stdout).toContain("sudo cat");
      expect(stdout).toContain("admin@libredb.org");
    } finally {
      // A failing assertion must not leave the fixture behind.
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the banner is written once, never rewritten on a later boot", () => {
    const writers = shippedFiles.filter((file) => /> ?\/etc\/libredb-studio\.info/.test(fs.readFileSync(file, "utf8")));
    expect(writers.map((file) => path.basename(file))).toEqual(["libredb-banner"]);
  });

  test("the MOTD hook is named the way run-parts requires", () => {
    // run-parts --lsbsysinit skips anything with a dot in the name, so the check
    // has to read the directory rather than a path written here.
    const hooks = fs.readdirSync(path.join(AMI, "files/etc/update-motd.d"));
    expect(hooks).toContain("99-libredb-studio");
    for (const name of hooks) expect(name).not.toContain(".");
  });

  test("every docker command the buyer is handed starts with sudo", () => {
    // /var/run/docker.sock is root:docker 0660 and nothing puts `ubuntu` in the
    // docker group (membership of it is equivalent to root, and passwordless
    // sudo already grants what the buyer needs). The script's own calls run as
    // root and must stay unprefixed, so scope this to the banner heredoc.
    const heredoc = banner.slice(banner.indexOf("cat > /etc/libredb-studio.info"), banner.indexOf("\nEOF"));
    for (const line of heredoc.split("\n")) {
      if (/(^|\s)docker /.test(line)) expect({ line, sudo: /sudo docker /.test(line) }).toEqual({ line, sudo: true });
    }
  });
});

describe("AWS AMI SSH policy", () => {
  test("the drop-in wins the include order and actually carries both directives", () => {
    // Ubuntu's own 50-cloud-init.conf already sets PasswordAuthentication no and
    // Canonical's sshd_config already sets PermitRootLogin prohibit-password, so
    // 02-configure.sh's effective-config assertions pass even if this file is
    // empty. Only a content assertion catches a drop-in that became a no-op.
    expect(fs.existsSync(path.join(AMI, "files/etc/ssh/sshd_config.d/00-libredb-marketplace.conf"))).toBe(true);
    expect(sshd).toMatch(/^PasswordAuthentication no$/m);
    expect(sshd).toMatch(/^PermitRootLogin prohibit-password$/m);
  });

  test("the drop-in is installed and proven on the installed path", () => {
    // Without this, deleting the install line leaves a green build AND a green
    // suite: the effective-config checks below are answered by Ubuntu's own
    // defaults, and the previous test only reads the file in the repo.
    expect(configure).toMatch(/install -m 0644 [^\n]*00-libredb-marketplace\.conf/);
    expect(configure).toMatch(
      /grep -qx 'PasswordAuthentication no' \/etc\/ssh\/sshd_config\.d\/00-libredb-marketplace\.conf/,
    );
    expect(configure).toMatch(
      /grep -qx 'PermitRootLogin prohibit-password' \/etc\/ssh\/sshd_config\.d\/00-libredb-marketplace\.conf/,
    );
  });

  test("the effective config is asserted at build time, before the host keys go", () => {
    // A here-string rather than a pipe, so `grep -q` closing early cannot make
    // pipefail report a correct config as a failure.
    expect(configure).toMatch(/grep -qx 'passwordauthentication no' <<<"\$\(sshd -T\)"/);
    expect(configure).toMatch(/grep -qE '\^permitrootlogin [^']*' <<<"\$\(sshd -T\)"/);
    expect(cleanup).not.toContain("sshd -T");
  });
});

describe("AWS AMI build workflow", () => {
  const workflow = fs.readFileSync(path.join(AMI, "../../../.github/workflows/aws-ami-build.yml"), "utf8");
  const readme = fs.readFileSync(path.join(AMI, "../README.md"), "utf8");
  /** The preflight step that decides whether there is anything to build. */
  const decide = workflow.slice(workflow.indexOf("- id: decide"), workflow.indexOf("  build:\n"));

  test("runs on a published release or a manual dispatch, never on a pull request", () => {
    // Same trigger pair as npm-publish.yml, order not pinned. A pull_request
    // trigger would hand the OIDC role to a fork's branch.
    expect(workflow).toMatch(/^ {2}release:\n {4}types: \[published\]$/m);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(workflow).not.toMatch(/pull_request(_target)?:/);
  });

  test("every decision lives in preflight, which runs on all three paths", () => {
    // A release-only `if:` is walked straight past by the dispatch the release
    // chain would send, so the gates cannot live there - and preflight itself
    // must carry no `if:` at all, or the same hole reopens one level up.
    expect(workflow).toMatch(/^ {2}preflight:$/m);
    const preflight = workflow.slice(workflow.indexOf("  preflight:"), workflow.indexOf("  build:\n"));
    expect(preflight).not.toMatch(/^ {4}if:/m);
    // Without these outputs the build job can never run, and every test below
    // would still pass.
    expect(preflight).toMatch(/^ {4}outputs:\n {6}run: \$\{\{ steps\.decide\.outputs\.run \}\}/m);
    expect(preflight).toMatch(/^ {6}version: \$\{\{ steps\.decide\.outputs\.version \}\}/m);
    expect(workflow).toContain("needs: preflight");
    expect(workflow).toContain("if: needs.preflight.outputs.run == 'true'");
  });

  test("a machine path stands down where a named dispatch fails loudly", () => {
    expect(decide).toMatch(/stand_down\(\)[^\n]*run=false/);
    expect(decide).toMatch(/explicit=\$\(\[ -n "\$INPUT_VERSION" \]/);
    expect(decide).toMatch(/if \[ "\$explicit" = yes \]; then echo "::error::\$1"; exit 1; fi/);
  });

  test("chart releases never build a product AMI", () => {
    // libredb-studio-<chart version> tags emit release:published too.
    expect(decide).toMatch(/libredb-studio-\*\) stand_down/);
  });

  test("a prerelease is recognised by its tag shape, not by the release flag", () => {
    // release-artifacts.yml publishes prerelease tags without --prerelease, so
    // github.event.release.prerelease is false for them and testing it is a
    // no-op. The version string is what tells them apart.
    expect(workflow).not.toContain("github.event.release.prerelease");
    // Scoped to the semver block itself: a slice spanning the whole step lets a
    // lazy match walk past a downgraded check and find the next one's exit.
    const semver = decide.slice(decide.indexOf("if ! [["), decide.indexOf("# On a release run"));
    // Anchored, three parts, and no leading zeros - `01.2.3` is not a version
    // anything published.
    expect(semver).toContain("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$");
    expect(semver).toMatch(/refuse "version is not a product release/);
    expect(semver).not.toContain("::warning::");
    // And the shape check above it, which catches an rc tag before the regex.
    const shape = decide.slice(decide.indexOf('case "$VERSION"'), decide.indexOf("if ! [["));
    expect(shape).toMatch(/refuse "version is not a product release/);
  });

  test("a release tag that disagrees with package.json stops the build", () => {
    expect(workflow).toContain("RELEASE_TAG: ${{ github.event.release.tag_name }}");
    expect(decide).toMatch(/does not match package\.json version[\s\S]{0,80}?exit 1/);
  });

  test("all three AWS variables are required before anything is built", () => {
    for (const name of ["AWS_SUPPORT_EMAIL", "AWS_AMI_BUILD_ROLE_ARN", "AWS_AMI_INGESTION_ROLE_ARN"]) {
      expect(decide).toContain(name);
    }
    expect(decide).toMatch(/for name in SUPPORT_EMAIL BUILD_ROLE_ARN INGESTION_ROLE_ARN/);
    expect(decide).toMatch(/refuse "repository variable for \$name is not set"/);
  });

  test("run=true is written after every check, never before one", () => {
    const go = decide.indexOf('echo "run=true"');
    expect(go).toBeGreaterThan(0);
    for (const check of ["libredb-studio-*", "is not a product release", "does not match package.json", "is not set"]) {
      expect(decide.indexOf(check)).toBeLessThan(go);
    }
    expect(decide.lastIndexOf("exit 1")).toBeLessThan(go);
  });

  test("no workflow input is interpolated into any shell body", () => {
    // ${{ inputs.* }} inside a `run:` is the template-injection shape. Bodies are
    // taken by indentation rather than by a lazy match to a lookahead: an earlier
    // revision of this test captured zero characters and looped over six empty
    // strings, which is a guard that cannot fail.
    const lines = workflow.split("\n");
    const bodies: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      // Eight spaces or more: a step's `run:`. A job's `outputs:` mapping can
      // legitimately hold a key called `run`, at six.
      const start = /^( {8,})run: \|?/.exec(lines[i]);
      if (!start) continue;
      const indent = start[1].length;
      const body: string[] = [lines[i].slice(start[0].length)];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() !== "" && lines[j].search(/\S/) <= indent) break;
        body.push(lines[j]);
      }
      bodies.push(body.join("\n"));
    }
    expect(bodies.length).toBeGreaterThan(4);
    // A guard that captured nothing would pass the loop below vacuously.
    expect(bodies.join("").length).toBeGreaterThan(2000);
    for (const body of bodies) {
      expect({ head: body.trim().slice(0, 45), hit: /\$\{\{/.exec(body)?.[0] ?? null }).toEqual({
        head: body.trim().slice(0, 45),
        hit: null,
      });
    }
  });

  test("the build job takes its version from preflight, not from the raw input", () => {
    // ${{ inputs.version }} here would ship an empty version on every release
    // path, because a release run has no input.
    const buildJob = workflow.slice(workflow.indexOf("  build:\n"));
    expect(buildJob).toMatch(/env:\n {6}VERSION: \$\{\{ needs\.preflight\.outputs\.version \}\}/);
  });

  test("only the build job may mint an AWS credential, with exactly two scopes", () => {
    // A job-level permissions block REPLACES the workflow-level one, so reading
    // the top block alone would miss a widened job.
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    const buildJob = workflow.slice(workflow.indexOf("  build:\n"));
    const jobPerms = buildJob.slice(buildJob.indexOf("permissions:"));
    // Values, not just names: `contents: write` on this job is a widening a
    // name-only comparison would wave through.
    const scopes = (jobPerms.slice(0, jobPerms.indexOf("\n    timeout")).match(/^ {6}[a-z-]+: [a-z]+/gm) ?? []).map(
      (line) => line.trim(),
    );
    expect(scopes).toEqual(["contents: read", "id-token: write"]);
    expect(workflow.slice(0, workflow.indexOf("  build:\n"))).not.toContain("id-token: write");
  });

  test("the credential is minted after the wait, not held through it", () => {
    // configure-aws-credentials above the digest step would hold a live AWS
    // credential for the length of a thirty-minute wait.
    const buildJob = workflow.slice(workflow.indexOf("  build:\n"));
    expect(buildJob.indexOf("Resolve image digest")).toBeLessThan(buildJob.indexOf("configure-aws-credentials@"));
  });

  test("preflight cannot hold the lane open", () => {
    // Constant concurrency group plus cancel-in-progress: false means a hung
    // preflight would block every later run.
    const preflight = workflow.slice(workflow.indexOf("  preflight:"), workflow.indexOf("  build:\n"));
    expect(preflight).toMatch(/timeout-minutes: \d+/);
  });

  test("every action is pinned to a full commit sha and drops its token", () => {
    const uses = workflow.match(/uses: \S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/@[0-9a-f]{40}$/);
    const checkouts = workflow.match(/actions\/checkout@/g) ?? [];
    const persist = workflow.match(/persist-credentials: false/g) ?? [];
    expect(persist.length).toBe(checkouts.length);
  });

  test("carries no long-lived credentials", () => {
    expect(workflow).not.toMatch(/aws-access-key-id|aws-secret-access-key|secrets\./);
  });

  test("the digest step waits half an hour rather than racing the push", () => {
    // docker-build-push builds arm64 under emulation inside a 60-minute budget;
    // a ten-minute wait would usually expire before the tag lands.
    expect(workflow).toMatch(/for attempt in \$\(seq 1 60\)/);
    expect(workflow).toMatch(/sleep 30/);
    expect(workflow).toContain("^sha256:[0-9a-f]{64}$");
    expect(workflow).toMatch(/timeout-minutes: 90/);
  });

  test("one AMI build at a time, across refs, and never cancelled mid-flight", () => {
    // The protected resource is one AMI namespace in one account, so the group
    // must not be per-ref: a release run and a dispatch would each register one.
    expect(workflow).toMatch(/concurrency:\n {2}group: aws-ami-build\n {2}cancel-in-progress: false/);
  });

  test("the README describes the triggers the workflow actually declares", () => {
    // The repo has drift guards for exactly this class; this file had none, and
    // the README went stale the moment the trigger changed.
    expect(readme).toContain("release: published");
    expect(readme).toContain("dispatch-downstream");
    expect(readme).toContain("gh workflow run aws-ami-build.yml");
    expect(workflow).toMatch(/^ {2}release:$/m);
    // Substrings alone let the README say the OPPOSITE of the code and stay
    // green - which is exactly how a sentence claiming a chain dispatch would
    // "fail on the unset variables" survived two reviews. Assert the claim.
    const chain = readme.slice(readme.indexOf("dispatch-downstream"), readme.indexOf("A preflight job"));
    expect(chain).toMatch(/stands down/);
    expect(chain).not.toMatch(/would\s+fail/);
    const preflightPara = readme.slice(readme.indexOf("A preflight job"));
    expect(preflightPara).toMatch(/NAMES a version fails loudly/);
    expect(preflightPara).toMatch(/stands down quietly/);
  });
});
