/**
 * The SNMP provider.
 *
 * HOW IT WAS REGISTERED. The class landed before its registration, and the order was measured on
 * 13 October 2026: a provider class compiles and typechecks with no `queryDialect`, no
 * `QueryError(..., "snmp")` and no member added to any shared union, while adding a type-id to the
 * shared records without a class and a factory case produced 27 type errors and three broken
 * factory tests, because the factory test walks every shipped type-id and builds it. The
 * registration has since landed: `snmp` is a member of `DatabaseType`, the factory
 * builds this class, and the capabilities declare `queryDialect: "snmp"`, registered in
 * `QUERY_DIALECTS`, so the editor gives this provider a tab type of its own rather than the one it
 * gives a provider that declares no dialect.
 *
 * WHAT IS WIRED. The client is this provider's own, not a library: `client.ts` and
 * `transport.ts` open one UDP socket with `node:dgram`, so nothing is added to `package.json`.
 * `connect`, `query`, `getOverview` and `getHealth` reach an agent through it, behind the valve
 * that lets only a Get, a GetNext or a GetBulk leave. The catalog surfaces (`listObjects`,
 * `describeObject`, `describeObjects`) send nothing at all: they answer from the bundled MIB
 * modules through `mib-tree.ts`, so they work before `connect` and cost the agent no request.
 *
 * `queryReadOnly` is the agent's: one command of the console's four, read by `agent-statement.ts` and refused before
 * anything is sent when it is not one of them or when it would walk a withheld security or target subtree, then sent
 * over an exchange opened for that read alone through the agent's client (`agent-client.ts`), which holds Get, GetNext
 * and GetBulk only, and answered by `agent-read.ts` with values rendered as the console renders them, refused past the
 * row, byte or time budget rather than cut. On a handle opened for any agent-mode profile the console is refused and
 * every reading the agent does not report answers its reason (`agent-surface.ts`). MCP read stays closed on this
 * engine.
 */
import { randomInt } from "node:crypto";
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  ActiveSessionDetails,
  Container,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KindCount,
  ProviderCapabilities,
  ObjectDetail,
  ObjectDetailBatch,
  PerformanceMetrics,
  ProviderExecutionContext,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
  ReadOnlyStatementBudget,
  ReadOnlyStatementMode,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import type { DatabaseConnection, QueryWarning } from "@/lib/types";
import { SNMP_LABELS, SNMP_NO_COUNT } from "./labels";
import { isWithinSubtree, SNMP_KINDS, type SnmpKind } from "./objects";
import { catalogObjects, describeCatalogObject } from "./mib-tree";
import { checkConnection, type SnmpConnectionInput } from "./connection-options";
import { openExchange, resolveTarget, type Exchange, type ResolvedTarget } from "./client";
import { describeEnd, firstRequest, resolveName, startWalk, stepWalk, type WalkState } from "./read";
import { renderValue } from "./values";
import { EXCEPTION_TAGS, syntaxFromTag, tableRows, toWalkVarbind } from "./rows";
import { DEFAULT_WALK_BUDGET, parseStatement, type Statement } from "./statement";
import { PDU_GET, PDU_GET_BULK, PDU_GET_NEXT } from "./valve";
import type { ResponseVarbind } from "./message";
import { allNotices } from "./mib";
import { failureFromStatus } from "./errors";
import { assertReadOnlyBudget } from "@/lib/db/providers/sql/read-only-budget";
import { createSnmpAgentClient } from "./agent-client";
import { runSnmpAgentRead, SNMP_AGENT_FAILURE_SENTENCES, SnmpAgentError, snmpAgentResult } from "./agent-read";
import { readSnmpAgentStatement } from "./agent-statement";
import { SNMP_AGENT_WITHHELD } from "./agent-surface";

/** Studio's own refusals on the agent's statement path, made before anything is sent. */
export const SNMP_PROVIDER_SENTENCES = Object.freeze({
  profileRequired: "Read-only execution requires a provider opened under the agent read-only profile",
  noEstimate: "SNMP composes no estimating plan for the agent",
});

/**
 * How long an exchange waits before it calls the agent silent, when nothing else is asked for.
 *
 * Five seconds rather than the sixty of `DEFAULT_QUERY_TIMEOUT`: over UDP there is no refusal to
 * read, so every one of the ordinary mistakes - a wrong community, an object outside the view, a
 * dropped datagram - arrives as silence, and the sentence the user needs is not worth a minute.
 */
