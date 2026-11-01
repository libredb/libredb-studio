// Runs each step of a .json capture plan against one Trino coordinator and prints each step beside its answer.
// Usage: node probe.mjs <coordinator-url> <plan.json>
//
// A step is one of:
//   { "note": "..." }                                    a line printed as it is
//   { "sql": "...", "txn": "read-only" }                 the statement inside a fresh START TRANSACTION READ ONLY,
//                                                        rolled back after it, the way the agent path sends it
//   { "sql": "...", "txn": "none" }                      the statement in autocommit, a transaction header of NONE
//   { "session": ["...", ...] }                          the statements one after another inside ONE read-only
//                                                        transaction, rolled back after the last, so what a failed
//                                                        statement does to the transaction is recorded; an item
//                                                        { "aside": "..." } runs in autocommit meanwhile, as another
//                                                        session would
// Every request carries the user header "studio" and nothing else of the session: no catalog, no schema, no session
// property. Trino here runs with no authentication, so no credential is sent and none is printed. An answer is its
// column names and rows, or its error name and message; whether it started or cleared a transaction is printed as a
// word, and a transaction id in a message as a label, and query ids and timings are not printed, so two runs differ
// only where the server did.
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: the captures record what the server holds then.
import { readFileSync } from "node:fs";

const [coordinator, file] = process.argv.slice(2);
const cut = (text) => (text.length > 600 ? `${text.slice(0, 600)} ...(${text.length} chars)` : text);

/** An answer with a transaction id, which differs run to run, replaced by a label. */
const shown = (text) =>
  cut(text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<transaction id>"));

/** One statement through the client protocol, following every page, with the transaction headers it answered. */
async function run(sql, transaction) {
  const headers = { "X-Trino-User": "studio", "X-Trino-Transaction-Id": transaction };
  let response = await fetch(`${coordinator}/v1/statement`, { method: "POST", headers, body: sql });
  let started = null;
  let cleared = false;
  const rows = [];
  let columns = null;
  for (;;) {
    started = started ?? response.headers.get("x-trino-started-transaction-id");
    cleared = cleared || response.headers.get("x-trino-clear-transaction-id") === "true";
    const page = await response.json();
    rows.push(...(page.data ?? []));
    columns = columns ?? page.columns?.map((column) => column.name) ?? null;
    if (page.error !== undefined) {
      return { started, cleared, answer: `${page.error.errorName}: ${page.error.message}` };
    }
    if (page.nextUri === undefined)
      return { started, cleared, answer: `OK ${JSON.stringify(columns ?? [])} ${JSON.stringify(rows)}` };
    response = await fetch(page.nextUri, { headers: { "X-Trino-User": "studio" } });
  }
}

function line(sql, outcome) {
  const marks = [
    outcome.started === null ? null : "started a transaction",
    outcome.cleared ? "ended the transaction" : null,
  ]
    .filter((mark) => mark !== null)
    .join(", ");
  console.log(`> ${sql}`);
  console.log(`  ${shown(outcome.answer)}${marks === "" ? "" : ` (${marks})`}`);
}

/** A fresh read-only transaction, its id, and the line saying it opened. */
async function begin() {
  const opened = await run("START TRANSACTION READ ONLY", "NONE");
  if (opened.started === null) throw new Error(`START TRANSACTION READ ONLY started nothing: ${opened.answer}`);
  return opened.started;
}

for (const step of JSON.parse(readFileSync(file, "utf8"))) {
  if (step.note !== undefined) {
    console.log(`# ${step.note}`);
    continue;
  }
  if (step.session !== undefined) {
    const transaction = await begin();
    console.log("(START TRANSACTION READ ONLY)");
    for (const item of step.session) {
      if (typeof item === "string") line(item, await run(item, transaction));
      else line(`[autocommit, meanwhile] ${item.aside}`, await run(item.aside, "NONE"));
    }
    line("ROLLBACK", await run("ROLLBACK", transaction));
    continue;
  }
  if (step.txn === "none") {
    line(`[autocommit] ${step.sql}`, await run(step.sql, "NONE"));
    continue;
  }
  const transaction = await begin();
  line(`[read-only transaction] ${step.sql}`, await run(step.sql, transaction));
  const rolledBack = await run("ROLLBACK", transaction);
  if (!rolledBack.cleared) console.log(`  (ROLLBACK did not end the transaction: ${rolledBack.answer})`);
}
