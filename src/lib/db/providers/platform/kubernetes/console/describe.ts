/**
 * `describe TYPE NAME`: one object as one grid of section, field and value, the shape of kubectl's generic describer
 * for every kind. Three reads: the object as a one-row Table (its server-formatted columns), the object itself
 * (metadata and conditions), and its events, selected by the involved object's kind, name, namespace and uid with
 * each value escaped. Summary rows are the Table's cells, then the namespace, the creation time, each label,
 * annotation, owner and finalizer; one Conditions row per condition; one Events row per event, oldest first, as
 * kubectl orders them. Both object reads are redacted on the request, so a Secret's values and its last-applied
 * annotation never reach a row; an identity that may not list events sees one row that says so, the anonymous
 * sentence when the connection sends no credential. On the agent path the rows are written from the copies masked for
 * the machine (`machine-redaction.ts`), while the events are still selected by the real object. An agent read whose
 * events did not all fit the read is refused, never answered with only some of them.
 */
import { QueryError } from "@/lib/db/errors";
import { rowBudgetSentence } from "@/lib/db/providers/sql/read-only-budget";
import { ACCEPT_JSON, ACCEPT_TABLE } from "../client";
import type { IndexedResource } from "../discovery";
import { KubernetesRequestError } from "../errors";
import { KUBERNETES_EVENTS_READ_MAX, KUBERNETES_PAGE_SIZE, KUBERNETES_TYPE } from "../limits";
import { maskObjectForMachine, maskTableForMachine } from "../machine-redaction";
import { redactResponse } from "../redaction";
import { fieldSelectorValue } from "../request-policy";
import { cellOf, type KubeTable, parseTable, scanTable } from "../table";
import {
  ageOf,
  byCodeUnit,
  type KubectlContext,
  type KubectlGrid,
  machineRowLimit,
  namespaceFor,
  objectOf,
  redactionMode,
  resolveType,
  stringOf,
  textGrid,
} from "./context";
import { eventTime, type KubeEvent } from "./events";
import type { KubectlStatement } from "./parse";

type DescribeStatement = Extract<KubectlStatement, { readonly command: "describe" }>;

const FIELDS = ["SECTION", "FIELD", "VALUE"] as const;

const MACHINE_EVENTS_CAP_SENTENCE =
  "More than 5,000 events name this object, and an agent read is refused rather than answered with only some of them: read them with events --for TYPE/NAME --types=Warning.";

/** `key=value` rows of a string map, or one `<none>` row, as kubectl prints an empty map. */
function mapRows(section: string, field: string, value: unknown): unknown[][] {
  const map = objectOf(value) ?? {};
  const keys = Object.keys(map).sort(byCodeUnit);
  if (keys.length === 0) return [[section, field, "<none>"]];
  return keys.map((key) => [section, field, `${key}=${String(map[key])}`]);
}

/** The events of one object, oldest first; a refusal to list them is one row that says so. */
async function eventRows(
  context: KubectlContext,
  object: Readonly<Record<string, unknown>>,
  resource: IndexedResource,
  namespace: string | undefined,
): Promise<unknown[][]> {
  const events = (await context.surface.discovery.get()).resources.find(
    (entry) => entry.group === "" && entry.resource === "events",
  );
  if (events === undefined) return [["Events", "Events", "This server does not serve core events."]];
  const metadata = objectOf(object.metadata) ?? {};
  // kubectl's own selector for an object's events, its terms in its order; each value escaped.
  const terms: [string, unknown][] = [
    ["involvedObject.kind", resource.kind],
    ["involvedObject.name", metadata.name],
    ...(namespace === undefined ? [] : ([["involvedObject.namespace", namespace]] as [string, unknown][])),
    ["involvedObject.uid", metadata.uid],
  ];
  const fieldSelector = terms
    .filter(([, value]) => typeof value === "string" && value !== "")
    .map(([key, value]) => `${key}=${fieldSelectorValue(value as string)}`)
    .join(",");
  const read = async (page: { readonly continueToken?: string; readonly limit: number }): Promise<KubeTable> => {
    const body = await context.surface.client.json(
      {
        op: "list",
        target: events,
        ...(namespace === undefined ? {} : { namespace }),
        query: {
          limit: page.limit,
          fieldSelector,
          ...(page.continueToken === undefined ? {} : { continue: page.continueToken }),
        },
      },
      { ...context.call(), accept: ACCEPT_JSON },
    );
    return parseTable(redactResponse(events, body, redactionMode(context)));
  };
  let items: readonly KubeEvent[];
  let more = false;
  try {
    const scan = await scanTable(read, {
      offset: 0,
      // On the agent path the read stops one row past the budget, so the refusal costs 201 rows, not 5,000.
      limit: machineRowLimit(context, KUBERNETES_EVENTS_READ_MAX),
      pageSize: KUBERNETES_PAGE_SIZE,
    });
    items = scan.rows.map((row) => (row.object ?? {}) as KubeEvent);
    more = scan.more;
  } catch (error) {
    if (!(error instanceof KubernetesRequestError) || error.status !== 403) throw error;
    // The client's own sentence: it names the list and, for a connection that sends no credential, the anonymous request.
    return [["Events", "Events", error.message]];
  }
  // The editor is told the list is partial; the agent's answer must be whole, so its read is refused instead.
  if (more && context.machine !== undefined)
    throw new QueryError(
      items.length > context.machine.maxRows
        ? rowBudgetSentence(items.length, context.machine.maxRows)
        : MACHINE_EVENTS_CAP_SENTENCE,
      KUBERNETES_TYPE,
    );
  if (items.length === 0) return [["Events", "Events", "<none>"]];
  const sorted = [...items].sort((a, b) => eventTime(a) - eventTime(b));
  const rows = sorted.map((event) => {
    const source = objectOf(event.source) ?? {};
    const from = stringOf(event.reportingComponent) || stringOf(source.component) || "";
    const age = ageOf(context, event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp);
    return [
      "Events",
      `${stringOf(event.type) ?? ""} ${stringOf(event.reason) ?? ""}`.trim(),
      `${age} ago${from === "" ? "" : `, from ${from}`}: ${(stringOf(event.message) ?? "").trim()}`,
    ];
  });
  if (more)
    rows.push([
      "Events",
      "Events",
      "More than 5,000 events name this object; the first 5,000 the server listed are shown.",
    ]);
  return rows;
}

