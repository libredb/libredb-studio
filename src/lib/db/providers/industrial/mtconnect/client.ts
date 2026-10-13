/**
 * The client seam: one operation, a GET of a route from the closed table (MT-S1).
 *
 * There is no method argument and no body parameter anywhere in this module. That is the shape the
 * read-only promise rests on, and it rests on the shape rather than on a setting because MEASURED
 * on the pinned agent with `AllowPut = true` the agent's own Swagger grows from 15 operations to
 * 39, among them a PUT that sets an observation and a POST that injected a Fault which `/current`
 * then served like any other observation.
 *
 * What this module composes: the route table (`routes.ts`), the phase 0 guard (`guard.ts`), the
 * shared HTTP transport, and the reader (`xml.ts`). It adds four rules of its own, each from a
 * measurement.
 *
 * ONE REQUEST AT A TIME PER AGENT. MEASURED on the pinned agent: while a 300 alternative `path` ran
 * in a loop, the median of `sample?count=1` on the same agent rose from 1.4 ms to 74.1 ms, a factor
 * of 51, with a worst case of 169.9 ms. That is not a latency budget question. The agent serves the
 * machine's own clients, so a careless read from Studio degrades the shop floor's own monitoring
 * (decision K-61).
 *
 * THE REQUEST HAS AN 8 KiB CEILING AND CROSSING IT IS SILENT. MEASURED with a raw socket: a request
 * whose whole header block was 8,153 bytes was answered, and one of 8,216 bytes got no answer at
 * all, the agent writing zero bytes and closing the connection. The limit is on the header block
 * rather than on the path, so this module budgets the whole request target and leaves room for the
 * headers (decision K-61). There is no error document in that case, so the sentence the user reads
 * comes from here.
 *
 * CAPS ARE IN BYTES. MEASURED across four models: `current` is about 164 bytes an observation and
 * `probe` about 110 bytes a data item on a generated model and 190 on the richer demo one. Bytes per
 * observation hold steady across a factor of a hundred in model size while bytes per data item move
 * with how rich the model is, so a cap counted in rows is quietly wrong on a rich model
 * (decision K-62).
 *
 * A NON MTCONNECT ANSWER GETS OUR OWN SENTENCE. MEASURED through a reverse proxy: a 401 came back as
 * `text/html`, nginx's own page, not as an `MTConnectError`. A provider that parses every non 200
 * answer as an error document gets nothing from it, so the root element is checked and anything else
 * is named here (decision K-81). This holds whether or not authentication is ever offered, because a
 * proxy can answer with HTML for a 401, a 403, a 502 or a maintenance page.
 */
import { endpointUrl, type HttpOrigin } from "@/lib/db/http/endpoint";
import type { NodeTransport } from "@/lib/db/http/node-transport";
import { MTC_REQUEST_HEADER_BUDGET_BYTES, type MtcOp } from "./routes";
import type { MtcRequest } from "./guard";
import { readMtconnectXml, streamMtconnectObservations, type MtcElement, type MtcObservation } from "./xml";

/** The four roots an MTConnect answer can have. Anything else is not an agent answering. */
const MTCONNECT_ROOTS = new Set(["MTConnectDevices", "MTConnectStreams", "MTConnectAssets", "MTConnectError"]);

/**
 * The byte cap of each route.
 *
 * `probe` and `current` are unpaged and grow with the model, so their caps are sized from the
 * measured constants with room for a model several times the largest one measured: the 500 device
 * model answered `probe` in 2,918,819 bytes and `current` in 4,355,514. `sample` is bounded by its
 * `count` as well, and the whole buffer of a default agent measured 19,072,397 bytes, which is past
 * every cap here on purpose: no read asks for the whole buffer.
 */
export const MTC_BYTE_CAPS: Readonly<Record<MtcOp, number>> = Object.freeze({
  probe: 12 * 1024 * 1024,
  current: 16 * 1024 * 1024,
  sample: 8 * 1024 * 1024,
  assets: 8 * 1024 * 1024,
  asset: 2 * 1024 * 1024,
});

/** Headers the provider sends. `identity` is what the transport asks for in any case. */
const REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: "application/xml",
});

