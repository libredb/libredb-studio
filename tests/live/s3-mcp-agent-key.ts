/**
 * Live check of MCP's `run_s3_read` under a seed's agent read key, on the server an agent-scope/<set>/run.sh started
 * with S3_SCOPE_LIVE pointing here, captured into `mcp.json` beside that run.sh.
 *
 *   S3_SCOPE_LIVE=tests/live/s3-mcp-agent-key.ts sh tests/fixtures/s3/agent-scope/<set>/run.sh
 *
 * The environment is run.sh's, as tests/live/s3-agent-scope.ts reads it: S3_SCOPE_SERVER, S3_SCOPE_IMAGE,
 * S3_SCOPE_PORT, S3_SCOPE_OUT, S3_SCOPE_CONTAINER and the four keys made for the run. The keys reach the seed only as
 * `${ENV}` references: the seed file is `tests/fixtures/s3/agent-scope/mcp-seed.json`, checked in, which this script
 * copies with the server's port added and points the loader at.
 *
 * WHY THIS EXISTS. MCP reads S3 only under the seed's agent read key, never the connection's own key, so the buckets a
 * call reaches are the agent key's grants, enforced by the server. Both seed connections sign with the broad key as
 * their own key, which lists every bucket; one's agent key is the unlisted key (the scoped grants without
 * s3:ListAllMyBuckets), the other's the scoped key (with it). Every call goes through the real `/api/mcp` route with
 * a token minted for the run, except the cancel, which drives the tool's own handler with the route's context:
 *
 *   own key    the broad key's raw bucket listing, the positive control: every bucket the run made;
 *   heads      a raw HeadBucket of each bucket the run made, signed with each agent key: what the server answers a
 *              key for a bucket it is granted and for one it is not, which the bucket listing's per-bucket check reads;
 *   listing    `aws s3api list-buckets` through the tool on each connection: the unlisted agent key's granted buckets
 *              alone, the proof MCP signed with the agent key; and the scoped agent key's, which the server lists every
 *              bucket name on Silo and RustFS, s3:ListAllMyBuckets being applied as written: the answer must name only
 *              the buckets whose raw HeadBucket that key was answered 200, count the rest in a note naming none, and
 *              have cost one ListBuckets and one HeadBucket per listed bucket;
 *   oracle     every named read of a bucket the agent key is granted nothing on against one that does not exist, and
 *              of a key that exists in such a bucket against one that does not: alike, word for word, once the name
 *              is taken out, and each the one missing-or-unreadable sentence;
 *   reads      each of the six reads of a granted bucket, and of the public bucket, which RustFS opens to every key;
 *   refused    forms agent mode never sends, refused before anything is acquired;
 *   limits     with the server paused after the acquisition, a read at the least timeout_ms and a client cancel.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. The capture records no access key ID or
 * secret, not even as a placeholder, and the script refuses to write one that holds any; its `leaks` list must be
 * empty. Any failed check ends the run non-zero, after the capture is written.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { amzDateOf, canonicalQueryOf, signatureV4 } from "@/lib/db/providers/objectstore/s3/sigv4";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set; run this through run.sh`);
  return value;
}

const SERVER = env("S3_SCOPE_SERVER");
if (SERVER !== "silo" && SERVER !== "rustfs" && SERVER !== "garage")
  throw new Error("S3_SCOPE_SERVER is silo, rustfs or garage");
const GARAGE = SERVER === "garage";
const IMAGE = env("S3_SCOPE_IMAGE");
const PORT = Number(env("S3_SCOPE_PORT"));
const OUT = env("S3_SCOPE_OUT");
const CONTAINER = env("S3_SCOPE_CONTAINER");
const KEYS = {
  root: { accessKeyId: env("S3_SCOPE_ROOT_KEY"), secretAccessKey: env("S3_SCOPE_ROOT_SECRET") },
  scoped: { accessKeyId: env("S3_SCOPE_SCOPED_KEY"), secretAccessKey: env("S3_SCOPE_SCOPED_SECRET") },
  broad: { accessKeyId: env("S3_SCOPE_BROAD_KEY"), secretAccessKey: env("S3_SCOPE_BROAD_SECRET") },
  unlisted: { accessKeyId: env("S3_SCOPE_UNLISTED_KEY"), secretAccessKey: env("S3_SCOPE_UNLISTED_SECRET") },
} as const;
const CREDENTIAL_VALUES = Object.values(KEYS).flatMap((key) => [key.accessKeyId, key.secretAccessKey]);
const REGION = GARAGE ? "garage" : "us-east-1";
const HOST = "127.0.0.1";
const DATE = new Date().toISOString().slice(0, 10);
const REPO = posix.resolve(import.meta.dir.replaceAll("\\", "/"), "../..");

// The MCP route's own environment, set before any of its modules load: the channel on, a JWT secret made for the run.
process.env.JWT_SECRET = randomBytes(32).toString("hex");
process.env.S3_SCOPE_REGION = REGION;
const { pinMcpTestEnvironment } = await import("../helpers/mcp-fixtures");
pinMcpTestEnvironment();
const { useMcpChannel: openMcpChannel, mintTestToken } = await import("../helpers/mcp-token");
openMcpChannel();
const route = await import("@/app/api/mcp/route");
const { connectClient, routeServe } = await import("../helpers/mcp-harness");
const { resetCache } = await import("@/lib/seed");
const { McpConnectionContext } = await import("@/lib/mcp/context");
const { MCP_CANCELLED_TEXT } = await import("@/lib/mcp/output");
const { timeoutText } = await import("@/lib/mcp/tools/read-query-limits");
const { runStatement } = await import("@/lib/mcp/tools/run-statement");
const { mcpStatementArm } = await import("@/lib/mcp/tools/statement-arms");
const { languageServer } = await import("@/lib/agent/languages/server");
const { S3_AGENT_FAILURE_SENTENCES } = await import("@/lib/db/providers/objectstore/s3/agent-metadata-read");

const BUCKETS = {
  granted: "scope-granted",
  versions: "scope-versions",
  objectsOnly: "scope-objects-only",
  other: "scope-other",
  public: "scope-public",
  missing: "scope-missing",
} as const;
const MADE = [BUCKETS.granted, BUCKETS.versions, BUCKETS.objectsOnly, BUCKETS.other, BUCKETS.public];
/** The buckets the scoped and the unlisted keys hold a grant on (scoped-policy.json, or run.sh's Garage grants). */
const GRANTED: readonly string[] = [BUCKETS.granted, BUCKETS.versions, BUCKETS.objectsOnly];
const PRESENT = "present.txt";
const ABSENT = "absent.txt";
/** What present.txt's user metadata carries: it must reach no answer. */
const METADATA_MARKER = "scope-marker-metadata";

