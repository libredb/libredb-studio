/**
 * The statements tests' harness: a statements object over a real Snowflake transport on the scripted node
 * transports, with the fake clock and test deadlines, plus the readers of what it sent.
 *
 * Every harness is kept until `closeOpened()`, which each test file calls after every test: the engine limiter is
 * process-wide, so a run left waiting or polling would hold a permit into the next test.
 */
import { httpOrigin } from "@/lib/db/http/endpoint";
import {
  createSnowflakeStatements,
  type SnowflakeContext,
  type SnowflakeStatements,
} from "@/lib/db/providers/sql/snowflake/statements";
import { createSnowflakeTransport } from "@/lib/db/providers/sql/snowflake/transport";
import { resultAnswer, TEST_HANDLE } from "./snowflake-answers";
import {
  fakeClock,
  type RecordedRequest,
  type ScriptedAnswer,
  scriptedTokens,
  scriptedTransports,
  testDeps,
} from "./snowflake-node-transport";
import { ALLOWS_PRIVATE_HOSTS } from "./egress-decisions";

export const HOST = "acme-x1.snowflakecomputing.com";
export const ORIGIN = httpOrigin("https", HOST, 443, ALLOWS_PRIVATE_HOSTS);
export const TLS = { rejectUnauthorized: true, identity: HOST } as const;
export const SUBMIT = { method: "POST", path: /^\/api\/v2\/statements$/ } as const;
export const STATUS = { method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ } as const;
export const CANCEL = { method: "POST", path: /^\/api\/v2\/statements\/[^/]+\/cancel$/ } as const;
export const STATUS_PATH = `/api/v2/statements/${TEST_HANDLE}`;
export const CONTEXT: SnowflakeContext = {
  database: "SALES",
  schema: "PUBLIC",
  warehouse: "STUDIO_WH",
  role: "STUDIO_RO",
};
export const FAILURE = {
  host: HOST,
  user: "STUDIO",
  role: CONTEXT.role,
  authMethod: "pat",
  accountClaim: "ACME-X1",
  userClaim: "STUDIO",
  fingerprint: null,
  fingerprintHex8: null,
  publicKeyBody: null,
} as const;
export const ONE_COLUMN = [{ name: "N", type: "fixed", precision: 38, scale: 0 }];

export interface Harness {
  readonly statements: SnowflakeStatements;
  readonly transports: ReturnType<typeof scriptedTransports>;
  readonly deps: ReturnType<typeof testDeps>;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly tokens: ReturnType<typeof scriptedTokens>;
}

const opened: Harness[] = [];

export function setup(
  input: {
    readonly context?: SnowflakeContext;
    readonly queryTimeoutMs?: number;
    readonly secrets?: string[];
    readonly failure?: Partial<typeof FAILURE> | { readonly authMethod: "keypair" | "pat"; readonly user?: string };
  } = {},
): Harness {
  const transports = scriptedTransports();
  const clock = fakeClock();
  const deps = testDeps(transports, clock);
  const tokens = scriptedTokens(["token-one", "token-two"], "PROGRAMMATIC_ACCESS_TOKEN");
  const transport = createSnowflakeTransport({ origin: ORIGIN, tls: TLS, tokens, egress: ALLOWS_PRIVATE_HOSTS }, deps);
  const statements = createSnowflakeStatements({
    transport,
    origin: ORIGIN,
    context: input.context ?? CONTEXT,
    queryTimeoutMs: input.queryTimeoutMs ?? 60_000,
    failure: { ...FAILURE, ...input.failure },
    secrets: () => input.secrets ?? ["pat-secret"],
    deps,
  });
  const harness = { statements, transports, deps, clock, tokens };
  opened.push(harness);
  return harness;
}

/** Lets every pending promise and the scripted transports' callbacks run. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Fires every deadline asked for so far, and again until `promise` settles, so no test waits on a real timer. */
export async function settleWithDeadlines<T>(harness: Harness, promise: Promise<T>): Promise<void> {
  let settled = false;
  const done = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let round = 0; round < 50; round += 1) {
    if (settled) break;
    harness.deps.deadlines.requested.forEach((_, index) => harness.deps.deadlines.fire(index));
    // oxlint-disable-next-line no-await-in-loop -- each round lets the runs react before the next fire.
    await tick();
  }
  await done;
}

/**
 * Closes every harness built since the last call, firing deadlines until each close returns, so no run keeps a
 * permit of the process-wide engine limiter into the next test. Call it from each file's `afterEach`.
 */
export async function closeOpened(): Promise<void> {
  for (const harness of opened.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- each harness ends its runs before the next, so no permit leaks.
    await settleWithDeadlines(harness, harness.statements.close());
  }
}

export const bodyOf = (request: RecordedRequest): Record<string, unknown> => JSON.parse(request.body ?? "{}");
export const submits = (harness: Harness): RecordedRequest[] =>
  harness.transports.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/api/v2/statements");
export const cancels = (harness: Harness): RecordedRequest[] =>
  harness.transports.requests.filter((r) => r.url.endsWith("/cancel"));
export const one = (value = "1"): ScriptedAnswer => resultAnswer({ columns: ONE_COLUMN, rows: [[value]] });

export async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/**
 * The role check's answer: the effective role, the secondary roles value, as `CURRENT_SECONDARY_ROLES()` sends it,
 * the signed-in user, `FAILURE.user` by default, and the current database, schema and warehouse, `CONTEXT`'s by
 * default (null where a name did not resolve).
 */
export const roleAnswer = (
  role: string,
  secondary: string | null = '{"roles":"","value":""}',
  user: string | null = FAILURE.user,
  names: {
    readonly database?: string | null;
    readonly schema?: string | null;
    readonly warehouse?: string | null;
  } = {},
): ScriptedAnswer =>
  resultAnswer({
    columns: ["R", "S", "U", "D", "C", "W"].map((name) => ({ name, type: "text" })),
    rows: [
      [
        role,
        secondary,
        user,
        names.database === undefined ? (CONTEXT.database ?? null) : names.database,
        names.schema === undefined ? (CONTEXT.schema ?? null) : names.schema,
        names.warehouse === undefined ? (CONTEXT.warehouse ?? null) : names.warehouse,
      ],
    ],
  });
