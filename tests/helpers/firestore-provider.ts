/**
 * Fixtures for the Firestore provider tests, over the fake seams (`firestore-seams.ts`): the provider runs its
 * real transport, and these turn a per-request handler into the seams' answer function and every recorded request
 * into one flat view with its lane, method, path, query, authorization header and parsed body.
 */
import type { NodeRequest, NodeResponse, NodeTransportOptions } from "@/lib/db/http/node-transport";
import type { FirestoreTarget } from "@/lib/db/providers/document/firestore/names";
import { buildRequest } from "@/lib/db/providers/document/firestore/requests";
import type { LaneKind } from "@/lib/db/providers/document/firestore/seams";
import type { DatabaseConnection } from "@/lib/types";
import { type FakeFirestoreSeams, type FirestoreAnswer, jsonAnswer } from "./firestore-seams";

export const PROVIDER_TARGET: FirestoreTarget = Object.freeze({ projectId: "demo-studio", databaseId: "(default)" });
export const PROVIDER_DOCS = "projects/demo-studio/databases/(default)/documents";
/** Long enough for the access-token rule in google-credentials.ts (20 URL-safe characters or more). */
export const PASTED_TOKEN = "ya29.pasted-token-value-123";
export const DATABASE = Object.freeze({
  name: "projects/demo-studio/databases/(default)",
  type: "FIRESTORE_NATIVE",
  firestoreDataAccessMode: "DATA_ACCESS_MODE_ENABLED",
  databaseEdition: "STANDARD",
});

export function firestoreConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "fs-1",
    name: "Firestore",
    type: "firestore",
    database: "demo-studio",
    password: PASTED_TOKEN,
    createdAt: new Date(0),
    ...overrides,
  };
}

export interface WireRequest {
  readonly lane: LaneKind;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export interface SentWireRequest extends WireRequest {
  /** The lane's authorization header, which the transport sets per lane. */
  readonly authorization: string | undefined;
}

export type WireHandler = (request: WireRequest) => NodeResponse | Promise<NodeResponse>;

function viewOf(request: NodeRequest, lane: LaneKind): WireRequest {
  const url = new URL(request.url);
  return {
    lane,
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    body: request.body === undefined ? undefined : JSON.parse(request.body),
  };
}

/** The seams' answer function for a handler that reads the flat view. */
export function wire(handler: WireHandler): FirestoreAnswer {
  return (request, lane) => handler(viewOf(request, lane));
}

/** Every request the transport sent, lane by lane in the order the lanes were built. */
export function requestsOf(seams: FakeFirestoreSeams): SentWireRequest[] {
  return seams.lanes.flatMap((lane) =>
    lane.requests.map((request) => ({ ...viewOf(request, lane.lane), authorization: authorization(lane.options) })),
  );
}

function authorization(options: NodeTransportOptions): string | undefined {
  return options.headers.authorization;
}

export function isProbe(request: Pick<WireRequest, "method" | "path">): boolean {
  return request.method === "GET" && request.path.endsWith(buildRequest(PROVIDER_TARGET, { kind: "database" }).path);
}

/** A Google server: the database resource for the probe, then `rest` for every other request. */
export function googleServer(database: unknown = DATABASE, rest: WireHandler = () => jsonAnswer({})): WireHandler {
  return (request) => (isProbe(request) ? jsonAnswer(database) : rest(request));
}

/** An answer that never comes; the fake transport rejects it when the request's signal aborts. */
export const HANG = (): Promise<NodeResponse> => new Promise<NodeResponse>(() => {});

/** Fires the most recent request deadline of `ms` the transport asked the seams for. */
export function fireRequestDeadline(seams: FakeFirestoreSeams, ms: number): void {
  const index = seams.deadlines.map((deadline) => deadline.ms).lastIndexOf(ms);
  if (index < 0) throw new Error(`no deadline of ${ms} ms was asked for`);
  seams.fireDeadline(index);
}