const SILENCE_DEADLINE_MS = 5000;

/**
 * The health this provider reads: the shared shape, plus the three things an agent does report.
 *
 * The shared shape was written for a database and has no field for any of them, so they ride beside
 * it rather than inside a field that means something else. Every shared figure an agent has no notion
 * of is a sentence saying so, and `activeConnections` is left out, which is how the shared shape asks
 * a provider that cannot measure it to say so.
 */
export interface SnmpHealth extends HealthInfo {
  /** `sysUpTime.0` as rendered, in hundredths of a second, or why it is missing. */
  readonly uptime: string;
  /** `sysDescr.0` as rendered, or why it is missing. */
  readonly description: string;
  /** From sending the health read to its answer, measured here. */
  readonly roundTripMs: number;
}

/** Why the two shared figures are not numbers. One line each, for the coverage reason `runMaintenance` gives. */
const NO_DATABASE_SIZE = "An SNMP agent reports no database size: it serves managed objects, not stored data.";
const NO_CACHE_RATIO = "An SNMP agent reports no cache hit ratio: no standard object publishes one.";

/** RFC 3418: the two objects every agent answers about itself. */
const SYS_DESCR = [1, 3, 6, 1, 2, 1, 1, 1, 0] as const;
const SYS_UPTIME = [1, 3, 6, 1, 2, 1, 1, 3, 0] as const;

const PDU_TAGS: Readonly<Record<string, number>> = { get: PDU_GET, getNext: PDU_GET_NEXT, getBulk: PDU_GET_BULK };

/**
 * Request ids, from `node:crypto` rather than from a counter.
 *
 * An agent answers whatever asked, and over UDP anything on the path can answer too. A counter
 * that starts at one on every connection makes a guessable id, and a guessed id is an answer
 * this provider would match to a question it did not answer. The valve and the connected socket
 * both narrow that; this narrows it further and costs nothing.
 */
function nextRequestId(): number {
  return randomInt(1, 0x7fffffff);
}

/** The subtree a run is bounded by. A `get` and a `next` have none, and are not bounded. */
function subtreeOf(parsed: Statement): readonly number[] {
  // Resolved through the same function the request uses, never with a second rule. The empty array
  // this used to return for a written name is the WIDEST possible subtree, so a resolvable name
  // walked the entire agent silently.
  if (parsed.command === "walk") return resolveName(parsed.subtree);
  if (parsed.command === "table") return resolveName(parsed.table);
  return [];
}

/** The kind a caller named, or the sentence that lists the two this provider has. */
function requireKind(kind: string): SnmpKind {
  if (!(SNMP_KINDS as readonly string[]).includes(kind)) {
    throw new DatabaseConfigError(`\`${kind}\` is not a kind this provider has: it has ${SNMP_KINDS.join(" and ")}`);
  }
  return kind as SnmpKind;
}