/**
 * Room left for the request line and the headers the transport adds, inside the 8 KiB block.
 *
 * CHOSEN, NOT MEASURED, and the measurement beside it is what makes the size defensible rather than
 * the number itself: the transport's own header block on this provider's requests is about 160 bytes
 * (`GET`, the host, `accept: application/xml`, `accept-encoding: identity`, `connection`), so 512 is
 * about three times what the headers take and leaves 7,680 bytes for the route and its parameters.
 */
const HEADER_OVERHEAD_BYTES = 512;

/** The route and parameter budget the two constants above leave, which is what a request is held to. */
export const MTC_TARGET_BUDGET_BYTES = MTC_REQUEST_HEADER_BUDGET_BYTES - HEADER_OVERHEAD_BYTES;

export type MtcClientFailure = "request-too-long" | "not-mtconnect" | "unreadable" | "capped";

export class MtcClientError extends Error {
  constructor(
    readonly failure: MtcClientFailure,
    message: string,
  ) {
    super(message);
    this.name = "MtcClientError";
  }
}

/** The request target the provider will send, built from typed parts and never by joining strings. */
export function buildTarget(origin: HttpOrigin, pathPrefix: string, request: MtcRequest): string {
  const segments = request.route.template.split("/").map((segment) => {
    const name = /^\{([A-Za-z0-9_]+)\}$/.exec(segment);
    return name === null ? segment : encodeURIComponent(request.params[name[1]] ?? "");
  });
  const prefix = pathPrefix.endsWith("/") ? pathPrefix.slice(0, -1) : pathPrefix;
  const pathname = `${prefix}/${segments.join("/")}`;
  const params = new URLSearchParams();
  // Declaration order, so that one request has one spelling and a captured request can be compared.
  for (const key of Object.keys(request.route.query)) {
    const value = request.query[key];
    if (value !== undefined) params.append(key, value);
  }
  const url = endpointUrl(origin, pathname, params.toString() === "" ? undefined : params);

  // The ceiling is on the whole header block, so the target is measured against a budget that
  // leaves room for the request line and the headers rather than against 8 KiB directly.
  const target = url.slice(url.indexOf(origin.host) + origin.host.length);
  const targetBytes = new TextEncoder().encode(target).length;
  const budget = MTC_TARGET_BUDGET_BYTES;
  if (targetBytes > budget) {
    throw new MtcClientError(
      "request-too-long",
      `This request is ${targetBytes} bytes of route and parameters, and the agent answers nothing at all past about ${MTC_REQUEST_HEADER_BUDGET_BYTES} bytes of request headers: it closes the connection without writing an error document. Shorten the path or ask for fewer rows.`,
    );
  }
  return url;
}

/** What one read gives back: the parsed document, or the agent's own error document. */
export interface MtcAnswer {
  readonly status: number;
  readonly root: MtcElement;
  /** True where the root is `MTConnectError`, so the caller reads the typed or legacy error shape. */
  readonly isError: boolean;
  readonly bytes: number;
  /**
   * The answer AS THE AGENT WROTE IT, which is what an asset's Source tab shows.
   *
   * Kept rather than re-rendered from the tree, so the document a reader sees is the agent's own
   * bytes and its `origin` can honestly say `stored`: a re-render would reorder attributes, drop
   * the prolog and re-indent, and none of that is the asset the plant holds. It is bounded by the
   * same byte cap the read was, and `asset` is the smallest of them at 2 MiB.
   */
  readonly text: string;
}

function assertMtconnect(status: number, contentType: string | null, text: string): MtcElement {
  const read = readMtconnectXml(new Uint8Array(new TextEncoder().encode(text)));
  if (!read.ok) {
    // A refusal from the reader is named, so the sentence says which rule the document broke.
    throw new MtcClientError(
      read.reason === "doctype" || read.reason === "entity-declaration" ? "not-mtconnect" : "unreadable",
      `The answer could not be read as an MTConnect document (${read.reason}). The agent answered ${status}${
        contentType === null ? "" : ` with ${contentType}`
      }.`,
    );
  }
  if (!MTCONNECT_ROOTS.has(read.root.name)) {
    throw new MtcClientError(
      "not-mtconnect",
      `This address answered ${status}${contentType === null ? "" : ` with ${contentType}`}, and its document's root element is ${read.root.name} rather than an MTConnect one. A reverse proxy in front of an agent answers its own pages this way, for a sign-in, a refusal or a gateway error.`,
    );
  }
  return read.root;
}

