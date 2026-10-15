/**
 * What the provider declares about itself.
 *
 * Every `supports*` is false and `enforcesReadOnly` is true, following the RabbitMQ provider, and
 * for the same reason stated the same way: read only whatever the connection's flag says, because
 * the client has one operation, a GET of a route from a closed table (MT-S1). No agent setting can
 * change that, which matters here more than it does for a database. MEASURED on the pinned agent:
 * with `AllowPut = true` the agent's own Swagger lists 39 operations instead of 15, among them a
 * PUT that sets an observation, and a POST that injected a Fault which `/current` then served like
 * any other observation.
 *
 * There is no `queryReadOnly`, so no agent statement execution and no MCP read query, which follows
 * the rule issue #424 sets for a provider whose text is not a query language.
 *
 * The type id is a member of the published `DatabaseType` union (`src/lib/types.ts`). It was a local
 * alias here while that line was queued behind six other issues, and the alias is gone: nothing in
 * this directory declares the id for itself any more.
 *
 * Browser-safe: no Node built-in, no server module.
 */
import type { ObjectKindSpec } from "@/lib/db/types";

/**
 * The default port, from the Institute's quickstart and cppagent's README, and MEASURED on the
 * pinned image, whose `ExposedPorts` is `5000/tcp`.
 */
export const MTCONNECT_DEFAULT_PORT = 5000;

/**
 * The dialect id the editor registers, declared as a JSON language with a dialect of its own,
 * following the provider that declares `kubectl` for a text that is not JSON.
 */
export const MTCONNECT_QUERY_DIALECT = "mtconnect";

/**
 * The tree holds one container level, the device.
 *
 * This is not a simplification of the model, it is the only thing the tree can express. The tree
 * models at most two container levels, and its own source comment records that no engine in the
 * repository declares three. MEASURED: the Institute's demo reaches three component levels
 * (`Mazak / Resources / Materials / Stock`, with a data item at the third), and a model with five
 * nested components is served by the agent without complaint, at XML element depth 15. So there is
 * no agent side ceiling to design against, and components are named into the data item's label
 * while the Keys panel walks the real hierarchy.
 */
export const MTCONNECT_CONTAINER_LEVEL = Object.freeze({
  /** One level: the device. The Agent device is a device here like any other. */
  depth: 1,
  label: "Device",
});

/**
 * The kinds under a device, and the surface each one is listed from.
 *
 * `enumeratedBy` is the field that decides this, and it is exclusive rather than additive. READ in
 * `src/lib/db/object-kinds.ts`: `enumerableKinds()` returns the declared kinds whose `enumeratedBy`
 * is undefined, and its own comment says a kind only the Keys panel enumerates "never gets a
 * folder, an inventory listing or a line of plan mode's prompt". `keyBrowserKind()` answers the
 * first kind declaring `enumeratedBy: "key-browser"`, and the census admits at most one, which must
 * carry `hasSource` and sit on capabilities that declare `keyScan`.
 *
 * So a kind is listed from the tree OR from the Keys panel, never from both. All three kinds below
 * are listed from the tree, and none declares `enumeratedBy`.
 *
 * The reason is measured rather than stylistic. Every provider that declares `keyScan` has a
 * keyspace with no bound, where a tree folder cannot list what a connection holds. It was SIX when
 * this was written and naming them froze the sentence: OPC UA landed afterwards, declared one, and
 * left the count behind. `capabilities.test.ts` counts the declarations from the built providers
 * instead, so the claim is measured on the day it is read rather than on the day it was typed. MTConnect's counts are bounded by the device model: MEASURED on the
 * Institute's demo, the three devices hold 20, 104 and 120 data items, and the issue's own 42 device
 * fixture holds at most 123 in one device. A folder lists a hundred rows without paging, so the
 * panel's paging buys nothing here.
 *
 * The tree takes the Prometheus naming pattern, and a Keys panel cannot sit beside it for the same
 * kind: the mechanism above makes the two exclusive per kind. If `dataitem` were
 * declared `enumeratedBy: "key-browser"` it would vanish from the tree, from the inventory and from
 * plan mode's grounding, which is the opposite of what the Prometheus pattern is for. What the Keys
 * panel would add, walking the component hierarchy deeper than the tree's two container levels, is
 * a separate question from how a data item is listed, and it needs its own kind and its own
 * decision. Until that decision exists, nothing here declares `keyScan` and nothing claims a Keys
 * panel surface.
 */
