/**
 * Server values more than one language pack holds by reference (#1821). A leaf: it imports nothing.
 */

/** A language whose argument is text: the statement is the string as written, and nothing else is one. */
export const canonicalText = (raw: unknown): string | null => (typeof raw === "string" && raw.length > 0 ? raw : null);

/**
 * The `operations` tool rules, which every language holds by reference: `operations` sends no statement in any
 * language, so its rules are the SQL ones, shared rather than restated.
 */
export const OPERATIONS_TOOL_RULE = [
  // "and no schema inventory was captured for you" until #411, which captures one.
  // Hedged rather than stated flatly because these rules are the same for every run
  // of this workflow while the grounding is not. The CAUSE of that moved at #414: it
  // was the dialect table — `CATALOG_PLANS` served two engines and this workflow
  // deliberately runs on the others — and it is now a reading that can fail on any
  // engine, since a dialect with no catalog plan asks its provider instead and
  // usually gets an inventory. The hedge is unchanged, because an ungrounded
  // operations run is still an ordinary thing. The per-run truth is in the opening
  // note, which is built from what this drive actually established.
  "You have NO SQL in this run: there is no inspect_schema, no run_read_query and no inspect_plan. Where this engine can be read, a schema inventory of table names and their indexes was captured for you before your first turn and the message opening this run says so; it is there to tell you what the engine names back at you.",
  "Everything you read, you read with inspect_operations.",
  // The kinds are not listed here: these rules are one text for every engine, and the inspect_operations definition a
  // run is handed lists exactly the readings its engine offers.
  "Take the readings your objective needs, of the kinds inspect_operations offers on this engine, one call each, and narrow them with limit or schema rather than asking for everything.",
  // The verifier's rule, in the model's own terms. A rule the model is never told is
  // a rule live runs fail (#350, #356), so the bar and its honest exception are both
  // said here, next to the tools that can satisfy them.
  "Your report must cite at least one reading you took: this run answers with what the engine said about itself, not with what you expect of a database like this one.",
  "A reading that comes back EMPTY is an answer, not a failure — no blocked session, no slow query, no unused index is what a healthy server looks like. Cite it and say what it shows.",
  "If this engine serves no reading of a kind you asked for, you will be told so plainly. Try another kind rather than guessing: a report has to cite a reading you actually took, so a run that takes none can report nothing.",
  "EVERY READING IS A MOMENT. A session list is who was connected as you looked; a slow-query list is what the engine has accumulated, not what it did today. Say what you saw and when, and never imply you measured a trend or watched something change.",
  "recommend_change offers the user one index or one rewrite, and nothing else: an operational action — killing a session, vacuuming a table, dropping an index — has no card here, so state it as a claim in your report rather than filing it as a recommendation.",
].join(" ");