interface RawAnswer {
  readonly status: number;
  readonly body: Buffer;
}

/** One request sent with node:http, past every Studio check, signed for `who`. */
function raw(
  who: (typeof KEYS)[keyof typeof KEYS],
  method: string,
  pathname: string,
  query = "",
  body: Buffer = Buffer.alloc(0),
  extra: Readonly<Record<string, string>> = {},
): Promise<RawAnswer> {
  const amzDate = amzDateOf(new Date());
  const headers: Record<string, string> = {
    host: `${HOST}:${PORT}`,
    ...extra,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
  };
  headers.authorization = signatureV4(
    {
      method,
      canonicalUri: pathname,
      canonicalQuery: canonicalQueryOf(query),
      headers,
      payloadHash: "UNSIGNED-PAYLOAD",
    },
    who,
    { region: REGION, service: "s3", amzDate },
  );
  return new Promise((resolve, reject) => {
    const sent = httpRequest(
      {
        host: HOST,
        port: PORT,
        method,
        path: query === "" ? pathname : `${pathname}?${query}`,
        headers: { ...headers, "content-length": String(body.length) },
      },
      (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () => resolve({ status: answer.statusCode ?? 0, body: Buffer.concat(chunks) }));
        answer.on("error", reject);
      },
    );
    sent.on("error", reject);
    sent.end(body);
  });
}

async function must(answer: Promise<RawAnswer>, what: string): Promise<RawAnswer> {
  const settled = await answer;
  if (settled.status < 200 || settled.status >= 300) throw new Error(`${what} answered HTTP ${settled.status}`);
  return settled;
}

const PUBLIC_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: ["*"] },
      Action: ["s3:GetBucketLocation", "s3:ListBucket"],
      Resource: [`arn:aws:s3:::${BUCKETS.public}`],
    },
    {
      Effect: "Allow",
      Principal: { AWS: ["*"] },
      Action: ["s3:GetObject"],
      Resource: [`arn:aws:s3:::${BUCKETS.public}/*`],
    },
  ],
});

