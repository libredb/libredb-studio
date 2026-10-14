/**
 * The evidence harness for the Apache Spark provider.
 *
 * It drives @grpc/grpc-js against the compose services of database-compose.yml with the definition the descriptor
 * generator's loadSparkDescriptor() builds, never an import of proto/descriptor.ts or of the provider, so a capture
 * records what Spark sent independently of the code under test. Each entry of SPARK_CAPTURE_CATALOG runs in a fresh
 * session and writes tests/fixtures/spark/<version>/<name>.json, the request as the provider's codec reads it back
 * (requestDeserialize of requestSerialize, with the provider's loader options), so the replay matches it with that
 * codec. Client-chosen ids are written <session>, <operation> and <tag>, inside grpc-status-details-bin too, whose
 * Status message and ErrorInfo values are then re-encoded; the authorization metadata <token>; and every Config value
 * whose full key lies under spark.sql.catalog. <value>. A file that would still hold the token or a client id, in its
 * text or inside a bytes value read as Latin-1, or pass 2 MB, is not written. An outcome other than the catalog expects
 * stops the run, so a surprise is reported rather than recorded. A target is dialled only once `docker port` lists it
 * for its fixture container, which runs its pinned image. Captures run under Bun only.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), with the variables of
 * tests/helpers/spark-live.ts set and the service started:
 *   bun tests/live/spark-evidence.ts --setup <spark|spark-4-1|spark-auth>   create the sample objects
 *   bun tests/live/spark-evidence.ts --capture <spark|spark-4-1|spark-auth|spark-tls> [<entry> ...]
 *   bun tests/live/spark-evidence.ts --readme                                render tests/fixtures/spark/README.md
 *   bun tests/live/spark-evidence.ts --surfaces                              rewrite each capture's surface
 * Named entries, each an entry of SPARK_CAPTURE_CATALOG that runs on the service, retake only their captures; with no
 * entry named, every entry of the service runs. `--surfaces` contacts no server: it writes into each capture's header
 * the surface its entry gives it now, every other byte as written, so a changed surface needs no retake.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import protobuf from "protobufjs";
import { loadSparkDescriptor } from "../../scripts/generate-spark-descriptor.mjs";
import {
  maskSparkLive,
  readSparkLiveArguments,
  type SparkLiveArguments,
  type SparkLiveService,
  sparkLiveSecrets,
} from "../helpers/spark-live";
import {
  capturesOf,
  SPARK_CAPTURE_CATALOG,
  SPARK_CAPTURE_METADATA_SESSION_CONF,
  SPARK_CAPTURE_SESSION_CONF,
  SPARK_FIXTURE_CONTAINERS,
  SPARK_SAMPLE_STATEMENTS,
  SPARK_SERVICE_IMAGES,
  type SparkBeforeStatement,
  type SparkCaptureEntry,
  type SparkCaptureName,
  type SparkCaptureVersionDir,
} from "./spark-evidence-plan";

const ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "spark");
const MAX_CAPTURE_BYTES = 2_000_000;
const USAGE =
  "Usage: bun tests/live/spark-evidence.ts --setup <spark|spark-4-1|spark-auth> | --capture <spark|spark-4-1|spark-auth|spark-tls> [<entry> ...] | --readme | --surfaces";
const USER_CONTEXT = { user_id: "libredb-studio", user_name: "libredb-studio" };
const CLIENT_TYPE = "libredb-studio";
const CHUNKING = [
  { result_chunking_options: { allow_arrow_batch_chunking: true, preferred_arrow_chunk_size: "4194304" } },
];
const VERSION_OF: Readonly<Record<SparkLiveService, SparkCaptureVersionDir>> = {
  spark: "4.2.0",
  "spark-4-1": "4.1.3",
  "spark-auth": "4.2.0",
  "spark-tls": "4.2.0",
};
/** The provider's loader options (SPARK_LOADER_OPTIONS of grpc-client.ts), copied: the harness never imports it. */
export const SPARK_CAPTURE_LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;
const CATALOG_PREFIX = "spark.sql.catalog.";
const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";

export type SparkCaptureRpc =
  | "ExecutePlan"
  | "AnalyzePlan"
  | "Config"
  | "Interrupt"
  | "ReleaseSession"
  | "FetchErrorDetails";
type Rpc = SparkCaptureRpc;
type Token = SparkCaptureEntry["token"];
export type SparkCaptureAnswer =
  | { readonly outcome: "pass"; readonly payload: unknown }
  | {
      readonly outcome: "error";
      readonly code: number;
      readonly details: string;
      readonly metadata: Record<string, unknown>;
    };
type Answer = SparkCaptureAnswer;
type UnaryMethod = (
  request: object,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response?: object) => void,
) => void;
type StreamMethod = (
  request: object,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
) => grpc.ClientReadableStream<object>;

/** The ids the harness chose in one entry's session, which a capture writes as placeholders. */
export interface SparkCaptureIds {
  readonly session: string;
  readonly operations: string[];
  readonly tags: string[];
}
type Ids = SparkCaptureIds;

interface Context {
  readonly args: SparkLiveArguments;
  readonly service: SparkLiveService;
  readonly version: SparkCaptureVersionDir;
  readonly client: grpc.Client;
  readonly secrets: readonly string[];
}

let definition: grpc.ServiceDefinition | undefined;
function sparkService(): grpc.ServiceDefinition {
  definition ??= fromJSON(loadSparkDescriptor(), SPARK_CAPTURE_LOADER_OPTIONS)[
    "spark.connect.SparkConnectService"
  ] as grpc.ServiceDefinition;
  return definition;
}

