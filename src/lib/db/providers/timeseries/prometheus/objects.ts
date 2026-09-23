/**
 * Prometheus object surface (#1085, sections 4.1 to 4.4).
 *
 * Six kinds and no container. `containerLevels` is empty, the Elasticsearch and SQLite shape, so
 * `listContainers` answers `[]` and every object is addressed from the root. The tree draws one
 * flat folder per declared kind and never nests one object's children under it (listing is
 * container-scoped, `src/components/object-tree/flatten.ts`), so `childKinds` on a rule group and
 * a scrape pool is a declaration and nothing more, and a child row's NAME says which parent it
 * belongs to: `<alert> (<group>)`, `<instance> (<pool>)`.
 *
 * Four listings feed the six kinds: the metric names, the rules listing (rule groups and both rule
 * kinds), the scrape pools and the active targets. One private reader per kind feeds both
 * `countObjects` and `listObjects`, so a count is always the listed length (the Redis precedent),
 * and one `countObjects` call sends each listing at most once.
 *
 * Every read goes through `ObjectsTransport`, the read-only slice of the seam this module uses
 * (#1085 3.5, interface segregation), so no endpoint, parameter or envelope member is spelled here
 * and the seam guard holds for this file.
 *
 * Identity is the engine's own, read from the v3.13.3 source rather than left to measurement:
 *
 * - A rule group is keyed `<file>;<group>`, `GroupKey` in `rules/group.go`, because group names
 *   need not be unique across files. The rule manager holds its groups in a map under that key
 *   (`rules/manager.go`), so one listing never carries two groups with one key, and a path is
 *   RESOLVED against the listing, never split: either part may hold a `;`.
 * - A rule is `<position>:<name>`, its 1-based position among all its group's rules, because
 *   shipped rule sets repeat a rule name inside one group.
 * - A target is its scrape URL, a space, and 12 hex digits of a SHA-256 over its label set,
 *   because two targets in one pool can share `instance`, and Prometheus itself tells targets apart
 *   by label set and URL (`scrape/target.go`, `Target.hash`).
 *
 * No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: this product offers no write path to
 * Prometheus (#1085 section 2), and `docs/providers/prometheus.md` names that absence.
 */
import { createHash } from "node:crypto";
import { DatabaseError, QueryError } from "@/lib/db/errors";
import {
  applySourceBound,
  assertObjectPathShape,
  callerBoundTruncationReason,
  containerDepth,
  declaredKinds,
  findKind,
  type ObjectPathShapeEngine,
  requireSourceKind,
  SOURCE_PART_LIMIT,
} from "@/lib/db/object-kinds";
import { comparePaths } from "@/lib/db/object-path";
import type {
  ColumnSchema,
  Container,
  DatabaseObject,
  DatabaseType,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
  ObjectSourcePart,
  ProviderCapabilities,
} from "@/lib/db/types";
import { ALL_METRICS_SELECTOR, metricSelector } from "./promql";
import { vectorFieldNames } from "./results";
import {
  type CappedList,
  type PrometheusMetadataEntry,
  type PrometheusQueryOptions,
  type PrometheusRecordingRule,
  type PrometheusRule,
  type PrometheusRuleGroup,
  type PrometheusTarget,
  type PrometheusTransport,
  PrometheusTransportError,
  type TimeWindow,
} from "./transport";

/**
 * How many metric names one listing holds before its count is a floor (#1085 4.3, M10).
 *
 * It bounds the metric listing and the tree's Metrics count, and it keeps plan mode no room for
 * the other kinds: the agent's grounding walk bounds the metric batch at the listing's length and
 * stops at the first truncated batch, so past 2,000 names plan mode grounds metrics only
 * (`docs/BACKLOG.md` B84). The design fixes 2,000; `tests/fixtures/prometheus/README.md`, section
 * "Measurements", entry M10, records the live check that keeps it or the number that replaces it.
 */
export const METRIC_LIST_CAP = 2000;

/**
 * How many series one bulk column read takes before its batch is marked truncated (#1085 4.2,
 * M13). The candidate is 20,000; `tests/fixtures/prometheus/README.md`, section "Measurements",
 * entry M13, records the measurement that confirms or replaces it.
 */
export const DESCRIBE_SERIES_CAP = 20_000;

/** The span every inventory read covers: the last hour, ending at the injected clock's now (#1085 4.2). */
export const INVENTORY_WINDOW_MS = 3_600_000;

const METRIC_KIND = "metric";
const RULE_GROUP_KIND = "rule_group";
const RECORDING_RULE_KIND = "recording_rule";
const ALERTING_RULE_KIND = "alerting_rule";
const SCRAPE_POOL_KIND = "scrape_pool";
const TARGET_KIND = "target";

/** Every kind's source is JSON this product renders (#1085 4.4), so the pair is declared once. */
const JSON_SOURCE = { hasSource: true, sourceLanguage: "json" } as const;

/**
 * The six kinds, in the order the agent's grounding walk reads them (M7): metrics first, then the
 * rule groups and both rule kinds, then the scrape pools and their targets.
 *
 * Only a metric has columns: its label names, then `timestamp` and `value`. A rule group and a
 * scrape pool are `group`s whose `childKinds` state what they hold without drawing anything, the
 * Oracle and MariaDB package precedent; each child declares `attachedTo` its parent, which is the
 * one declaration that makes its two-segment path legal at depth 0 (`assertObjectPathShape`).
 */
