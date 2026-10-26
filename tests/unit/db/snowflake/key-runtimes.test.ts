/**
 * The Snowflake key intake on the runtimes production runs: in this Bun process and in one Node child per binary that
 * NODE_TRANSPORT_NODES lists, split on the path delimiter, or else in the `node` on PATH, so CI's Node 24 runs them and
 * NODE_TRANSPORT_NODES can list Node 24, 26.10 and 26.12 in one pass. Each child must report the version its binary
 * prints, so a listed Node never passes as another.
 *
 * Each child runs one bundle that Bun.build({ target: "node" }) makes of auth.ts and the key helper around the text of
 * `runCases`, the function this process runs in place. The missing and wrong passphrase errors differ by runtime (Bun
 * throws ERR_MISSING_PASSPHRASE, Node's OpenSSL 3 ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED), so each child also reports
 * the raw codes `createPrivateKey` throws, printed for the record, and each must read as its sentence. Bun's BoringSSL has no
 * scrypt PBES2 and no SHA-384 or SHA-512 PRF, so those keys are unreadable there and load on Node.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import * as auth from "@/lib/db/providers/sql/snowflake/auth";
import * as keys from "../../../helpers/snowflake-keys";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const AUTH = join(ROOT, "src/lib/db/providers/sql/snowflake/auth.ts");
const KEYS = join(ROOT, "tests/helpers/snowflake-keys.ts");

interface Report {
  readonly runtime: string;
  /** Each case's outcome: "loaded", or the name of the key sentence that refused it. */
  readonly results: Readonly<Record<string, string>>;
  /** The codes createPrivateKey threw for a missing and for a wrong passphrase, per key form. */
  readonly codes: Readonly<Record<string, string>>;
  /** How long each relabelled case took to read, in milliseconds. */
  readonly elapsed: Readonly<Record<string, number>>;
  /** The CPU time a key at each PRF's iteration ceiling took to open, in milliseconds, once per round. */
  readonly ceilingMs: Readonly<Record<string, readonly number[]>>;
}

