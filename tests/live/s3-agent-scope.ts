/**
 * Measures what a bucket-scoped key and a broad read key reach through the S3 agent's reads on the server an
 * agent-scope/<set>/run.sh started, and writes what the server and the agent answered into that run.sh's directory.
 *
 *   bun tests/live/s3-agent-scope.ts
 *
 * The environment names the server: S3_SCOPE_SERVER (silo, rustfs or garage), S3_SCOPE_IMAGE (the image with its digest),
 * S3_SCOPE_PORT (its S3 port on 127.0.0.1), S3_SCOPE_OUT (the directory to write), and an access key id and its
 * secret for each of four keys made for the run by run.sh, named S3_SCOPE_<WHO>_KEY and the matching _SECRET, where
 * WHO is ROOT (the key the server was started with), SCOPED (holding scoped-policy.json in the agent-scope fixture
 * directory), BROAD (holding the agent-boundary fixture's reader-policy.json) or UNLISTED (holding
 * unlisted-policy.json, the scoped key's grants without s3:ListAllMyBuckets).
 *
 * The scoped key may list every bucket name (s3:ListAllMyBuckets), list and read the objects of scope-granted and
 * scope-versions, and read, but not list, the objects of scope-objects-only. scope-other is granted nothing, and
 * scope-public is granted nothing either but carries a bucket policy that lets anyone read and list it. scope-missing
 * is never created. Every bucket that exists holds present.txt, whose user metadata carries a marker, and
 * scope-versions also holds gone.txt behind a delete marker. Garage has no policies, versioning or bucket policy, only
 * per-key grants on a bucket, so its run.sh creates the buckets and grants the scoped and the unlisted key read on
 * scope-granted, scope-versions and scope-objects-only, the broad key read on every bucket and root read, write and
 * owner, and gone.txt is simply deleted.
 *
 * What is measured is whether an agent read tells the scoped key more than its policy grants: for each named read, the
 * agent's answer for a bucket it is granted nothing on against a bucket that does not exist, and for a key in such a
 * bucket that exists against one that does not. The same HEADs are also sent raw, signed and unsigned, to record what
 * the server itself tells any client. A raw answer is recorded by its status alone, never by its body.
 *
 * Nothing written holds a credential: no access key id or secret, not even as a placeholder, and the script refuses to
 * write a capture that holds any of the eight values.
 *
 * The run exits non-zero when a capture holds a leak, an oracle entry for an ungranted bucket or key is false, or a
 * scoped-key read of scope-other or scope-missing is refused in any words but the notFound sentence; the capture is
 * still written, so what failed can be read.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { request as httpRequest } from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { S3_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/objectstore/s3/agent-metadata-read";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { amzDateOf, canonicalQueryOf, signatureV4 } from "@/lib/db/providers/objectstore/s3/sigv4";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const SERVER = env("S3_SCOPE_SERVER");
if (SERVER !== "silo" && SERVER !== "rustfs" && SERVER !== "garage")
  throw new Error("S3_SCOPE_SERVER is silo, rustfs or garage");
const GARAGE = SERVER === "garage";
const IMAGE = env("S3_SCOPE_IMAGE");
const PORT = Number(env("S3_SCOPE_PORT"));
const OUT = env("S3_SCOPE_OUT");
const KEYS = {
  root: { accessKeyId: env("S3_SCOPE_ROOT_KEY"), secretAccessKey: env("S3_SCOPE_ROOT_SECRET") },
  scoped: { accessKeyId: env("S3_SCOPE_SCOPED_KEY"), secretAccessKey: env("S3_SCOPE_SCOPED_SECRET") },
  broad: { accessKeyId: env("S3_SCOPE_BROAD_KEY"), secretAccessKey: env("S3_SCOPE_BROAD_SECRET") },
  unlisted: { accessKeyId: env("S3_SCOPE_UNLISTED_KEY"), secretAccessKey: env("S3_SCOPE_UNLISTED_SECRET") },
} as const;
type Who = keyof typeof KEYS;
const CREDENTIAL_VALUES = Object.values(KEYS).flatMap((key) => [key.accessKeyId, key.secretAccessKey]);
const REGION = GARAGE ? "garage" : "us-east-1";
const HOST = "127.0.0.1";
const DATE = new Date().toISOString().slice(0, 10);

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 };
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };

const BUCKETS = {
  granted: "scope-granted",
  versions: "scope-versions",
  objectsOnly: "scope-objects-only",
  other: "scope-other",
  public: "scope-public",
  missing: "scope-missing",
} as const;
const PRESENT = "present.txt";
const ABSENT = "absent.txt";
const GONE = "gone.txt";
/** What present.txt's user metadata carries: it must reach no agent answer. */
const METADATA_MARKER = "scope-marker-metadata";

interface RawAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

