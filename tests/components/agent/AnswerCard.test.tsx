import "../../setup-dom";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AnswerCard, answerCardState } from "@/components/agent/AnswerCard";
import { applyStatementName } from "@/components/agent/rail-parts";
import { foldLedgerEntries } from "@/components/agent/timeline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import type { AgentInventoryNoun } from "@/lib/agent/inventory-noun";
import type { AgentLedgerEntry } from "@/lib/agent/run-store";
import type { AgentRunEvent } from "@/lib/agent/types";
import type { ProviderCapabilities } from "@/lib/db/types";

/**
 * The run's outcome, rendered once at the top of the rail.
 *
 * What these tests pin is the property that makes the card safe to add at all: it is a
 * SECOND rendering of entries the ledger already holds, so every claim on it has to be
 * traceable to one. They are therefore written over `foldLedgerEntries` rather than over
 * hand-built timeline objects — a hand-built one can say something no ledger produces,
 * which is exactly the failure mode the card is meant not to have.
 *
 * Three of them are correctness rather than presentation:
 *
 *  - **`Apply to editor` keeps the accessible name `applyStatementName` builds.** That
 *    name carries the guard's marks (WCAG 2.5.3), and the whole point of moving the
 *    control up here is that it must not lose them on the way.
 *  - **On an engine whose statements are not SQL there is no read-only chip.** Nothing
 *    read the statement, so a green chip would be a claim no code in this product made.
 *  - **A statement is never painted as SQL unless something says it is.** The tint
 *    follows `tab-language.ts`, and where no capabilities are to hand it follows the
 *    guard's own reach rather than defaulting to SQL.
 */

afterEach(cleanup);

const FENCE = "```";

const ACTOR = { sessionId: "ada", role: "user" } as const;

const opened = (mode: "planning" | "agent"): AgentLedgerEntry => ({
  kind: "run-opened",
  atMs: 1_000,
  runId: "arun_1",
  mode,
  actor: ACTOR,
  connectionId: "seed:sales",
  objective: "why is checkout slow",
});

const event = (value: AgentRunEvent): AgentLedgerEntry => ({ kind: "event", event: value });

const started = (mode: "planning" | "agent") => event({ kind: "run-started", atMs: 1_001, mode });

/**
 * A capture entry, in the word the ENGINE itself used for its rows.
 *
 * Parameterised because the card's two grounding chips are read off THIS entry: the
 * count, the noun and the fingerprint a run recorded are the only place those claims
 * come from, so a test that wants a different one writes a different capture rather
 * than handing the card a figure no ledger produced.
 */
const capturedAs = (options: {
  readonly fingerprint: string;
  readonly tableCount: number;
  readonly noun?: AgentInventoryNoun;
}): AgentLedgerEntry =>
  event({
    kind: "context-captured",
    atMs: 1_002,
    fingerprint: options.fingerprint,
    tableCount: options.tableCount,
    ...(options.noun === undefined ? {} : { noun: options.noun }),
  });

const captured = capturedAs({ fingerprint: "ctx_7dfa9911", tableCount: 2 });

const closing = (text: string) => event({ kind: "closing-statement", atMs: 1_010, text });

const finished = (status: "succeeded" | "failed" | "cancelled", reason?: "model-unavailable") =>
  event({ kind: "run-finished", atMs: 1_020, status, ...(reason === undefined ? {} : { reason }) });

const STATEMENT = "SELECT count(*) FROM orders";

const capabilitiesFor = (queryLanguage: "sql" | "json", queryDialect?: "libredb" | "redis"): ProviderCapabilities => ({
  queryLanguage,
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: false,
  defaultPort: null,
  schemaRefreshPattern: "",
  ...(queryDialect === undefined ? {} : { queryDialect }),
});

/** A plan run that drafted a statement, with the guard's verdict the caller names. */
function planTimeline(options: {
  readonly sql?: string;
  readonly readOnly: boolean;
  readonly guardApplicable?: boolean;
  readonly guardViolation?: "NON_READ_STATEMENT" | "MULTIPLE_STATEMENTS";
  readonly identifiers: Parameters<typeof draftEvent>[0]["identifiers"];
  readonly prose?: string;
  /** The run's grounding: another capture entry, or `null` for a run that captured nothing. */
  readonly capture?: AgentLedgerEntry | null;
}) {
  return foldLedgerEntries([
    opened("planning"),
    started("planning"),
    ...(options.capture === null ? [] : [options.capture ?? captured]),
    closing(options.prose ?? `Here is the read:\n${FENCE}sql\n${options.sql ?? STATEMENT}\n${FENCE}`),
    draftEvent(options),
    finished("succeeded"),
  ]);
}

function draftEvent(options: {
  readonly sql?: string;
  readonly readOnly: boolean;
  readonly guardApplicable?: boolean;
  readonly guardViolation?: "NON_READ_STATEMENT" | "MULTIPLE_STATEMENTS";
  readonly identifiers:
    | { readonly kind: "checked"; readonly unknownTables: readonly string[] }
    | { readonly kind: "no-inventory" }
    | { readonly kind: "not-applicable" };
}): AgentLedgerEntry {
  return event({
    kind: "plan-statement-drafted",
    atMs: 1_011,
    sql: options.sql ?? STATEMENT,
    dialect: "postgres",
    readOnly: options.readOnly,
    ...(options.guardApplicable === undefined ? {} : { guardApplicable: options.guardApplicable }),
    ...(options.guardViolation === undefined ? {} : { guardViolation: options.guardViolation }),
    identifiers: options.identifiers,
  });
}