let constructor: grpc.ServiceClientConstructor | undefined;
function serviceClient(): grpc.ServiceClientConstructor {
  constructor ??= grpc.makeGenericClientConstructor(sparkService(), "SparkConnectService");
  return constructor;
}

/** `request` as the codec reads it back: what Spark received, in the decoded form the provider's codec gives. */
function decodedRequest(rpc: Rpc, request: object): object {
  const method = sparkService()[rpc] as grpc.MethodDefinition<object, object>;
  return method.requestDeserialize(method.requestSerialize(request));
}

/** A stored value with every {"$bytes": "<base64>"} as bytes again. */
function storedBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(storedBytes);
  if (value === null || typeof value !== "object") return value;
  const { $bytes } = value as { readonly $bytes?: unknown };
  if (typeof $bytes === "string" && Object.keys(value).length === 1) return Buffer.from($bytes, "base64");
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, storedBytes(inner)]));
}

/** A stored request passed through its RPC's codec and stored again; a capture's request is already in this form. */
export function reencodedRequest(rpc: SparkCaptureRpc, request: unknown): unknown {
  return encode(decodedRequest(rpc, storedBytes(request) as object));
}

function openClient(args: SparkLiveArguments, service: SparkLiveService, address: string): grpc.Client {
  const Client = serviceClient();
  if (service !== "spark-tls") return new Client(address, grpc.credentials.createInsecure());
  return new Client(address, grpc.credentials.createSsl(readFileSync(path.join(args.tlsDir, "ca.pem"))), {
    "grpc.ssl_target_name_override": "localhost",
    "grpc.default_authority": "localhost",
  });
}

function metadataFor(ctx: Context, token: Token): grpc.Metadata {
  const metadata = new grpc.Metadata();
  if (token === "configured") metadata.set("authorization", `Bearer ${ctx.args.token}`);
  if (token === "wrong") metadata.set("authorization", `Bearer ${ctx.args.token}-wrong`);
  return metadata;
}

function failure(error: grpc.ServiceError): Answer {
  return { outcome: "error", code: error.code, details: error.details, metadata: { ...error.metadata.getMap() } };
}

function unary(ctx: Context, rpc: Exclude<Rpc, "ExecutePlan">, request: object, token: Token): Promise<Answer> {
  const method = (ctx.client as unknown as Record<string, UnaryMethod>)[rpc] as UnaryMethod;
  return new Promise((resolve) => {
    method.call(ctx.client, request, metadataFor(ctx, token), { deadline: Date.now() + 30_000 }, (error, response) =>
      resolve(error === null ? { outcome: "pass", payload: response } : failure(error)),
    );
  });
}

function executePlan(ctx: Context, request: object, token: Token, onFirst?: () => void): Promise<Answer> {
  const method = (ctx.client as unknown as Record<string, StreamMethod>).ExecutePlan as StreamMethod;
  const call = method.call(ctx.client, request, metadataFor(ctx, token), { deadline: Date.now() + 330_000 });
  const responses: object[] = [];
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: Answer) => {
      if (!settled) {
        settled = true;
        resolve(answer);
      }
    };
    call.on("data", (response: object) => {
      responses.push(response);
      if (responses.length === 1) onFirst?.();
    });
    call.on("error", (error: grpc.ServiceError) => settle(failure(error)));
    call.on("end", () => settle({ outcome: "pass", payload: responses }));
  });
}

const base = (ids: Ids) => ({ session_id: ids.session, user_context: USER_CONTEXT, client_type: CLIENT_TYPE });
const configSet = (ids: Ids, pairs: readonly (readonly [string, string])[]) => ({
  ...base(ids),
  operation: { set: { pairs: pairs.map(([key, value]) => ({ key, value })) } },
});
const commandRequest = (ids: Ids, sql: string, operation: string, tag: string) => ({
  ...base(ids),
  operation_id: operation,
  tags: [tag],
  request_options: CHUNKING,
  plan: { command: { sql_command: { input: { sql: { query: sql } } } } },
});
const relationRequest = (ids: Ids, relation: object, operation: string, tag: string) => ({
  ...base(ids),
  operation_id: operation,
  tags: [tag],
  request_options: CHUNKING,
  plan: { root: relation },
});

/** The lazy relation a command step answered, or undefined when it answered inline. */
function lazyRelation(payload: unknown): object | undefined {
  const result = (
    payload as readonly {
      readonly sql_command_result?: { readonly relation?: { readonly rel_type?: string } } | null;
    }[]
  )
    .map((response) => response.sql_command_result)
    .find((value) => value !== null && value !== undefined);
  const relation = result?.relation;
  if (relation === undefined || relation === null) throw new Error("the command step answered no sql_command_result");
  return relation.rel_type === "local_relation" ? undefined : relation;
}

function newRun(ids: Ids): { readonly operation: string; readonly tag: string } {
  const operation = randomUUID();
  const tag = `libredb-studio-${randomUUID()}`;
  ids.operations.push(operation);
  ids.tags.push(tag);
  return { operation, tag };
}

/** A statement run for its effect, before a capture: both steps, and any failure stops the run. */
async function runUncaptured(ctx: Context, ids: Ids, sql: string, token: Token): Promise<void> {
  const run = newRun(ids);
  const command = await executePlan(ctx, commandRequest(ids, sql, run.operation, run.tag), token);
  if (command.outcome === "error")
    throw new Error(`setup statement failed (${command.code}): ${maskSparkLive(command.details, ctx.secrets)}`);
  const relation = lazyRelation(command.payload);
  if (relation === undefined) return;
  const second = randomUUID();
  ids.operations.push(second);
  const answer = await executePlan(ctx, relationRequest(ids, relation, second, run.tag), token);
  if (answer.outcome === "error")
    throw new Error(`setup statement failed (${answer.code}): ${maskSparkLive(answer.details, ctx.secrets)}`);
}

