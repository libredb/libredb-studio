/**
 * The request allowlist: every request the provider sends is described as a `KubernetesRequest`, turned into one
 * method, one path after the API path, a query and a Studio-built body here, and admitted by `admitRequest` on the
 * final strings before the transport is reached. A request that matches no row is refused before any socket opens.
 *
 * The rows, each with an exact segment count: GET on discovery and health (`/api`, `/apis`, `/version`, `/readyz`,
 * `/openapi/v3` and one OpenAPI group document with one `hash`); GET on a collection only when discovery lists
 * `list` for the resource (`watch` for a watch), on an object only with `get`; GET on `pods/{name}/log`; POST only to
 * the three self reviews, with a body Studio builds as JSON. Every other method, path and subresource is refused,
 * and the subresources that run code or tunnel traffic are refused by name. Subresource names come from this module,
 * never from discovery.
 *
 * Names are checked before a path is built and nothing is percent-encoded into a path: namespaces and container
 * names are DNS-1123 labels, pod names DNS-1123 subdomains, every other object name `[A-Za-z0-9._:@~-]+` other than
 * `.` and `..`.
 */
import { QueryError } from "@/lib/db/errors";
import { DNS1123_LABEL } from "./connection-options";
import type { KubernetesRequestContext } from "./errors";
import { KUBERNETES_TYPE } from "./limits";

/** A resource as discovery lists it: what a collection or object request is checked against. */
export interface ResourceRef {
  /** "" for the core group. */
  readonly group: string;
  readonly version: string;
  /** The plural resource name. */
  readonly resource: string;
  readonly namespaced: boolean;
  readonly verbs: readonly string[];
}

export interface ListQuery {
  readonly limit?: number;
  readonly continue?: string;
  readonly labelSelector?: string;
  readonly fieldSelector?: string;
  readonly resourceVersion?: string;
  readonly resourceVersionMatch?: "NotOlderThan" | "Exact";
  readonly includeObject?: "None" | "Metadata";
}

export interface WatchQuery {
  readonly resourceVersion: string;
  readonly timeoutSeconds: number;
  readonly labelSelector?: string;
  readonly fieldSelector?: string;
  readonly includeObject?: "None" | "Metadata";
}

export interface LogQuery {
  readonly container?: string;
  readonly tailLines?: number;
  readonly limitBytes?: number;
  readonly sinceSeconds?: number;
  readonly sinceTime?: string;
  readonly previous?: boolean;
  readonly timestamps?: boolean;
}

export type SelfReview = "selfsubjectreviews" | "selfsubjectaccessreviews" | "selfsubjectrulesreviews";

export type KubernetesRequest =
  | { readonly op: "discovery"; readonly root: "api" | "apis" }
  | { readonly op: "version" }
  | { readonly op: "readyz"; readonly verbose?: boolean }
  | { readonly op: "openapi-index" }
  | { readonly op: "openapi-group"; readonly group: string; readonly version: string; readonly hash: string }
  | { readonly op: "list"; readonly target: ResourceRef; readonly namespace?: string; readonly query?: ListQuery }
  | { readonly op: "watch"; readonly target: ResourceRef; readonly namespace?: string; readonly query: WatchQuery }
  | {
      readonly op: "get";
      readonly target: ResourceRef;
      readonly namespace?: string;
      readonly name: string;
      readonly includeObject?: "None" | "Metadata";
    }
  | { readonly op: "logs"; readonly namespace: string; readonly pod: string; readonly query: LogQuery }
  | { readonly op: "review"; readonly review: SelfReview; readonly body: Readonly<Record<string, unknown>> };

/** One request as the client sends it: the path is relative to the connection's API path. */
export interface PlannedRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: readonly (readonly [name: string, value: string])[];
  readonly body?: string;
  readonly context: KubernetesRequestContext;
}

/** Subresources that run code, open a tunnel or write, refused by name wherever they appear in a path. */
const REFUSED_SUBRESOURCES: readonly string[] = Object.freeze([
  "exec",
  "attach",
  "portforward",
  "proxy",
  "token",
  "eviction",
  "binding",
  "ephemeralcontainers",
]);

/** A namespace's own subresources, which sit where a namespaced collection would: `/api/v1/namespaces/<ns>/status`. */
const NAMESPACE_SUBRESOURCES: ReadonlySet<string> = new Set(["status", "finalize"]);

const DNS1123_SUBDOMAIN = /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const VERSION = /^v[0-9]+((alpha|beta)[0-9]+)?$/;
const OBJECT_NAME = /^[A-Za-z0-9._:@~-]{1,253}$/;
const FINAL_PATH = /^[A-Za-z0-9._:@~/-]+$/;
const HEX = /^[0-9A-Fa-f]{1,128}$/;
const DIGITS = /^[0-9]{1,10}$/;
const RFC3339 = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;

