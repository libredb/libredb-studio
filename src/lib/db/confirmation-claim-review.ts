import type { DatabaseType } from "@/lib/types";

/**
 * Studio's review record of the claims a provider row makes that loosen the confirmation gate (E21-Q1).
 *
 * A loosening claim is a fact a row declares beside its provider that spares a statement the gate would otherwise ask
 * about:
 *
 * - `decides-alone`: a vocabulary row's `decidesAlone: true`, which makes the row's reader the gate's whole answer, so
 *   the SQL keyword test and the per-statement reading never run;
 * - `exempt-form`: one form of a grammar row's `confirmExemptForms`, a keyword sequence led by a shared dangerous
 *   keyword that does not ask on that dialect;
 * - `text-not-sql`: a grammar row's `readsSqlText: false`, which spares the ask about a run the SQL reader cannot
 *   read and the reading of each statement the text splits into.
 *
 * The gate counts a claim only where this record lists it. Any other claim is read as if the row had not made it, so
 * the gate asks wherever the SQL reading or the row's own vocabulary asks. An entry is added in the same change as the
 * claim, with the reviewer's reason, and `tests/unit/lib/db/confirmation-claim-review.test.ts` fails until it is, and
 * also fails on an entry whose claim no row makes.
 *
 * A claim is keyed by its kind, the connection type that makes it and, for an exempt form, the form's words, so the
 * record reviews the rows this repository ships; the provider's own identity is not part of the key yet. It reviews
 * flags only: a reviewed decides-alone row's reader is the shipped one, trusted as it is.
 *
 * A leaf: it imports nothing but a type, so the gate can read it in the browser.
 */

/** One claim a row makes that would spare a statement the gate asks about. */
export type ConfirmationClaim =
  | { readonly kind: "decides-alone"; readonly type: DatabaseType }
  | { readonly kind: "exempt-form"; readonly type: DatabaseType; readonly form: readonly string[] }
  | { readonly kind: "text-not-sql"; readonly type: DatabaseType };

/** A claim on the record, with the reason it holds. */
export interface ReviewedConfirmationClaim {
  readonly claim: ConfirmationClaim;
  /** One sentence: why the claim holds for the provider this repository ships, with the issue or spec section. */
  readonly reason: string;
}

/**
 * Every loosening claim the rows this repository ships make, each with its reason, written by hand and frozen to the
 * form's words, so no projection of the engine declarations can feed it (docs/providers/CONTRACT.md, clause M-52).
 */