export const MTCONNECT_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  // A data item of category SAMPLE or EVENT. Its Source tab shows nothing: an observation is a
  // value and a timestamp, not a document, so `hasSource` is absent rather than false.
  // `relation`: it has rows and it is read from. The union is
  // relation | routine | group | attached | config, and an observation stream is rows.
  Object.freeze({
    id: "dataitem",
    role: "relation" as const,
    label: "Data item",
    labelPlural: "Data items",
    hasColumns: true,
  }),
  // A CONDITION data item. Separate from `dataitem` because its row carries four fields no other
  // observation has (`nativeCode`, `nativeSeverity`, `qualifier`, `conditionId`) and its state is
  // the element name rather than a value.
  Object.freeze({
    id: "condition",
    role: "relation" as const,
    label: "Condition",
    labelPlural: "Conditions",
    hasColumns: true,
  }),
  // An asset. This one does have a document: MEASURED on the demo, an asset arrives as an XML
  // element with its own children, and the issue requires it be shown as received, extension
  // elements included.
  // `config`: an asset is defined by its own XML document, which is what its Source tab shows.
  // RabbitMQ and MQTT use the same role for the same reason.
  Object.freeze({
    id: "asset",
    role: "config" as const,
    label: "Asset",
    labelPlural: "Assets",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "xml",
  }),
]);

/**
 * Whether this provider declares a Keys panel surface. It does not, for the reason above.
 *
 * Written as a named constant rather than as an absence so that a test can assert it, because an
 * absent declaration is exactly the failure this field causes: MEASURED in main, a kind listed from
 * the Keys panel without `enumeratedBy` produces a red Schema Error after connect while every unit
 * test stays green.
 */
export const MTCONNECT_DECLARES_KEY_SCAN = false;

/**
 * What the provider answers for the surfaces it does not implement.
 *
 * An agent publishes no query plan, no slow query log, no session list, no table statistics and no
 * storage figures, and inventing a number for any of them would be worse than an empty answer. The
 * one figure it does publish is in the Header of every answer, which is what `getHealth` reads.
 */
export const MTCONNECT_ABSENT_SURFACES = Object.freeze([
  "explain",
  "slowQueries",
  "activeSessions",
  "tableStats",
  "indexStats",
  "storageStats",
  "maintenance",
  "testDataGeneration",
  "inlineRowEdit",
  "resultPagination",
  "connectionString",
]);

/**
 * The health read.
 *
 * MEASURED on three generated models, 42, 200 and 500 devices: `GET /sample?count=1` answered 908
 * to 960 bytes in 2 to 4 ms in all three, so the health read does not grow with the model. It also
 * proves an MTConnect agent is answering, since its root element is `MTConnectStreams`, and it
 * carries a full Header. It is the one read every schema version from 1.3 to 2.8 answers: 1.4.0
 * refuses a negative `count`, and the Agent device and `deviceType` arrived only at schema 1.7 and
 * 2.3, so neither can be part of a version independent probe.
 */
export const MTCONNECT_HEALTH_REQUEST = "/sample?count=1";

/**
 * The read whose Header carries the BUFFER's sequence window, which is not the health read.
 *
 * A Header reports the window of the ANSWER rather than of the buffer wherever the request narrows
 * it, and three keys narrow it in three different ways. MEASURED on the pinned agent at schema
 * versions 1.3, 1.7 and 2.0, against the same buffer in each:
 *
 * - `count` POSITIVE, which the health read uses: `nextSequence` is the sequence after the FIRST
 *   returned observation. `/sample?count=1` answered `nextSequence="2"` at all three versions while
 *   the buffer's own next was 7955. `firstSequence` and `lastSequence` stayed the buffer's own.
 * - `count` NEGATIVE: `nextSequence` is one below the oldest returned observation, measured at 145
 *   where the buffer's next was 147.
 * - `to` given: `firstSequence` becomes the request's own `from` rather than the buffer's start.
 * - `/current`, with or without `path`: `nextSequence` is `lastSequence + 1`, the buffer's own, at
 *   all three versions. A `path` filter narrows the observations and not the window (measured at 927
 *   bytes against 4825 for the whole document), so a filter here is a size choice and not a
 *   correctness one; no filter is used, because a path that fits one device model does not fit
 *   another.
 *
 * Reading the window from the health read is what this provider shipped with, and it refused every
 * `at` and every `from` above 2, telling the reader the agent's next sequence number was 2 when the
 * agent itself answered the same request with 200. `/probe` cannot be the source either: MEASURED,
 * it carries no sequence attribute at all.
 */
export const MTCONNECT_WINDOW_REQUEST = "/current";

/**
 * Fields of `HealthInfo` an agent cannot answer are reported as unknown rather than as a number,
 * following the MQTT provider. MEASURED: the Header carries `instanceId`, `bufferSize`,
 * `firstSequence`, `lastSequence` and `nextSequence`, and nothing about connections, uptime or
 * storage. `activeConnections` is the one optional field, so it is omitted rather than guessed.
 */
export const MTCONNECT_HEALTH_UNKNOWN = "unknown";