/** The run's buckets and objects, as root; Garage's buckets and grants are run.sh's. */
async function seed(): Promise<void> {
  const { root } = KEYS;
  if (!GARAGE) {
    for (const bucket of MADE) await must(raw(root, "PUT", `/${bucket}`), `create ${bucket}`);
    await must(raw(root, "PUT", `/${BUCKETS.public}`, "policy=", Buffer.from(PUBLIC_POLICY)), "public policy");
  }
  for (const bucket of MADE)
    await must(
      raw(root, "PUT", `/${bucket}/${PRESENT}`, "", Buffer.from("present body\n"), {
        "x-amz-meta-owner": METADATA_MARKER,
      }),
      `put ${bucket}/${PRESENT}`,
    );
}

/** The status a raw HeadBucket of each bucket the run made answers `who`. */
async function rawHeadBuckets(who: (typeof KEYS)[keyof typeof KEYS]): Promise<Record<string, number>> {
  const statuses: Record<string, number> = {};
  for (const bucket of [...MADE, BUCKETS.missing]) statuses[bucket] = (await raw(who, "HEAD", `/${bucket}`)).status;
  return statuses;
}

/** The bucket names a raw ListBuckets signed with `who` answers. */
async function rawListing(who: (typeof KEYS)[keyof typeof KEYS]): Promise<string[]> {
  const answer = await must(raw(who, "GET", "/"), "ListBuckets");
  return [...answer.body.toString("utf8").matchAll(/<Name>([^<]*)<\/Name>/g)].map((match) => match[1]).sort();
}

interface Answered {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly structuredContent?: Record<string, unknown>;
}

interface Record_ {
  readonly connection: string;
  readonly statement: string;
  readonly isError: boolean;
  readonly rows?: unknown;
  readonly notes?: unknown;
  /** The answer's last text block, for a refusal: Studio's own words, never a server's. */
  readonly text?: string;
  readonly ms: number;
}

const serve = routeServe(route);
let token = "";

async function tool(name: string, args: Record<string, unknown>): Promise<Answered> {
  const session = await connectClient(serve, { token });
  try {
    return (await session.client.callTool({ name, arguments: args })) as unknown as Answered;
  } finally {
    await session.close();
  }
}

async function s3Read(connection: string, statement: string, extra: Record<string, unknown> = {}): Promise<Record_> {
  const started = Date.now();
  const answer = await tool("run_s3_read", { connection_id: `seed:${connection}`, statement, ...extra });
  const ms = Date.now() - started;
  const isError = answer.isError === true;
  return {
    connection,
    statement,
    isError,
    ms,
    ...(isError
      ? { text: answer.content.at(-1)?.text ?? "" }
      : { rows: answer.structuredContent?.rows, notes: answer.structuredContent?.notes }),
  };
}

const namedReads = (bucket: string): readonly string[] => [
  `aws s3api head-bucket --bucket ${bucket}`,
  `aws s3api get-bucket-location --bucket ${bucket}`,
  `aws s3api get-bucket-versioning --bucket ${bucket}`,
  `aws s3 ls s3://${bucket} --recursive --summarize`,
  `aws s3api head-object --bucket ${bucket} --key ${PRESENT}`,
  `aws s3api head-object --bucket ${bucket} --key ${ABSENT}`,
];

const words = (record: Record_, bucket: string): string =>
  JSON.stringify({ isError: record.isError, text: record.text, rows: record.rows }).replaceAll(bucket, "<bucket>");

const REFUSED = [
  "aws s3api list-objects-v2 --bucket scope-granted",
  "aws s3 ls s3://scope-granted/",
  "aws s3 ls s3://scope-granted/p --recursive --summarize",
  "aws s3api get-object --bucket scope-granted --key present.txt out.txt",
  "aws s3api get-object-tagging --bucket scope-granted --key present.txt",
  "aws s3api put-object --bucket scope-granted --key written.txt",
  "aws s3api list-buckets --endpoint-url http://elsewhere",
];

