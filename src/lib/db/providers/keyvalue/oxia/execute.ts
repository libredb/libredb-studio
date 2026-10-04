/**
 * One parsed Oxia command run over the walks (SB2-5.1, SB2-5.2, SB2-5.5).
 *
 * Dispatch only: the walks (`walks.ts`) own the routing, the fan-out bound, the merge and its exactness bound, the
 * byte budget, the receive cap and the internal-key refusal, and the surface's client takes a limiter permit per
 * shard call, so this module adds no range, merge or routing logic and keeps no queue. It reads the order verdict
 * with `surface.order` for every command that merges or compares, and hands it on in the outcome, whose notices
 * (`results.ts`) read it. It raises nothing of its own but a run whose signal is already aborted and a defect of its
 * caller; every failure of a call is the walks' `OxiaError`, which the provider words (SB2-5.5).
 */
import type { OxiaCallOptions, OxiaComparison, OxiaRange } from "./client";
import type { OxiaCommand, OxiaCommandComparison, ParsedOxiaCommand } from "./commands";
import type { OxiaOutcome } from "./results";
import {
  comparisonGet,
  listRange,
  type OxiaSurface,
  prefixListPage,
  prefixScanPage,
  rangeScanPage,
  readKeys,
} from "./walks";

export interface OxiaExecutionBounds {
  /** OXIA_MAX_LIMIT: the rows a result holds at most. */
  readonly rowLimit: number;
  /** OXIA_RUN_BYTE_BUDGET: key and value bytes one console run keeps, enforced by the walks. */
  readonly byteBudget: number;
  /** OXIA_CELL_LIMIT: characters one grid cell holds, applied by results.ts. */
  readonly cellLimit: number;
  /** The connection's query timeout, the run's deadline. */
  readonly queryTimeoutMs: number;
}

export interface OxiaExecutionContext {
  readonly bounds: OxiaExecutionBounds;
  /** The run's signal (the provider's run registry) and its absolute deadline. */
  readonly call: OxiaCallOptions;
  /** The connection's namespace, normalised. */
  readonly namespace: string;
}

const COMPARISONS: Readonly<Record<OxiaCommandComparison, OxiaComparison>> = {
  equal: "EQUAL",
  floor: "FLOOR",
  ceiling: "CEILING",
  lower: "LOWER",
  higher: "HIGHER",
};

/** The optional routing of a command: its partition key and its index, each only when given. */
function routing(command: OxiaCommand): { readonly partitionKey?: string; readonly index?: string } {
  return {
    ...(command.partitionKey === undefined ? {} : { partitionKey: command.partitionKey }),
    ...(command.index === undefined ? {} : { index: command.index }),
  };
}

/** `[MIN, MAX)` as the walks take a range; the walk sets the index name itself from `index`. */
const bounds = (min: string, max: string): OxiaRange => ({ startInclusive: min, endExclusive: max });

/** Runs one parsed command and answers its outcome; `results.ts` turns that into the grid's result. */
export async function executeOxiaCommand(
  surface: OxiaSurface,
  parsed: ParsedOxiaCommand,
  context: OxiaExecutionContext,
): Promise<OxiaOutcome> {
  const { command } = parsed;
  const { call, namespace } = context;
  // A run cancelled before it began sends nothing.
  call.signal.throwIfAborted();
  if (command.kind !== "get" && command.limit > context.bounds.rowLimit) {
    throw new RangeError(
      `A command asked for ${command.limit} rows, past the ${context.bounds.rowLimit} a result holds: the parser bounds --limit`,
    );
  }
  const snapshot = await surface.snapshot(call);
  const client = surface.client;

  if (command.kind === "get") {
    if (command.comparison === "equal" && command.index === undefined) {
      // One EQUAL get on the shard the key or the partition key routes to; no order is read.
      const get = {
        key: command.key,
        includeValue: true,
        ...(command.partitionKey === undefined ? {} : { partitionKey: command.partitionKey }),
      };
      const [answer] = await readKeys(client, snapshot, [get], call);
      return { kind: "get", command, answer, namespace };
    }
    // A comparison, or any --index get: the fan-out without values, then the winner's value (SB1-7.6).
    const verdict = await surface.order(call);
    const answer = await comparisonGet(
      client,
      snapshot,
      verdict.order,
      { key: command.key, comparison: COMPARISONS[command.comparison], includeValue: true, ...routing(command) },
      call,
    );
    return { kind: "get", command, answer, namespace, verdict };
  }

  const verdict = await surface.order(call);
  const { range } = command;
  if (command.kind === "list") {
    const answer =
      range.kind === "prefix"
        ? await prefixListPage(
            client,
            snapshot,
            verdict.order,
            {
              prefix: range.prefix,
              limit: command.limit,
              ...(command.partitionKey === undefined ? {} : { partitionKey: command.partitionKey }),
            },
            call,
          )
        : await listRange(
            client,
            snapshot,
            verdict.order,
            { range: bounds(range.min, range.max), limit: command.limit, ...routing(command) },
            call,
          );
    return { kind: "list", command, answer, namespace, verdict };
  }
  const answer =
    range.kind === "prefix"
      ? await prefixScanPage(
          client,
          snapshot,
          verdict.order,
          {
            prefix: range.prefix,
            limit: command.limit,
            ...(command.partitionKey === undefined ? {} : { partitionKey: command.partitionKey }),
          },
          call,
        )
      : await rangeScanPage(
          client,
          snapshot,
          verdict.order,
          { range: bounds(range.min, range.max), limit: command.limit, ...routing(command) },
          call,
        );
  return { kind: "range-scan", command, answer, namespace, verdict };
}