/** Runs where it is defined and, by its text, inside each child bundle; it names only its arguments. */
function runCases(a: typeof auth, k: typeof keys, c: Pick<typeof crypto, "createPrivateKey">, runtime: string): Report {
  const key = k.rsaKey();
  const pass = k.KEY_TEST_PASSPHRASE;
  const forms: Record<string, string> = {
    pkcs8: k.pbes2Pbkdf2Pem(key, pass, 2_048),
    pkcs1: k.pkcs1Pem(key, pass),
  };
  const outcome = (pem: string, passphrase: string | undefined): string => {
    try {
      a.loadPrivateKey(pem, passphrase);
      return "loaded";
    } catch (error) {
      const message = (error as Error).message;
      const found = Object.entries(a.SNOWFLAKE_KEY_SENTENCES).find(([, sentence]) => sentence === message);
      return found === undefined ? `other: ${(error as Error).name}` : found[0];
    }
  };
  const code = (pem: string, passphrase: string | undefined): string => {
    try {
      c.createPrivateKey({ key: pem, format: "pem", ...(passphrase === undefined ? {} : { passphrase }) });
      return "none";
    } catch (error) {
      return String((error as { code?: unknown }).code);
    }
  };
  const results: Record<string, string> = {};
  const codes: Record<string, string> = {};
  for (const [name, pem] of Object.entries(forms)) {
    results[`${name} with no passphrase`] = outcome(pem, undefined);
    results[`${name} with a wrong passphrase`] = outcome(pem, "not-the-passphrase");
    results[`${name} with its passphrase`] = outcome(pem, pass);
    codes[`${name} missing`] = code(pem, undefined);
    codes[`${name} wrong`] = code(pem, "not-the-passphrase");
  }
  // A wrong passphrase decrypts to random bytes, and about one time in 256 their padding holds and the decoder refuses
  // them with a code of its own. OpenSSL 4 reports ERR_OSSL_ASN1_WRONG_TAG for the PKCS#8 case; the first such
  // passphrase of a fixed sequence must still read as the wrong passphrase.
  for (const [name, pem] of Object.entries(forms)) {
    let garbled: string | undefined;
    for (let i = 0; i < 20_000 && garbled === undefined; i += 1) {
      const thrown = code(pem, `wrong-${i}`);
      if (thrown !== "ERR_OSSL_BAD_DECRYPT" && thrown !== "ERR_OSSL_EVP_BAD_DECRYPT") garbled = `wrong-${i}`;
    }
    results[`${name} with a wrong passphrase that decrypts to garbage`] =
      garbled === undefined ? "none found" : outcome(pem, garbled);
    codes[`${name} garbled`] = garbled === undefined ? "none found" : code(pem, garbled);
  }
  for (const prf of ["sha1", "sha256", "sha384", "sha512", null] as const) {
    results[`PBKDF2 2,048 with ${prf ?? "the PRF omitted"}`] = outcome(k.pbes2Pbkdf2Pem(key, pass, 2_048, prf), pass);
  }
  results["scrypt N 16,384"] = outcome(k.pbes2ScryptPem(key, pass, 16_384, 8, 1), pass);
  // Each PRF at its own ceiling, timed: the ceilings are set so each costs about what SHA-256 at its ceiling does.
  // The cost is the process's CPU time, which a pause on a busy runner does not add to as it adds to the clock. The
  // four PRFs are read in turn, three rounds of them, and the check takes each one's least reading.
  const cpuMs = (): number => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1_000;
  };
  const ceilingPems = (["sha1", "sha256", "sha384", "sha512"] as const).map(
    (prf) => [prf, k.pbes2Pbkdf2Pem(key, pass, a.SNOWFLAKE_MAX_PBKDF2_ITERATIONS[prf], prf)] as const,
  );
  const ceilingMs: Record<string, number[]> = {};
  for (let round = 0; round < 3; round += 1) {
    for (const [prf, pem] of ceilingPems) {
      const started = cpuMs();
      results[`PBKDF2 ${prf} at its ceiling`] = outcome(pem, pass);
      ceilingMs[prf] = [...(ceilingMs[prf] ?? []), Math.round(cpuMs() - started)];
    }
  }
  // An EncryptedPrivateKeyInfo under an unencrypted label: Node's OpenSSL decrypts it whatever the label says.
  const relabel = (pem: string, label: string): string => pem.split("ENCRYPTED PRIVATE KEY").join(label);
  const elapsed: Record<string, number> = {};
  const relabelled: Record<string, string> = {
    "PBKDF2 2,048 as PRIVATE KEY": relabel(k.pbes2Pbkdf2Pem(key, pass, 2_048), "PRIVATE KEY"),
    "PBKDF2 20,000,000 as PRIVATE KEY": relabel(k.pbes2Pbkdf2Outer(20_000_000, "sha512"), "PRIVATE KEY"),
    "scrypt p 64 as PRIVATE KEY": relabel(k.pbes2ScryptOuter(16_384, 8, 64), "PRIVATE KEY"),
    "PBKDF2 20,000,000 as RSA PRIVATE KEY": relabel(k.pbes2Pbkdf2Outer(20_000_000, "sha512"), "RSA PRIVATE KEY"),
    "scrypt p 64 as RSA PRIVATE KEY": relabel(k.pbes2ScryptOuter(16_384, 8, 64), "RSA PRIVATE KEY"),
  };
  for (const [name, pem] of Object.entries(relabelled)) {
    const started = Date.now();
    results[name] = outcome(pem, pass);
    elapsed[name] = Date.now() - started;
  }
  return { runtime, results, codes, elapsed, ceilingMs };
}

const PASSPHRASE_CASES: Readonly<Record<string, string>> = {
  "pkcs8 with no passphrase": "needsPassphrase",
  "pkcs8 with a wrong passphrase": "wrongPassphrase",
  "pkcs8 with its passphrase": "loaded",
  "pkcs1 with no passphrase": "needsPassphrase",
  "pkcs1 with a wrong passphrase": "wrongPassphrase",
  "pkcs1 with its passphrase": "loaded",
  "pkcs8 with a wrong passphrase that decrypts to garbage": "wrongPassphrase",
  "pkcs1 with a wrong passphrase that decrypts to garbage": "wrongPassphrase",
  "PBKDF2 2,048 with sha1": "loaded",
  "PBKDF2 2,048 with sha256": "loaded",
  "PBKDF2 2,048 with the PRF omitted": "loaded",
  "PBKDF2 sha1 at its ceiling": "loaded",
  "PBKDF2 sha256 at its ceiling": "loaded",
  "PBKDF2 2,048 as PRIVATE KEY": "loaded",
  "PBKDF2 20,000,000 as PRIVATE KEY": "kdfCost",
  "scrypt p 64 as PRIVATE KEY": "kdfCost",
  "PBKDF2 20,000,000 as RSA PRIVATE KEY": "unreadable",
  "scrypt p 64 as RSA PRIVATE KEY": "unreadable",
};

/** A relabelled key is refused from its DER, before any key is derived: well under the 8 s a 20,000,000 count costs. */
const RELABELLED_REFUSAL_MAX_MS = 1_000;