export const CONFIRMATION_CLAIM_REVIEW: readonly ReviewedConfirmationClaim[] = Object.freeze([
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "etcd" }),
    reason:
      "The provider's guard.ts reads an etcdctl command with the parser the provider runs, so what asks and what runs are one parse (#1089, section 5.5).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "firestore" }),
    reason:
      "The console's guard reads a statement with the parser the provider runs and refuses every write method before anything is sent (spec 3.2).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "influxdb" }),
    reason:
      "The browser-safe InfluxQL policy the provider runs reads the text and refuses every write before anything is sent (InfluxDB spec 5.7).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "kafka" }),
    reason:
      "A Kafka read request is parsed as one read of one topic or refused before anything is sent, and its topic may carry any SQL keyword (#1088, section 2).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "kubernetes" }),
    reason:
      "The provider refuses every mutating kubectl command before any request, so a SQL keyword in an object name names nothing that runs (docs/providers/kubernetes.md, section 11).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "milvus" }),
    reason:
      "The provider's guard.ts reads a console request with the parser the provider runs, and a v1 request only reads (vector-family spec 5.7).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "modbus" }),
    reason:
      "The encoder builds four read function codes and the identification request and nothing else, so no console text can write (#1723).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "mqtt" }),
    reason: "The provider has no console and no code that can write to a broker (#1635).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "mtconnect" }),
    reason: "The console reads one request line from a closed table of nine routes, every one a GET (#1722).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "neo4j" }),
    reason:
      "The provider reads a Cypher statement with the graph lexer and refuses every write before sending it (Neo4j spec 5.5).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "netconf" }),
    reason:
      "The provider builds four read operations and a close, and no function in it can build an edit-config, a commit or a lock (#1724).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "opcua" }),
    reason: "The client seam names eight read services and none of them writes (#1677).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "oxia" }),
    reason:
      "The provider's guard.ts reads an oxia client command with the parser the provider runs, and v1 only reads (O10, C17).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "prometheus" }),
    reason:
      "A PromQL expression only ever reaches a query endpoint that cannot write, and a metric may be named like any SQL keyword (#1085, section 2).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "qdrant" }),
    reason:
      "The provider's guard.ts reads a console request with the parser the provider runs, and a v1 request only reads (vector-family spec 6.7).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "rabbitmq" }),
    reason: "A read request reads a stream's messages and nothing else (#1656).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "s3" }),
    reason:
      "The provider's guard reads a command with the parser the provider runs, v1 only reads, and the guard refuses every write command before anything is sent (docs/providers/s3.md, section 5.3).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "snmp" }),
    reason:
      "A read request names no verb, and the provider sends only read requests (docs/providers/snmp.md, section 5.3).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "sparkplug" }),
    reason: "The encoder has no function that writes a PUBLISH, so no console text can change a plant (#1720).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "decides-alone", type: "weaviate" }),
    reason:
      "The provider's guard.ts reads a console request with the parser the provider runs, and a v1 request only reads (#1566, spec 3.4).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "exempt-form", type: "snowflake", form: Object.freeze(["ALTER", "SESSION", "SET"]) }),
    reason:
      "Each Snowflake statement runs in its own session, so a session setting cannot outlive the statement that sets it (SF-030).",
  }),
  Object.freeze({
    claim: Object.freeze({
      kind: "exempt-form",
      type: "snowflake",
      form: Object.freeze(["ALTER", "SESSION", "UNSET"]),
    }),
    reason:
      "Each Snowflake statement runs in its own session, so a session setting cannot outlive the statement that unsets it (SF-030).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "etcd" }),
    reason:
      "An etcdctl command line is split by the shell's quoting rules and read by the provider's own parser (#1089).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "firestore" }),
    reason:
      "A Firestore console statement is read by the console's own guard with the parser the provider runs (spec 3.2).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "influxdb" }),
    reason:
      "An InfluxQL statement escapes with a backslash and is read by the provider's own lexer, which refuses every write (InfluxDB spec 5.7).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "kafka" }),
    reason: "A Kafka read request is one JSON object naming a topic, whose strings escape with a backslash (#1088).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "kubernetes" }),
    reason:
      "A kubectl subset statement is split by POSIX shell rules, so a SQL span reader would misread its quoting (docs/providers/kubernetes.md, section 5.1).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "milvus" }),
    reason:
      "A Milvus console request is a request line and one JSON body, parsed by the provider itself (vector-family spec 5.4).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "modbus" }),
    reason: "A Modbus read request is one JSON object against a register map, so no span of it is SQL (#1723).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "mongodb" }),
    reason:
      "A MongoDB command is a JSON document the provider parses, and it never reaches the SQL readers on the query path (#297).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "mqtt" }),
    reason: "The MQTT provider has no console and takes no statement text at all (#1635).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "mtconnect" }),
    reason: "An MTConnect request line is written in the agent's own URL grammar, so no span of it is SQL (#1722).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "neo4j" }),
    reason:
      "A Cypher statement escapes with a backslash and is read by the provider's graph lexer, which refuses every write (Neo4j spec 5.5).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "netconf" }),
    reason: "A NETCONF read request is one JSON object naming a datastore and a path, so no span of it is SQL (#1724).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "opcua" }),
    reason: "An OPC UA read request is one JSON object naming node ids, so no span of it is SQL (#1677).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "oxia" }),
    reason:
      "An oxia client read command is split by POSIX shell rules, so a SQL span reader would misread its quoting (O10).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "prometheus" }),
    reason:
      "A PromQL expression escapes with a backslash, and it only reaches a query endpoint that cannot write (#1085).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "qdrant" }),
    reason:
      "A Qdrant console request is a request line and one JSON body, parsed by the shared console parser (vector-family spec 6.4).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "rabbitmq" }),
    reason: "A RabbitMQ read request names a stream to read and nothing else (#1656).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "redis" }),
    reason:
      "A Redis command line is read by the provider's own command reader, and it never reaches the SQL readers on the query path (#297).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "s3" }),
    reason:
      "An S3 read command is split by POSIX shell rules, so a SQL span reader would misread its quoting (docs/providers/s3.md, section 5.9).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "snmp" }),
    reason:
      "An SNMP read request names objects to read and no verb, so no span of it is SQL (docs/providers/snmp.md, section 1.1).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "sparkplug" }),
    reason:
      "A Sparkplug read request is one JSON object naming a group, an edge node and a window, so no span of it is SQL (#1720).",
  }),
  Object.freeze({
    claim: Object.freeze({ kind: "text-not-sql", type: "weaviate" }),
    reason:
      "A Weaviate console request is a request line and one JSON body, parsed by the shared console parser (#1566, spec 5.1).",
  }),
]);

/** Whether two forms have the same words in the same order, each compared upper-cased as the gate reads them. */
function sameForm(listed: readonly string[], asked: readonly string[]): boolean {
  return (
    listed.length === asked.length && listed.every((word, index) => word.toUpperCase() === asked[index].toUpperCase())
  );
}

/** A claim the gate asks the record about: its type is absent where the statement has no connection. */
export interface ConfirmationClaimQuery {
  readonly kind: ConfirmationClaim["kind"];
  readonly type: DatabaseType | undefined;
  /** The form's words, for an exempt form. */
  readonly form?: readonly string[];
}

/** Whether the record lists this claim; a claim with no type, or an exempt form with no form, is never listed. */
export function isReviewedConfirmationClaim(asked: ConfirmationClaimQuery): boolean {
  return CONFIRMATION_CLAIM_REVIEW.some(({ claim }) => {
    if (claim.kind !== asked.kind || claim.type !== asked.type) return false;
    if (claim.kind !== "exempt-form") return true;
    return asked.form !== undefined && sameForm(claim.form, asked.form);
  });
}