/** One request sent with node:http, past every Studio check: signed for `who`, or unsigned when `who` is null. */
function raw(
  who: (typeof KEYS)[Who] | null,
  method: string,
  pathname: string,
  query = "",
  body: Buffer = Buffer.alloc(0),
  extra: Readonly<Record<string, string>> = {},
): Promise<RawAnswer> {
  const amzDate = amzDateOf(new Date());
  const host = `${HOST}:${PORT}`;
  const headers: Record<string, string> = { host, ...extra };
  if (who !== null) {
    headers["x-amz-date"] = amzDate;
    headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
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
  }
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
        answer.on("end", () =>
          resolve({ status: answer.statusCode ?? 0, headers: answer.headers, body: Buffer.concat(chunks) }),
        );
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

/** The buckets and objects of the run, as root. */
async function seed(): Promise<void> {
  const { root } = KEYS;
  // Garage's buckets and grants are run.sh's, made through its admin API; it has no versioning and no bucket policy.
  if (!GARAGE) await seedBuckets();
  const put = (bucket: string, key: string) =>
    must(
      raw(root, "PUT", `/${bucket}/${key}`, "", Buffer.from(`${key} body\n`), { "x-amz-meta-owner": METADATA_MARKER }),
      `put ${bucket}/${key}`,
    );
  for (const bucket of [BUCKETS.granted, BUCKETS.versions, BUCKETS.objectsOnly, BUCKETS.other, BUCKETS.public])
    await put(bucket, PRESENT);
  await put(BUCKETS.versions, GONE);
  await must(raw(root, "DELETE", `/${BUCKETS.versions}/${GONE}`), "delete gone.txt");
}

async function seedBuckets(): Promise<void> {
  const { root } = KEYS;
  for (const bucket of [BUCKETS.granted, BUCKETS.versions, BUCKETS.objectsOnly, BUCKETS.other, BUCKETS.public])
    await must(raw(root, "PUT", `/${bucket}`), `create ${bucket}`);
  await must(
    raw(
      root,
      "PUT",
      `/${BUCKETS.versions}`,
      "versioning=",
      Buffer.from(
        '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
      ),
    ),
    "enable versioning",
  );
  await must(raw(root, "PUT", `/${BUCKETS.public}`, "policy=", Buffer.from(PUBLIC_POLICY)), "public policy");
}

function studio(who: Who): S3Provider {
  const key = KEYS[who];
  const connection = {
    id: `s3-scope-${SERVER}`,
    name: `S3 scope ${SERVER}`,
    type: "s3",
    host: HOST,
    port: PORT,
    user: key.accessKeyId,
    password: key.secretAccessKey,
    region: REGION,
    createdAt: new Date(0),
  } as DatabaseConnection;
  return new S3Provider(connection, {}, READ_ONLY);
}

interface AgentRecord {
  readonly statement: string;
  readonly as: Who;
  readonly fields?: readonly string[];
  readonly rows?: readonly unknown[];
  readonly warnings?: readonly string[];
  readonly refused?: string;
}

async function agentRecord(who: Who, statement: string): Promise<AgentRecord> {
  const provider = studio(who);
  await provider.connect();
  try {
    const result = await provider.queryReadOnly(statement, BUDGET);
    return {
      statement,
      as: who,
      fields: result.fields,
      rows: result.rows,
      ...(result.warnings === undefined ? {} : { warnings: result.warnings.map((warning) => warning.message) }),
    };
  } catch (error) {
    return { statement, as: who, refused: (error as Error).message };
  } finally {
    await provider.disconnect();
  }
}

const NAMED_BUCKETS = [
  BUCKETS.granted,
  BUCKETS.versions,
  BUCKETS.objectsOnly,
  BUCKETS.other,
  BUCKETS.public,
  BUCKETS.missing,
] as const;

const bucketReads = (bucket: string): readonly string[] => [
  `aws s3api head-bucket --bucket ${bucket}`,
  `aws s3api get-bucket-location --bucket ${bucket}`,
  `aws s3api get-bucket-versioning --bucket ${bucket}`,
  `aws s3 ls s3://${bucket} --recursive --summarize`,
  `aws s3api head-object --bucket ${bucket} --key ${PRESENT}`,
  `aws s3api head-object --bucket ${bucket} --key ${ABSENT}`,
];

/** An agent answer with its bucket's name taken out, so two buckets' answers can be compared. */
function shapeOf(record: AgentRecord | undefined, bucket: string): string {
  if (record === undefined) throw new Error("no record");
  return JSON.stringify({ ...record, statement: undefined, as: undefined }).replaceAll(bucket, "<bucket>");
}

interface RawRecord {
  readonly call: string;
  readonly as: Who | "anonymous";
  readonly status: number;
  /** The `x-minio-error-code` header's value where the server sent one: an error code, never a name or a value. */
  readonly errorCode?: string;
}

async function rawHeads(): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  for (const as of ["scoped", "anonymous"] as const) {
    const who = as === "anonymous" ? null : KEYS[as];
    for (const bucket of NAMED_BUCKETS) {
      for (const [call, pathname] of [
        [`HeadBucket ${bucket}`, `/${bucket}`],
        [`HeadObject ${bucket}/${PRESENT}`, `/${bucket}/${PRESENT}`],
        [`HeadObject ${bucket}/${ABSENT}`, `/${bucket}/${ABSENT}`],
      ] as const) {
        const answer = await raw(who, "HEAD", pathname);
        const code = answer.headers["x-minio-error-code"];
        records.push({ call, as, status: answer.status, ...(typeof code === "string" ? { errorCode: code } : {}) });
      }
    }
  }
  return records;
}