/**
 * How much more than SHA-256 at its ceiling any PRF at its own ceiling may cost on Node. Measured 2026-10-12 on Node
 * 24.14.0 and 26.10.0, 1,000,000 iterations each: SHA-1 up to about 2 times SHA-256, SHA-384 and SHA-512 4 to 5 times,
 * so one ceiling for all four let a SHA-512 key cost about five times the SHA-256 budget.
 *
 * Each PRF is judged by the least CPU time of three readings. Judged by one wall-clock reading of about 100 ms, the
 * check failed twice on the macOS CI runner (three test files on three vCPUs) on 14 and 15 Oct 2026, and on 2 of 12
 * local runs when the child was paused for 250 ms every 600 ms, against 0 of 12 without the pauses.
 */
const CEILING_COST_RATIO_MAX = 2;

/** What differs: Node opens scrypt and the SHA-384 and SHA-512 PRFs, Bun's BoringSSL opens none of them. */
function expected(onBun: boolean): Readonly<Record<string, string>> {
  const other = onBun ? "unreadable" : "loaded";
  return {
    ...PASSPHRASE_CASES,
    "PBKDF2 2,048 with sha384": other,
    "PBKDF2 2,048 with sha512": other,
    "scrypt N 16,384": other,
    "PBKDF2 sha384 at its ceiling": other,
    "PBKDF2 sha512 at its ceiling": other,
  };
}

function expectReport(report: Report | undefined, onBun: boolean): void {
  // Printed before any check, so a failing run carries the readings: the runner prints a failing file's output.
  console.log(`snowflake key runtimes: ${report?.runtime} threw ${JSON.stringify(report?.codes)}`);
  console.log(`snowflake key runtimes: ${report?.runtime} at the ceilings took ${JSON.stringify(report?.ceilingMs)}`);
  console.log(`snowflake key runtimes: ${report?.runtime} took ${JSON.stringify(report?.elapsed)}`);
  expect(report?.results).toEqual(expected(onBun));
  for (const [name, ms] of Object.entries(report?.elapsed ?? {})) {
    if (name !== "PBKDF2 2,048 as PRIVATE KEY") expect([name, ms <= RELABELLED_REFUSAL_MAX_MS]).toEqual([name, true]);
  }
  if (!onBun) {
    const least = (prf: string): number => Math.min(...(report?.ceilingMs[prf] ?? [Number.NaN]));
    const budget = least("sha256") * CEILING_COST_RATIO_MAX;
    for (const prf of Object.keys(report?.ceilingMs ?? {})) expect([prf, least(prf) <= budget]).toEqual([prf, true]);
  }
}

/** The Node binaries NODE_TRANSPORT_NODES lists, or the node on PATH; an empty list or no node fails by name. */
function nodeBinaries(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  if (listed !== undefined) {
    const binaries = listed.split(delimiter).filter((entry) => entry !== "");
    if (binaries.length === 0) throw new Error("NODE_TRANSPORT_NODES is set and lists no Node binary");
    return binaries;
  }
  const onPath = Bun.which("node");
  if (onPath === null) {
    throw new Error(
      "No node on PATH: this file runs the cases under Node, the production runtime; install Node 24 or later",
    );
  }
  return [onPath];
}

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "snowflake-key-runtimes-"));
  writeFileSync(
    join(dir, "child.ts"),
    [
      'import * as crypto from "node:crypto";',
      `import * as auth from ${JSON.stringify(AUTH)};`,
      `import * as keys from ${JSON.stringify(KEYS)};`,
      `const runCases = ${runCases.toString()};`,
      "const report = runCases(auth, keys, crypto, `node ${process.version}`);",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [join(dir, "child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("in this Bun process", () => {
  test("the passphrase codes, the PBKDF2 PRFs and scrypt", () => {
    expectReport(runCases(auth, keys, crypto, `bun ${Bun.version}`), true);
  });
});

for (const binary of nodeBinaries()) {
  describe(`in a Node child, ${binary}`, () => {
    let report: Report | undefined;
    beforeAll(async () => {
      const child = Bun.spawn([binary, join(dir, "child.js")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`The child ${binary} exited ${exitCode}: ${stderr}`);
      report = JSON.parse(stdout.trim().split("\n").at(-1) as string) as Report;
    }, 60_000);

    test("the child ran on the runtime it was asked for", () => {
      const printed = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
      expect(report?.runtime).toBe(`node ${printed.stdout.toString().trim()}`);
    });

    test("the passphrase codes, the PBKDF2 PRFs and scrypt", () => {
      expectReport(report, false);
    });
  });
}