/** What a correlation id looks like in a real run, read off the browser on 2026-08-21. */
const LONG_ID = "722b2a10-e3f2-4b9c-8177-367359a21500";

const ARTIFACT = {
  correlationId: "corr_9",
  runId: "arun_1",
  operationId: "sql.select.rows",
  summary: { rowCount: 1, columnNames: ["total"], elapsedMs: 12, truncated: false },
} as const;

/** An agent run that read once, answered from that read and reported one claim. */
function reportTimeline(
  options: {
    readonly cites?: string;
    readonly withAnswer?: boolean;
    readonly failed?: boolean;
    /** The correlation id the run's read was stored under. A real one is a UUID. */
    readonly correlationId?: string;
  } = {},
) {
  const artifact = { ...ARTIFACT, correlationId: options.correlationId ?? ARTIFACT.correlationId };
  const cites = options.cites ?? artifact.correlationId;
  return foldLedgerEntries([
    opened("agent"),
    started("agent"),
    captured,
    event({ kind: "statement-drafted", atMs: 1_003, stepId: "s1", sql: STATEMENT, rationale: "count the orders" }),
    event({ kind: "tool-completed", atMs: 1_004, stepId: "s1", artifact }),
    ...(options.withAnswer === false
      ? []
      : [
          event({
            kind: "answer-composed",
            atMs: 1_005,
            sql: STATEMENT,
            artifact,
            presentation: { kind: "table" },
            handover: "none",
          }),
        ]),
    event({
      kind: "report-composed",
      atMs: 1_006,
      claims: [
        {
          claim: "Checkout writes 1 order per session.",
          evidence: [{ source: "artifact", correlationId: cites, locator: "row 1" }],
        },
      ],
    }),
    options.failed === true ? finished("failed", "model-unavailable") : finished("succeeded"),
  ]);
}

describe("AnswerCard — nothing to show", () => {
  test("renders nothing before a run has recorded anything", () => {
    const { queryByTestId } = render(<AnswerCard timeline={foldLedgerEntries([])} />);
    expect(queryByTestId("agent-answer")).toBeNull();
  });

  test("renders nothing for a finished run whose ledger holds no answer, refusal or report", () => {
    const timeline = foldLedgerEntries([opened("agent"), started("agent"), captured, finished("cancelled")]);
    const { queryByTestId } = render(<AnswerCard timeline={timeline} />);
    expect(queryByTestId("agent-answer")).toBeNull();
  });
});

