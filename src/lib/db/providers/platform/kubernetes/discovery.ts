/**
 * Aggregated discovery (`GET /api` and `GET /apis`, the v2 form, else v2beta1), the admission of well-formed entries,
 * the per-connection resource index and its 10-minute cache.
 *
 * An entry enters the index only when its group is a DNS-1123 subdomain (or empty for the core group), its version
 * reads like `v1`, `v1beta1` or `v2alpha1`, its resource is a lower-case DNS-1123 label, and its singular, kind,
 * verbs, short names and categories are the shapes the API defines; anything else is dropped and counted, never
 * repaired. A resource's version is the first version of its group, in the server's preference order, that lists it
 * and is not `Stale`.
 *
 * A server that answers only the unaggregated form is refused: aggregated discovery is the 1.30 floor (1.28 and 1.29
 * answer the beta form). 1.27 answers the beta form too, so `connect()` also refuses an index without the GA
 * SelfSubjectReview, which Kubernetes serves from 1.28.
 */
import { QueryError } from "@/lib/db/errors";
import { ACCEPT_DISCOVERY, type KubernetesCall, type KubernetesClient } from "./client";
import { DNS1123_LABEL } from "./connection-options";
import { KubernetesRequestError } from "./errors";
import { KUBERNETES_DISCOVERY_TTL_MS, KUBERNETES_TYPE } from "./limits";
import type { ResourceRef } from "./request-policy";

/** One resource of the index: what a request is checked against, and what name resolution reads. */
export interface IndexedResource extends ResourceRef {
  readonly singular: string;
  readonly kind: string;
  readonly shortNames: readonly string[];
  readonly categories: readonly string[];
}

export interface ResourceIndex {
  /** Every admitted resource, core first, then the groups in the server's order. */
  readonly resources: readonly IndexedResource[];
  /** Every served group version, `v1` or `apps/v1`, in the server's order. */
  readonly groupVersions: readonly string[];
  /** How many malformed entries were dropped. */
  readonly dropped: number;
}

export const DISCOVERY_FLOOR_SENTENCE =
  "This API server did not answer aggregated discovery, which Kubernetes serves from 1.30 (1.28 and 1.29 as a beta); Studio supports Kubernetes 1.30 and later.";

export const VERSION_FLOOR_SENTENCE =
  "This API server does not serve authentication.k8s.io/v1 SelfSubjectReview, which Kubernetes serves from 1.28, so it runs 1.27 or earlier; Studio supports Kubernetes 1.30 and later, and 1.28 and 1.29 on a best-effort basis.";

const DNS1123_SUBDOMAIN = /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const VERSION = /^v[0-9]+((alpha|beta)[0-9]+)?$/;
const KIND = /^[A-Za-z][A-Za-z0-9]{0,62}$/;
const VERB = /^[a-z]{1,32}$/;
const AGGREGATED = new Set(["apidiscovery.k8s.io/v2", "apidiscovery.k8s.io/v2beta1"]);

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, pattern: RegExp): readonly string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && pattern.test(entry)))
    return undefined;
  return value as string[];
}

/** One admitted resource, or undefined for an entry that is not well formed. */
function admit(entry: unknown, group: string, version: string): IndexedResource | undefined {
  if (!isObject(entry)) return undefined;
  const { resource, singularResource, scope, responseKind } = entry;
  if (typeof resource !== "string" || !DNS1123_LABEL.test(resource)) return undefined;
  const singular = singularResource === undefined || singularResource === "" ? resource : singularResource;
  if (typeof singular !== "string" || !DNS1123_LABEL.test(singular)) return undefined;
  if (scope !== "Namespaced" && scope !== "Cluster") return undefined;
  const kind = isObject(responseKind) ? responseKind.kind : undefined;
  if (typeof kind !== "string" || !KIND.test(kind)) return undefined;
  const verbs = stringList(entry.verbs, VERB);
  const shortNames = stringList(entry.shortNames, /^[A-Za-z0-9]{1,63}$/);
  const categories = stringList(entry.categories, DNS1123_LABEL);
  if (verbs === undefined || shortNames === undefined || categories === undefined) return undefined;
  return {
    group,
    version,
    resource,
    namespaced: scope === "Namespaced",
    verbs,
    singular,
    kind,
    shortNames,
    categories,
  };
}

/**
 * Folds one `APIGroupDiscoveryList` into the index under construction; refuses a body of any other kind. The `/api`
 * body holds only the core group, whose item carries no name; every `/apis` item names its group.
 */