export const PROMETHEUS_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: METRIC_KIND, role: "relation", label: "Metric", labelPlural: "Metrics", hasColumns: true, ...JSON_SOURCE },
  {
    id: RULE_GROUP_KIND,
    role: "group",
    label: "Rule group",
    labelPlural: "Rule groups",
    childKinds: [RECORDING_RULE_KIND, ALERTING_RULE_KIND],
    ...JSON_SOURCE,
  },
  {
    id: RECORDING_RULE_KIND,
    role: "config",
    label: "Recording rule",
    labelPlural: "Recording rules",
    attachedTo: RULE_GROUP_KIND,
    ...JSON_SOURCE,
  },
  {
    id: ALERTING_RULE_KIND,
    role: "config",
    label: "Alerting rule",
    labelPlural: "Alerting rules",
    attachedTo: RULE_GROUP_KIND,
    ...JSON_SOURCE,
  },
  {
    id: SCRAPE_POOL_KIND,
    role: "group",
    label: "Scrape pool",
    labelPlural: "Scrape pools",
    childKinds: [TARGET_KIND],
    ...JSON_SOURCE,
  },
  {
    id: TARGET_KIND,
    role: "config",
    label: "Target",
    labelPlural: "Targets",
    attachedTo: SCRAPE_POOL_KIND,
    ...JSON_SOURCE,
  },
] as const);

/**
 * This provider's name, in the sentences about its own declaration and a caller's arguments. A
 * sentence about what the server holds names the server instead, because a wire-compatible relative
 * such as VictoriaMetrics answers these reads through this provider too.
 */
const ENGINE_NAME = "Prometheus";

export type ObjectsTransport = Pick<
  PrometheusTransport,
  "query" | "metricNames" | "labelNames" | "seriesLabels" | "metadata" | "rules" | "scrapePools" | "targets"
>;

export interface ObjectSurfaceDeps {
  readonly transport: ObjectsTransport;
  /** Milliseconds since the epoch: the inventory window ends here. */
  readonly now: () => number;
  /** The provider's own declaration, which carries `PROMETHEUS_OBJECT_KINDS` and no container level. */
  readonly capabilities: ProviderCapabilities;
  /** `{ code: <the provider's type>, label: "A Prometheus", attachedSegment: "required" }`. */
  readonly engine: ObjectPathShapeEngine;
  /** The options the existence read, `count(last_over_time(<selector>[1h]))`, runs with. */
  readonly queryOptions: () => PrometheusQueryOptions;
}

/** How many hex digits of the label-set digest a target's path segment keeps (#1085 4.1). */
const TARGET_DIGEST_LENGTH = 12;

/**
 * A rule group's path segment: the engine's own key, `GroupKey(file, name)` in `rules/group.go`.
 * Never split back into its parts: a path is resolved against the rules listing instead.
 */
export function groupKey(group: Pick<PrometheusRuleGroup, "file" | "name">): string {
  return `${group.file};${group.name}`;
}

/** A rule's path segment: its 1-based position among ALL its group's rules, a colon, then its name. */
export function ruleSegment(position: number, name: string): string {
  return `${position}:${name}`;
}

/**
 * A target's path segment: the scrape URL, a space, then the first 12 hex digits of a SHA-256 over
 * the canonical label set.
 *
 * Canonical is the label pairs as JSON, sorted by name in code-unit order. JSON quotes and escapes
 * both halves of every pair, so two label sets never share a text, where a plain `name=value,`
 * join gives `{"a,b": "c"}` and `{"a": "b,c"}` the same one. The URL carries the scheme, address,
 * path and parameters, and the labels are the public ones the API reports: the closest this API
 * comes to the full label set and URL `Target.hash` tells targets apart by (`scrape/target.go`).
 */
export function targetSegment(target: Pick<PrometheusTarget, "scrapeUrl" | "labels">): string {
  const pairs = Object.entries(target.labels).sort(([left], [right]) => comparePaths([left], [right]));
  const digest = createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
  return `${target.scrapeUrl} ${digest.slice(0, TARGET_DIGEST_LENGTH)}`;
}

/**
 * The object surface of one Prometheus connection (#1085 4.1 to 4.4), which the provider composes
 * and delegates its object methods to. It holds no connection state: every call reads through the
 * transport it was given, and the provider decides when a call may be made.
 */
export class PrometheusObjects {
  constructor(private readonly deps: ObjectSurfaceDeps) {}

  /**
   * No container level exists, so there is nothing to list and nothing is read to say so: the
   * search provider's answer for the same shape. The tree opens straight onto the kind folders.
   */
  listContainers(parent?: readonly string[]): Promise<Container[]> {
    void parent;
    return Promise.resolve([]);
  }