const REVIEW_PATHS: Readonly<Record<SelfReview, string>> = Object.freeze({
  selfsubjectreviews: "/apis/authentication.k8s.io/v1/selfsubjectreviews",
  selfsubjectaccessreviews: "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
  selfsubjectrulesreviews: "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews",
});

const COLLECTION_KEYS: ReadonlySet<string> = new Set([
  "limit",
  "continue",
  "labelSelector",
  "fieldSelector",
  "resourceVersion",
  "resourceVersionMatch",
  "includeObject",
  "watch",
  "allowWatchBookmarks",
  "timeoutSeconds",
]);
const OBJECT_KEYS: ReadonlySet<string> = new Set(["includeObject"]);
const LOG_KEYS: ReadonlySet<string> = new Set([
  "container",
  "tailLines",
  "limitBytes",
  "sinceSeconds",
  "sinceTime",
  "previous",
  "timestamps",
]);

/** Each query key's value rule, where it has one beyond being text. */
const VALUE_RULES: Readonly<Record<string, (value: string) => boolean>> = Object.freeze({
  limit: (value: string) => DIGITS.test(value),
  timeoutSeconds: (value: string) => DIGITS.test(value),
  tailLines: (value: string) => DIGITS.test(value),
  limitBytes: (value: string) => DIGITS.test(value),
  sinceSeconds: (value: string) => DIGITS.test(value),
  includeObject: (value: string) => value === "None" || value === "Metadata",
  resourceVersionMatch: (value: string) => value === "NotOlderThan" || value === "Exact",
  watch: (value: string) => value === "1",
  allowWatchBookmarks: (value: string) => value === "true",
  previous: (value: string) => value === "true" || value === "false",
  timestamps: (value: string) => value === "true" || value === "false",
  verbose: (value: string) => value === "true",
  hash: (value: string) => HEX.test(value),
  sinceTime: (value: string) => RFC3339.test(value),
  container: (value: string) => DNS1123_LABEL.test(value),
});

function refuse(message: string): never {
  throw new QueryError(`${message} Nothing was sent.`, KUBERNETES_TYPE);
}

/** A field selector value built from a name: `\`, `,` and `=` escaped, as the server's selector grammar reads them. */
export function fieldSelectorValue(value: string): string {
  return value.replace(/[\\,=]/g, (character) => `\\${character}`);
}

function checkNamespace(namespace: string): void {
  if (!DNS1123_LABEL.test(namespace)) refuse("A namespace must be a DNS-1123 label.");
}

/**
 * Whether a name may be the object segment of a request path: a pod name is a DNS-1123 subdomain, any other name
 * `[A-Za-z0-9._:@~-]+` other than `.` and `..`. The tree lists only names that pass, so no stored segment fails later.
 */
export function isRequestableName(name: string, pod: boolean): boolean {
  return pod ? DNS1123_SUBDOMAIN.test(name) : OBJECT_NAME.test(name) && name !== "." && name !== "..";
}

function checkObjectName(name: string, pod: boolean): void {
  if (!isRequestableName(name, pod))
    refuse(
      pod
        ? "A pod name must be a DNS-1123 subdomain."
        : "An object name may hold letters, digits and . _ : @ ~ -, and may not be . or ..",
    );
}

function checkTarget(target: ResourceRef, verb: "list" | "get" | "watch", namespace: string | undefined): void {
  if (target.group !== "" && !DNS1123_SUBDOMAIN.test(target.group))
    refuse("An API group must be a DNS-1123 subdomain.");
  if (!VERSION.test(target.version)) refuse("An API version must read like v1, v1beta1 or v2alpha1.");
  if (!DNS1123_LABEL.test(target.resource)) refuse("A resource name must be a lower-case DNS-1123 label.");
  if (!target.verbs.includes(verb)) refuse(`Discovery does not list ${verb} for ${target.resource}.`);
  if (!target.namespaced && namespace !== undefined)
    refuse(`${target.resource} is cluster-scoped and takes no namespace.`);
  if (namespace !== undefined) checkNamespace(namespace);
}

function collectionPath(target: ResourceRef, namespace: string | undefined): string {
  const root = target.group === "" ? `/api/${target.version}` : `/apis/${target.group}/${target.version}`;
  return namespace === undefined ? `${root}/${target.resource}` : `${root}/namespaces/${namespace}/${target.resource}`;
}