export async function describeObject(context: KubectlContext, statement: DescribeStatement): Promise<KubectlGrid> {
  const resource = await resolveType(context, statement.type);
  const namespace = namespaceFor(context, resource, statement);
  const where = { ...(namespace === undefined ? {} : { namespace }), name: statement.name };
  const tableBody = await context.surface.client.json(
    { op: "get", target: resource, ...where, includeObject: "None" },
    { ...context.call(), accept: ACCEPT_TABLE },
  );
  const table = parseTable(redactResponse(resource, tableBody, redactionMode(context)));
  const object =
    objectOf(
      redactResponse(
        resource,
        await context.surface.client.json({ op: "get", target: resource, ...where }, context.call()),
        redactionMode(context),
      ),
    ) ?? {};
  // Routing reads the body, the rows are written from the masked copy (R6): on the agent path the Summary cells and
  // the metadata and condition rows come from copies masked for the machine, while `eventRows` below keeps the real
  // object, so a Secret's events are still selected by its real name and uid.
  const shownTable = context.machine === undefined ? table : maskTableForMachine(resource, table);
  const shown = context.machine === undefined ? object : maskObjectForMachine(resource, object);
  const metadata = objectOf(shown.metadata) ?? {};
  const rows: unknown[][] = [];
  const [first] = shownTable.rows;
  for (const column of shownTable.columns) {
    const cell = first === undefined ? undefined : cellOf(shownTable, first, column.name);
    rows.push([
      "Summary",
      column.name,
      cell === undefined || cell === null ? "" : typeof cell === "string" ? cell : JSON.stringify(cell),
    ]);
  }
  if (namespace !== undefined) rows.push(["Summary", "Namespace", namespace]);
  rows.push(["Summary", "Created", stringOf(metadata.creationTimestamp) ?? "<unknown>"]);
  rows.push(...mapRows("Summary", "Label", metadata.labels));
  rows.push(...mapRows("Summary", "Annotation", metadata.annotations));
  const owners = Array.isArray(metadata.ownerReferences) ? metadata.ownerReferences : [];
  for (const owner of owners.map((entry) => objectOf(entry) ?? {})) {
    rows.push([
      "Summary",
      "Owner",
      `${String(owner.kind)}/${String(owner.name)}${owner.controller === true ? " (controller)" : ""}`,
    ]);
  }
  const finalizers = Array.isArray(metadata.finalizers) ? metadata.finalizers : [];
  for (const finalizer of finalizers) rows.push(["Summary", "Finalizer", String(finalizer)]);
  const status = objectOf(shown.status) ?? {};
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  for (const condition of conditions.map((entry) => objectOf(entry) ?? {})) {
    const reason = stringOf(condition.reason);
    const message = stringOf(condition.message);
    const detail = [reason, message].filter((part): part is string => part !== undefined && part !== "").join(": ");
    rows.push([
      "Conditions",
      String(condition.type),
      `${String(condition.status)}${detail === "" ? "" : ` (${detail})`}`,
    ]);
  }
  rows.push(...(await eventRows(context, object, resource, namespace)));
  return textGrid(FIELDS, rows);
}