function fold(body: unknown, root: "api" | "apis", resources: IndexedResource[], groupVersions: string[]): number {
  if (!isObject(body) || body.kind !== "APIGroupDiscoveryList" || !AGGREGATED.has(String(body.apiVersion)))
    throw new QueryError(DISCOVERY_FLOOR_SENTENCE, KUBERNETES_TYPE);
  let dropped = 0;
  const items = Array.isArray(body.items) ? body.items : [];
  for (const item of items) {
    const name = isObject(item) && isObject(item.metadata) ? item.metadata.name : undefined;
    const group =
      root === "api"
        ? name === undefined || name === ""
          ? ""
          : undefined
        : typeof name === "string" && DNS1123_SUBDOMAIN.test(name)
          ? name
          : undefined;
    if (group === undefined || !isObject(item)) {
      dropped += 1;
      continue;
    }
    const seen = new Set<string>();
    for (const entry of Array.isArray(item.versions) ? item.versions : []) {
      if (!isObject(entry) || typeof entry.version !== "string" || !VERSION.test(entry.version)) {
        dropped += 1;
        continue;
      }
      if (entry.freshness === "Stale") continue;
      groupVersions.push(group === "" ? entry.version : `${group}/${entry.version}`);
      for (const raw of Array.isArray(entry.resources) ? entry.resources : []) {
        const resource = admit(raw, group, entry.version);
        if (resource === undefined) {
          dropped += 1;
          continue;
        }
        // The first non-stale version of the group that lists a resource is its version.
        if (seen.has(resource.resource)) continue;
        seen.add(resource.resource);
        resources.push(resource);
      }
    }
  }
  return dropped;
}

/** The index of the two discovery bodies, core first. */
export function parseDiscovery(core: unknown, groups: unknown): ResourceIndex {
  const resources: IndexedResource[] = [];
  const groupVersions: string[] = [];
  const dropped = fold(core, "api", resources, groupVersions) + fold(groups, "apis", resources, groupVersions);
  return { resources, groupVersions, dropped };
}

/** Reads both discovery documents, `/apis` only after `/api` answered, so a rejected token is one request. */
export async function readDiscovery(client: KubernetesClient, call: KubernetesCall): Promise<ResourceIndex> {
  const discovery = { ...call, accept: ACCEPT_DISCOVERY };
  const core = await client.json({ op: "discovery", root: "api" }, discovery);
  const groups = await client.json({ op: "discovery", root: "apis" }, discovery);
  return parseDiscovery(core, groups);
}

/**
 * Refuses a server older than 1.28. 1.27 answers the beta aggregated form by default, so discovery alone admits it;
 * it serves SelfSubjectReview only as a beta, and the GA version is what tells the two apart.
 */
export function requireSupportedServer(index: ResourceIndex): void {
  const review = findResource(index, "authentication.k8s.io", "selfsubjectreviews");
  if (review === undefined || review.version !== "v1") throw new QueryError(VERSION_FLOOR_SENTENCE, KUBERNETES_TYPE);
}

/** The resource of one group, by its plural name, or undefined when discovery does not list it. */
export function findResource(index: ResourceIndex, group: string, resource: string): IndexedResource | undefined {
  return index.resources.find((entry) => entry.group === group && entry.resource === resource);
}

/** One connection's index, kept for 10 minutes and read again on an explicit refresh; concurrent reads share one load. */
export class DiscoveryCache {
  private held: { readonly index: ResourceIndex; readonly readAt: number } | undefined;
  private loading: Promise<ResourceIndex> | undefined;

  constructor(
    private readonly load: () => Promise<ResourceIndex>,
    private readonly now: () => number,
  ) {}

  /** The held index while it is fresh, else a new read. */
  async get(): Promise<ResourceIndex> {
    const held = this.held;
    if (held !== undefined && this.now() - held.readAt < KUBERNETES_DISCOVERY_TTL_MS) return held.index;
    return this.refresh();
  }

  /** A new read, whatever is held; a read in flight is shared. */
  async refresh(): Promise<ResourceIndex> {
    if (this.loading !== undefined) return this.loading;
    const loading = this.load().then(
      (index) => {
        this.held = { index, readAt: this.now() };
        this.loading = undefined;
        return index;
      },
      (error: unknown) => {
        this.loading = undefined;
        throw error;
      },
    );
    this.loading = loading;
    return loading;
  }

  /** Drops the held index, so the next read asks the server. */
  clear(): void {
    this.held = undefined;
  }
}

/**
 * Runs `work` on the index; when the server answers a `text/plain` 404 (a type it no longer serves), the index is
 * read again once and `work` runs once more on it, as kubectl refreshes its cache on an unknown type.
 */
export async function withTypeRefresh<T>(
  cache: DiscoveryCache,
  work: (index: ResourceIndex) => Promise<T>,
): Promise<T> {
  try {
    return await work(await cache.get());
  } catch (error) {
    if (!(error instanceof KubernetesRequestError) || !error.typeMissing) throw error;
    return work(await cache.refresh());
  }
}