/** A statement the replay sends before the captured one: its command step, which must answer inline, captured. */
async function runBefore(
  ctx: Context,
  ids: Ids,
  statement: SparkBeforeStatement,
  surface: string,
  token: Token,
): Promise<void> {
  const run = newRun(ids);
  const request = commandRequest(ids, statement.sql, run.operation, run.tag);
  const answer = await executePlan(ctx, request, token);
  if (answer.outcome === "pass" && lazyRelation(answer.payload) !== undefined) {
    throw new Error(
      `${statement.name}: the statement answered with a relation to run, not inline; nothing was written`,
    );
  }
  writeCapture(ctx, statement.name, "ExecutePlan", surface, request, answer, ids, "pass");
}

/** `value` as JSON, every Uint8Array as {"$bytes": "<base64>"} once `check` has read it. */
function encode(value: unknown, check: (bytes: Uint8Array) => void = () => undefined): unknown {
  if (value instanceof Uint8Array) {
    check(value);
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map((item) => encode(item, check));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, encode(inner, check)]));
  }
  return value;
}

/**
 * Config answers: a value under spark.sql.catalog. may hold a catalog's credentials, so it is never written. A get_all
 * answer names its keys without the prefix, so the full key is the prefix and the returned key together.
 */
export function withoutCatalogValues(
  rpc: SparkCaptureRpc,
  request: object,
  answer: SparkCaptureAnswer,
): SparkCaptureAnswer {
  if (rpc !== "Config" || answer.outcome !== "pass") return answer;
  const prefix =
    (request as { readonly operation?: { readonly get_all?: { readonly prefix?: string } } }).operation?.get_all
      ?.prefix ?? "";
  const payload = answer.payload as { readonly pairs?: readonly { readonly key: string; readonly value?: unknown }[] };
  // oxlint-disable-next-line no-map-spread -- the answer object is decoded once and must stay as Spark sent it.
  const pairs = (payload.pairs ?? []).map((pair) =>
    pair.key.startsWith(CATALOG_PREFIX) || `${prefix}${pair.key}`.startsWith(CATALOG_PREFIX)
      ? { ...pair, value: "<value>" }
      : pair,
  );
  return { outcome: "pass", payload: { ...payload, pairs } };
}

function maskIds(text: string, ids: Ids): string {
  let masked = text;
  for (const tag of ids.tags) masked = masked.split(tag).join("<tag>");
  for (const operation of ids.operations) masked = masked.split(operation).join("<operation>");
  return masked.split(ids.session).join("<session>");
}

const clientIds = (ids: Ids): string[] => [...ids.tags, ...ids.operations, ids.session];

/**
 * grpc-status-details-bin with the client-chosen ids masked in the Status message and the ErrorInfo metadata values,
 * re-encoded; Spark's bytes as sent when they hold no client id. Any other detail keeps its bytes, and the check of
 * captureText stops the write if one of them holds an id.
 */
export function maskStatusDetails(bytes: Uint8Array, ids: SparkCaptureIds): Uint8Array {
  if (!clientIds(ids).some((id) => Buffer.from(bytes).toString("latin1").includes(id))) return bytes;
  const Status = RPC_TYPES.lookupType("google.rpc.Status");
  const ErrorInfo = RPC_TYPES.lookupType("google.rpc.ErrorInfo");
  const status = Status.decode(bytes) as unknown as {
    readonly code: number;
    readonly message: string;
    readonly details: readonly { readonly type_url: string; readonly value: Uint8Array }[];
  };
  const details = status.details.map((detail) => {
    if (detail.type_url !== ERROR_INFO) return { type_url: detail.type_url, value: detail.value };
    const info = ErrorInfo.decode(detail.value) as unknown as {
      readonly reason: string;
      readonly domain: string;
      readonly metadata: Readonly<Record<string, string>>;
    };
    const metadata = Object.fromEntries(Object.entries(info.metadata).map(([key, text]) => [key, maskIds(text, ids)]));
    return {
      type_url: detail.type_url,
      value: ErrorInfo.encode({ reason: info.reason, domain: info.domain, metadata }).finish(),
    };
  });
  return Status.encode({ code: status.code, message: maskIds(status.message, ids), details }).finish();
}

/**
 * The JSON text of one capture: the header, then the answer with the ids masked and the authorization metadata
 * written <token>. Every bytes value is read as Latin-1 before it is written, so the token or a client id inside one
 * stops the write as it does in the text.
 */
export function captureText(
  name: string,
  header: Readonly<Record<string, unknown>>,
  answer: SparkCaptureAnswer,
  ids: SparkCaptureIds,
  secrets: readonly string[],
): string {
  const holdsToken = (text: string) => secrets.some((secret) => secret !== "" && text.includes(secret));
  const check = (bytes: Uint8Array) => {
    const text = Buffer.from(bytes).toString("latin1");
    if (holdsToken(text)) throw new Error(`${name}: the capture would hold the token; nothing was written`);
    if (clientIds(ids).some((id) => text.includes(id))) {
      throw new Error(`${name}: a bytes value would hold a client-chosen id; nothing was written`);
    }
  };
  const status = answer.outcome === "error" ? answer.metadata["grpc-status-details-bin"] : undefined;
  const body =
    answer.outcome === "pass"
      ? { outcome: "pass", payload: answer.payload }
      : {
          outcome: "error",
          code: answer.code,
          details: answer.details,
          metadata: {
            ...answer.metadata,
            ...(status instanceof Uint8Array ? { "grpc-status-details-bin": maskStatusDetails(status, ids) } : {}),
            ...("authorization" in answer.metadata ? { authorization: "<token>" } : {}),
          },
        };
  const text = maskIds(`${JSON.stringify(encode({ $captured: header, ...body }, check), null, 2)}\n`, ids);
  if (holdsToken(text)) throw new Error(`${name}: the capture would hold the token; nothing was written`);
  return text;
}