  /**
   * Every declared kind's count, each the length of the listing its own reader produces.
   *
   * The readers share one `CallReads`, so the rules listing three kinds come from is sent once. A
   * kind whose listing was refused carries that refusal's sentence while the other kinds still
   * count. A listing read ends in one of two refusals: the transport's own
   * `PrometheusTransportError`, or the `DatabaseError` the shared endpoint module raises for a
   * redirect (`rejectRedirect`), which the transport passes through unchanged; neither message
   * carries a response body. Any other fault propagates, because a badge presents its text as the
   * engine's own sentence (the search provider's rule).
   */
  async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.requireContainer(container);
    const reads = this.reads();
    const kinds = declaredKinds(this.deps.capabilities);
    const counts = await Promise.all(kinds.map((kind) => this.countKind(reads, kind.id)));
    return Object.fromEntries(kinds.map((kind, index): [string, KindCount] => [kind.id, counts[index]]));
  }

  /** The objects of one kind, from the same reader its count comes from. */
  async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    this.requireContainer(container);
    return (await this.readKind(this.reads(), kind)).objects;
  }

  /**
   * One object's columns. A metric's are the label names its series carry over the window, then
   * `timestamp` and `value`, named by `vectorFieldNames`, the one function the vector shaper uses,
   * so the tree and the grid name one metric's fields alike. Every series carries
   * its metric name, so a labels read that names no label found no series in the window: such a
   * metric has no columns to report, the answer `describeObjects` gives it by leaving it out, and
   * not a timestamp and a value no series holds. The other five kinds have no columns and answer
   * three empty arrays without a read.
   */
  async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const spec = this.requireKind(kind);
    assertObjectPathShape(this.deps.capabilities, spec, kind, path, this.deps.engine);
    if (kind !== METRIC_KIND) return noColumns(path);
    const name = path[path.length - 1];
    const labelNames = await this.deps.transport.labelNames(metricSelector(name), this.window());
    return labelNames.length === 0 ? noColumns(path) : metricDetail(path, labelNames);
  }

  /**
   * Every metric's columns in ONE series read, grouped by metric name (#1085 4.2).
   *
   * One request per call and never one per metric, because this is the inventory's hot path: every
   * connection select asks for the columns of every relation kind. The read is bounded twice and
   * both bounds say so on `truncated`, joined the Redis way: the caller's `limit` on metrics, in the
   * shared sentence, and `DESCRIBE_SERIES_CAP` on series, in this provider's own, on an unbounded
   * call too. Past the series cap any metric's label list may lack a label only its unread series
   * carry, which is why the batch is marked rather than presented as complete.
   *
   * The metric set is the series read's own, because this call reads no listing: a metric beyond a
   * capped listing can be described here, and a listed metric whose series all stopped sampling
   * before the window is not, while they remain in the head. The head answers the label listings
   * with no per-series time filter, so that metric is listed and `describeObject` still reads its
   * labels, but the series read skips a series with no sample in range (`tsdb/head_read.go`,
   * `tsdb/querier.go`); `docs/providers/prometheus.md` states the difference.
   */
  async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.requireKind(kind);
    this.requireContainer(container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A ${ENGINE_NAME} bulk column read limit must be a positive whole number, received ${limit}`,
        this.deps.engine.code,
      );
    }
    if (kind !== METRIC_KIND) return { details: [] };

    const span = this.window();
    const answer = await this.deps.transport.seriesLabels(ALL_METRICS_SELECTOR, span, DESCRIBE_SERIES_CAP + 1);
    const seriesCapped = answer.truncatedByServer || answer.items.length > DESCRIBE_SERIES_CAP;
    const metrics = labelNamesByMetric(answer.items.slice(0, DESCRIBE_SERIES_CAP));
    const bounded = limit !== undefined && metrics.length > limit;
    const details = (bounded ? metrics.slice(0, limit) : metrics).map(([name, labelNames]) =>
      metricDetail([...container, name], labelNames),
    );
    if (!bounded && !seriesCapped) return { details };
    const reasons = [
      ...(bounded ? [callerBoundTruncationReason(limit)] : []),
      ...(seriesCapped ? [SERIES_BOUND_SENTENCE] : []),
    ];
    return { details, truncated: { limit: bounded ? limit : details.length, reason: reasons.join(", and ") } };
  }

  /**
   * One object's source as rendered JSON parts (#1085 4.4, #1085 S7). Every text is `JSON.stringify` of
   * the engine's own values, so an annotation, a HELP string or a target error is shown exactly as
   * the server sent it and cannot forge structure. `limit` bounds each readable part's characters
   * through the shared `applySourceBound`, which marks what it cut and nothing else; a refusal part
   * is the engine's sentence and is never cut.
   *
   * A name that does not exist is a `QueryError` naming its last segment, which is what the shared
   * conformance helper holds every provider to; each kind decides existence from its own listing.
   */
  async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    const spec = requireSourceKind(this.deps.capabilities, kind, {
      displayName: ENGINE_NAME,
      type: this.deps.engine.code,
    });
    assertObjectPathShape(this.deps.capabilities, spec, kind, path, this.deps.engine);
    if (!Object.hasOwn(SOURCE_READERS, kind)) {
      throw new Error(`${ENGINE_NAME} declares source for the object kind "${kind}" and has no reader for it`);
    }
    const [first, ...rest] = await SOURCE_READERS[kind](this.sourceContext(), path);
    return {
      path: [...path],
      kind,
      parts: [
        renderPart(first, spec.sourceLanguage, limit),
        ...rest.map((draft) => renderPart(draft, spec.sourceLanguage, limit)),
      ],
    };
  }

  private sourceContext(): SourceContext {
    return {
      transport: this.deps.transport,
      reads: this.reads(),
      queryOptions: this.deps.queryOptions,
      code: this.deps.engine.code,
    };
  }

  /** One kind's count from its own reader, or the refusal of the listing it reads. */
  private async countKind(reads: CallReads, kind: string): Promise<KindCount> {
    try {
      const { objects, sampledFrom } = await this.readKind(reads, kind);
      return sampledFrom === undefined ? { count: objects.length } : { count: objects.length, sampledFrom };
    } catch (error) {
      if (!(error instanceof PrometheusTransportError) && !(error instanceof DatabaseError)) throw error;
      return { unavailable: error.message };
    }
  }

  /**
   * The one reader of a kind. The readers table is checked with `Object.hasOwn`, never `in`, so a
   * kind id spelled like an `Object.prototype` member cannot resolve to a function; a declared kind
   * with no reader is a defect in this file, and it fails loudly instead of counting zero.
   */
  private readKind(reads: CallReads, kind: string): Promise<KindListing> {
    if (!Object.hasOwn(KIND_READERS, kind)) {
      throw new Error(`${ENGINE_NAME} declares the object kind "${kind}" and has no reader for it`);
    }
    return KIND_READERS[kind](reads);
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.deps.capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`${ENGINE_NAME} declares no object kind "${kind}"`, this.deps.engine.code);
    }
    return spec;
  }

  /** Read through `containerDepth()`, so the check moves with the declaration, which says 0. */
  private requireContainer(container: readonly string[]): void {
    const depth = containerDepth(this.deps.capabilities);
    if (container.length !== depth) {
      throw new QueryError(
        `A ${ENGINE_NAME} container path has ${depth} segment(s), received ${JSON.stringify(container)}`,
        this.deps.engine.code,
      );
    }
  }

  /** The last hour to the injected clock's now, in the float seconds the engine takes (#1085 4.2). */
  private window(): TimeWindow {
    const nowMs = this.deps.now();
    return { startSeconds: (nowMs - INVENTORY_WINDOW_MS) / 1000, endSeconds: nowMs / 1000 };
  }

  private reads(): CallReads {
    return new CallReads(this.deps.transport, this.window());
  }
}

/** One kind's objects, and the sentence that makes its count a floor when the read was capped. */
interface KindListing {
  readonly objects: DatabaseObject[];
  readonly sampledFrom?: string;
}

/** The metric names one listing holds, and whether the server holds more. */
interface MetricListing {
  readonly names: readonly string[];
  readonly truncated: boolean;
}

type KindReader = (reads: CallReads) => Promise<KindListing>;

/**
 * Where a capped metric count was read from, phrased to follow "counted from", which is how the
 * tree titles a floor badge (`src/components/object-tree/flatten.ts`, `formatCount`).
 */
const METRIC_LIST_SAMPLE = `one label-values read capped at ${METRIC_LIST_CAP.toLocaleString("en-US")} names`;

/**
 * The alert states a reader acts on, in the engine's own words (`AlertState` in
 * `rules/alerting.go`); `inactive`, and `unknown` for a rule not yet evaluated, are the ordinary
 * states and leave `DatabaseObject.status` unset.
 */
const NOTABLE_ALERT_STATES: ReadonlySet<string> = new Set(["firing", "pending"]);

/** The target health a reader acts on (`TargetHealth` in `scrape/target.go`); `up` is the ordinary one. */
const NOTABLE_TARGET_HEALTH: ReadonlySet<string> = new Set(["down", "unknown"]);

/**
 * The listings one call reads, each sent at most once and shared by every kind that needs it.
 *
 * `countObjects` answers six kinds from four listings, and three of those kinds are one rules
 * listing: reading it per kind would send the same request three times for one row of badges. A
 * rejected read is shared too, so the three rule kinds carry one refusal rather than three
 * attempts at it.
 */
class CallReads {
  private metricNamesRead: Promise<CappedList<string>> | undefined;
  private rulesRead: Promise<readonly PrometheusRuleGroup[]> | undefined;
  private scrapePoolsRead: Promise<readonly string[]> | undefined;
  private targetsRead: Promise<readonly PrometheusTarget[]> | undefined;

  constructor(
    private readonly transport: ObjectsTransport,
    private readonly window: TimeWindow,
  ) {}

  /** One name more than the cap is asked for (see `metricListing`). */
  metricNames(): Promise<CappedList<string>> {
    this.metricNamesRead ??= this.transport.metricNames(this.window, METRIC_LIST_CAP + 1);
    return this.metricNamesRead;
  }

  /** The whole listing: every group, alerts excluded. */
  rules(): Promise<readonly PrometheusRuleGroup[]> {
    this.rulesRead ??= this.transport.rules();
    return this.rulesRead;
  }

  scrapePools(): Promise<readonly string[]> {
    this.scrapePoolsRead ??= this.transport.scrapePools();
    return this.scrapePoolsRead;
  }

  /** Every active target of every pool; dropped targets are never listed (#1085 4.1). */
  targets(): Promise<readonly PrometheusTarget[]> {
    this.targetsRead ??= this.transport.targets();
    return this.targetsRead;
  }
}

/**
 * The metric names of the window, and whether the list stopped short.
 *
 * One name more than the cap is asked for, so a server that sends no truncation notice still shows
 * it cut the list; either signal makes the count a floor, and the first `METRIC_LIST_CAP` names are
 * listed. A capped listing is not the alphabetically first names: the head cuts its label values in
 * the order it first saw them, and the API sorts what is left (`tsdb/index/postings.go`,
 * `MemPostings.LabelValues`; `web/api/v1/api.go`, `labelValues`).
 */
async function metricListing(reads: CallReads): Promise<MetricListing> {
  const answer = await reads.metricNames();
  return {
    names: answer.items.slice(0, METRIC_LIST_CAP),
    truncated: answer.truncatedByServer || answer.items.length > METRIC_LIST_CAP,
  };
}

/** A metric row is its name and nothing more: a list read measures no series count (#1085 4.3). */
async function listMetrics(reads: CallReads): Promise<KindListing> {
  const { names, truncated } = await metricListing(reads);
  const objects = names.map((name) => ({ path: [name], name, kind: METRIC_KIND })).sort(byPath);
  return truncated ? { objects, sampledFrom: METRIC_LIST_SAMPLE } : { objects };
}

/** Rule groups in the listing's own order, which the engine sorts by file, then name (`RuleGroups`). */
async function listRuleGroups(reads: CallReads): Promise<KindListing> {
  const groups = await reads.rules();
  return { objects: groups.map((group) => ({ path: [groupKey(group)], name: group.name, kind: RULE_GROUP_KIND })) };
}

/**
 * One rule kind, in each group's own order, because a rule's position is its identity. A row is
 * named with its group, since the tree never nests a rule under the group it belongs to.
 */
async function listRules(reads: CallReads, kind: string, ruleKind: PrometheusRule["kind"]): Promise<KindListing> {
  const objects: DatabaseObject[] = [];
  for (const group of await reads.rules()) {
    group.rules.forEach((rule, index) => {
      if (rule.kind !== ruleKind) return;
      objects.push({
        path: [groupKey(group), ruleSegment(index + 1, rule.name)],
        name: `${rule.name} (${group.name})`,
        kind,
        ...(rule.kind === "alerting" && NOTABLE_ALERT_STATES.has(rule.state) ? { status: rule.state } : {}),
      });
    });
  }
  return { objects };
}

async function listScrapePools(reads: CallReads): Promise<KindListing> {
  const pools = await reads.scrapePools();
  return { objects: pools.map((pool) => ({ path: [pool], name: pool, kind: SCRAPE_POOL_KIND })).sort(byPath) };
}

/**
 * Every active target, sorted by path, because the engine answers a pool's targets in Go map order
 * (`scrape/scrape.go`, `scrapePool.ActiveTargets`). A row is named `<instance> (<pool>)`: the
 * engine always sets `instance`, defaulting it to the target's address (`scrape/target.go`,
 * `PopulateLabels`), and two targets may share it, which is why the path carries URL and digest.
 */
async function listTargets(reads: CallReads): Promise<KindListing> {
  const targets = await reads.targets();
  return {
    objects: targets
      .map((target) => ({
        path: [target.scrapePool, targetSegment(target)],
        name: `${target.labels.instance} (${target.scrapePool})`,
        kind: TARGET_KIND,
        ...(NOTABLE_TARGET_HEALTH.has(target.health) ? { status: target.health } : {}),
      }))
      .sort(byPath),
  };
}

function byPath(left: DatabaseObject, right: DatabaseObject): number {
  return comparePaths(left.path, right.path);
}

/** The one reader of each kind, feeding both its count and its listing, keyed by the declared ids. */
const KIND_READERS: Readonly<Record<string, KindReader>> = Object.freeze({
  [METRIC_KIND]: listMetrics,
  [RULE_GROUP_KIND]: listRuleGroups,
  [RECORDING_RULE_KIND]: (reads: CallReads) => listRules(reads, RECORDING_RULE_KIND, "recording"),
  [ALERTING_RULE_KIND]: (reads: CallReads) => listRules(reads, ALERTING_RULE_KIND, "alerting"),
  [SCRAPE_POOL_KIND]: listScrapePools,
  [TARGET_KIND]: listTargets,
});

/** The label a series carries its metric name under, PromQL's own. */
const METRIC_NAME_LABEL = "__name__";

/** A label's value is a string. */
const LABEL_TYPE = "string";

/**
 * The types of the two fields `vectorFieldNames` puts after the labels, in its order: the sample's
 * time, and its value, a float64 or, for a native histogram, the histogram itself (#1085 5.3).
 */
const SAMPLE_FIELD_TYPES = ["timestamp", "float64 or histogram"] as const;

/** The series bound in this provider's own words, phrased to follow the caller's sentence after ", and ". */
const SERIES_BOUND_SENTENCE =
  `the series read stopped at ${DESCRIBE_SERIES_CAP.toLocaleString("en-US")} series, so a metric may be missing ` +
  "from this batch or described without a label only its unread series carry";

/**
 * A metric's detail from its label names: the fields `vectorFieldNames` gives, each label typed as
 * the string it is, then the sample's two fields. A series may lack any label, so a label column is
 * nullable, except the metric name, which every series of the metric carries.
 */
function metricDetail(path: readonly string[], labelNames: readonly string[]): ObjectDetail {
  const fields = vectorFieldNames(labelNames);
  const labelCount = fields.length - SAMPLE_FIELD_TYPES.length;
  return {
    path: [...path],
    columns: fields.map(
      (name, index): ColumnSchema =>
        index < labelCount
          ? { name, type: LABEL_TYPE, nullable: name !== METRIC_NAME_LABEL, isPrimary: false }
          : { name, type: SAMPLE_FIELD_TYPES[index - labelCount], nullable: false, isPrimary: false },
    ),
    indexes: [],
    foreignKeys: [],
  };
}

/** The detail of an object with no columns to report: its path and three empty arrays. */
function noColumns(path: readonly string[]): ObjectDetail {
  return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
}

/**
 * Each metric's label names over a series read, as `[name, labelNames]` pairs in path order. The
 * read's selector matches only series that carry a metric name, so every series names its metric.
 */
function labelNamesByMetric(series: readonly Readonly<Record<string, string>>[]): [string, string[]][] {
  const byMetric = new Map<string, Set<string>>();
  for (const labels of series) {
    const name = labels[METRIC_NAME_LABEL];
    const known = byMetric.get(name) ?? new Set<string>();
    for (const label of Object.keys(labels)) known.add(label);
    byMetric.set(name, known);
  }
  return [...byMetric]
    .map(([name, labels]): [string, string[]] => [name, [...labels]])
    .sort(([left], [right]) => comparePaths([left], [right]));
}

/** What a source reader needs: the transport for its own reads, the call's listings, the code its errors carry. */
interface SourceContext {
  readonly transport: ObjectsTransport;
  readonly reads: CallReads;
  readonly queryOptions: () => PrometheusQueryOptions;
  readonly code: DatabaseType;
}

/** A part before it is rendered: the value to serialise, or the engine's reason there is none. */
type PartDraft =
  | { readonly id: string; readonly label: string; readonly value: unknown }
  | { readonly id: string; readonly label: string; readonly unavailable: string };

/** Non-empty, like the document it becomes. */
type PartDrafts = readonly [PartDraft, ...PartDraft[]];

type SourceReader = (context: SourceContext, path: readonly string[]) => Promise<PartDrafts>;

/** The indent every source is rendered with. */
const SOURCE_INDENT = 2;

const METADATA_PART_ID = "metadata";
const METADATA_PART_LABEL = "Metadata";

/**
 * The engine fact a metric without metadata is answered with (#1085 4.4). Prometheus collects
 * metadata per metric family from the targets it scrapes, so a series no target exposes has none,
 * and the metadata read answers the same empty map for such a real metric as for a name that does
 * not exist, which is why existence is decided before this is said. The design's backticks around
 * ALERTS are left out because a refusal renders as plain text, and its subject is the server rather
 * than Prometheus, because a relative answers this read too.
 */
const METADATA_ABSENT =
  "The server holds no metadata for this name: metadata is collected per metric family from active scrape " +
  "targets, so recording-rule outputs, ALERTS and classic histogram series have none.";

/**
 * The suffixes a series name carries beyond its family's (#1085 4.4): a classic histogram's
 * `_bucket`, `_sum` and `_count`, a summary's `_sum` and `_count`, and an OpenMetrics counter's
 * `_total` and `_created`. The engine keys metadata by the family name exactly
 * (`scrape/scrape.go`, `scrapeCache.GetMetadata`), so a name is looked up as written, then once
 * without the one suffix it ends in.
 */
const FAMILY_SUFFIXES = ["_bucket", "_sum", "_count", "_total", "_created"] as const;

/**
 * One draft as a document part. `form` is complete because every read here answers the object
 * whole, and `origin` is rendered because this product prints the JSON, which is what the shipped
 * caption for that origin says ("A structured definition, rendered here as JSON",
 * `src/components/object-source/source-caption.ts`). A refusal passes through whole.
 */
function renderPart(draft: PartDraft, language: string, limit: number | undefined): ObjectSourcePart {
  if ("unavailable" in draft) return draft;
  const bounded = applySourceBound(JSON.stringify(draft.value, null, SOURCE_INDENT), limit);
  return {
    id: draft.id,
    label: draft.label,
    text: bounded.text,
    language,
    form: "complete",
    origin: "rendered",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

/**
 * Whether a metric exists, which the listing decides: the metadata read cannot, because it answers
 * the same empty map for an unknown name as for a real metric with no metadata (#1085 4.4). A name
 * outside a complete listing does not exist. A capped listing is not the alphabetically first names
 * (see `metricListing`), so a name outside it is asked about directly, with a count of its one
 * selector (#1085 S4) over the listing's own hour, `count(last_over_time(<selector>[1h]))`: `1h` is
 * `INVENTORY_WINDOW_MS` written as a PromQL range, so a change to that constant changes this text too.
 * An instant count of the bare selector would look back five minutes only, and would call absent a
 * metric the listing could show because it went quiet before that. The read answers a sample only
 * when the metric has series in the hour.
 */
async function requireMetric(context: SourceContext, name: string): Promise<void> {
  const { names, truncated } = await metricListing(context.reads);
  if (names.includes(name)) return;
  if (truncated) {
    const expression = `count(last_over_time(${metricSelector(name)}[1h]))`;
    const answer = await context.transport.query(expression, context.queryOptions());
    if (answer.value.shape === "vector" && answer.value.series.length > 0) return;
  }
  throw new QueryError(`The server reports no metric named ${name}`, context.code);
}

function familyName(name: string): string | undefined {
  const suffix = FAMILY_SUFFIXES.find((candidate) => name.length > candidate.length && name.endsWith(candidate));
  return suffix === undefined ? undefined : name.slice(0, -suffix.length);
}

interface MetadataLookup {
  /** The name the entries were found under: the metric's own, or its family's. */
  readonly family: string;
  readonly entries: readonly PrometheusMetadataEntry[];
}

/** Metadata by the exact name, then by the family name, and no third guess (#1085 4.4). */
async function metadataFor(transport: ObjectsTransport, name: string): Promise<MetadataLookup> {
  const exact = await transport.metadata(name);
  const family = familyName(name);
  if (exact.length > 0 || family === undefined) return { family: name, entries: exact };
  return { family, entries: await transport.metadata(family) };
}

/**
 * The distinct entries in a stable order. Targets that expose one family with different HELP text
 * give it several entries, and the engine answers them from a Go map, in no order at all, so they
 * are keyed by type, help and unit and sorted by that key here.
 */
function distinctEntries(entries: readonly PrometheusMetadataEntry[]): PrometheusMetadataEntry[] {
  const byKey = new Map<string, PrometheusMetadataEntry>();
  for (const entry of entries) byKey.set(JSON.stringify([entry.type, entry.help, entry.unit]), entry);
  return [...byKey].sort(([left], [right]) => comparePaths([left], [right])).map(([, entry]) => entry);
}

/**
 * One part per distinct metadata entry, and never more parts than a document may carry: the
 * source route refuses a document of more than `SOURCE_PART_LIMIT` parts (`src/lib/api/object-route.ts`),
 * so past that the last part holds every remaining entry as one JSON array. Nothing the engine
 * answered is dropped, and nothing it left out is added: an entry sent without a unit, as
 * VictoriaMetrics sends every entry, renders without one.
 */
function metadataDrafts(family: string, entries: readonly PrometheusMetadataEntry[]): PartDrafts {
  const distinct = distinctEntries(entries);
  const total = distinct.length;
  const value = (entry: PrometheusMetadataEntry) => ({
    family,
    type: entry.type,
    help: entry.help,
    ...(entry.unit === undefined ? {} : { unit: entry.unit }),
  });
  if (total === 1) return [{ id: METADATA_PART_ID, label: METADATA_PART_LABEL, value: value(distinct[0]) }];
  const singles = total > SOURCE_PART_LIMIT ? SOURCE_PART_LIMIT - 1 : total;
  const drafts = distinct.slice(0, singles).map(
    (entry, index): PartDraft => ({
      id: `${METADATA_PART_ID}-${index + 1}`,
      label: `${METADATA_PART_LABEL} ${index + 1} of ${total}`,
      value: value(entry),
    }),
  );
  const overflow = distinct.slice(singles);
  const rest: PartDraft[] =
    overflow.length === 0
      ? []
      : [
          {
            id: `${METADATA_PART_ID}-${singles + 1}`,
            label: `${METADATA_PART_LABEL} ${singles + 1} to ${total} of ${total}`,
            value: overflow.map(value),
          },
        ];
  return [drafts[0], ...drafts.slice(1), ...rest];
}

/** A metric's metadata, one part per distinct entry, or the engine fact when there is none. */
async function metricSource(context: SourceContext, path: readonly string[]): Promise<PartDrafts> {
  const name = path[path.length - 1];
  await requireMetric(context, name);
  const { family, entries } = await metadataFor(context.transport, name);
  if (entries.length === 0) {
    return [{ id: METADATA_PART_ID, label: METADATA_PART_LABEL, unavailable: METADATA_ABSENT }];
  }
  return metadataDrafts(family, entries);
}

/** The group a key names, found in a listing by its key and never by splitting the key. */
function requireGroup(groups: readonly PrometheusRuleGroup[], key: string, code: DatabaseType): PrometheusRuleGroup {
  const group = groups.find((candidate) => groupKey(candidate) === key);
  if (group === undefined) throw new QueryError(`The server has no rule group ${key}`, code);
  return group;
}

/**
 * A group, resolved by its key against the rules listing (#1085 4.4), because `<file>;<group>` does
 * not split unambiguously when either part holds a `;`. The listing is read with alerts excluded
 * and already carries every field a group's source and a recording rule's source render, so its
 * entry is the source of both and no second read is sent; only an alerting rule's live state needs
 * one (see `alertingRuleSource`).
 */
async function readGroup(context: SourceContext, key: string): Promise<PrometheusRuleGroup> {
  return requireGroup(await context.reads.rules(), key, context.code);
}

/** A rule group's evaluation facts and how many rules it holds, from its listing entry. */
async function ruleGroupSource(context: SourceContext, path: readonly string[]): Promise<PartDrafts> {
  const group = await readGroup(context, path[path.length - 1]);
  return [
    {
      id: "group",
      label: "Rule group",
      value: {
        file: group.file,
        name: group.name,
        interval: group.interval,
        limit: group.limit,
        evaluationTime: group.evaluationTime,
        lastEvaluation: group.lastEvaluation,
        ruleCount: group.rules.length,
      },
    },
  ];
}

/** A recording rule as the listing has it, found in its group by its position and name. */
async function recordingRuleSource(context: SourceContext, path: readonly string[]): Promise<PartDrafts> {
  const key = path[path.length - 2];
  const segment = path[path.length - 1];
  const group = await readGroup(context, key);
  const rule = group.rules.find(
    (candidate, index): candidate is PrometheusRecordingRule =>
      candidate.kind === "recording" && ruleSegment(index + 1, candidate.name) === segment,
  );
  if (rule === undefined) {
    throw new QueryError(`The server has no recording rule ${segment} in the rule group ${key}`, context.code);
  }
  return [
    {
      id: "rule",
      label: "Recording rule",
      value: {
        name: rule.name,
        query: rule.query,
        labels: rule.labels,
        health: rule.health,
        lastError: rule.lastError,
        evaluationTime: rule.evaluationTime,
        lastEvaluation: rule.lastEvaluation,
      },
    },
  ];
}

function noAlertingRule(key: string, segment: string, code: DatabaseType): QueryError {
  return new QueryError(`The server has no alerting rule ${segment} in the rule group ${key}`, code);
}

/**
 * An alerting rule: its definition from the listing's group, then its live state from the one
 * filtered read that names the group, its file and the rule, which is the read that carries alerts
 * (#1085 4.4), so the live count stays out of the definition. That read answers only the rules of
 * that name, so a name repeated in one group is found there by its occurrence among the same-named
 * rules, counted in the listing's group.
 */
async function alertingRuleSource(context: SourceContext, path: readonly string[]): Promise<PartDrafts> {
  const key = path[path.length - 2];
  const segment = path[path.length - 1];
  const group = await readGroup(context, key);
  const index = group.rules.findIndex(
    (candidate, position) => candidate.kind === "alerting" && ruleSegment(position + 1, candidate.name) === segment,
  );
  const rule = group.rules[index];
  if (rule === undefined || rule.kind !== "alerting") throw noAlertingRule(key, segment, context.code);
  const occurrence = group.rules.slice(0, index).filter((other) => other.name === rule.name).length;
  const named = await context.transport.rules({ group: group.name, file: group.file, ruleName: rule.name });
  const namedGroup = named.find((candidate) => groupKey(candidate) === key);
  const live = namedGroup?.rules.filter((other) => other.name === rule.name)[occurrence];
  if (live === undefined || live.kind !== "alerting") throw noAlertingRule(key, segment, context.code);
  return [
    {
      id: "definition",
      label: "Definition",
      value: {
        name: rule.name,
        query: rule.query,
        duration: rule.duration,
        keepFiringFor: rule.keepFiringFor,
        labels: rule.labels,
        annotations: rule.annotations,
        health: rule.health,
        lastError: rule.lastError,
      },
    },
    { id: "state", label: "Live state", value: { state: live.state, alerts: live.alerts } },
  ];
}

/** Active targets counted by the health word the engine gave each, keyed in code-unit order. */
function countByHealth(targets: readonly PrometheusTarget[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const target of targets) counts.set(target.health, (counts.get(target.health) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => comparePaths([left], [right])));
}

/**
 * A scrape pool's active targets counted by health (#1085 4.4). The pool must be in the pools
 * listing: the targets read answers an empty list for a pool that does not exist, which would read
 * as a pool with no target. Only targets the read reports for this pool are counted.
 */
async function scrapePoolSource(context: SourceContext, path: readonly string[]): Promise<PartDrafts> {
  const pool = path[path.length - 1];
  if (!(await context.reads.scrapePools()).includes(pool)) {
    throw new QueryError(`The server has no scrape pool ${pool}`, context.code);
  }
  const targets = (await context.transport.targets(pool)).filter((target) => target.scrapePool === pool);
  return [
    {
      id: "targets",
      label: "Targets by health",
      value: { scrapePool: pool, targets: targets.length, targetsByHealth: countByHealth(targets) },
    },
  ];
}

/**
 * A target, found by its pool and segment in its own pool's read (#1085 4.4). A scrape interval or
 * timeout the engine did not send is left out rather than filled in: VictoriaMetrics sends neither,
 * and keeps both among the discovered labels the part shows whole.
 */
async function targetSource(context: SourceContext, path: readonly string[]): Promise<PartDrafts> {
  const pool = path[path.length - 2];
  const segment = path[path.length - 1];
  const target = (await context.transport.targets(pool)).find(
    (candidate) => candidate.scrapePool === pool && targetSegment(candidate) === segment,
  );
  if (target === undefined) {
    throw new QueryError(`The server has no active target ${segment} in the scrape pool ${pool}`, context.code);
  }
  return [
    {
      id: "target",
      label: "Target",
      value: {
        scrapeUrl: target.scrapeUrl,
        health: target.health,
        lastError: target.lastError,
        lastScrape: target.lastScrape,
        lastScrapeDuration: target.lastScrapeDuration,
        ...(target.scrapeInterval === undefined ? {} : { scrapeInterval: target.scrapeInterval }),
        ...(target.scrapeTimeout === undefined ? {} : { scrapeTimeout: target.scrapeTimeout }),
        labels: target.labels,
        discoveredLabels: target.discoveredLabels,
      },
    },
  ];
}

/** Each kind's source reader, keyed like `KIND_READERS` and checked the same way. */
const SOURCE_READERS: Readonly<Record<string, SourceReader>> = Object.freeze({
  [METRIC_KIND]: metricSource,
  [RULE_GROUP_KIND]: ruleGroupSource,
  [RECORDING_RULE_KIND]: recordingRuleSource,
  [ALERTING_RULE_KIND]: alertingRuleSource,
  [SCRAPE_POOL_KIND]: scrapePoolSource,
  [TARGET_KIND]: targetSource,
});