export class SnmpProvider extends BaseDatabaseProvider {
  /**
   * Public, because the base's is protected and a provider is the thing that opens it. The
   * house does the same in every provider that has its own transport to inject.
   */
  public constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
  ) {
    super(config, options);
  }

  /**
   * Whether this handle was opened for the agent read-only profile by an acquisition that sends statements
   * (`sendsStatements`). Only then does `queryReadOnly` answer; the operations profile's acquisitions send no statement.
   */
  private get readOnlyProfile(): boolean {
    return this.execution.readOnly === true && this.execution.sendsStatements === true;
  }

  /**
   * Whether this handle was opened for any agent-mode profile: every execution profile opens `readOnly` and no editor
   * handle does. On such a handle the console is refused and every reading the agent does not report answers its reason.
   */
  private get agentProfile(): boolean {
    return this.execution.readOnly === true;
  }

  /** The refusal of a reading an agent-mode handle does not take, after the connection check every reading makes. */
  private agentWithheld(sentence: string, what: string): never {
    if (this.exchange === undefined) {
      throw new DatabaseConfigError(`This connection is not open: \`connect\` comes before ${what}.`);
    }
    throw new QueryError(sentence, "snmp");
  }

  public getLabels(): ProviderLabels {
    return SNMP_LABELS;
  }

  /**
   * Every member written out: the base class answers for SQL, and every one of those answers
   * would be wrong here. Each `false` is a claim this provider can defend.
   *
   * `queryDialect` names this provider's own grammar, registered in `QUERY_DIALECTS`. It is not
   * optional in practice: without it the registry answers with MongoDB's tab and MongoDB's
   * generator, which the golden file recorded before this line existed.
   */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // Not SQL and not this product's JSON: a statement here is `get 1.3.6.1.2.1.1.1.0`, a
      // small command grammar of this provider's own. `json` is the nearest of the five the
      // union allows, and the `queryDialect` below is what keeps that from being read as a
      // claim about the text.
      queryLanguage: "json",
      // Declared, and the measurement is why. With this absent the registry fell back to
      // MongoDB's tab and MongoDB's generator: the golden file recorded `tabType: "mongodb"` for
      // this provider, so a tree click would have opened a MongoDB editor on an SNMP agent.
      queryDialect: "snmp",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      // One request answers one request. A walk is bounded by the budget and by the agent's own
      // datagram size, not by a window a caller can advance.
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      // TRUE, and not as a way to turn a menu off. An SNMP table is not a stored thing: it is a
      // conceptual table RFC 2578 describes, assembled by walking columns that hang side by side
      // in the OID tree and grouping them by the index each instance carries. There is nothing to
      // count rows of without doing that walk, which is why the count menu must not be offered.
      tablesAreDerivedGroupings: true,
      // Structural rather than configured: the outgoing valve parses every datagram and refuses
      // any PDU that is not a Get, GetNext or GetBulk, so no code path here can build a write.
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      // No URI form. `snmp://` is not in `ENGINE_URI_SCHEMES`, and inventing one would be ours.
      supportsConnectionString: false,
      defaultPort: 161,
      statementTerminator: "none",
      // One connection is one agent, and an agent has no level above its objects. With no level
      // declared there is no path shape to declare either, which is why that member is absent
      // rather than set: the union has no value for "there are no containers".
      containerLevels: [],
      // Both kinds have columns: a table's are the columns its entry declares, and a group's are its
      // scalars. Both come from the bundled modules, so opening one in the tree sends nothing.
      objectKinds: SNMP_KINDS.map((kind) => ({
        id: kind,
        label: kind,
        labelPlural: kind,
        role: "relation" as const,
        hasColumns: true,
      })),
      // Nothing a read runs changes the tree.
      schemaRefreshPattern: "(?!)",
    };
  }

  /** Open while a connection is held. Undefined means nothing to close, which is not an error. */
  private exchange: Exchange | undefined;
  private target: ResolvedTarget | undefined;
  /**
   * What the connection check warned about without refusing, plus the notices the bundled MIB
   * modules carry. Shown ONCE, on the first result, and cleared: a notice repeated on every
   * read is a notice an operator stops reading.
   */
  private pendingNotices: string[] = [];

  /**
   * The connection record as this provider reads it.
   *
   * v2c only for now, and the reason is a fact rather than a preference: the shared connection
   * record carries a host, a port, a user and a password, and v3 needs a security level, a
   * privacy passphrase, a context name and an engine id pin, none of which exist on it until
   * the registration change adds the form. The v3 message layer is written and measured
   * against real net-snmp datagrams; what it lacks is somewhere for an operator to type.
   *
   * The community is read from the password field because that is what a community is: one
   * secret, no user beside it.
   */
  private connectionInput(): SnmpConnectionInput {
    return {
      host: this.config.host ?? "",
      port: this.config.port ?? 161,
      version: "v2c",
      community: this.config.password ?? "",
      allowInsecureAuth: this.config.allowInsecureAuth,
    };
  }

  public async connect(): Promise<void> {
    const input = this.connectionInput();
    // Checked before a socket exists. A refusal here is about the connection the operator
    // configured, so it must not arrive wearing the clothes of a failed read.
    const checked = checkConnection(input);
    this.pendingNotices = [...checked.cautions.map((caution) => caution.text), ...allNotices()];
    this.target = await resolveTarget(input.host, input.port);
    const exchange = await openExchange({
      target: this.target,
      community: input.community ?? "",
      // BOTH PLACES ARE READ, and reading one of them was a defect found on 15 October 2026.
      // This line used to read `this.config.queryTimeout` alone. The connection record does carry
      // that field, so the line worked for a provider built from a record that sets it - which is
      // what a unit test here does - and ignored `options.queryTimeout` entirely. Through the
      // factory nothing showed: it folds the record's value into the options before building
      // (`factory.ts`, `options.queryTimeout ?? connection.queryTimeout`). Built directly, which
      // is how every live check and integration case builds a provider, an asked-for deadline was
      // dropped and the default below was used instead.
      //
      // `this.queryTimeout` cannot stand in for either: the base has already resolved it to
      // `options.queryTimeout ?? 60_000`, so an unset option is indistinguishable from a minute,
      // and a minute is the wrong default here. Over UDP silence IS the ordinary failure - a
      // wrong community, an object outside the view, a dropped datagram - and someone who
      // mistyped a community should not wait a minute to be told nothing came back.
      deadlineMs: this.options.queryTimeout ?? this.config.queryTimeout ?? SILENCE_DEADLINE_MS,
    });

    // UDP HAS NO HANDSHAKE, so opening the socket proves nothing: it succeeded in 2 ms against a
    // loopback port with nothing behind it. A connection that reports success for a device that
    // is not there is worse than one that fails, because everything after it reads as an empty
    // device rather than as an absent one. So the connection is only open once the agent has
    // answered something.
    //
    // The sentence names BOTH possibilities on purpose. Over v2c a wrong community is answered
    // with silence, exactly like an absent agent, and this provider cannot tell them apart from
    // here. Claiming one of them would be inventing the half we did not measure.
    const probe = await exchange.send(PDU_GET, nextRequestId(), [SYS_UPTIME], undefined);
    if (!("varbinds" in probe)) {
      exchange.close();
      this.target = undefined;
      throw new DatabaseConfigError(
        `No SNMP agent answered at ${input.host}:${input.port}. ${probe.reason} ` +
          "Over SNMPv2c an agent that rejects the community answers exactly as one that is not there, " +
          "so this is either no agent at that address or the wrong community for it.",
      );
    }
    this.exchange = exchange;
  }

  public async disconnect(): Promise<void> {
    // A connection that was never opened has nothing to close, and saying so costs less than
    // pretending. One that was opened holds a socket, and the socket is the whole of it.
    this.exchange?.close();
    this.exchange = undefined;
    this.target = undefined;
  }

  /**
   * Runs one statement against the agent and returns its rows.
   *
   * THE STATEMENT IS PARSED BEFORE THE SOCKET IS TOUCHED. A user who typed something this
   * provider would never accept hears about THAT, not about a connection. It also means a
   * refused statement sends no datagram at all, which is the property the test asserts by
   * counting what the agent received.
   */
  public async query(statement: string): Promise<QueryResult> {
    const started = Date.now();
    const parsed = parseStatement(
      statement
        .trim()
        .split(/\s+/)
        .filter((word) => word !== ""),
    );
    const exchange = this.exchange;
    if (exchange === undefined) {
      throw new DatabaseConfigError("This connection is not open: `connect` comes before a statement.");
    }
    if (this.agentProfile) throw new RefusedBeforeSendError(SNMP_AGENT_WITHHELD.query, "snmp", statement);
    const { rows, note } = await this.run(exchange, parsed);
    // Field names come from the rows rather than from a fixed list: a table's columns are
    // whatever the agent had, and naming them here would mean naming them twice.
    const fields = rows.length === 0 ? ["object", "value", "type"] : Object.keys(rows[0]);
    // The connection's cautions and the MIB notices ride with the first result, because this
    // provider has nowhere else to put them: `DatabaseOverview` and `ProviderLabels` carry no
    // notice field, and `QueryResult.warnings` is the house's own surface for exactly this.
    const warnings: QueryWarning[] = [...this.pendingNotices, ...(note === undefined ? [] : [note])].map((message) => ({
      message,
      severity: "NOTICE",
    }));
    this.pendingNotices = [];
    return {
      rows: rows as Record<string, unknown>[],
      fields,
      rowCount: rows.length,
      executionTime: Date.now() - started,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  }

  /**
   * One agent statement. Only on a handle opened under the agent read-only profile; the statement is read by
   * `readSnmpAgentStatement` and refused before anything is sent when it is not one of the console's four commands or
   * when it would walk a withheld subtree. The read runs over an exchange opened for it alone, with the request's time
   * budget as every request's deadline and as the read's own, and closed when it ends, so nothing of one call reaches
   * the next; the console's pending notices are not touched. Its answer is refused past the row, byte or time budget
   * rather than cut, and a failure is worded by its category.
   */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    if (!this.readOnlyProfile)
      throw new RefusedBeforeSendError(SNMP_PROVIDER_SENTENCES.profileRequired, "snmp", statement);
    const target = this.target;
    if (target === undefined) {
      throw new DatabaseConfigError("This connection is not open: `connect` comes before a statement.");
    }
    assertReadOnlyBudget(budget, "snmp");
    if (mode !== "execute") throw new RefusedBeforeSendError(SNMP_PROVIDER_SENTENCES.noEstimate, "snmp", statement);
    const reading = readSnmpAgentStatement(statement, budget.maxResultRows);
    if (!reading.ok) throw new RefusedBeforeSendError(reading.message, "snmp", statement);
    const ms = budget.statementTimeoutMs;
    const exchange = await openExchange({ target, community: this.connectionInput().community ?? "", deadlineMs: ms });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SnmpAgentError(SNMP_AGENT_FAILURE_SENTENCES.silence(ms))), ms);
    });
    try {
      const answer = await Promise.race([
        runSnmpAgentRead(createSnmpAgentClient(exchange), reading.plan, budget),
        deadline,
      ]);
      return snmpAgentResult(answer, budget, Date.now() - started);
    } finally {
      clearTimeout(timer);
      exchange.close();
    }
  }

  /**
   * Drives one statement to its end: ask, read, decide whether to ask again.
   *
   * A `get` and a `next` are one exchange each. A `walk` keeps going while `stepWalk` says to,
   * and `stepWalk` owns every reason to stop: the end of the subtree, a budget, an OID that
   * did not move forward, or silence. None of those decisions is taken here, because a second
   * place that decides when a walk is over is a second place that can disagree.
   */
  private async run(
    exchange: Exchange,
    parsed: Statement,
  ): Promise<{ rows: Array<Record<string, string>>; note?: string }> {
    const rows: Array<Record<string, string>> = [];
    const collected: ResponseVarbind[] = [];
    const budget = parsed.command === "walk" ? parsed.budget : DEFAULT_WALK_BUDGET;
    const subtree = subtreeOf(parsed);
    let request = firstRequest(parsed);
    let state: WalkState = startWalk(Date.now());
    let note: string | undefined;

    for (;;) {
      // THE BULK PARAMETERS TRAVEL WITH THE REQUEST. They used to be dropped here: `firstRequest`
      // computed `maxRepetitions` and this call passed `undefined`, so every GetBulk went out with
      // max-repetitions zero and the agent answered with an empty varbind list - correctly, by
      // RFC 3416. MEASURED against a real net-snmp agent on 14 October 2026: `snmpbulkget -Cr0`
      // returns nothing from the same subtree that `-Cr10` returns sixteen objects from. Every
      // `walk` and every `table` therefore returned zero rows on a tree that was there.
      const bulk =
        request.maxRepetitions === undefined ? undefined : { nonRepeaters: 0, maxRepetitions: request.maxRepetitions };
      const answer = await exchange.send(PDU_TAGS[request.pdu], nextRequestId(), request.oids, bulk);
      if (!("varbinds" in answer)) {
        // A reading, not a throw: "the agent said no" and "nothing came back" are things the
        // caller decides about, and the sentence already says which one happened.
        return { rows, note: answer.reason };
      }
      // A GetBulk OVER-READS on purpose: it returns up to max-repetitions objects and the last of
      // them are past the subtree, because the agent does not know where the caller meant to stop.
      // `stepWalk` already refuses to count those, but the rows were being pushed before it ran, so
      // a sixteen-object subtree came back as fifty rows carrying a neighbour's objects. MEASURED
      // on 14 October 2026 against a real agent, the moment the max-repetitions defect above was
      // fixed: the walk's own note said sixteen while the grid held fifty. The walk and the table
      // therefore read the prefix that is inside the subtree; `get` and `next` have no subtree and
      // keep every varbind they were answered with.
      const walking = parsed.command === "walk" || parsed.command === "table";
      const scoped: ResponseVarbind[] = [];
      for (const varbind of answer.varbinds) {
        if (walking && !isWithinSubtree(subtree, varbind.oid)) break;
        scoped.push(varbind);
      }
      for (const varbind of scoped) {
        const exception = EXCEPTION_TAGS[varbind.tag];
        if (exception !== undefined) continue;
        const rendered = renderValue(syntaxFromTag(varbind.tag, varbind.value), varbind.value);
        rows.push({ object: varbind.oid.join("."), value: rendered.display, type: rendered.as });
      }
      if (parsed.command === "table") {
        // Collected as plain rows above; the shape comes after the walk, because a column is
        // only short once the walk has ended and `buildTable` is what decides what short means.
        collected.push(...scoped);
      }
      if (parsed.command !== "walk" && parsed.command !== "table") return { rows };

      const step = stepWalk(subtree, budget, state, answer.varbinds.map(toWalkVarbind), Date.now());
      state = step.state;
      if (step.kind === "stop") {
        note = describeEnd(step.end, state.rows);
        break;
      }
      request = step.request;
    }
    if (parsed.command === "table") return { rows: tableRows(subtree, collected), note };
    return { rows, note };
  }

  public async listContainers(): Promise<Container[]> {
    // One connection is one agent, and an agent has no level above its objects.
    return [];
  }

  public async countObjects(): Promise<Record<string, KindCount>> {
    // The number of objects each folder lists, from the bundled catalog. It counts definitions,
    // never instances on the agent, which are not counted: see SNMP_NO_COUNT. A refused count would
    // make the object tree draw the folder as a leaf that cannot be opened.
    return Object.fromEntries(SNMP_KINDS.map((kind) => [kind, { count: catalogObjects(kind).length }]));
  }

  /**
   * The bundled tree's objects of one kind, in agent order, with no request sent.
   *
   * A path is the descriptor alone: one connection is one agent, and an agent has no level above
   * its objects. A deprecated or obsolete table carries that status, the case a reader has
   * something to act on.
   */
  public async listObjects(_container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    return catalogObjects(requireKind(kind)).map((object) => ({
      path: [object.name],
      name: object.name,
      kind: object.kind,
      ...(object.status === undefined ? {} : { status: object.status }),
    }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return describeCatalogObject(path.at(-1) ?? "", requireKind(kind));
  }

  /** Every object of one kind, from the same tree: no round trip at all, let alone one per object. */
  public async describeObjects(
    _container: readonly string[],
    kind: string,
    limit?: number,
  ): Promise<ObjectDetailBatch> {
    const objects = catalogObjects(requireKind(kind));
    const taken = limit === undefined ? objects : objects.slice(0, limit);
    const details = taken.map((object) => describeCatalogObject(object.name, object.kind));
    return taken.length === objects.length
      ? { details }
      : { details, truncated: { limit: taken.length, reason: callerBoundTruncationReason(taken.length) } };
  }

  /**
   * One Get of `sysDescr.0` and `sysUpTime.0`, through the same exchange and valve as every read.
   *
   * An agent that does not answer fails the read: a health answer built from nothing would tell the
   * connection test and the fleet view that a silent device is fine. An agent that answers one of the
   * two with an exception has that exception named in place of the value.
   */
  public async getHealth(): Promise<SnmpHealth> {
    const exchange = this.exchange;
    if (exchange === undefined) {
      throw new DatabaseConfigError("This connection is not open: `connect` comes before a health read.");
    }
    const sent = Date.now();
    const answer = await exchange.send(PDU_GET, nextRequestId(), [SYS_DESCR, SYS_UPTIME], undefined);
    const roundTripMs = Date.now() - sent;
    if (!("varbinds" in answer)) throw new QueryError(`The agent did not answer the health read. ${answer.reason}`);
    // A non-zero error-status sends the request's own varbinds back with NULL values. Read as
    // values they would render as two empty strings, a healthy-looking nothing: the status is the answer.
    const refused = failureFromStatus(answer.errorStatus);
    if (refused !== undefined) throw new QueryError(`The agent refused the health read: ${refused.reason}`);
    const read = (oid: readonly number[], name: string): string => {
      const varbind = answer.varbinds.find((candidate) => candidate.oid.join(".") === oid.join("."));
      const exception = varbind === undefined ? "nothing" : EXCEPTION_TAGS[varbind.tag];
      if (varbind === undefined || exception !== undefined)
        return `unavailable: the agent answered ${exception} for ${name}`;
      return renderValue(syntaxFromTag(varbind.tag, varbind.value), varbind.value).display;
    };
    return {
      uptime: read(SYS_UPTIME, "sysUpTime.0"),
      description: read(SYS_DESCR, "sysDescr.0"),
      roundTripMs,
      databaseSize: NO_DATABASE_SIZE,
      cacheHitRatio: NO_CACHE_RATIO,
      slowQueries: [],
      activeSessions: [],
    };
  }

  public async runMaintenance(): Promise<never> {
    // Not "not implemented": maintenance is a write, and this provider has no code that writes.
    throw new DatabaseConfigError(
      // ONE LINE ON PURPOSE. Split over two with `+`, the second line is a record the coverage tool
      // never marks: the expression runs, the continuation is not counted, and no case can make it green.
      // oxlint-disable-next-line max-len -- see above: splitting this string hides a line from the coverage gate
      "This provider performs no maintenance. Maintenance would be a write, and this provider has no code that writes: its client sits behind a seam reaching GetRequest, GetNextRequest and GetBulkRequest and nothing else.",
    );
  }

  /**
   * The agent's own description and uptime, read from it.
   *
   * The table and index counts are the object tree's, from the bundled modules (one INDEX clause
   * per table), so the overview and the tree agree about the same connection. Every other figure
   * is `0` or a sentence, and that is not a placeholder: an agent is not a database server and
   * has no size and no connections of its own. The two values read are the two an agent really
   * does report about itself.
   */
  public async getOverview(): Promise<DatabaseOverview> {
    // On an agent-mode handle the zeros below would read as the agent's own figures; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(SNMP_AGENT_WITHHELD.overview, "an overview");
    const exchange = this.exchange;
    if (exchange === undefined) {
      throw new DatabaseConfigError("This connection is not open: `connect` comes before an overview.");
    }
    const answer = await exchange.send(PDU_GET, nextRequestId(), [SYS_DESCR, SYS_UPTIME], undefined);
    // An exception (noSuchObject and the rest) carries no value, so it is read as no answer rather
    // than rendered as an empty one.
    const read = (oid: readonly number[]) =>
      "varbinds" in answer
        ? answer.varbinds.find(
            (varbind) => varbind.oid.join(".") === oid.join(".") && EXCEPTION_TAGS[varbind.tag] === undefined,
          )
        : undefined;
    const descr = read(SYS_DESCR);
    const uptime = read(SYS_UPTIME);
    return {
      version:
        descr === undefined ? SNMP_NO_COUNT : renderValue(syntaxFromTag(descr.tag, descr.value), descr.value).display,
      uptime:
        uptime === undefined
          ? SNMP_NO_COUNT
          : renderValue(syntaxFromTag(uptime.tag, uptime.value), uptime.value).display,
      maxConnections: 0,
      databaseSize: SNMP_NO_COUNT,
      tableCount: catalogObjects("table").length,
      indexCount: catalogObjects("table").length,
    } as DatabaseOverview;
  }

  /**
   * The four below answer empty rather than refusing, because empty is the truth: an agent
   * publishes none of these. A refusal would say "ask later"; empty says "there is none".
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    // On an agent-mode handle an empty answer would read as the agent's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(SNMP_AGENT_WITHHELD.performance, "a reading");
    return {};
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    // On an agent-mode handle an empty answer would read as the agent's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(SNMP_AGENT_WITHHELD.slowQueries, "a reading");
    // An agent keeps no statement history: there is no statement, only a read of a name.
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    // On an agent-mode handle an empty answer would read as the agent's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(SNMP_AGENT_WITHHELD.sessions, "a reading");
    // UDP has no session to be active. Every message stands alone (RFC 3416 section 2.4).
    return [];
  }

  public async getTableStats(): Promise<TableStats[]> {
    // On an agent-mode handle an empty answer would read as the agent's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(SNMP_AGENT_WITHHELD.tableStats, "a reading");
    // A conceptual table is a shape the MIB declares, not a stored object with statistics.
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    // On an agent-mode handle an empty answer would read as the agent's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(SNMP_AGENT_WITHHELD.indexStats, "a reading");
    // An INDEX clause names a row's key; it is not an index with a size or a scan count.
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    // On an agent-mode handle an empty answer would read as the agent's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(SNMP_AGENT_WITHHELD.storage, "a reading");
    // An agent reports no storage of its own, and the device's storage is a MIB to read
    // rather than a property of this connection.
    return [];
  }
}
