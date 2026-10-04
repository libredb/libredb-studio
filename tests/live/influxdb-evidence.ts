/**
 * The InfluxDB evidence harness (InfluxDB spec 8, E22, gate 4). It sends every request of the statement plan
 * (tests/live/influxdb-evidence-plan.ts) to the `influxdb1`, `influxdb2`, `influxdb3` and `influxdb3-filelimit`
 * services of docker/influxdb/README.md over `node:http`, with no provider import, and writes each answer as
 * tests/fixtures/influxdb/<version>/<capture>.json in the `InfluxCapture` shape of tests/helpers/influxdb-fixtures.ts,
 * plus tests/fixtures/influxdb/manifest.json. The file-limit fixture is the same 3.12.0 Core image, so its two
 * captures are written under 3.12.0-core.
 *
 * The harness never writes to a server. Before a statement is sent, its type's policy allows it (`evaluateInfluxql`
 * or `evaluateInfluxSql`), or the run stops naming the capture; a differential corpus entry on 1.13.1 and 2.9.1 is
 * sent only with the read principal. After the run, each engine line is asked, as admin, what the database that
 * does not exist holds, and the run fails unless it holds no series. docker/influxdb/seed.sh is the only writer and
 * is neither imported nor run here.
 *
 * Each capture records the image as `tag@digest`, the date, the request with its credential replaced by the scheme
 * (`basic`, `token`, `bearer` or `none`), the status, the content type and the body. A body the server ended before
 * its terminating chunk is recorded with `cut` and the bytes received: "zero-byte" when nothing arrived, "mid-line"
 * when it stops inside a line, "line-end" when it stops after whole lines (K10, R39). A cut the plan does not expect
 * stops the run, and an entry the plan expects to be cut is sent again until it shows that cut, at most CUT_ATTEMPTS
 * times, then the run stops naming what it saw. Measured on 3.12.0 (2026-10-04): the K10 recipe's cut lands on a line
 * end every time (0 of about 720 runs over curl, Python and node ended inside a line), so `sql-truncated` is recorded
 * as "line-end", and `sql-truncated-mid-line` is derived from it by `midLineSlice`, labelled synthetic (R39).
 * A request that times out stops the run; it is never recorded as a cut. No capture is written while any of them
 * holds a secret form: each password, each token, and for Basic `user:password` and its base64. The credentials are
 * read from database-compose.yml and docker/influxdb/seed.sh, the files that set them.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), with the three engine
 * services up and seeded within the hour, `docker/influxdb/seed.sh bench` run, and `influxdb3-filelimit` up:
 *   bun tests/live/influxdb-evidence.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { InfluxCapture, InfluxFixtureVersion, InfluxManifest } from "../helpers/influxdb-fixtures";
import {
  type BodyCut,
  cutOf,
  type FixtureCredentials,
  midLineSlice,
  nowhereProblem,
  policyVerdict,
  readFixtureCredentials,
} from "./influxdb-evidence-checks";
import {
  buildEvidencePlan,
  buildNowhereChecks,
  EVIDENCE_MID_LINE_SLICES,
  type EvidenceEntry,
  type EvidenceLine,
} from "./influxdb-evidence-plan";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/influxdb");
const REQUEST_TIMEOUT_MS = 60_000;
const CUT_ATTEMPTS = 200;

interface LineService {
  readonly container: string;
  readonly port: number;
  /** The fixture directory and the capture's `version`. */
  readonly version: InfluxFixtureVersion;
}

const SERVICES: Readonly<Record<EvidenceLine, LineService>> = {
  "1.13.1": { container: "libredb-influxdb1", port: 8087, version: "1.13.1" },
  "2.9.1": { container: "libredb-influxdb2", port: 8086, version: "2.9.1" },
  "3.12.0-core": { container: "libredb-influxdb3", port: 8181, version: "3.12.0-core" },
  "3.12.0-core-filelimit": { container: "libredb-influxdb3-filelimit", port: 8182, version: "3.12.0-core" },
};

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

/** The running container's image as `tag@digest`; a container that is not healthy or not pinned stops the run. */
function pinnedImage(container: string): string {
  const state = docker([
    "inspect",
    "--format",
    "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
    container,
  ]);
  if (state !== "running healthy") {
    throw new Error(`${container} is "${state}", not "running healthy": bring it up as docker/influxdb/README.md says`);
  }
  const image = docker(["inspect", "--format", "{{.Config.Image}}", container]);
  if (!/@sha256:[0-9a-f]{64}$/.test(image))
    throw new Error(`${container} runs ${image}, which is not pinned by digest`);
  return image;
}

// -- the credentials ----------------------------------------------------------------------------------------------

interface Credentials {
  readonly fixed: FixtureCredentials;
  readonly v2ReadToken: string;
  /** Every form of every secret this run sends: none may appear in a written file. */
  readonly secretForms: readonly string[];
}

