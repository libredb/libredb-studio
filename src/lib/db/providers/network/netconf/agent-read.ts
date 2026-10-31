/**
 * What an agent's NETCONF read sends and answers: the check of what is withheld, run before every read from the
 * device's own modules, then the read itself through the agent's client (`agent-client.ts`), its answer pruned of every
 * withheld node and shaped into rows exactly as the console shapes them (`rowsIn` in `reader.ts`).
 *
 * THE CHECK RUNS ON EVERY READ, AND NOTHING OF IT IS KEPT. Each read opens its own session, reads the YANG library,
 * fetches the text of every module and submodule the library lists with `<get-schema>` and compiles the withheld policy
 * from them (`agent-withheld.ts`) before anything else is sent, so a module set that changed between two reads is read
 * as it is now. On the fixture that is 59 texts and about 890 KB in 45 ms. A library, a module text or a parse that
 * fails refuses the read before it is sent: a read the check could not decide is never answered unchecked. So does a
 * device that serves more module text than the check's total (`NETCONF_SCHEMA_BUDGET`), before more is fetched, since
 * the check runs on the server's event loop.
 *
 * VALUES ARE ANSWERED. A device's configuration and state are its management data, so the agent reads them, as text,
 * and the result travels to the model inside the untrusted-content fence like every other result. A withheld node
 * answers `[withheld]` in its place, never its value or a child of it, an entry of a list keyed by a withheld leaf is not
 * answered at all, and each is warned with its path and its kind's reason. A read whose path names a withheld node, a
 * node inside one, or filters on a withheld key is refused before it is sent, since even an empty answer would tell
 * whether a guessed value exists.
 *
 * Budgets refuse rather than cut: a list holding more entries than the request's limit or the row budget, an answer
 * past the byte budget and a read past the time budget are refused. A failure is worded by its category, Studio's own
 * refusals as Studio's, and never by the device's own text or a credential.
 */
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import {
  byteBudgetSentence,
  measureResultBytes,
  ROW_BUDGET_PREFIX,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import { MetadataProjectionError } from "@/lib/db/redaction/metadata-only";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import { NetconfAgentError, type NetconfAgentClient, type NetconfAgentLibrary } from "./agent-client";
import type { NetconfAgentPlan } from "./agent-statement";
import {
  NETCONF_SCHEMA_BUDGET,
  NETCONF_WITHHELD_REASONS,
  NetconfSchemaBudgetError,
  NetconfWithheldPolicy,
  type NetconfModuleText,
  type NetconfWithheldRow,
  withheldRows,
  withheldWarning,
} from "./agent-withheld";
import { elementAt, rowsIn } from "./reader";
import { XmlReaderError } from "./reader-port";
import { NetconfSessionError } from "./session";
import { scanYangModule } from "./yangkeys";
import { YangTextError } from "./yangtree";

/** What an agent read answers before the budgets are applied to its rows. */
export interface NetconfAgentAnswer {
  readonly fields: readonly string[];
  readonly rows: ReadonlyArray<Readonly<Record<string, string>>>;
  readonly withheld: readonly NetconfWithheldRow[];
}

const STUDIO = "This is Studio's refusal, not the device's answer.";

export const NETCONF_AGENT_FAILURE_SENTENCES = {
  schemaUnread: `Studio could not read every YANG module this device serves (its library, a module's text, or that text's grammar), so it cannot decide which nodes are withheld, and the read is refused rather than answered unchecked. ${STUDIO}`,
  schemaTooLarge: `This device serves more YANG module text than Studio checks for one read (more than ${NETCONF_SCHEMA_BUDGET.maxTexts} texts, ${NETCONF_SCHEMA_BUDGET.maxBytes} bytes or ${NETCONF_SCHEMA_BUDGET.maxStatements} statements in all), so it cannot decide which nodes are withheld, and the read is refused rather than answered unchecked. ${STUDIO}`,
  notInLibrary: (module: string): string =>
    `This device's YANG library names no module or submodule ${module}, so nothing was read. ${STUDIO}`,
  withheldPath: (at: string, kind: keyof typeof NETCONF_WITHHELD_REASONS): string =>
    `The read of ${at} meets a node withheld from agent mode (${kind}): ${NETCONF_WITHHELD_REASONS[kind]}, so the read was refused before it was sent, since even an empty answer would tell whether a guessed value exists; read a node beside it, or its parent, which answers it as [withheld]. ${STUDIO}`,
  overLimit: (limit: number): string =>
    `The list holds more than ${limit} entries, the limit the request wrote, so it was refused rather than cut; raise the limit up to the row budget or read a narrower path, such as one entry by its keys. ${STUDIO}`,
  overRows: (allowed: number): string =>
    `${ROW_BUDGET_PREFIX}: the list holds more than ${allowed} entries, the row budget, so it was refused rather than cut; read a narrower path, such as one entry by its keys. ${STUDIO}`,
  time: (ms: number): string =>
    `${TIME_BUDGET_PREFIX}: the read did not finish within ${ms}ms, Studio's time budget for one read, which covers opening its session, reading the device's YANG modules for the withheld-node check and the read itself, so it was refused rather than answered in part. ${STUDIO}`,
  credential: "The device refused this connection's credential, so nothing was read.",
  settings:
    "This connection's settings could not be used for the read (its address, account, key or host key pin), so nothing was sent.",
  unreachable: "The device could not be reached, or its session ended before the read was answered.",
  unreadable: "The device's answer could not be read within Studio's bounds for one message, so it was not answered.",
} as const;

const F = NETCONF_AGENT_FAILURE_SENTENCES;

const fail = (sentence: string): never => {
  throw new NetconfAgentError(sentence);
};

/** The text of every module and submodule the library lists, through the agent's client alone. */
async function moduleTexts(client: NetconfAgentClient, library: NetconfAgentLibrary): Promise<NetconfModuleText[]> {
  const entries = library.modules.flatMap((entry) => [
    { name: entry.name, revision: entry.revision },
    ...entry.submodules.map((sub) => ({ name: sub.name, revision: sub.revision })),
  ]);
  if (entries.length > NETCONF_SCHEMA_BUDGET.maxTexts) throw new NetconfSchemaBudgetError("too many module texts");
  const texts: NetconfModuleText[] = [];
  let bytes = 0;
  for (const entry of entries) {
    // oxlint-disable-next-line no-await-in-loop -- one request in flight per session (`docs/providers/netconf.md` 3.4).
    const text = await client.schema(entry.name, entry.revision);
    bytes += text.length;
    // Past the total, nothing more is fetched: the check would refuse the read whatever the rest held.
    if (bytes > NETCONF_SCHEMA_BUDGET.maxBytes) throw new NetconfSchemaBudgetError("too many module bytes");
    texts.push({ name: entry.name, text });
  }
  return texts;
}

/** The library, every module text and the policy compiled from them, or the read's fail-closed refusal. */
async function checkOf(
  client: NetconfAgentClient,
): Promise<{ library: NetconfAgentLibrary; texts: NetconfModuleText[]; policy: NetconfWithheldPolicy }> {
  try {
    const library = await client.library();
    const texts = await moduleTexts(client, library);
    return { library, texts, policy: NetconfWithheldPolicy.compile(library.modules, texts) };
  } catch (error) {
    if (error instanceof NetconfSchemaBudgetError) return fail(F.schemaTooLarge);
    if (error instanceof NetconfAgentError || error instanceof YangTextError || error instanceof XmlReaderError) {
      return fail(F.schemaUnread);
    }
    throw error;
  }
}

/** The answer of one admitted read, through the agent's client alone. */
async function runNetconfAgentRead(
  client: NetconfAgentClient,
  plan: NetconfAgentPlan,
  budget: ReadOnlyStatementBudget,
): Promise<NetconfAgentAnswer> {
  const { library, texts, policy } = await checkOf(client);
  const textOf = (name: string): string | undefined => texts.find((entry) => entry.name === name)?.text;
  if (plan.kind === "schema") {
    const text = textOf(plan.module);
    if (text === undefined) return fail(F.notInLibrary(plan.module));
    const revision = library.modules.find((entry) => entry.name === plan.module)?.revision ?? "";
    return { fields: ["module", "revision", "text"], rows: [{ module: plan.module, revision, text }], withheld: [] };
  }
  const namespaces = new Map<string, string>();
  for (const entry of library.modules) if (entry.namespace !== undefined) namespaces.set(entry.name, entry.namespace);
  const first = plan.path[0]?.module as string;
  const firstText = textOf(first);
  if (firstText === undefined || !namespaces.has(first)) return fail(F.notInLibrary(first));
  // Every module a later node names is checked here too, so the request builder never meets one the library lacks.
  for (const node of plan.path) {
    if (node.module !== undefined && !namespaces.has(node.module)) return fail(F.notInLibrary(node.module));
  }
  const refusal = policy.pathRefusal(plan.path, (module) => namespaces.get(module));
  if (refusal !== undefined) return fail(F.withheldPath(refusal.at, refusal.kind));

  const data = await client.read(plan.datastore, plan.path, namespaces);
  const moduleByNamespace = new Map([...namespaces].map(([name, namespace]) => [namespace, name]));
  const pruned = policy.prune(data, (namespace) =>
    namespace === undefined ? undefined : moduleByNamespace.get(namespace),
  );
  const withheld = withheldRows(pruned.withheld);
  const names = plan.path.map((node) => node.name);
  const parent = elementAt(pruned.data, names.slice(0, -1));
  if (parent === undefined) return { fields: [], rows: [], withheld };
  // A node whose every child was an entry keyed by a withheld leaf answers no row: an empty one would be Studio's.
  const target = elementAt(parent, names.slice(-1));
  if (target !== undefined && pruned.emptied.has(target)) return { fields: [], rows: [], withheld };
  const built = rowsIn(parent, names.at(-1) as string, scanYangModule(firstText), {
    maxRows: Number.MAX_SAFE_INTEGER,
    maxCellChars: Number.MAX_SAFE_INTEGER,
  });
  if (plan.limit !== undefined && plan.limit < budget.maxResultRows && built.rows.length > plan.limit) {
    return fail(F.overLimit(plan.limit));
  }
  if (built.rows.length > budget.maxResultRows) return fail(F.overRows(budget.maxResultRows));
  return { fields: [...built.columns], rows: built.rows, withheld };
}

/** A failure of the read worded by its category; Studio's own refusals pass as they are, and a defect rises unchanged. */
function categorized(error: unknown): unknown {
  if (error instanceof NetconfAgentError) return error;
  if (error instanceof MetadataProjectionError) return new NetconfAgentError(error.message);
  if (error instanceof AuthenticationError) return new NetconfAgentError(F.credential);
  if (error instanceof DatabaseConfigError) return new NetconfAgentError(F.settings);
  if (error instanceof ConnectionError || error instanceof NetconfSessionError)
    return new NetconfAgentError(F.unreachable);
  if (error instanceof XmlReaderError || error instanceof QueryError) return new NetconfAgentError(F.unreadable);
  return error;
}

/**
 * The answer of one admitted read over a session `open` opens for it alone, raced against the request's time budget
 * as a whole, and closed however the read ends. Past the budget the read is refused in Studio's words, and a session
 * still opening is closed once it opens.
 */
export async function runNetconfAgentReadWithin(
  open: () => Promise<NetconfAgentClient>,
  plan: NetconfAgentPlan,
  budget: ReadOnlyStatementBudget,
): Promise<NetconfAgentAnswer> {
  const ms = budget.statementTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new NetconfAgentError(F.time(ms)));
    }, ms);
  });
  const opened = open();
  const close = (): void => {
    opened.then((client) => client.close()).catch(() => {});
  };
  // Past the budget no further request of this read is sent, whatever it was waiting on when the budget ran out.
  const live =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      expired ? Promise.reject(new NetconfAgentError(F.time(ms))) : call(...args);
  const guarded = opened.then(
    (client): NetconfAgentClient => ({
      library: live(client.library),
      schema: live(client.schema),
      read: live(client.read),
      close: client.close,
    }),
  );
  try {
    return await Promise.race([guarded.then((client) => runNetconfAgentRead(client, plan, budget)), deadline]);
  } catch (error) {
    throw categorized(error);
  } finally {
    clearTimeout(timer);
    close();
  }
}

/** The answer of one read as a result: refused past the row or byte budget rather than cut, each withheld node warned. */
export function netconfAgentResult(
  answer: NetconfAgentAnswer,
  budget: ReadOnlyStatementBudget,
  executionTime: number,
): QueryResult {
  const rows = answer.rows.map((row) => ({ ...row }));
  if (rows.length > budget.maxResultRows) fail(rowBudgetSentence(rows.length, budget.maxResultRows));
  const bytes = measureResultBytes(rows);
  if (bytes > budget.maxResultBytes) fail(byteBudgetSentence(bytes, budget.maxResultBytes));
  const warnings = answer.withheld.map((row) => ({ message: withheldWarning(row) }));
  return {
    fields: [...answer.fields],
    rows,
    rowCount: rows.length,
    executionTime,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