/**
 * A capture's text with the surface in its header replaced and every other byte as written. A text that JSON does not
 * write back byte for byte, so not as captureText wrote it, is refused rather than rewritten.
 */
export function withSurface(name: string, text: string, surface: string): string {
  const capture = JSON.parse(text) as { readonly $captured: { surface: string } };
  if (`${JSON.stringify(capture, null, 2)}\n` !== text) {
    throw new Error(`${name}: the capture is not as the harness writes it; nothing was written`);
  }
  capture.$captured.surface = surface;
  return `${JSON.stringify(capture, null, 2)}\n`;
}

let sparkVersion = "";

function writeCapture(
  ctx: Context,
  name: SparkCaptureName,
  rpc: Rpc,
  surface: string,
  request: object,
  answer: Answer,
  ids: Ids,
  expected: "pass" | "error",
): void {
  if (answer.outcome !== expected) {
    const detail = answer.outcome === "error" ? `${answer.code} ${maskSparkLive(answer.details, ctx.secrets)}` : "pass";
    throw new Error(`${name}: expected ${expected}, Spark answered ${detail}; nothing was written`);
  }
  const { image, digest } = SPARK_SERVICE_IMAGES[ctx.service];
  const header = {
    service: ctx.service,
    image,
    digest,
    sparkVersion,
    date: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    rpc: `SparkConnectService/${rpc}`,
    surface,
    request: decodedRequest(rpc, request),
  };
  const text = captureText(name, header, withoutCatalogValues(rpc, request, answer), ids, ctx.secrets);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_CAPTURE_BYTES)
    throw new Error(`${name}: ${bytes} bytes, above the 2 MB capture bound; nothing was written`);
  const directory = path.join(FIXTURES, ctx.version);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.json`), text);
  console.log(`wrote ${ctx.version}/${name}.json (${answer.outcome})`);
}

async function runEntry(ctx: Context, entry: SparkCaptureEntry): Promise<void> {
  const ids: Ids = { session: randomUUID(), operations: [], tags: [] };
  const { action, token, surface } = entry;
  if (entry.session !== "none") {
    const pairs =
      entry.session === "metadata"
        ? [...SPARK_CAPTURE_SESSION_CONF, ...SPARK_CAPTURE_METADATA_SESSION_CONF]
        : SPARK_CAPTURE_SESSION_CONF;
    const setup = await unary(ctx, "Config", configSet(ids, pairs), token);
    if (setup.outcome === "error") throw new Error(`${entry.name}: the session setup failed (${setup.code})`);
  }
  if (entry.conf !== undefined) {
    const conf = await unary(ctx, "Config", configSet(ids, entry.conf), token);
    if (conf.outcome === "error")
      throw new Error(`${entry.name}: the Config set of ${entry.conf.map(([key]) => key).join(", ")} failed`);
  }
  for (const sql of entry.uncaptured ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- each statement reads what the one before it made in the session.
    await runUncaptured(ctx, ids, sql, token);
  }
  for (const statement of entry.before ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- each statement reads what the one before it made in the session.
    await runBefore(ctx, ids, statement, `${surface}: the statement run before it, command step`, token);
  }
  switch (action.kind) {
    case "version": {
      const request = { ...base(ids), spark_version: {} };
      writeCapture(
        ctx,
        entry.name,
        "AnalyzePlan",
        surface,
        request,
        await unary(ctx, "AnalyzePlan", request, token),
        ids,
        entry.expect,
      );
      return;
    }
    case "config-set": {
      const pairs = action.metadata
        ? [...SPARK_CAPTURE_SESSION_CONF, ...SPARK_CAPTURE_METADATA_SESSION_CONF]
        : SPARK_CAPTURE_SESSION_CONF;
      const request = configSet(ids, pairs);
      writeCapture(
        ctx,
        entry.name,
        "Config",
        surface,
        request,
        await unary(ctx, "Config", request, token),
        ids,
        entry.expect,
      );
      return;
    }
    case "config-get": {
      const request = { ...base(ids), operation: { get_option: { keys: [...action.keys] } } };
      writeCapture(
        ctx,
        entry.name,
        "Config",
        surface,
        request,
        await unary(ctx, "Config", request, token),
        ids,
        entry.expect,
      );
      return;
    }
    case "config-get-all": {
      const request = { ...base(ids), operation: { get_all: { prefix: action.prefix } } };
      writeCapture(
        ctx,
        entry.name,
        "Config",
        surface,
        request,
        await unary(ctx, "Config", request, token),
        ids,
        entry.expect,
      );
      return;
    }
    case "statement": {
      const run = newRun(ids);
      const first = commandRequest(ids, action.sql, run.operation, run.tag);
      const command = await executePlan(ctx, first, token);
      if (action.step === "command") {
        writeCapture(ctx, entry.name, "ExecutePlan", `${surface}: command step`, first, command, ids, entry.expect);
        return;
      }
      if (command.outcome === "error")
        throw new Error(`${entry.name}: the command step failed (${command.code}) before the relation step`);
      if (action.commandName !== undefined) {
        writeCapture(ctx, action.commandName, "ExecutePlan", `${surface}: command step`, first, command, ids, "pass");
      }
      const relation = lazyRelation(command.payload);
      if (relation === undefined) throw new Error(`${entry.name}: the statement answered inline, not as a relation`);
      const second = randomUUID();
      ids.operations.push(second);
      const request = relationRequest(ids, relation, second, run.tag);
      writeCapture(
        ctx,
        entry.name,
        "ExecutePlan",
        `${surface}: relation step`,
        request,
        await executePlan(ctx, request, token),
        ids,
        entry.expect,
      );
      return;
    }
    case "interrupt": {
      const run = newRun(ids);
      const first = commandRequest(ids, action.sql, run.operation, run.tag);
      const command = await executePlan(ctx, first, token);
      writeCapture(
        ctx,
        `${entry.name}-command` as SparkCaptureName,
        "ExecutePlan",
        `${surface}: command step`,
        first,
        command,
        ids,
        "pass",
      );
      if (command.outcome === "error") throw new Error(`${entry.name}: the command step failed (${command.code})`);
      const relation = lazyRelation(command.payload);
      if (relation === undefined) throw new Error(`${entry.name}: the statement answered inline, not as a relation`);
      const second = randomUUID();
      ids.operations.push(second);
      const request = relationRequest(ids, relation, second, run.tag);
      const interrupt = { ...base(ids), interrupt_type: "INTERRUPT_TYPE_TAG", operation_tag: run.tag };
      let interrupted: Promise<Answer> | undefined;
      const stream = executePlan(ctx, request, token, () => {
        interrupted = unary(ctx, "Interrupt", interrupt, token);
      });
      const streamAnswer = await stream;
      if (interrupted === undefined) throw new Error(`${entry.name}: the stream ended before its first response`);
      writeCapture(ctx, entry.name, "Interrupt", surface, interrupt, await interrupted, ids, entry.expect);
      writeCapture(
        ctx,
        `${entry.name}-relation` as SparkCaptureName,
        "ExecutePlan",
        `${surface}: relation step`,
        request,
        streamAnswer,
        ids,
        "error",
      );
      return;
    }
    case "release": {
      const request = { ...base(ids), allow_reconnect: false };
      writeCapture(
        ctx,
        entry.name,
        "ReleaseSession",
        surface,
        request,
        await unary(ctx, "ReleaseSession", request, token),
        ids,
        entry.expect,
      );
      return;
    }
    case "after-release": {
      const release = await unary(ctx, "ReleaseSession", { ...base(ids), allow_reconnect: false }, token);
      if (release.outcome === "error") throw new Error(`${entry.name}: the release failed (${release.code})`);
      if (action.sql !== undefined) {
        const run = newRun(ids);
        const command = commandRequest(ids, action.sql, run.operation, run.tag);
        writeCapture(
          ctx,
          entry.name,
          "ExecutePlan",
          `${surface}: command step`,
          command,
          await executePlan(ctx, command, token),
          ids,
          entry.expect,
        );
        return;
      }
      const request = { ...base(ids), operation: { get_option: { keys: ["spark.sql.ansi.enabled"] } } };
      writeCapture(
        ctx,
        entry.name,
        "Config",
        surface,
        request,
        await unary(ctx, "Config", request, token),
        ids,
        entry.expect,
      );
      return;
    }
    case "fetch-error-details": {
      const run = newRun(ids);
      const first = commandRequest(ids, action.sql, run.operation, run.tag);
      const command = await executePlan(ctx, first, token);
      let failed = command;
      if (action.commandName === undefined) {
        writeCapture(ctx, entry.name, "ExecutePlan", `${surface}: command step`, first, command, ids, entry.expect);
      } else {
        if (command.outcome === "error")
          throw new Error(`${entry.name}: the command step failed (${command.code}) before the relation step`);
        writeCapture(ctx, action.commandName, "ExecutePlan", `${surface}: command step`, first, command, ids, "pass");
        const relation = lazyRelation(command.payload);
        if (relation === undefined) throw new Error(`${entry.name}: the statement answered inline, not as a relation`);
        const second = randomUUID();
        ids.operations.push(second);
        const request = relationRequest(ids, relation, second, run.tag);
        failed = await executePlan(ctx, request, token);
        writeCapture(ctx, entry.name, "ExecutePlan", `${surface}: relation step`, request, failed, ids, entry.expect);
      }
      if (failed.outcome !== "error") throw new Error(`${entry.name}: the statement did not fail`);
      const errorId = statusDetailsOf(failed.metadata["grpc-status-details-bin"])?.errorInfo?.metadata.errorId;
      if (errorId === undefined) throw new Error(`${entry.name}: the failure carried no errorId`);
      const request = { ...base(ids), error_id: errorId };
      writeCapture(
        ctx,
        `${entry.name}-details` as SparkCaptureName,
        "FetchErrorDetails",
        `${surface}: FetchErrorDetails of its errorId`,
        request,
        await unary(ctx, "FetchErrorDetails", request, token),
        ids,
        "pass",
      );
      return;
    }
  }
}

/**
 * The surface each capture of `entry` holds in its header, by capture name: the entry's surface, followed by the
 * suffix, if any, that runEntry adds for the ExecutePlan step, the FetchErrorDetails call or the statement run before
 * it that the capture holds. `--surfaces` rewrites the stored captures to these, so a changed surface needs no retake.
 */
export function captureSurfaces(entry: SparkCaptureEntry): ReadonlyMap<SparkCaptureName, string> {
  const { action, surface } = entry;
  const command = `${surface}: command step`;
  const relation = `${surface}: relation step`;
  const surfaces = new Map<SparkCaptureName, string>();
  switch (action.kind) {
    case "version":
    case "config-set":
    case "config-get":
    case "config-get-all":
    case "release":
      surfaces.set(entry.name, surface);
      break;
    case "statement":
      surfaces.set(entry.name, action.step === "command" ? command : relation);
      if (action.step === "relation" && action.commandName !== undefined) surfaces.set(action.commandName, command);
      break;
    case "interrupt":
      surfaces.set(entry.name, surface);
      surfaces.set(`${entry.name}-command` as SparkCaptureName, command);
      surfaces.set(`${entry.name}-relation` as SparkCaptureName, relation);
      break;
    case "after-release":
      surfaces.set(entry.name, action.sql === undefined ? surface : command);
      break;
    case "fetch-error-details":
      surfaces.set(entry.name, action.commandName === undefined ? command : relation);
      if (action.commandName !== undefined) surfaces.set(action.commandName, command);
      surfaces.set(`${entry.name}-details` as SparkCaptureName, `${surface}: FetchErrorDetails of its errorId`);
      break;
  }
  for (const statement of entry.before ?? []) {
    surfaces.set(statement.name, `${surface}: the statement run before it, command step`);
  }
  return surfaces;
}

// -- status details, read with protobufjs only to render the answers; the provider reads them by hand (status-details.ts)

const RPC_TYPES = protobuf.Root.fromJSON({
  nested: {
    google: {
      nested: {
        rpc: {
          nested: {
            Status: {
              fields: {
                code: { type: "int32", id: 1 },
                message: { type: "string", id: 2 },
                details: { rule: "repeated", type: "Any", id: 3 },
              },
            },
            Any: { fields: { type_url: { type: "string", id: 1 }, value: { type: "bytes", id: 2 } } },
            ErrorInfo: {
              fields: {
                reason: { type: "string", id: 1 },
                domain: { type: "string", id: 2 },
                metadata: { keyType: "string", type: "string", id: 3 } as protobuf.IMapField,
              },
            },
          },
        },
      },
    },
  },
});

/** A grpc-status-details-bin value, as bytes or as a capture stores it: the Status code, message and ErrorInfo. */
export function statusDetailsOf(bytes: unknown):
  | {
      readonly code: number;
      readonly message: string;
      readonly errorInfo: { readonly reason: string; readonly metadata: Readonly<Record<string, string>> } | undefined;
    }
  | undefined {
  const raw = bytes instanceof Uint8Array ? bytes : (bytes as { readonly $bytes?: string } | undefined)?.$bytes;
  if (raw === undefined) return undefined;
  const buffer = typeof raw === "string" ? Buffer.from(raw, "base64") : raw;
  const status = RPC_TYPES.lookupType("google.rpc.Status").decode(buffer) as unknown as {
    readonly code: number;
    readonly message: string;
    readonly details: readonly { readonly type_url: string; readonly value: Uint8Array }[];
  };
  const info = status.details.find((detail) => detail.type_url === ERROR_INFO);
  const decoded =
    info === undefined
      ? undefined
      : (RPC_TYPES.lookupType("google.rpc.ErrorInfo").decode(info.value) as unknown as {
          readonly reason: string;
          readonly metadata: Readonly<Record<string, string>>;
        });
  return {
    code: status.code,
    message: status.message,
    errorInfo: decoded === undefined ? undefined : { reason: decoded.reason, metadata: { ...decoded.metadata } },
  };
}

// -- the README ---------------------------------------------------------------------------------------------------

interface StoredCapture {
  readonly $captured: {
    readonly service: string;
    readonly sparkVersion: string;
    readonly date: string;
    readonly runtime: string;
    readonly rpc: string;
    readonly surface: string;
  };
  readonly outcome: "pass" | "error";
  readonly payload?: unknown;
  readonly code?: number;
  readonly details?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function stored(version: SparkCaptureVersionDir, name: string): StoredCapture | undefined {
  const file = path.join(FIXTURES, version, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as StoredCapture) : undefined;
}

/** A Markdown table cell: a backslash doubled first, so the one before an escaped `|` stays its own. */
function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function answerLines(): string[] {
  const lines: string[] = [];
  const fact = (captures: string, text: string) => lines.push(`| ${captures} | ${cell(text)} |`);
  const keys = (version: SparkCaptureVersionDir, name: string) =>
    (
      stored(version, name)?.payload as
        | { readonly pairs?: readonly { readonly key: string; readonly value: string }[] }
        | undefined
    )?.pairs ?? [];
  fact(
    "`4.2.0/config-catalog-keys`, `4.2.0/show-catalogs`",
    `Config get_all keys: ${
      keys("4.2.0", "config-catalog-keys")
        .map((pair) => pair.key)
        .join(", ") || "none"
    }; SHOW CATALOGS rows are in the Arrow answer`,
  );
  for (const version of ["4.2.0", "4.1.3"] as const) {
    fact(
      `\`${version}/session-conf-readback\``,
      keys(version, "session-conf-readback")
        .map((pair) => `${pair.key}=${pair.value}`)
        .join(", "),
    );
    fact(
      `\`${version}/large-var-types-refused\``,
      `outcome ${stored(version, "large-var-types-refused")?.outcome ?? "missing"}; the field types are in the Arrow schema`,
    );
    fact(
      `\`${version}/use-namespace-current\``,
      `outcome ${stored(version, "use-namespace-current")?.outcome ?? "missing"}; the rows are in the Arrow answer`,
    );
    const batches = (
      (stored(version, "batch-rows")?.payload as
        | readonly { readonly arrow_batch?: { readonly row_count: string } | null }[]
        | undefined) ?? []
    ).flatMap((response) => (response.arrow_batch ? [response.arrow_batch.row_count] : []));
    fact(`\`${version}/batch-rows\``, `row_count per batch: ${batches.join(", ")}`);
    const schema = (
      (stored(version, "negative-scale-decimal")?.payload as
        | readonly {
            readonly schema?: {
              readonly struct?: {
                readonly fields: readonly {
                  readonly data_type: { readonly decimal?: { readonly precision?: number; readonly scale?: number } };
                }[];
              };
            } | null;
          }[]
        | undefined) ?? []
    ).find((response) => response.schema)?.schema?.struct?.fields[0]?.data_type.decimal;
    fact(
      `\`${version}/negative-scale-decimal\``,
      schema ? `decimal(${schema.precision},${schema.scale})` : "no schema",
    );
  }
  const proxy = stored("4.2.0", "proxy-silent-timeout");
  fact(
    "`4.2.0/proxy-silent-timeout`",
    proxy?.outcome === "error"
      ? `error ${proxy.code}: ${proxy.details}`
      : `outcome ${proxy?.outcome ?? "missing"} under the proxy's 300 s read timeout`,
  );
  fact(
    "`4.2.0/show-user-functions-quoted`",
    `outcome ${stored("4.2.0", "show-user-functions-quoted")?.outcome ?? "missing"}; the names are in the Arrow answer`,
  );
  const bound = stored("4.2.0", "command-over-batch-bound");
  const info =
    bound?.metadata === undefined ? undefined : statusDetailsOf(bound.metadata["grpc-status-details-bin"])?.errorInfo;
  fact(
    "`4.2.0/command-over-batch-bound`",
    bound?.outcome === "error"
      ? `error ${bound.code}, reason ${info?.reason ?? "none"}, errorClass ${info?.metadata.errorClass ?? "none"}: ${(bound.details ?? "").split("\n")[0]}`
      : `outcome ${bound?.outcome ?? "missing"}`,
  );
  fact(
    "`4.2.0/show-tables`, `show-views`, `show-user-functions`, `describe-table`, `describe-view`, `describe-table-struct30`",
    "every statement the object surface issues on the studio namespace",
  );
  return lines;
}