function readCredentials(): Credentials {
  const fixed = readFixtureCredentials(
    readFileSync(path.join(ROOT, "database-compose.yml"), "utf8"),
    readFileSync(path.join(ROOT, "docker/influxdb/seed.sh"), "utf8"),
  );
  const v2ReadToken = execFileSync(
    "sh",
    ["-c", "docker cp libredb-influxdb-seed:/tokens/influxdb2-read-token - | tar -xO"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
  if (v2ReadToken === "") throw new Error("the 2.x read-only token is empty: run the influxdb-seed one-shot");
  const basicForms = [fixed.v1Admin, fixed.v1Reader].flatMap(({ user, password }) => [
    password,
    `${user}:${password}`,
    Buffer.from(`${user}:${password}`).toString("base64"),
  ]);
  return {
    fixed,
    v2ReadToken,
    secretForms: [...basicForms, fixed.v2OperatorToken, v2ReadToken, fixed.v3AdminToken],
  };
}

const basic = ({ user, password }: { user: string; password: string }) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

/** The `authorization` header of an entry and the scheme the capture records in its place. */
function authorization(
  entry: EvidenceEntry,
  credentials: Credentials,
): { header?: string; auth: InfluxCapture["request"]["auth"] } {
  if (entry.principal === "anonymous") return { auth: "none" };
  const { v1Admin, v1Reader, v2OperatorToken, v3AdminToken } = credentials.fixed;
  switch (entry.line) {
    case "1.13.1":
      if (entry.capture === "token-without-user") return { header: `Token ${v1Reader.password}`, auth: "token" };
      return { header: basic(entry.principal === "admin" ? v1Admin : v1Reader), auth: "basic" };
    case "2.9.1":
      return {
        header: `Token ${entry.principal === "admin" ? v2OperatorToken : credentials.v2ReadToken}`,
        auth: "token",
      };
    default:
      if (entry.principal !== "admin")
        throw new Error(`${entry.capture} on ${entry.line} names a principal 3.x does not have`);
      return { header: `Bearer ${v3AdminToken}`, auth: "bearer" };
  }
}

// -- the checks before a request (E22) ---------------------------------------------------------------------------

function textOf(entry: EvidenceEntry): string | undefined {
  return entry.form?.q ?? entry.query?.q ?? entry.body?.q;
}

function assertSendable(entry: EvidenceEntry): void {
  const where = `${entry.line} ${entry.capture}`;
  if (entry.kind === "corpus") {
    if ((entry.line === "1.13.1" || entry.line === "2.9.1") && entry.principal !== "read") {
      throw new Error(`${where} is a corpus entry not bound to the read principal: nothing sent`);
    }
    return;
  }
  const text = textOf(entry);
  if (text === undefined) return;
  const verdict = policyVerdict(entry.language ?? "influxql", text);
  if (!verdict.allowed) throw new Error(`${where} is refused by its policy (${verdict.message}): nothing sent`);
}

// -- requests -----------------------------------------------------------------------------------------------------

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
  readonly bytes: number;
  readonly cut?: BodyCut;
}

function send(entry: EvidenceEntry, header: string | undefined): Promise<Answer> {
  const query = entry.query === undefined ? "" : `?${new URLSearchParams(entry.query).toString()}`;
  let payload: string | undefined;
  const headers: Record<string, string> = {};
  if (header !== undefined) headers.authorization = header;
  if (entry.form !== undefined) {
    payload = new URLSearchParams(entry.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (entry.body !== undefined) {
    payload = JSON.stringify(entry.body);
    headers["content-type"] = "application/json";
  }
  if (payload !== undefined) headers["content-length"] = String(Buffer.byteLength(payload));
  const options = {
    host: "127.0.0.1",
    port: SERVICES[entry.line].port,
    method: entry.method,
    path: `${entry.path}${query}`,
    headers,
    timeout: REQUEST_TIMEOUT_MS,
    agent: false as const,
  };
  return new Promise((resolve, reject) => {
    // A timed-out request is a failed run, never a cut: destroying it also closes the response incomplete.
    let timedOut = false;
    const timeout = new Error(`${entry.line} ${entry.capture} did not finish in ${REQUEST_TIMEOUT_MS} ms`);
    const request = http.request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      // A reset after the head arrives as an "aborted" error on the response; "close" below reads the state.
      response.on("error", () => {});
      response.on("close", () => {
        if (timedOut) {
          reject(timeout);
          return;
        }
        const bytes = Buffer.concat(chunks);
        const body = bytes.toString("utf8");
        const cut = cutOf(response.complete, bytes);
        resolve({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"] ?? null,
          body,
          bytes: bytes.length,
          ...(cut === undefined ? {} : { cut }),
        });
      });
    });
    request.on("timeout", () => {
      timedOut = true;
      request.destroy(timeout);
    });
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function capture(entry: EvidenceEntry, credentials: Credentials): Promise<{ answer: Answer; attempts: number }> {
  assertSendable(entry);
  const { header } = authorization(entry, credentials);
  // The cut an entry must show: none, unless the plan expects one.
  const want = entry.expectCut;
  const limit = want === undefined ? 1 : CUT_ATTEMPTS;
  const seen: string[] = [];
  for (let attempt = 1; attempt <= limit; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- one request at a time, so a retry follows the cut before it.
    const answer = await send(entry, header);
    if (answer.cut === want) return { answer, attempts: attempt };
    seen.push(`${answer.cut ?? "complete"} at ${answer.bytes} bytes`);
  }
  throw new Error(`${entry.line} ${entry.capture} expected ${want ?? "a complete body"}, saw ${seen.join(", ")}`);
}

function record(
  entry: EvidenceEntry,
  image: string,
  date: string,
  answer: Answer,
  credentials: Credentials,
): InfluxCapture {
  const { auth } = authorization(entry, credentials);
  const cut = answer.cut;
  return {
    version: SERVICES[entry.line].version,
    name: entry.capture,
    image,
    capturedAt: date,
    request: {
      method: entry.method,
      path: entry.path,
      query: entry.query ?? {},
      ...(entry.form === undefined ? {} : { form: entry.form }),
      ...(entry.body === undefined ? {} : { body: entry.body }),
      auth,
    },
    status: answer.status,
    contentType: answer.contentType,
    body: answer.body,
    ...(cut === undefined ? {} : { cut, bytes: answer.bytes }),
  };
}

/** E22: the admin read must prove the database that does not exist holds nothing; anything else fails the run. */
function assertNowhereEmpty(entry: EvidenceEntry, answer: Answer): void {
  const problem = nowhereProblem(answer);
  if (problem !== undefined) {
    throw new Error(`${entry.line}: the read of ${entry.form?.db} proves nothing held: ${problem}: ${answer.body}`);
  }
}

function assertNoSecret(file: string, text: string, forms: readonly string[]): void {
  for (const form of forms) {
    if (text.includes(form)) throw new Error(`${file} would hold a credential this run sent: nothing written`);
  }
}

async function main(): Promise<number> {
  const credentials = readCredentials();
  const plan = buildEvidencePlan();
  const checks = buildNowhereChecks();
  // Every policy check runs before the first request, so a refused text sends nothing at all.
  for (const entry of [...plan, ...checks]) assertSendable(entry);
  const images = new Map<EvidenceLine, string>();
  for (const line of new Set(plan.map((entry) => entry.line))) images.set(line, pinnedImage(SERVICES[line].container));
  const date = new Date().toISOString().slice(0, 10);

  const files = new Map<string, string>();
  const captures = new Map<string, InfluxCapture>();
  for (const entry of [...plan, ...checks]) {
    // oxlint-disable-next-line no-await-in-loop -- one request at a time, in plan order.
    const { answer, attempts } = await capture(entry, credentials);
    if (entry.capture === "nowhere-check") assertNowhereEmpty(entry, answer);
    const captured = record(entry, images.get(entry.line) as string, date, answer, credentials);
    const file = `${captured.version}/${entry.capture}.json`;
    if (files.has(file)) throw new Error(`${file} is written twice`);
    files.set(file, `${JSON.stringify(captured, null, 2)}\n`);
    captures.set(file, captured);
    console.error(
      `${answer.status}${answer.cut === undefined ? "" : ` ${answer.cut}`} ${file}${attempts > 1 ? ` (attempt ${attempts})` : ""}`,
    );
  }
  // R39: each mid-line capture is a slice of a recorded line-end one, never sent and never edited by hand.
  for (const slice of EVIDENCE_MID_LINE_SLICES) {
    const version = SERVICES[slice.line].version;
    const source = captures.get(`${version}/${slice.source}.json`);
    if (source === undefined) throw new Error(`${version}/${slice.source}.json was not recorded: nothing to slice`);
    const file = `${version}/${slice.capture}.json`;
    if (files.has(file)) throw new Error(`${file} is written twice`);
    const sliced = midLineSlice(source, slice.capture);
    files.set(file, `${JSON.stringify(sliced, null, 2)}\n`);
    console.error(`synthetic ${sliced.cut} ${file} (${sliced.bytes} of ${source.bytes} bytes)`);
  }

  const manifest: InfluxManifest = {
    versions: (["1.13.1", "2.9.1", "3.12.0-core"] as const).map((version) => ({
      version,
      image: images.get(version) as string,
      capturedAt: date,
    })),
  };
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  for (const [file, text] of files) assertNoSecret(file, text, credentials.secretForms);
  for (const [file, text] of files) {
    const target = path.join(OUT, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  console.error(`wrote ${files.size} files under tests/fixtures/influxdb`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