async function main(): Promise<void> {
  await seed();
  const dir = mkdtempSync(posix.join(tmpdir().replaceAll("\\", "/"), "libredb-s3-mcp-"));
  const template = JSON.parse(
    readFileSync(posix.join(REPO, "tests/fixtures/s3/agent-scope/mcp-seed.json"), "utf8"),
  ) as {
    connections: Record<string, unknown>[];
  };
  const seedPath = posix.join(dir, "seed-connections.json");
  writeFileSync(
    seedPath,
    JSON.stringify({
      ...template,
      connections: template.connections.map((entry) => Object.assign({}, entry, { port: PORT })),
    }),
  );
  process.env.SEED_CONFIG_PATH = seedPath;
  resetCache();
  token = await mintTestToken();
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };

  try {
    const ownKeyListing = await rawListing(KEYS.broad);
    check(
      MADE.every((bucket) => ownKeyListing.includes(bucket)),
      "the connection's own key lists every bucket",
    );

    const listed = await tool("list_connections", {});
    const connections = (listed.structuredContent?.connections ?? []) as Array<Record<string, unknown>>;
    check(
      JSON.stringify(connections.map((row) => [row.id, row.read_tool])) ===
        JSON.stringify([
          ["seed:unlisted-agent", "run_s3_read"],
          ["seed:scoped-agent", "run_s3_read"],
        ]),
      "list_connections names run_s3_read on both connections",
    );
    const inspect = await tool("inspect_schema", { connection_id: "seed:unlisted-agent" });
    check(inspect.isError === true && (inspect.content.at(-1)?.text ?? "").includes("run_s3_read"), "inspect_schema");

    const listing = {
      unlisted: await s3Read("unlisted-agent", "aws s3api list-buckets"),
      scoped: await s3Read("scoped-agent", "aws s3api list-buckets"),
    };
    const namesOf = (record: Record_) =>
      ((record.rows ?? []) as Array<{ bucket: string }>).map((row) => row.bucket).sort();
    // What the server answers each agent key: its raw listing, and a raw HeadBucket of every bucket the run made.
    const heads = { unlisted: await rawHeadBuckets(KEYS.unlisted), scoped: await rawHeadBuckets(KEYS.scoped) };
    const rawListed = { unlisted: await rawListing(KEYS.unlisted), scoped: await rawListing(KEYS.scoped) };
    const listingCost = Object.fromEntries(
      (["unlisted", "scoped"] as const).map((who) => [
        who,
        {
          listedByServer: rawListed[who].length,
          requests: { ListBuckets: 1, HeadBucket: rawListed[who].length },
          answeredMs: listing[who].ms,
        },
      ]),
    );
    for (const who of ["unlisted", "scoped"] as const) {
      const readable = rawListed[who].filter((bucket) => heads[who][bucket] >= 200 && heads[who][bucket] < 300);
      const withheld = rawListed[who].length - readable.length;
      check(
        JSON.stringify(namesOf(listing[who])) === JSON.stringify(readable),
        `the ${who} agent key's listing names exactly the listed buckets whose HeadBucket it is answered 200`,
      );
      check(
        JSON.stringify(listing[who].notes ?? []) ===
          JSON.stringify(withheld === 0 ? [] : [S3_AGENT_FAILURE_SENTENCES.withheldBuckets(withheld)]),
        `the ${who} agent key's listing counts the ${withheld} withheld buckets in a note`,
      );
      check(!namesOf(listing[who]).includes(BUCKETS.other), `the ${who} agent key's listing names no ungranted bucket`);
    }
    const unlistedNames = namesOf(listing.unlisted);
    check(unlistedNames.length > 0, "the unlisted agent key lists its granted buckets");
    check(
      unlistedNames.every((bucket) => GRANTED.includes(bucket)),
      "the unlisted agent key lists no bucket it is granted nothing on",
    );
    check(!unlistedNames.includes(BUCKETS.other), "MCP signed with the agent key, not the connection's own");

    const oracle: Record<string, boolean> = {};
    const reads: Record_[] = [];
    for (const [index, statement] of namedReads(BUCKETS.other).entries()) {
      const ungranted = await s3Read("unlisted-agent", statement);
      const missing = await s3Read("unlisted-agent", namedReads(BUCKETS.missing)[index]);
      reads.push(ungranted, missing);
      const alike = words(ungranted, BUCKETS.other) === words(missing, BUCKETS.missing);
      oracle[statement.replace(BUCKETS.other, "<bucket>")] = alike;
      check(alike, `ungranted and missing answer alike: ${statement}`);
      check(
        ungranted.isError && (ungranted.text ?? "").includes(S3_AGENT_FAILURE_SENTENCES.notFound),
        `refused in the notFound sentence: ${statement}`,
      );
    }
    const presentUngranted = reads[8];
    const absentUngranted = reads[10];
    oracle.ungrantedPresentKeyLikeAbsent =
      words(presentUngranted, BUCKETS.other) === words(absentUngranted, BUCKETS.other);
    check(oracle.ungrantedPresentKeyLikeAbsent, "a present key in an ungranted bucket answers as an absent one");
    for (const statement of namedReads(BUCKETS.granted)) reads.push(await s3Read("unlisted-agent", statement));
    for (const statement of namedReads(BUCKETS.public).slice(0, 5))
      reads.push(await s3Read("unlisted-agent", statement));

    const server = languageServer("s3api");
    const refused: Record_[] = [];
    for (const statement of REFUSED) {
      const record = await s3Read("unlisted-agent", statement);
      refused.push(record);
      const admission = server.admit?.(statement);
      check(
        record.isError &&
          admission !== null &&
          admission !== undefined &&
          record.text ===
            `The command was refused before it reached the server (${admission.code}). ${admission.message}`,
        `refused before anything is acquired: ${statement}`,
      );
    }

    // The limits, with the server paused after the acquisition the reads above opened.
    execFileSync("docker", ["pause", CONTAINER]);
    let limits: Record<string, unknown>;
    try {
      const timeout = await s3Read("unlisted-agent", `aws s3api head-bucket --bucket ${BUCKETS.granted}`, {
        timeout_ms: 500,
      });
      check(timeout.text === timeoutText(500), "a paused server is the timeout answer at the least timeout_ms");
      const arm = mcpStatementArm("run_s3_read");
      const context = new McpConnectionContext({ username: "alice", role: "admin" } as never);
      const controller = new AbortController();
      const started = Date.now();
      const pending = runStatement(
        arm,
        arm.inputSchema.parse({
          connection_id: "seed:unlisted-agent",
          statement: `aws s3api head-bucket --bucket ${BUCKETS.granted}`,
          timeout_ms: 3_000,
        }) as never,
        { context, signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 1_000);
      const cancelled = await pending;
      const cancelledMs = Date.now() - started;
      check(cancelled.content.at(-1)?.text === MCP_CANCELLED_TEXT, "a client cancel answers the cancel");
      limits = {
        timeout: { timeout_ms: 500, answered_ms: timeout.ms, text: timeout.text },
        cancel: { timeout_ms: 3_000, cancelled_at_ms: 1_000, answered_ms: cancelledMs },
      };
    } finally {
      execFileSync("docker", ["unpause", CONTAINER]);
    }

    // What the tool answered, without the statements, which name a key in full where the request did.
    const answered = [listing.unlisted, listing.scoped, ...reads, ...refused].map((read) => ({
      connection: read.connection,
      isError: read.isError,
      rows: read.rows,
      notes: read.notes,
      text: read.text,
    }));
    const answers = JSON.stringify({ answered, connections });
    const leaks = [
      ...(answers.includes(METADATA_MARKER) ? ["the metadata marker"] : []),
      ...[PRESENT, ABSENT].filter((key) => answers.includes(key)).map((key) => `the key ${key}`),
      ...(answers.includes(`:${PORT}`) ? ["the endpoint's port"] : []),
      ...(CREDENTIAL_VALUES.some((value) => answers.includes(value)) ? ["a credential"] : []),
    ];
    check(leaks.length === 0, `leaks: ${leaks.join(", ")}`);

    const capture = {
      server: SERVER,
      image: IMAGE,
      date: DATE,
      region: REGION,
      seed: "tests/fixtures/s3/agent-scope/mcp-seed.json, with this server's port",
      ownKey: "the broad key, holding tests/fixtures/s3/agent-boundary/reader-policy.json",
      agentKeys: {
        "unlisted-agent":
          "the unlisted key, holding unlisted-policy.json: the scoped grants without s3:ListAllMyBuckets",
        "scoped-agent": "the scoped key, holding scoped-policy.json: the same grants with s3:ListAllMyBuckets",
      },
      ownKeyListing,
      rawListed,
      heads,
      listing,
      listingCost,
      oracle,
      reads,
      refused,
      limits,
      leaks,
      failures,
    };
    const text = `${JSON.stringify(capture, null, 2)}\n`;
    for (const value of CREDENTIAL_VALUES) {
      if (text.includes(value)) throw new Error("the capture holds a credential value, so it was not written");
    }
    writeFileSync(posix.join(OUT.replaceAll("\\", "/"), "mcp.json"), text);
    console.log(`${SERVER}: ${reads.length} reads, ${refused.length} refused, leaks ${leaks.length}`);
    console.log(
      JSON.stringify({ ownKeyListing, rawListed, heads, unlisted: unlistedNames, scoped: namesOf(listing.scoped) }),
    );
    console.log(JSON.stringify({ notes: listing.scoped.notes, listingCost }));
    for (const failure of failures) console.error(`failed: ${failure}`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit();