async function main(): Promise<void> {
  await seed();

  const agent: AgentRecord[] = [];
  for (const who of ["scoped", "broad"] as const) {
    agent.push(await agentRecord(who, "aws s3api list-buckets"));
    for (const bucket of NAMED_BUCKETS)
      for (const statement of bucketReads(bucket)) agent.push(await agentRecord(who, statement));
    agent.push(await agentRecord(who, `aws s3api head-object --bucket ${BUCKETS.versions} --key ${GONE}`));
  }
  // What a key without s3:ListAllMyBuckets is answered for the bucket listing, and for a bucket it is granted.
  agent.push(await agentRecord("unlisted", "aws s3api list-buckets"));
  agent.push(await agentRecord("unlisted", `aws s3api head-bucket --bucket ${BUCKETS.granted}`));
  const rawRecords = await rawHeads();

  const find = (who: Who, statement: string) =>
    agent.find((record) => record.as === who && record.statement === statement);
  // The scoped key's answer for a bucket it is granted nothing on, against a bucket that does not exist, read by read;
  // and for an object that exists in such a bucket, against one that does not.
  const oracle = {
    ungrantedBucketLikeMissing: Object.fromEntries(
      bucketReads(BUCKETS.other).map((statement, index) => [
        statement.replace(BUCKETS.other, "<bucket>"),
        shapeOf(find("scoped", statement), BUCKETS.other) ===
          shapeOf(find("scoped", bucketReads(BUCKETS.missing)[index]), BUCKETS.missing),
      ]),
    ),
    ungrantedPresentKeyLikeAbsent:
      shapeOf(find("scoped", bucketReads(BUCKETS.other)[4]), BUCKETS.other) ===
      shapeOf(find("scoped", bucketReads(BUCKETS.other)[5]), BUCKETS.other),
    objectsOnlyPresentKeyLikeAbsent:
      shapeOf(find("scoped", bucketReads(BUCKETS.objectsOnly)[4]), BUCKETS.objectsOnly) ===
      shapeOf(find("scoped", bucketReads(BUCKETS.objectsOnly)[5]), BUCKETS.objectsOnly),
  };

  const answersText = JSON.stringify(agent.map((record) => ({ ...record, statement: undefined })));
  const leaks = [
    ...(answersText.includes(METADATA_MARKER) ? ["the metadata marker"] : []),
    ...[PRESENT, ABSENT, GONE].filter((key) => answersText.includes(key)).map((key) => `the key ${key}`),
    ...(answersText.includes(`${PORT}`) ? ["the endpoint's port"] : []),
  ];

  const capture = {
    server: SERVER,
    image: IMAGE,
    date: DATE,
    region: REGION,
    scoped: "a key made for the run, holding scoped-policy.json beside this server's directory",
    broad: "a key made for the run, holding tests/fixtures/s3/agent-boundary/reader-policy.json",
    unlisted: "a key made for the run, holding unlisted-policy.json beside this server's directory",
    buckets: BUCKETS,
    agent,
    raw: rawRecords,
    oracle,
    leaks,
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  for (const value of CREDENTIAL_VALUES) {
    if (text.includes(value)) throw new Error("the capture holds a credential value, so it was not written");
  }
  writeFileSync(path.join(OUT, "scope.json"), text);
  console.log(`${SERVER}: ${agent.length} agent records, ${rawRecords.length} raw HEADs, leaks ${leaks.length}`);
  console.log(JSON.stringify(oracle, null, 2));
  // The oracle compares two answers to each other, so two alike wrong refusals would pass it: every scoped-key read
  // of a bucket it is granted nothing on, or of one that does not exist, must be refused in the notFound sentence.
  const wrongRefusals = [BUCKETS.other, BUCKETS.missing]
    .flatMap((bucket) => bucketReads(bucket))
    .filter((statement) => find("scoped", statement)?.refused !== S3_AGENT_FAILURE_SENTENCES.notFound);
  const oracleFalse = [
    ...Object.entries(oracle.ungrantedBucketLikeMissing)
      .filter(([, alike]) => !alike)
      .map(([statement]) => statement),
    ...(oracle.ungrantedPresentKeyLikeAbsent ? [] : ["ungrantedPresentKeyLikeAbsent"]),
  ];
  for (const statement of wrongRefusals) console.error(`not refused in the notFound sentence: ${statement}`);
  for (const entry of oracleFalse) console.error(`oracle entry false: ${entry}`);
  if (leaks.length > 0 || wrongRefusals.length > 0 || oracleFalse.length > 0) process.exitCode = 1;
}

await main();