export interface MtcClientOptions {
  readonly origin: HttpOrigin;
  readonly pathPrefix: string;
  readonly transport: NodeTransport;
  /** One permit per agent (decision K-61). The provider's limiter supplies it. */
  readonly withPermit: <T>(run: () => Promise<T>) => Promise<T>;
  readonly signal: AbortSignal;
}

/**
 * One read. Every call goes through the permit, so two reads of one agent never overlap.
 *
 * `NodeResponse.text` hands back a whole body, so the transport's byte cap is what bounds a read
 * before this module sees it; the cap passed here is the route's own.
 */
export async function readOnce(options: MtcClientOptions, request: MtcRequest): Promise<MtcAnswer> {
  const url = buildTarget(options.origin, options.pathPrefix, request);
  const response = await options.withPermit(() =>
    options.transport.request({
      method: "GET",
      url,
      headers: REQUEST_HEADERS,
      signal: options.signal,
      maxResponseBytes: MTC_BYTE_CAPS[request.op],
    }),
  );
  const root = assertMtconnect(response.status, response.contentType, response.text);
  return {
    status: response.status,
    root,
    isError: root.name === "MTConnectError",
    bytes: new TextEncoder().encode(response.text).length,
    text: response.text,
  };
}

/**
 * A `sample` read, walked observation by observation and stopped at the row cap.
 *
 * The walk is streaming because the row cap has to be met while reading rather than afterwards
 * (MT-S4). What this does NOT claim is that streaming always costs less memory: MEASURED over fifty
 * reads of a 4.4 MiB answer in one process, peak RSS was 382.6 MiB as a tree and 161.0 MiB streaming
 * under Node, and 171.2 MiB as a tree against 216.9 MiB streaming under Bun. The gain depends on the
 * runtime (decision K-100). What holds in both is that the cap is enforced while reading, and that
 * nothing leaks: RSS settled by the twentieth read in all four runs.
 */
export async function readObservations(
  options: MtcClientOptions,
  request: MtcRequest,
  rowCap: number,
  onObservation: (observation: MtcObservation) => void,
): Promise<{ readonly read: number; readonly capped: boolean }> {
  const url = buildTarget(options.origin, options.pathPrefix, request);
  const response = await options.withPermit(() =>
    options.transport.request({
      method: "GET",
      url,
      headers: REQUEST_HEADERS,
      signal: options.signal,
      maxResponseBytes: MTC_BYTE_CAPS[request.op],
    }),
  );
  const bytes = new Uint8Array(new TextEncoder().encode(response.text));

  // An error document is small and is read as a tree, because it is not a stream of observations.
  const peek = readMtconnectXml(bytes);
  if (peek.ok && peek.root.name === "MTConnectError") {
    return { read: 0, capped: false };
  }
  if (!peek.ok || !MTCONNECT_ROOTS.has(peek.root.name)) {
    assertMtconnect(response.status, response.contentType, response.text);
  }

  let read = 0;
  let capped = false;
  const walk = streamMtconnectObservations(bytes, (observation) => {
    if (read >= rowCap) {
      capped = true;
      return false;
    }
    read++;
    onObservation(observation);
    return true;
  });
  if (!walk.ok) {
    throw new MtcClientError("unreadable", `The sample answer could not be read (${walk.reason}).`);
  }
  return { read, capped };
}

/**
 * The Header of an answer, as a plain record.
 *
 * Buffer facts come only from a read without `from` and `to`. MEASURED on the pinned agent: with
 * `to` given, the Header's `firstSequence` is the request's own `from` rather than the buffer's
 * start, so a cursor built from such a read would be built on the request rather than on the agent.
 */
export function headerOf(root: MtcElement): Readonly<Record<string, string>> {
  const header = root.children.find((child) => child.name === "Header");
  return header?.attributes ?? {};
}