describe("AnswerCard — a plan run's statement", () => {
  const checkedTimeline = () => planTimeline({ readOnly: true, identifiers: { kind: "checked", unknownTables: [] } });

  test("renders the drafted statement, its status and the guard's own reading", () => {
    const { getByTestId } = render(<AnswerCard timeline={checkedTimeline()} capabilities={capabilitiesFor("sql")} />);

    expect(getByTestId("agent-answer-plan")).toBeTruthy();
    expect(getByTestId("agent-answer-status").textContent).toBe("succeeded");
    expect(getByTestId("agent-answer-statement").textContent).toContain(STATEMENT);
    expect(getByTestId("agent-answer-guard").textContent).toBe(
      "Checked as a bounded read against the captured inventory. Nothing was executed.",
    );
    // The clipboard control every verbatim block in this rail carries.
    expect(getByTestId("agent-answer-statement-copy")).toBeTruthy();
  });

  test("tints the block by the engine's language, and never paints a Mongo body as SQL", () => {
    const sqlCard = render(<AnswerCard timeline={checkedTimeline()} capabilities={capabilitiesFor("sql")} />);
    expect(sqlCard.getByTestId("agent-answer-statement").getAttribute("data-language")).toBe("sql");
    cleanup();

    const mongo = render(<AnswerCard timeline={checkedTimeline()} capabilities={capabilitiesFor("json")} />);
    expect(mongo.getByTestId("agent-answer-statement").getAttribute("data-language")).toBe("json");
    cleanup();

    const redis = render(<AnswerCard timeline={checkedTimeline()} capabilities={capabilitiesFor("json", "redis")} />);
    expect(redis.getByTestId("agent-answer-statement").getAttribute("data-language")).toBe("redis");
    cleanup();

    const libredb = render(
      <AnswerCard timeline={checkedTimeline()} capabilities={capabilitiesFor("json", "libredb")} />,
    );
    expect(libredb.getByTestId("agent-answer-statement").getAttribute("data-language")).toBe("libredb");
  });

  test("with no capabilities to hand, the guard's reach decides the language rather than a default of SQL", () => {
    const read = render(<AnswerCard timeline={checkedTimeline()} />);
    expect(read.getByTestId("agent-answer-statement").getAttribute("data-language")).toBe("sql");
    cleanup();

    const unexamined = render(
      <AnswerCard
        timeline={planTimeline({ readOnly: false, guardApplicable: false, identifiers: { kind: "not-applicable" } })}
        capabilities={null}
      />,
    );
    expect(unexamined.getByTestId("agent-answer-statement").getAttribute("data-language")).toBe("unknown");
  });

  test("keeps the accessible name the guard's marks travel in", () => {
    const timeline = planTimeline({
      readOnly: false,
      guardViolation: "MULTIPLE_STATEMENTS",
      identifiers: { kind: "checked", unknownTables: ["shipments"] },
    });
    const draft = timeline.items.find((item) => item.planStatement !== undefined)?.planStatement;
    expect(draft).toBeTruthy();

    const { getByTestId } = render(<AnswerCard timeline={timeline} onApplyStatement={() => {}} />);
    const apply = getByTestId("agent-answer-plan-apply");
    // The name the rail already builds, not a label written again here.
    expect(apply.getAttribute("aria-label")).toBe(applyStatementName(draft!));
    expect(apply.getAttribute("aria-label")).toContain("Apply to editor.");
    expect(apply.getAttribute("aria-label")).toContain("MULTIPLE_STATEMENTS");
  });

  test("applies the statement the ledger recorded, and only when the host can take it", () => {
    const applied: string[] = [];
    const { getByTestId } = render(
      <AnswerCard timeline={checkedTimeline()} onApplyStatement={(sql) => applied.push(sql)} />,
    );
    fireEvent.click(getByTestId("agent-answer-plan-apply"));
    expect(applied).toEqual([STATEMENT]);
    cleanup();

    const hostless = render(<AnswerCard timeline={checkedTimeline()} />);
    expect(hostless.queryByTestId("agent-answer-plan-apply")).toBeNull();
    // The statement is still readable and still copyable without an editor to take it.
    expect(hostless.getByTestId("agent-answer-statement-copy")).toBeTruthy();
  });

  test("chips read the guard, the names, the inventory and the fingerprint off the ledger", () => {
    const timeline = planTimeline({
      readOnly: true,
      identifiers: { kind: "checked", unknownTables: ["shipments"] },
    });
    const { getByTestId, getAllByTestId } = render(<AnswerCard timeline={timeline} />);

    expect(getByTestId("agent-answer-chip-guard").textContent).toBe("Read-only");
    expect(getAllByTestId("agent-answer-chip-name").map((chip) => chip.textContent)).toEqual(["shipments"]);
    expect(getByTestId("agent-answer-chip-inventory").textContent).toBe("2 tables read");
    expect(getByTestId("agent-answer-chip-fingerprint").textContent).toBe("ctx_7dfa");
  });

  test("counts the inventory in the engine's own word, and in the singular when there is one", () => {
    const { getByTestId } = render(
      <AnswerCard
        timeline={planTimeline({
          readOnly: true,
          identifiers: { kind: "checked", unknownTables: [] },
          capture: capturedAs({
            fingerprint: "ctx_druid001",
            tableCount: 1,
            noun: { singular: "datasource", plural: "datasources" },
          }),
        })}
      />,
    );
    expect(getByTestId("agent-answer-chip-inventory").textContent).toBe("1 datasource read");
  });

  test("says nothing about an inventory for a run whose ledger holds no capture", () => {
    const { queryByTestId } = render(
      <AnswerCard
        timeline={planTimeline({
          readOnly: true,
          identifiers: { kind: "checked", unknownTables: [] },
          capture: null,
        })}
      />,
    );
    expect(queryByTestId("agent-answer-chip-inventory")).toBeNull();
    expect(queryByTestId("agent-answer-chip-fingerprint")).toBeNull();
    expect(queryByTestId("agent-answer-chip-name")).toBeNull();
  });

  /*
    L4, measured in Chrome on 2026-08-21 against live MongoDB: the plan answer carried
    the amber `not checked` chip and NOTHING else, although that run had captured 5
    collections under fingerprint `ctx_ae00` and the chrome fold said so on the same
    screen. Backwards, and exactly where it costs most — where the guard examined
    nothing, the inventory is the only grounding claim the card has left.

    So both chips are read off the run's CAPTURE, which is a fact about what the run
    grounded itself on and has nothing to do with what the SQL guard could make of the
    draft. The capture is taken off the timeline the card is already handed rather than
    from a second prop beside it: a claim a caller can forget to pass is a claim that
    disappears, which is what happened here.
  */
  test("the inventory and the fingerprint are the capture's, on an engine the guard could not read", () => {
    const timeline = planTimeline({
      sql: "db.orders.find().sort({ placedAt: -1 }).limit(5)",
      readOnly: false,
      guardApplicable: false,
      identifiers: { kind: "not-applicable" },
      capture: capturedAs({
        fingerprint: "ctx_ae001f22",
        tableCount: 5,
        noun: { singular: "collection", plural: "collections" },
      }),
    });
    const { getByTestId } = render(<AnswerCard timeline={timeline} capabilities={capabilitiesFor("json")} />);

    // The guard's reading is unchanged: nothing examined this draft, and no chip says
    // it did.
    expect(getByTestId("agent-answer-chip-guard").textContent).toBe("not checked");
    // And the grounding is still stated, in the engine's own noun.
    expect(getByTestId("agent-answer-chip-inventory").textContent).toBe("5 collections read");
    expect(getByTestId("agent-answer-chip-fingerprint").textContent).toBe("ctx_ae00");
  });

  test("folds the model's own rationale away, and offers it whole", () => {
    const { getByTestId } = render(
      <AnswerCard timeline={planTimeline({ readOnly: true, identifiers: { kind: "checked", unknownTables: [] } })} />,
    );
    const why = getByTestId("agent-answer-why");
    expect(why.tagName).toBe("DETAILS");
    expect((why as HTMLDetailsElement).open).toBe(false);
    expect(getByTestId("agent-answer-why-prose").textContent).toContain("Here is the read:");
    expect(getByTestId("agent-answer-why-copy")).toBeTruthy();
  });

  /*
    L5, measured in Chrome on 2026-08-21 against live MongoDB: the card showed
    `db.orders.find()…`, its own `Copy`, `Apply to editor`, the `not checked` chip — and
    then, inside `Why this statement`, the SAME statement again with a second `Copy`.

    The rationale IS the prose the statement was read out of, so the statement is in it;
    the card displays that statement verbatim two lines above the fold. The words are
    unchanged and only the second copy of that ONE block is not printed. `Copy all`
    still carries the whole prose, which is the string the model wrote rather than this
    rendering of it.
  */
  test("does not print the statement again inside the fold that explains it", () => {
    const { getByTestId, queryByTestId } = render(
      <AnswerCard timeline={planTimeline({ readOnly: true, identifiers: { kind: "checked", unknownTables: [] } })} />,
    );

    const why = getByTestId("agent-answer-why-prose");
    expect(why.textContent).not.toContain(STATEMENT);
    expect(why.querySelector("pre")).toBeNull();
    // The block's own clipboard goes with the block. Nothing is lost: the statement is
    // displayed above with `agent-answer-statement-copy`, and `Copy all` holds the prose
    // exactly as the model wrote it, fence and all.
    expect(queryByTestId("prose-code-copy")).toBeNull();
    expect(getByTestId("agent-answer-statement-copy")).toBeTruthy();
    expect(why.textContent).toContain("Here is the read:");
  });

  test("copies the whole rationale, including the block it did not print", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
    const prose = `Here is the read:\n${FENCE}sql\n${STATEMENT}\n${FENCE}`;
    const { getByTestId } = render(
      <AnswerCard
        timeline={planTimeline({ readOnly: true, identifiers: { kind: "checked", unknownTables: [] }, prose })}
      />,
    );

    fireEvent.click(getByTestId("agent-answer-why-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(prose));
  });

  test("offers no rationale for a run whose ledger holds no closing prose", () => {
    const timeline = foldLedgerEntries([
      opened("planning"),
      started("planning"),
      draftEvent({ readOnly: true, identifiers: { kind: "checked", unknownTables: [] } }),
      finished("succeeded"),
    ]);
    const { queryByTestId } = render(<AnswerCard timeline={timeline} />);
    expect(queryByTestId("agent-answer-plan")).toBeTruthy();
    expect(queryByTestId("agent-answer-why")).toBeNull();
  });
});

describe("AnswerCard — what the guard did, and did not, examine", () => {
  test("an engine whose statements are not SQL gets the amber reading and NO read-only chip", () => {
    const timeline = planTimeline({
      readOnly: false,
      guardApplicable: false,
      identifiers: { kind: "not-applicable" },
    });
    const { getByTestId, queryAllByText } = render(
      <AnswerCard timeline={timeline} capabilities={capabilitiesFor("json")} onApplyStatement={() => {}} />,
    );

    expect(getByTestId("agent-answer-guard").textContent).toBe(
      "Not examined: the statement guard reads SQL, and this engine's statements are not SQL.",
    );
    expect(getByTestId("agent-answer-chip-guard").textContent).toBe("not checked");
    // The claim nothing in this product made: no code read this draft, so no chip says
    // it was read.
    expect(queryAllByText("Read-only")).toEqual([]);

    // Both existing sentences, verbatim, plus the caveat about what an inventory is —
    // each in the node whose test id it has carried since before the redesign, because
    // a shared blob cannot distinguish the right sentence for this state from any
    // sentence that happens to contain the phrase.
    expect(getByTestId("agent-plan-statement-guard-unread").textContent).toBe(
      "The statement guard reads SQL, and this engine's statements are not SQL — so nothing examined this draft. It is drafted, not run — nothing has happened to your data — but nothing here has established anything about it, for or against.",
    );
    expect(getByTestId("agent-plan-statement-unread").textContent).toBe(
      "The names in this statement were not checked: the check that would do it reads SQL, and this engine's statements are not SQL.",
    );
    expect(getByTestId("agent-plan-statement-caveat").textContent).toBe(
      "The run executed nothing. What was checked is what this run read of the schema, which records what exists rather than what your role is permitted to read.",
    );
    // And the claims are inside the popover that names them, not loose on the card.
    expect(getByTestId("agent-answer-guard-note").textContent).toContain("nothing examined this draft");
  });

  test("an objection is stated in full where it can be read, not folded into the popover", () => {
    const timeline = planTimeline({
      readOnly: false,
      guardViolation: "NON_READ_STATEMENT",
      identifiers: { kind: "checked", unknownTables: [] },
    });
    const { getByTestId } = render(<AnswerCard timeline={timeline} />);

    const guard = getByTestId("agent-answer-guard").textContent ?? "";
    expect(guard).toContain("The statement guard did not read this as a bounded read (NON_READ_STATEMENT).");
    expect(guard).toContain("nothing here establishes that running it would only read");
    expect(getByTestId("agent-answer-chip-guard").textContent).toBe("not classified as a read");
  });

  test("a guard that objected with no recorded reason still says so", () => {
    const timeline = planTimeline({ readOnly: false, identifiers: { kind: "checked", unknownTables: [] } });
    const { getByTestId } = render(<AnswerCard timeline={timeline} />);
    expect(getByTestId("agent-answer-guard").textContent).toContain("(no reason recorded)");
  });

  test("a run with no inventory says that, rather than that the names were unreadable", () => {
    const timeline = planTimeline({ readOnly: true, identifiers: { kind: "no-inventory" } });
    const { getByTestId, queryByTestId } = render(<AnswerCard timeline={timeline} />);
    expect(getByTestId("agent-plan-statement-unchecked").textContent).toBe(
      "No schema inventory was read for this run, so the names in this statement were not checked against anything.",
    );
    expect(queryByTestId("agent-plan-statement-unread")).toBeNull();
  });

  /*
    The guard read this draft and was satisfied by it, and no inventory was captured. The
    visible line must therefore not claim the inventory clause: the popover directly
    behind it says no inventory was read, and a line asserting a check "against the
    captured inventory" contradicts its own qualifier. The pre-redesign card made no
    positive claim here at all, so the clause is a new assertion and it goes where an
    inventory was actually read.
  */
  test("a checked statement with no inventory to check against drops the inventory clause", () => {
    const { getByTestId } = render(
      <AnswerCard timeline={planTimeline({ readOnly: true, identifiers: { kind: "no-inventory" } })} />,
    );
    expect(getByTestId("agent-answer-guard").textContent).toBe("Checked as a bounded read. Nothing was executed.");
    expect(getByTestId("agent-answer-guard").textContent).not.toContain("inventory");
  });

  test("a checked statement whose names were checked keeps the inventory clause", () => {
    const { getByTestId } = render(
      <AnswerCard timeline={planTimeline({ readOnly: true, identifiers: { kind: "checked", unknownTables: [] } })} />,
    );
    expect(getByTestId("agent-answer-guard").textContent).toBe(
      "Checked as a bounded read against the captured inventory. Nothing was executed.",
    );
  });

  test("names the inventory does not hold are said to be exactly that", () => {
    const timeline = planTimeline({
      readOnly: true,
      identifiers: { kind: "checked", unknownTables: ["shipments"] },
    });
    const { getByTestId } = render(<AnswerCard timeline={timeline} />);
    expect(getByTestId("agent-plan-statement-unknown").textContent).toBe(
      "These names are not in the inventory this run read, so the statement may not run as written:",
    );
  });

  test("the popover is a keyboard-reachable button, and its text is readable either way", () => {
    const timeline = planTimeline({ readOnly: true, identifiers: { kind: "checked", unknownTables: [] } });
    const { getByTestId } = render(<AnswerCard timeline={timeline} />);
    const info = getByTestId("agent-answer-guard-note-info");
    const body = getByTestId("agent-answer-guard-note");

    expect(info.tagName).toBe("BUTTON");
    expect(info.getAttribute("type")).toBe("button");
    expect(info.getAttribute("aria-label")).toBe("What the statement guard checked");
    expect(info.getAttribute("aria-expanded")).toBe("false");
    expect(info.getAttribute("aria-controls")).toBe(body.getAttribute("id"));
    // Closed is visually hidden and NOT absent: the claim stays in the accessibility
    // tree whether or not anyone opened the popover.
    expect(body.className).toContain("sr-only");

    fireEvent.click(info);
    expect(info.getAttribute("aria-expanded")).toBe("true");
    expect(getByTestId("agent-answer-guard-note").className).not.toContain("sr-only");

    fireEvent.click(info);
    expect(info.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("AnswerCard — an agent run's report", () => {
  test("quotes the model's claim and names what it cites", () => {
    const { getByTestId, getAllByTestId } = render(<AnswerCard timeline={reportTimeline()} />);

    expect(getByTestId("agent-answer-report")).toBeTruthy();
    expect(getByTestId("agent-answer-claim").textContent).toContain("Checkout writes 1 order per session.");
    expect(getByTestId("agent-answer-claim-copy")).toBeTruthy();
    const chips = getAllByTestId("agent-answer-citation-chip").map((chip) => chip.textContent ?? "");
    expect(chips[0]).toContain("Artifact corr_9");
    expect(chips[0]).toContain("row 1");
  });

  /*
    L8, measured in Chrome on 2026-08-21: the chip read
    `Artifact 722b2a10-e3f2-4b9c-8177-367359a21500` — a 36-character identifier filling
    a 384px panel, with no room left for the one thing the ledger actually knows about
    that read. A correlation id IS a UUID in a real run; `corr_9` is a fixture.

    So the chip carries the identifier at the length this rail prints an identifier at
    everywhere else — eight characters, which is the length the schema-snapshot label
    was already written at in the same function — followed by the ledger's own detail.
    The full identifier is in the `Evidence` fold, which is where a reader chasing a
    correlation id through a server log goes.
  */
  test("a citation chip names the read at chip length, with the ledger's own detail", () => {
    const { getByTestId } = render(<AnswerCard timeline={reportTimeline({ correlationId: LONG_ID })} />);

    const chip = getByTestId("agent-answer-citation-chip");
    expect(chip.textContent).toContain("Artifact 722b2a10");
    expect(chip.textContent).not.toContain(LONG_ID);
    // The ledger's own words about what that read returned, and the model's locator.
    expect(getByTestId("agent-answer-citation-chip-detail").textContent).toContain("1 row via sql.select.rows");
    expect(chip.textContent).toContain("row 1");
    // Nothing is lost: the identifier that identifies the read is in the fold, whole.
    expect(getByTestId("agent-answer-evidence-citation").textContent).toContain(LONG_ID);
  });

  test("offers the answer's own statement and result exactly as the ledger holds them", () => {
    const applied: string[] = [];
    const shown: string[] = [];
    const { getByTestId } = render(
      <AnswerCard
        timeline={reportTimeline()}
        onApplyStatement={(sql) => applied.push(sql)}
        onShowArtifact={(correlationId) => shown.push(correlationId)}
      />,
    );

    fireEvent.click(getByTestId("agent-answer-apply-statement"));
    fireEvent.click(getByTestId("agent-answer-show-result"));
    expect(applied).toEqual([STATEMENT]);
    expect(shown).toEqual(["corr_9"]);
  });

  /*
    L6, measured in Chrome on 2026-08-21: on the report path the rail offered three
    "Apply to editor" controls at once and NOT ONE of them carried an accessible name.
    The whole reason the redesign was allowed to move this control up here is that the
    card names the act it performs, so the name is built by the same function that names
    the plan card's — one author for every hand-off name in this rail, which is what
    lets a test assert the property rather than each site's spelling.

    It carries no mark, and that is the honest answer rather than an omission: a mark
    states what the statement GUARD made of a draft, and nothing drafted this one as a
    plan — the run wrote it, executed it on the engine's own read-only session and
    answered from the rows. There is no guard reading on the ledger for it, so there is
    nothing to say about one, and inventing a reassurance here is exactly the overclaim
    `applyStatementName`'s own docblock spends its length refusing.
  */
  test("names the hand-off with the rail's own name-builder, and claims no guard reading", () => {
    const { getByTestId } = render(<AnswerCard timeline={reportTimeline()} onApplyStatement={() => {}} />);

    const control = getByTestId("agent-answer-apply-statement");
    expect(control.getAttribute("aria-label")).toBe(applyStatementName(null));
    // WCAG 2.5.3: the visible label comes first and unaltered, so a voice user can say
    // what they can see.
    expect(control.getAttribute("aria-label")).toBe("Apply to editor.");
    expect(control.textContent).toContain("Apply to editor");
  });

  test("offers nothing to act on for a report whose run composed no answer", () => {
    const { queryByTestId } = render(
      <AnswerCard
        timeline={reportTimeline({ withAnswer: false })}
        onApplyStatement={() => {}}
        onShowArtifact={() => {}}
      />,
    );
    expect(queryByTestId("agent-answer-report")).toBeTruthy();
    expect(queryByTestId("agent-answer-apply-statement")).toBeNull();
    expect(queryByTestId("agent-answer-show-result")).toBeNull();
  });

  test("folds the evidence away with the statement each citation rests on", () => {
    const { getByTestId, getAllByTestId } = render(<AnswerCard timeline={reportTimeline()} />);
    const evidence = getByTestId("agent-answer-evidence");
    expect(evidence.tagName).toBe("DETAILS");
    expect((evidence as HTMLDetailsElement).open).toBe(false);

    const cited = getAllByTestId("agent-answer-evidence-citation");
    expect(cited).toHaveLength(1);
    expect(cited[0]?.textContent).toContain("1 row via sql.select.rows");
    expect(getByTestId("agent-answer-citation-quoted-copy")).toBeTruthy();
    expect(cited[0]?.textContent).toContain(STATEMENT);
  });

  test("a citation this timeline holds no entry for says so instead of looking checked", () => {
    const { getByTestId } = render(<AnswerCard timeline={reportTimeline({ cites: "corr_missing" })} />);
    expect(getByTestId("agent-answer-evidence-citation").textContent).toContain(
      "not in the part of this run's timeline the rail has read",
    );
    expect(getByTestId("agent-answer-citation-chip").getAttribute("data-resolved")).toBe("false");
  });

  /*
    WCAG 1.4.1. An unresolved citation is a gap in what the run established, and amber
    against a neutral chip says that to nobody who cannot see the hue — a screen-reader
    user, and anyone who cannot separate the two, read a checked citation and an
    unverified one as the same fact. The surface this replaced did not have the problem:
    it followed the label with the ledger's own `detail`, which for an unresolved
    citation IS the sentence saying so.
  */
  test("an unresolved chip says so in its own text, in the words the ledger recorded", () => {
    const { getByTestId } = render(<AnswerCard timeline={reportTimeline({ cites: "corr_missing" })} />);
    const chip = getByTestId("agent-answer-citation-chip");
    expect(chip.textContent).toContain("not in the part of this run's timeline the rail has read");
    expect(getByTestId("agent-answer-citation-chip-unresolved").textContent).toContain(
      "not in the part of this run's timeline the rail has read",
    );
  });

  /*
    Both readings say what they are IN TEXT, and the id says which reading it is — the
    rule this file follows for the guard's claims too. A single shared id for "the
    sentence at the end of the chip" cannot tell a test that the right sentence for
    this state is there: it would pass on either, and the two readings differ by
    exactly that.
  */
  test("a resolved chip reports the read rather than a gap, and says which it is", () => {
    const { getByTestId, queryByTestId } = render(<AnswerCard timeline={reportTimeline()} />);
    expect(getByTestId("agent-answer-citation-chip").getAttribute("data-resolved")).toBe("true");
    expect(getByTestId("agent-answer-citation-chip-detail").textContent).toContain("1 row via sql.select.rows");
    expect(queryByTestId("agent-answer-citation-chip-unresolved")).toBeNull();
  });

  test("an unresolved chip carries no detail node, because what it has to say is the gap", () => {
    const { queryByTestId } = render(<AnswerCard timeline={reportTimeline({ cites: "corr_missing" })} />);
    expect(queryByTestId("agent-answer-citation-chip-detail")).toBeNull();
  });
});

describe("AnswerCard — a plan run that drafted nothing", () => {
  const refusedTimeline = () =>
    foldLedgerEntries([
      opened("planning"),
      started("planning"),
      captured,
      closing("NO STATEMENT: the inventory has no country column"),
      finished("succeeded"),
    ]);

  test("renders the run's own words as the ending they are", () => {
    const { getByTestId } = render(<AnswerCard timeline={refusedTimeline()} />);

    expect(getByTestId("agent-answer-refused")).toBeTruthy();
    expect(getByTestId("agent-answer-refused").textContent).toContain("No statement drafted");
    expect(getByTestId("agent-answer-refusal-note").textContent).toBe(
      "This run drafted no statement. What it says is missing, and what it needs from you, are in its own words below.",
    );
    expect(getByTestId("agent-answer-refusal-prose").textContent).toContain("the inventory has no country column");
    // The protocol token the model was told to emit never reaches the reader.
    expect(getByTestId("agent-answer-refused").textContent).not.toContain("NO STATEMENT:");
    expect(getByTestId("agent-answer-refusal-copy")).toBeTruthy();
  });

  test("offers no statement controls, because there is no statement", () => {
    const { queryByTestId } = render(<AnswerCard timeline={refusedTimeline()} onApplyStatement={() => {}} />);
    expect(queryByTestId("agent-answer-plan-apply")).toBeNull();
    expect(queryByTestId("agent-answer-statement")).toBeNull();
  });
});

describe("AnswerCard — a run that failed", () => {
  test("says why, in the words the timeline already uses, and offers a retry", () => {
    const retries: number[] = [];
    const timeline = foldLedgerEntries([opened("agent"), started("agent"), finished("failed", "model-unavailable")]);
    const { getByTestId } = render(<AnswerCard timeline={timeline} onRetry={() => retries.push(1)} />);

    expect(getByTestId("agent-answer-failed")).toBeTruthy();
    expect(getByTestId("agent-answer-status").textContent).toBe("failed");
    expect(getByTestId("agent-answer-failure").textContent).toBe(
      "The model provider is not configured or could not be reached.",
    );
    fireEvent.click(getByTestId("agent-answer-retry"));
    expect(retries).toEqual([1]);
  });

  test("a failure the server classified no reason for says that, and offers no retry without a host", () => {
    const timeline = foldLedgerEntries([opened("agent"), started("agent"), finished("failed")]);
    const { getByTestId, queryByTestId } = render(<AnswerCard timeline={timeline} />);
    expect(getByTestId("agent-answer-failure").textContent).toContain("names no reason");
    expect(queryByTestId("agent-answer-retry")).toBeNull();
  });
});

/*
  A run CAN end `failed` holding what it produced, and the shape is not a corner case:
  `conclude` in `src/lib/agent/investigation.ts` writes the closing prose and then the
  drafted statement BEFORE `service.finish`, and it is called with `"failed"` for a
  model timeout, an exhausted deadline and the turn ceiling. `run-finished`'s own
  documentation names the combination — "`failed` having answered nothing (the turn
  ceiling)" is one axis, and the product on the ledger is the other.

  So the status is not what decides which card this is. The ledger's product decides,
  and the failure is stated beside it: a card that read the status first replaced a
  drafted statement, its marked hand-off, the guard's claims and the chips with a
  banner — while the transcript entry below went on saying they were "in the answer at
  the top of this rail".
*/
describe("AnswerCard — a run that failed holding what it produced", () => {
  test("a plan run that drafted and then failed still shows the statement, the hand-off and the guard", () => {
    const timeline = foldLedgerEntries([
      opened("planning"),
      started("planning"),
      captured,
      closing(`Here is the read:\n${FENCE}sql\n${STATEMENT}\n${FENCE}`),
      draftEvent({ readOnly: true, identifiers: { kind: "checked", unknownTables: [] } }),
      finished("failed", "model-unavailable"),
    ]);
    const { getByTestId } = render(<AnswerCard timeline={timeline} onApplyStatement={() => {}} onRetry={() => {}} />);

    expect(getByTestId("agent-answer-plan")).toBeTruthy();
    expect(getByTestId("agent-answer-statement").textContent).toContain(STATEMENT);
    expect(getByTestId("agent-answer-plan-apply")).toBeTruthy();
    expect(getByTestId("agent-answer-guard")).toBeTruthy();
    expect(getByTestId("agent-answer-chip-inventory")).toBeTruthy();
    // Nothing is hidden by showing the answer: the status pill still reads `failed` and
    // the reason is still stated, on the same card, with the retry beside it.
    expect(getByTestId("agent-answer-status").textContent).toBe("failed");
    expect(getByTestId("agent-answer-failed")).toBeTruthy();
    expect(getByTestId("agent-answer-failure").textContent).toBe(
      "The model provider is not configured or could not be reached.",
    );
    expect(getByTestId("agent-answer-retry")).toBeTruthy();
  });

  test("a report that arrived before the run failed is still the answer, with the failure beside it", () => {
    const { getByTestId } = render(
      <AnswerCard timeline={reportTimeline({ failed: true })} onApplyStatement={() => {}} onShowArtifact={() => {}} />,
    );

    expect(getByTestId("agent-answer-report")).toBeTruthy();
    expect(getByTestId("agent-answer-claim").textContent).toContain("Checkout writes 1 order per session.");
    // The hand-off the transcript entry withholds BECAUSE this card offers it.
    expect(getByTestId("agent-answer-apply-statement")).toBeTruthy();
    expect(getByTestId("agent-answer-failure").textContent).toBe(
      "The model provider is not configured or could not be reached.",
    );
  });

  test("a refusal a failing run recorded is still its own words, with the failure beside them", () => {
    const timeline = foldLedgerEntries([
      opened("planning"),
      started("planning"),
      captured,
      closing("NO STATEMENT: the inventory has no country column"),
      finished("failed"),
    ]);
    const { getByTestId } = render(<AnswerCard timeline={timeline} />);

    expect(getByTestId("agent-answer-refused")).toBeTruthy();
    expect(getByTestId("agent-answer-refusal-prose").textContent).toContain("the inventory has no country column");
    expect(getByTestId("agent-answer-failure").textContent).toContain("names no reason");
  });

  test("the answer state a run resolves to is one reading, exported for the rail to share", () => {
    // The rail withholds the transcript's copies of what the card renders, and it must
    // read that from the same place the card does. Two derivations was the defect: the
    // rail keyed its suppression on the ledger's report alone, so a failed run withheld
    // the transcript's hand-off for a card that was showing a failure banner instead.
    expect(answerCardState(reportTimeline({ failed: true }))).toBe("report");
    expect(answerCardState(planTimeline({ readOnly: true, identifiers: { kind: "checked", unknownTables: [] } }))).toBe(
      "plan",
    );
    expect(answerCardState(foldLedgerEntries([opened("agent"), started("agent"), finished("failed")]))).toBe("failed");
    expect(answerCardState(foldLedgerEntries([]))).toBeNull();
  });
});

describe("AnswerCard — a run still going", () => {
  const liveTimeline = () =>
    foldLedgerEntries([
      opened("agent"),
      started("agent"),
      captured,
      event({ kind: "statement-drafted", atMs: 1_003, stepId: "s1", sql: STATEMENT, rationale: "count the orders" }),
      event({ kind: "tool-completed", atMs: 5_004, stepId: "s1", artifact: ARTIFACT }),
    ]);

  test("shows the step it is on, what it has spent, and how long the ledger covers", () => {
    const timeline = liveTimeline();
    const { getByTestId } = render(<AnswerCard timeline={timeline} />);

    expect(getByTestId("agent-answer-running")).toBeTruthy();
    expect(getByTestId("agent-answer-step").textContent).toContain("Result stored");
    // The span the ledger records, not a clock: 1_000 to 5_004.
    expect(getByTestId("agent-answer-elapsed").textContent).toContain("4.0 s");

    const limit = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxStatementsPerRun;
    expect(getByTestId("agent-answer-spend").textContent).toContain(`1 / ${limit} statements`);
    expect(getByTestId("agent-answer-spend-note").textContent).toContain("a floor, never a ceiling");
    expect(getByTestId("agent-answer-progress").getAttribute("style")).toContain("width");
  });

  test("stops the run through the host, and offers no stop where the host cannot", () => {
    const stops: number[] = [];
    const { getByTestId } = render(<AnswerCard timeline={liveTimeline()} onStop={() => stops.push(1)} />);
    fireEvent.click(getByTestId("agent-answer-stop"));
    expect(stops).toEqual([1]);
    cleanup();

    const hostless = render(<AnswerCard timeline={liveTimeline()} />);
    expect(hostless.queryByTestId("agent-answer-stop")).toBeNull();
  });

  test("an answer that arrives before the run ends is shown as the answer, not as progress", () => {
    // Measured on the real stream: `answer-composed` and `run-finished` can reach the
    // browser in one chunk, and an answer gated on the status would never be rendered
    // in exactly that case. So the ledger's answer wins over the ledger's status.
    const timeline = foldLedgerEntries([
      opened("agent"),
      started("agent"),
      event({ kind: "statement-drafted", atMs: 1_003, stepId: "s1", sql: STATEMENT, rationale: "count" }),
      event({ kind: "tool-completed", atMs: 1_004, stepId: "s1", artifact: ARTIFACT }),
      event({
        kind: "report-composed",
        atMs: 1_006,
        claims: [
          {
            claim: "Checkout writes 1 order per session.",
            evidence: [{ source: "artifact", correlationId: "corr_9" }],
          },
        ],
      }),
    ]);
    const { getByTestId, queryByTestId } = render(<AnswerCard timeline={timeline} />);
    expect(getByTestId("agent-answer-report")).toBeTruthy();
    expect(queryByTestId("agent-answer-running")).toBeNull();
  });
});