function pairs(entries: Readonly<Record<string, string | number | boolean | undefined>>): [string, string][] {
  return Object.entries(entries)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => [key, String(value)]);
}

function context(
  verb: KubernetesRequestContext["verb"],
  target: Pick<ResourceRef, "resource" | "group">,
  namespace?: string,
  name?: string,
): KubernetesRequestContext {
  return {
    verb,
    resource: target.resource,
    group: target.group,
    ...(namespace === undefined ? {} : { namespace }),
    ...(name === undefined ? {} : { name }),
  };
}

/** The request as method, path, query and body, every name checked; `admitRequest` passes what this builds. */
export function planRequest(request: KubernetesRequest): PlannedRequest {
  const planned = build(request);
  admitRequest(planned.method, planned.path, planned.query);
  return planned;
}

function build(request: KubernetesRequest): PlannedRequest {
  const core = { resource: "", group: "" };
  switch (request.op) {
    case "discovery":
      return {
        method: "GET",
        path: `/${request.root}`,
        query: [],
        context: context("get", { ...core, resource: request.root }),
      };
    case "version":
      return { method: "GET", path: "/version", query: [], context: context("get", { ...core, resource: "version" }) };
    case "readyz":
      return {
        method: "GET",
        path: "/readyz",
        query: request.verbose === true ? [["verbose", "true"]] : [],
        context: context("get", { ...core, resource: "readyz" }),
      };
    case "openapi-index":
      return {
        method: "GET",
        path: "/openapi/v3",
        query: [],
        context: context("get", { ...core, resource: "openapi" }),
      };
    case "openapi-group": {
      if (request.group !== "" && !DNS1123_SUBDOMAIN.test(request.group))
        refuse("An API group must be a DNS-1123 subdomain.");
      if (!VERSION.test(request.version)) refuse("An API version must read like v1, v1beta1 or v2alpha1.");
      const path =
        request.group === ""
          ? `/openapi/v3/api/${request.version}`
          : `/openapi/v3/apis/${request.group}/${request.version}`;
      return {
        method: "GET",
        path,
        query: [["hash", request.hash]],
        context: context("get", { ...core, resource: "openapi" }),
      };
    }
    case "list": {
      checkTarget(request.target, "list", request.namespace);
      const query = request.query ?? {};
      return {
        method: "GET",
        path: collectionPath(request.target, request.namespace),
        query: pairs({
          limit: query.limit,
          continue: query.continue,
          labelSelector: query.labelSelector,
          fieldSelector: query.fieldSelector,
          resourceVersion: query.resourceVersion,
          resourceVersionMatch: query.resourceVersionMatch,
          includeObject: query.includeObject,
        }),
        context: context("list", request.target, request.namespace),
      };
    }
    case "watch": {
      checkTarget(request.target, "watch", request.namespace);
      const { query } = request;
      return {
        method: "GET",
        path: collectionPath(request.target, request.namespace),
        query: pairs({
          watch: "1",
          allowWatchBookmarks: "true",
          resourceVersion: query.resourceVersion,
          timeoutSeconds: query.timeoutSeconds,
          labelSelector: query.labelSelector,
          fieldSelector: query.fieldSelector,
          includeObject: query.includeObject,
        }),
        context: context("watch", request.target, request.namespace),
      };
    }
    case "get": {
      checkTarget(request.target, "get", request.namespace);
      if (request.target.namespaced && request.namespace === undefined)
        refuse(`${request.target.resource} is namespaced, so reading one object needs its namespace.`);
      checkObjectName(request.name, request.target.group === "" && request.target.resource === "pods");
      return {
        method: "GET",
        path: `${collectionPath(request.target, request.namespace)}/${request.name}`,
        query: pairs({ includeObject: request.includeObject }),
        context: context("get", request.target, request.namespace, request.name),
      };
    }
    case "logs": {
      checkNamespace(request.namespace);
      checkObjectName(request.pod, true);
      const { query } = request;
      return {
        method: "GET",
        path: `/api/v1/namespaces/${request.namespace}/pods/${request.pod}/log`,
        query: pairs({
          container: query.container,
          tailLines: query.tailLines,
          limitBytes: query.limitBytes,
          sinceSeconds: query.sinceSeconds,
          sinceTime: query.sinceTime,
          previous: query.previous,
          timestamps: query.timestamps,
        }),
        context: context("get", { resource: "pods/log", group: "" }, request.namespace, request.pod),
      };
    }
    case "review":
      return {
        method: "POST",
        path: REVIEW_PATHS[request.review],
        query: [],
        body: JSON.stringify(request.body),
        context: context("create", {
          resource: request.review,
          group: request.review === "selfsubjectreviews" ? "authentication.k8s.io" : "authorization.k8s.io",
        }),
      };
  }
}