export function renderSparkFixturesReadme(): string {
  const lines = [
    "# Apache Spark captures",
    "",
    "Answers Apache Spark gave to the provider's calls, written by `tests/live/spark-evidence.ts` from the services of `database-compose.yml`.",
    'Each file is one RPC exchange: a `$captured` header whose request is written as the provider\'s codec reads it back, the outcome, and the decoded answer with every bytes field as `{"$bytes": "<base64>"}`, Arrow bodies byte for byte.',
    "Client-chosen ids are written `<session>`, `<operation>` and `<tag>`, inside a `grpc-status-details-bin` too, whose Status message and ErrorInfo values are then re-encoded; the token is written `<token>`, and every Config value whose full key lies under `spark.sql.catalog.` `<value>`.",
    "Every statement an entry runs before its capture that the replay sends is captured under its own name, and a FetchErrorDetails capture and its failure come from one run, so the errorIds pair.",
    "Never edit a capture by hand: start the service, run `bun tests/live/spark-evidence.ts --setup <service>` and `--capture <service>`, or `--capture <service> <entry> ...` to retake the captures of some entries, then `--readme`.",
    "A surface changed in the catalog needs no retake: `--surfaces` rewrites it in every capture without contacting a server, then `--readme` renders it.",
    "",
    "## BUILT cases",
    "",
    "The integration replay builds two cases from these captures and labels them: the version refusal (the 4.2.0 version answer rewritten to `3.5.9` and `4.0.4`) and a nested namespace listing (the `SHOW NAMESPACES` answer rewritten to multi-part spellings), because no catalog of the open-source fixture nests.",
    "",
    "## Facts read from the captures",
    "",
    "| Captures | Recorded |",
    "|---|---|",
    ...answerLines(),
  ];
  for (const version of ["4.2.0", "4.1.3"] as const) {
    lines.push(
      "",
      `## ${version}`,
      "",
      "| Capture | Service | RPC | Surface | Outcome | Date | Runtime |",
      "|---|---|---|---|---|---|---|",
    );
    const directory = path.join(FIXTURES, version);
    const files = existsSync(directory)
      ? readdirSync(directory)
          .filter((file) => file.endsWith(".json"))
          .sort()
      : [];
    for (const file of files) {
      const capture = stored(version, file.slice(0, -".json".length)) as StoredCapture;
      const { service, rpc, surface, date, runtime } = capture.$captured;
      lines.push(
        `| \`${file.slice(0, -5)}\` | ${service} | ${rpc} | ${cell(surface)} | ${capture.outcome} | ${date} | ${runtime} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

// -- the command ----------------------------------------------------------------------------------------------------

/**
 * The address the harness dials: the target, once `docker port` lists it among the loopback addresses the fixture
 * container publishes (localhost read as 127.0.0.1), so a loopback port that leads anywhere else is refused.
 */
export function fixtureAddress(
  container: string,
  target: { readonly host: string; readonly port: number },
  published: string,
): string {
  const host = target.host === "localhost" ? "127.0.0.1" : target.host;
  const address = host.includes(":") ? `[${host}]:${target.port}` : `${host}:${target.port}`;
  const listed = published
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (!/^(127\.0\.0\.1|\[::1\]):\d+$/.test(address) || !listed.includes(address)) {
    throw new Error(
      `${container} does not publish the target ${address} (it publishes ${listed.join(", ") || "nothing"}); the harness reaches only the fixture's containers`,
    );
  }
  return address;
}

function docker(args: readonly string[]): string {
  return execFileSync("docker", [...args], { encoding: "utf8" }).trim();
}

/** The fixture container's address for `service`, after every container it reaches is found running its pinned image. */
function fixtureTarget(service: SparkLiveService, args: SparkLiveArguments): string {
  const reached =
    service === "spark-tls" ? [SPARK_FIXTURE_CONTAINERS["spark-tls"], SPARK_FIXTURE_CONTAINERS["spark-auth"]] : [];
  for (const { container, image } of [SPARK_FIXTURE_CONTAINERS[service], ...reached]) {
    const running = docker(["inspect", "--format", "{{.Config.Image}}", container]);
    if (running !== image) throw new Error(`${container} runs ${running}, not the pinned ${image}`);
  }
  const { container, port } = SPARK_FIXTURE_CONTAINERS[service];
  return fixtureAddress(container, args.targets[service], docker(["port", container, `${port}/tcp`]));
}

async function readVersion(ctx: Context, token: Token): Promise<string> {
  const ids: Ids = { session: randomUUID(), operations: [], tags: [] };
  const answer = await unary(ctx, "AnalyzePlan", { ...base(ids), spark_version: {} }, token);
  if (answer.outcome === "error")
    throw new Error(`the version read failed (${answer.code}): ${maskSparkLive(answer.details, ctx.secrets)}`);
  return (answer.payload as { readonly spark_version: { readonly version: string } }).spark_version.version;
}

async function main(argv: readonly string[]): Promise<number> {
  const [flag, value, ...named] = argv;
  if (flag === "--readme" && argv.length === 1) {
    writeFileSync(path.join(FIXTURES, "README.md"), renderSparkFixturesReadme());
    console.log("Wrote tests/fixtures/spark/README.md");
    return 0;
  }
  if (flag === "--surfaces" && argv.length === 1) {
    // Every capture is read and checked before the first write, so a refused one leaves every file as it was.
    const rewrites = SPARK_CAPTURE_CATALOG.flatMap((entry) =>
      entry.versions.flatMap((version) =>
        [...captureSurfaces(entry)].map(([name, surface]) => {
          const file = path.join(FIXTURES, version, `${name}.json`);
          const text = readFileSync(file, "utf8");
          return { file, name: `${version}/${name}`, text, next: withSurface(`${version}/${name}`, text, surface) };
        }),
      ),
    );
    for (const { file, name, text, next } of rewrites) {
      if (next === text) continue;
      writeFileSync(file, next);
      console.log(`rewrote the surface of ${name}.json`);
    }
    return 0;
  }
  const services: readonly string[] =
    flag === "--setup" ? ["spark", "spark-4-1", "spark-auth"] : ["spark", "spark-4-1", "spark-auth", "spark-tls"];
  if (
    (flag !== "--capture" && flag !== "--setup") ||
    (flag === "--setup" && named.length > 0) ||
    value === undefined ||
    !services.includes(value)
  ) {
    console.error(USAGE);
    return 2;
  }
  const runsOn = (entry: SparkCaptureEntry) =>
    value === "spark-4-1"
      ? entry.service === "spark" && entry.versions.includes("4.1.3")
      : entry.service === value && entry.versions.includes("4.2.0");
  const unknown = named.filter((name) => !SPARK_CAPTURE_CATALOG.some((entry) => entry.name === name && runsOn(entry)));
  if (unknown.length > 0) {
    console.error(`No entry of the capture catalog named ${unknown.join(", ")} runs on ${value}; nothing was sent.`);
    return 2;
  }
  const args = readSparkLiveArguments(process.env);
  if ("exitCode" in args) {
    console.error(args.message);
    return args.exitCode;
  }
  const service = value as SparkLiveService;
  let address: string;
  try {
    address = fixtureTarget(service, args);
  } catch (error) {
    console.error(maskSparkLive(error instanceof Error ? error.message : String(error), sparkLiveSecrets(args)));
    return 1;
  }
  const ctx: Context = {
    args,
    service,
    version: VERSION_OF[service],
    client: openClient(args, service, address),
    secrets: sparkLiveSecrets(args),
  };
  const token: Token = service === "spark-auth" || service === "spark-tls" ? "configured" : "none";
  try {
    sparkVersion = await readVersion(ctx, token);
    if (sparkVersion !== ctx.version) throw new Error(`${service} answers Spark ${sparkVersion}, not ${ctx.version}`);
    if (flag === "--setup") {
      if (service === "spark") {
        execFileSync("docker", [
          "exec",
          "-u",
          "0",
          SPARK_FIXTURE_CONTAINERS.spark.container,
          "sh",
          "-c",
          "mkdir -p /tmp/studio-unreadable && printf 'a\\n1\\n' > /tmp/studio-unreadable/data.csv && chmod 000 /tmp/studio-unreadable/data.csv",
        ]);
      }
      const ids: Ids = { session: randomUUID(), operations: [], tags: [] };
      const setup = await unary(ctx, "Config", configSet(ids, SPARK_CAPTURE_SESSION_CONF), token);
      if (setup.outcome === "error") throw new Error(`the session setup failed (${setup.code})`);
      for (const sql of SPARK_SAMPLE_STATEMENTS) {
        // oxlint-disable-next-line no-await-in-loop -- a sample statement reads the objects the ones before it created.
        await runUncaptured(ctx, ids, sql, token);
        console.log(`ok  ${sql.slice(0, 100)}`);
      }
      await unary(ctx, "ReleaseSession", { ...base(ids), allow_reconnect: false }, token);
      return 0;
    }
    const entries = SPARK_CAPTURE_CATALOG.filter(
      (entry) => runsOn(entry) && (named.length === 0 || named.includes(entry.name)),
    );
    for (const entry of entries) {
      // oxlint-disable-next-line no-await-in-loop -- one capture at a time, in the catalog's order, so the server is idle.
      await runEntry(ctx, entry);
      void capturesOf(entry);
    }
    return 0;
  } catch (error) {
    console.error(maskSparkLive(error instanceof Error ? error.message : String(error), ctx.secrets));
    return 1;
  } finally {
    ctx.client.close();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
