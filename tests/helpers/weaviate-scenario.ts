/**
 * What the Weaviate evidence harness and the integration test share (#1566 spec 7.3): the connection a scenario of
 * tests/live/weaviate-scenarios.ts opens, the provider calls it makes, how an outcome is written down, and the two
 * transports, one that records what a live server answered and one that answers from that record.
 *
 * An outcome keeps what the user is shown: a result's fields, rows, count and warnings, a surface call's value, or an
 * error's class and message. The run time is dropped, since it differs on every run and nothing is decided by it.
 */
import type { NodeRequest, NodeResponse, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { WeaviateProvider } from "@/lib/db/providers/vector/weaviate";
import { createRestWeaviateClient } from "@/lib/db/providers/vector/weaviate/rest-client";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import {
  WEAVIATE_SERVICES,
  type WeaviateCredential,
  type WeaviateScenario,
  type WeaviateStep,
} from "../live/weaviate-scenarios";

/** The credential values a scenario's connection carries. A replay uses stand-ins, a live run the real keys. */
export interface WeaviateSecrets {
  readonly root: string;
  readonly reader: string;
  readonly wrong: string;
  /** The PEM of the CA weaviate-tls's certificate chains to. */
  readonly ca: string;
}

/** What a replay sends in place of a key: the record holds no key, so no value is compared. */
export const REPLAY_SECRETS: WeaviateSecrets = {
  root: "replay-root-key",
  reader: "replay-reader-key",
  wrong: "replay-wrong-key",
  ca: "-----BEGIN CERTIFICATE-----\nreplay\n-----END CERTIFICATE-----\n",
};

function keyOf(credential: WeaviateCredential, secrets: WeaviateSecrets): string | undefined {
  return credential === "none" ? undefined : secrets[credential];
}

/** The connection a scenario opens, the same in a live run and in its replay but for the secrets. */
export function scenarioConnection(scenario: WeaviateScenario, secrets: WeaviateSecrets): DatabaseConnection {
  const service = WEAVIATE_SERVICES[scenario.service];
  const password = keyOf(scenario.credential, secrets);
  return {
    id: `weaviate-${scenario.service}-${scenario.name}`,
    name: `${scenario.service} ${scenario.name}`,
    type: "weaviate",
    host: "127.0.0.1",
    port: service.port,
    ...(password === undefined ? {} : { password }),
    ...(scenario.ssl === "verify-ca" ? { ssl: { mode: "verify-ca", caCert: secrets.ca } } : {}),
    ...(scenario.ssl === "disable" ? { ssl: { mode: "disable" } } : {}),
    ...(scenario.readOnly === true ? { readOnly: true, managed: true } : {}),
  } as DatabaseConnection;
}

/** One request as the provider put it on the wire, and what came back: an answer, or the error the transport threw. */
export interface WeaviateExchange {
  readonly method: "GET" | "POST";
  /** The path and query, without the origin. */
  readonly path: string;
  readonly body: string | null;
  readonly answer: NodeResponse | null;
  readonly thrown: { readonly kind: TransportError["kind"]; readonly message: string } | null;
}

export type WeaviateOutcome =
  | { readonly step: string; readonly value: unknown }
  | { readonly step: string; readonly error: { readonly name: string; readonly message: string } };

function pathOf(request: NodeRequest): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

/** A transport that hands each request to `inner` and writes the exchange down, a thrown error included. */
export function recordingTransport(
  inner: (options: NodeTransportOptions) => NodeTransport,
  exchanges: WeaviateExchange[],
  built: NodeTransportOptions[],
): (options: NodeTransportOptions) => NodeTransport {
  return (options) => {
    built.push(options);
    const transport = inner(options);
    return {
      async request(request) {
        const entry = { method: request.method, path: pathOf(request), body: request.body ?? null };
        try {
          const answer = await transport.request(request);
          exchanges.push({ ...entry, answer, thrown: null });
          return answer;
        } catch (error) {
          const thrown =
            error instanceof TransportError
              ? { kind: error.kind, message: error.message }
              : { kind: "network" as const, message: (error as Error).message };
          exchanges.push({ ...entry, answer: null, thrown });
          throw error;
        }
      },
      close() {
        transport.close();
      },
    };
  };
}

/**
 * A transport that answers from a record: each request must equal, method, path and body, an exchange not yet used,
 * and gets that exchange's answer or error. Requests sent at once may arrive in any order, so the match is by value,
 * never by position. A request the record does not hold throws by name, and `unused()` lists what was never asked.
 */
export function replayTransport(record: readonly WeaviateExchange[]): {
  readonly factory: (options: NodeTransportOptions) => NodeTransport;
  readonly sent: WeaviateExchange[];
  readonly built: NodeTransportOptions[];
  unused(): readonly WeaviateExchange[];
} {
  const pending = [...record];
  const sent: WeaviateExchange[] = [];
  const built: NodeTransportOptions[] = [];
  const factory = (options: NodeTransportOptions): NodeTransport => {
    built.push(options);
    return {
      async request(request) {
        const path = pathOf(request);
        const body = request.body ?? null;
        const index = pending.findIndex(
          (exchange) => exchange.method === request.method && exchange.path === path && exchange.body === body,
        );
        if (index < 0) throw new Error(`no recorded exchange answers ${request.method} ${path} ${body ?? ""}`);
        const [exchange] = pending.splice(index, 1);
        sent.push(exchange);
        if (exchange.thrown !== null) throw new TransportError(exchange.thrown.kind, exchange.thrown.message);
        return exchange.answer as NodeResponse;
      },
      close() {},
    };
  };
  return { factory, sent, built, unused: () => pending };
}

/** A provider over the given transport, built as the factory builds one. */
export function scenarioProvider(
  connection: DatabaseConnection,
  transport: (options: NodeTransportOptions) => NodeTransport,
): WeaviateProvider {
  return new WeaviateProvider(connection, {}, {}, (options, routes) =>
    createRestWeaviateClient(options, routes, transport),
  );
}

function resultOf(result: QueryResult): unknown {
  return {
    fields: result.fields,
    rows: result.rows,
    rowCount: result.rowCount,
    ...(result.columnTypes === undefined ? {} : { columnTypes: result.columnTypes }),
    ...(result.vectorColumns === undefined ? {} : { vectorColumns: result.vectorColumns }),
    ...(result.resultSets === undefined ? {} : { resultSets: result.resultSets }),
    ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
    ...(result.pagination === undefined ? {} : { pagination: result.pagination }),
  };
}

function stepName(step: WeaviateStep): string {
  if (step.call === "query") return `query ${step.text}`;
  if (step.call === "describeObject" || step.call === "readObjectSource") return `${step.call} ${step.name}`;
  if (step.call === "describeObjects" && step.limit !== undefined) return `describeObjects limit ${step.limit}`;
  return step.call;
}

async function callOf(provider: WeaviateProvider, step: WeaviateStep): Promise<unknown> {
  switch (step.call) {
    case "query":
      return resultOf(await provider.query(step.text));
    case "listContainers":
      return provider.listContainers();
    case "countObjects":
      return provider.countObjects([]);
    case "listObjects":
      return provider.listObjects([], "collection");
    case "describeObject":
      return provider.describeObject([step.name], "collection");
    case "describeObjects":
      return provider.describeObjects([], "collection", step.limit);
    case "readObjectSource":
      return provider.readObjectSource([step.name], "collection");
    case "getHealth": {
      const { responseTime: _responseTime, ...health } = (await provider.getHealth()) as unknown as Record<
        string,
        unknown
      >;
      return health;
    }
    case "getOverview":
      return provider.getOverview();
    case "getTableStats":
      return provider.getTableStats();
    case "getIndexStats":
      return provider.getIndexStats();
    case "connectWarnings":
      return provider.connectWarnings();
  }
}

function errorOf(step: string, error: unknown): WeaviateOutcome {
  const thrown = error as Error;
  return { step, error: { name: thrown.constructor.name, message: thrown.message } };
}

/**
 * Connects, makes every call in order and disconnects, writing down each outcome; a failed connect is the only
 * outcome, since nothing else can run. JSON round-trips each value so a live run and a replay compare as text does.
 */
export async function runScenario(
  provider: WeaviateProvider,
  steps: readonly WeaviateStep[],
): Promise<WeaviateOutcome[]> {
  const outcomes: WeaviateOutcome[] = [];
  try {
    await provider.connect();
  } catch (error) {
    return [errorOf("connect", error)];
  }
  outcomes.push({ step: "connect", value: null });
  for (const step of steps) {
    const name = stepName(step);
    try {
      outcomes.push({ step: name, value: JSON.parse(JSON.stringify((await callOf(provider, step)) ?? null)) });
    } catch (error) {
      outcomes.push(errorOf(name, error));
    }
  }
  await provider.disconnect();
  return outcomes;
}