/** What a GET path matches: a row's query keys, a subresource no row takes, or nothing. */
type GetRow = { readonly keys: ReadonlySet<string> } | { readonly subresource: string } | undefined;

function getRow(segments: readonly string[]): GetRow {
  const [first, second, third, fourth, fifth] = segments;
  const count = segments.length;
  if (count === 1 && (first === "api" || first === "apis" || first === "version")) return { keys: new Set() };
  if (count === 1 && first === "readyz") return { keys: new Set(["verbose"]) };
  if (first === "openapi") {
    if (second !== "v3") return undefined;
    if (count === 2) return { keys: new Set() };
    if (count === 4 && third === "api" && VERSION.test(fourth)) return { keys: new Set(["hash"]) };
    if (count === 5 && third === "apis" && DNS1123_SUBDOMAIN.test(fourth) && VERSION.test(fifth))
      return { keys: new Set(["hash"]) };
    return undefined;
  }
  // The resource part, after `/api/<v>` or `/apis/<g>/<v>`.
  let rest: readonly string[];
  if (first === "api" && count >= 3 && VERSION.test(second)) rest = segments.slice(2);
  else if (first === "apis" && count >= 4 && DNS1123_SUBDOMAIN.test(second) && VERSION.test(third))
    rest = segments.slice(3);
  else return undefined;
  const namespaced = rest[0] === "namespaces" && rest.length >= 3;
  if (namespaced && !DNS1123_LABEL.test(rest[1])) return undefined;
  if (namespaced && first === "api" && NAMESPACE_SUBRESOURCES.has(rest[2])) return { subresource: rest[2] };
  const [resource, name, ...beyond] = namespaced ? rest.slice(2) : rest;
  if (!DNS1123_LABEL.test(resource)) return undefined;
  if (name === undefined) return { keys: COLLECTION_KEYS };
  if (!OBJECT_NAME.test(name) || name === "." || name === "..") return undefined;
  if (beyond.length === 0) return { keys: OBJECT_KEYS };
  if (beyond.length === 1 && namespaced && first === "api" && resource === "pods" && beyond[0] === "log")
    return { keys: LOG_KEYS };
  return { subresource: beyond[0] };
}

/**
 * The allowlist on the final strings: the method, the path after the API path and the query. Called on every request
 * just before the transport; a request that matches no row, carries a key its row does not take or a value outside
 * its rule is refused.
 */
export function admitRequest(
  method: string,
  path: string,
  query: readonly (readonly [name: string, value: string])[],
): void {
  // The final-path rule runs here too, so this last gate holds even for a caller that skipped the client's check.
  const finalRefusal = finalPathRefusal(path);
  if (finalRefusal !== undefined) throw new QueryError(finalRefusal, KUBERNETES_TYPE);
  if (method === "POST") {
    if (!Object.values(REVIEW_PATHS).includes(path) || query.length > 0)
      refuse("Studio sends POST only to the three self reviews, with no query.");
    return;
  }
  if (method !== "GET") refuse("Studio sends GET and, to the three self reviews, POST, and no other method.");
  const segments = path.startsWith("/") ? path.slice(1).split("/") : [];
  const row = getRow(segments);
  if (row === undefined) refuse("Studio sends no request to this path.");
  if ("subresource" in row)
    refuse(
      REFUSED_SUBRESOURCES.includes(row.subresource)
        ? `The ${row.subresource} subresource is never requested.`
        : "Studio reads no subresource but a pod's log.",
    );
  const seen = new Set<string>();
  for (const [key, value] of query) {
    if (!row.keys.has(key)) refuse(`The query key ${key} is not sent on this request.`);
    if (seen.has(key)) refuse(`The query key ${key} is sent at most once.`);
    seen.add(key);
    const rule = VALUE_RULES[key];
    if (rule !== undefined && !rule(value)) refuse(`The value of the query key ${key} is outside what Studio sends.`);
  }
  if (segments[0] === "openapi" && segments.length > 2 && !seen.has("hash"))
    refuse("An OpenAPI group document is read only with its hash.");
}

/** The final-path rule, on the API path and the request path joined: no `%`, `//`, `;`, `.` or `..` segment. */
export function finalPathRefusal(fullPath: string): string | undefined {
  const bad =
    !FINAL_PATH.test(fullPath) ||
    fullPath.includes("//") ||
    fullPath
      .split("/")
      .slice(1)
      .some((segment) => segment === "." || segment === "..");
  return bad ? "The request path holds a character or a segment Studio never sends. Nothing was sent." : undefined;
}
