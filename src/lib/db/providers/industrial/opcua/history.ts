/**
 * Raw history for one node, paged and bounded (#1677 section 2, O-S5, O-S6).
 *
 * A HISTORY READ HAS NO NATURAL END, which is the fact this module is built around. Measured on the
 * pinned fixture: the node's history has a fixed origin and a moving end, because the server
 * back-fills synthetic values from before its own start and appends one every 10 seconds. The same
 * 24-hour window walked eight times over nineteen minutes answered 11 pages, then 12, then 13. So
 * the cap is what makes the read finish, and the page says the cap was reached rather than
 * implying the history ended.
 *
 * TWO WAYS TO PAGE, because not every server offers the first. OPC PLC and the in-process
 * `node-opcua` server hand back a continuation point and `BrowseNext`-style paging works. asyncua
 * NEVER hands one back: measured, a read with `numValuesPerNode: 5` returned 5 values and no
 * continuation point, which leaves the rest unreachable by token. There the next page has to start
 * after the last source timestamp instead. This module does the first where it can and falls back
 * to the second, and reports which it used.
 *
 * EVERY CONTINUATION POINT IS CONSUMED OR RELEASED IN THE SAME READ. They are scarce session state:
 * OPC PLC publishes 100 history continuation points and 10 browse ones, and a plant's own SCADA
 * clients share that table. A read that stopped at the cap without releasing would hold one until
 * the session closed.
 */
import {
  OPCUA_HISTORY_EMPTY_PAGE_LIMIT,
  OPCUA_HISTORY_MAX_REQUESTS,
  OPCUA_HISTORY_VALUES_PER_PAGE,
  OPCUA_HISTORY_VALUE_CAP,
} from "./constants";
import type { OpcuaHistoryValue, OpcuaNodeId, OpcuaReadOnlyClient } from "./client";
import { statusSentence } from "./errors";

/** Why a history read stopped, which the result reports rather than leaving to inference. */
export type OpcuaHistoryEnd =
  /** The server had no more values in the window. */
  | "exhausted"
  /**
   * The server refused the read, and its own status code says why.
   *
   * NOT THE SAME FACT AS AN EMPTY WINDOW, which is why it is its own reason. Measured on OPC PLC:
   * a node that keeps no history answers `BadHistoryOperationUnsupported` with zero values, and a
   * node that does not exist answers `BadNodeIdUnknown` with zero values. Both used to arrive as
   * "exhausted", so a reader was told the window held nothing when the truth was that the node
   * holds no history at all, or that they mistyped it.
   */
  | "refused"
  /** Our own value cap stopped it, and there is more history than this. */
  | "value-cap"
  /** The server pages but stopped handing back a way to continue, so the rest is unreachable. */
  | "no-continuation"
  /**
   * The server kept answering a continuation point with no values in it, and the read stopped
   * rather than following it for ever (`OPCUA_HISTORY_EMPTY_PAGE_LIMIT`).
   */
  | "empty-pages"
  /**
   * The read spent its whole request budget (`OPCUA_HISTORY_MAX_REQUESTS`) without reaching either
   * the end of the window or the value cap: the server answers, but so little per request that
   * following it further would be a storm rather than a read.
   */
  | "request-budget";

export interface OpcuaHistoryResult {
  readonly nodeId: OpcuaNodeId;
  readonly values: readonly OpcuaHistoryValue[];
  readonly end: OpcuaHistoryEnd;
  /** The server's own status code, where it refused: what the reader is shown instead of a guess. */
  readonly statusCode?: string;
  readonly pages: number;
  /** Whether paging followed continuation points or advanced the start time. */
  readonly paging: "continuation-point" | "timestamp";
}

/** The last source timestamp in a page, for the servers that hand back no continuation point. */
function lastTimestamp(values: readonly OpcuaHistoryValue[]): Date | undefined {
  for (let at = values.length - 1; at >= 0; at -= 1) {
    const stamp = values[at]?.sourceTimestamp;
    if (stamp !== undefined) {
      const when = new Date(stamp);
      if (!Number.isNaN(when.getTime())) return when;
    }
  }
  return undefined;
}

/**
 * Every value in the window, up to the cap.
 *
 * The page size is always set, never left to the server: Part 11 6.5.3 says `numValuesPerNode` 0
 * "indicates that there is no maximum", and `node-opcua-client` sends 0 when the caller sets
 * nothing, so a read that said nothing got whatever page the server felt like. Measured, that was
 * 100 values on OPC PLC and 1,100 in one response on asyncua.
 */
export async function readHistory(
  client: Pick<OpcuaReadOnlyClient, "historyRead" | "historyReadNext" | "releaseHistoryContinuationPoint">,
  request: {
    readonly nodeId: OpcuaNodeId;
    readonly start?: Date;
    readonly end?: Date;
    readonly limit?: number;
  },
): Promise<OpcuaHistoryResult> {
  const cap = Math.min(request.limit ?? OPCUA_HISTORY_VALUE_CAP, OPCUA_HISTORY_VALUE_CAP);
  /**
   * The window is fixed HERE, once, even when the reader named neither end.
   *
   * A CONTINUED READ IS VALIDATED AGAINST THE DETAILS OF THE READ THAT HANDED OUT THE POINT, so an
   * open-ended window resolved per call - `new Date()` a few seconds later - makes every
   * continuation a different request: measured on OPC PLC 2.15.10, exactly that answered
   * `BadContinuationPointInvalid` and left the rest of the history unreachable.
   */
  const from = request.start ?? new Date(0);
  const until = request.end ?? new Date();
  const values: OpcuaHistoryValue[] = [];
  let pages = 0;
  let paging: OpcuaHistoryResult["paging"] = "continuation-point";
  /** Whether this server ever handed back a token, which is what `paging` reports. */
  let tokenPaged = false;
  /** Consecutive pages that carried a continuation point and no values; see the branch that reads it. */
  let emptyPages = 0;
  let start = from;
  let point: Uint8Array | undefined;

  /**
   * ONE PAGE SIZE FOR THE WHOLE READ, fixed here with the window and for the same reason.
   *
   * `numValuesPerNode` is part of `ReadRawModifiedDetails`, so it is one of the details a server
   * validates a continuation against. Shrinking it as the cap came closer - 500, then 500, then
   * 200 - made the last continuation a different request: measured on OPC PLC, that answered
   * `BadContinuationPointInvalid` with zero values, which the loop below then read as an empty
   * window. A reader who asked for 1,200 values of a node holding 1,475 was handed 800 and told the
   * server had no more. The cap is honoured by slicing what came back, never by asking for less.
   */
  const perPage = Math.min(OPCUA_HISTORY_VALUES_PER_PAGE, cap);

  for (;;) {
    const page =
      point === undefined
        ? // oxlint-disable-next-line no-await-in-loop -- one page after another: a page starts where the one before it ended.
          await client.historyRead({
            nodeId: request.nodeId,
            startTime: start,
            endTime: until,
            valuesPerPage: perPage,
          })
        : // The window of the FIRST page travels with every continuation: measured on OPC PLC,
          // a continued read whose details differ from the read that handed out the point answers
          // BadContinuationPointInvalid, and the rest of the history is then unreachable.
          // oxlint-disable-next-line no-await-in-loop -- the release has to follow the page that handed back the point.
          await client.historyReadNext({
            nodeId: request.nodeId,
            continuationPoint: point,
            startTime: start,
            endTime: until,
            valuesPerPage: perPage,
          });
    pages += 1;

    /*
     * THE REQUEST BUDGET, which is the bound the other two leave a gap between. The value cap ends
     * a read that makes progress and the empty-page limit ends one that makes none; a server that
     * drips - ten empty pages, then one value, for ever - resets the empty-page counter every
     * eleventh page and meets neither until the cap. Measured against such a client: 109,990
     * requests inside one HTTP request. Whatever this page held, the read stops here and says which
     * bound stopped it, releasing the server's slot on the way out.
     */
    if (pages > OPCUA_HISTORY_MAX_REQUESTS) {
      if (page.continuationPoint !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- the release follows the page that handed back the point.
        await client.releaseHistoryContinuationPoint({
          nodeId: request.nodeId,
          continuationPoint: page.continuationPoint,
          startTime: start,
          endTime: until,
          valuesPerPage: perPage,
        });
      }
      return {
        nodeId: request.nodeId,
        values: values.slice(0, cap),
        end: "request-budget",
        pages: pages - 1,
        paging,
      };
    }

    /**
     * THE STATUS IS READ BEFORE THE VALUES, because a refusal and an empty window are different
     * facts. Anything that is not Good or Uncertain ends the read with the server's own code, which
     * `errors.ts` turns into a sentence the reader can act on.
     */
    if (!page.statusCode.startsWith("Good") && !page.statusCode.startsWith("Uncertain")) {
      if (page.continuationPoint !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- the release follows the page that handed back the point.
        await client.releaseHistoryContinuationPoint({
          nodeId: request.nodeId,
          continuationPoint: page.continuationPoint,
          startTime: start,
          endTime: until,
          valuesPerPage: perPage,
        });
      }
      return {
        nodeId: request.nodeId,
        values,
        end: "refused",
        statusCode: page.statusCode,
        pages,
        paging,
      };
    }

    values.push(...page.values);

    // The cap stops it, and the server's slot is handed back rather than left held.
    if (values.length >= cap) {
      if (page.continuationPoint !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- the next page is addressed by the last value of this one.
        await client.releaseHistoryContinuationPoint({
          nodeId: request.nodeId,
          continuationPoint: page.continuationPoint,
          startTime: start,
          endTime: until,
          valuesPerPage: perPage,
        });
      }
      return {
        nodeId: request.nodeId,
        values: values.slice(0, cap),
        end: "value-cap",
        pages,
        paging,
      };
    }

    if (page.continuationPoint !== undefined) {
      /*
       * A PAGE WITH A POINT AND NO VALUES MOVES NOTHING, and following it for ever is what this
       * counter stops. The cap above ends a read only because each page carries values; a page that
       * carries none and a point to continue from leaves `values.length` where it was, so
       * `values.length >= cap` was never reached. Measured against a server that answers that way:
       * 50,000 HistoryReadNext calls and still going, one HTTP request that never answered, and the
       * session held for all of it. The comment that used to sit here claimed the loop was bounded
       * because "every page that continues it carries at least one value" - true of the timestamp
       * branch below, and not of this one.
       */
      if (page.values.length === 0) {
        emptyPages += 1;
        if (emptyPages > OPCUA_HISTORY_EMPTY_PAGE_LIMIT) {
          // oxlint-disable-next-line no-await-in-loop -- the release follows the page that handed back the point.
          await client.releaseHistoryContinuationPoint({
            nodeId: request.nodeId,
            continuationPoint: page.continuationPoint,
            startTime: start,
            endTime: until,
            valuesPerPage: perPage,
          });
          return {
            nodeId: request.nodeId,
            values,
            end: "empty-pages",
            pages,
            paging,
          };
        }
      } else {
        emptyPages = 0;
      }
      point = page.continuationPoint;
      tokenPaged = true;
      continue;
    }

    /*
     * No continuation point. Either the window is spent, or this server never pages by token.
     *
     * AN EMPTY PAGE IS THE ONLY END, AND A SHORT PAGE IS NOT ONE. A short page used to end the read
     * as "exhausted", which is an inference and not a fact: Part 11 5.3.2 lets a server return
     * fewer values than `numValuesPerNode` asks for, and a server that caps its pages below our ask
     * and hands back no token would then have its FIRST page read as the whole of the history. The
     * reader would be shown 50 values of a node holding fifty thousand, with nothing saying so. So
     * a non-empty page without a token advances the window past its last value and reads on, and
     * only a page with nothing in it says the window is spent.
     *
     * The cost is one extra round trip per read, the one that comes back empty, and THIS branch is
     * bounded by the cap: every page that continues it carries at least one value, so there are at
     * most `cap` of them. The branch above, which continues on a continuation point, is bounded by
     * `OPCUA_HISTORY_EMPTY_PAGE_LIMIT` instead, for the reason written there.
     */
    if (page.values.length === 0) {
      return {
        nodeId: request.nodeId,
        values,
        end: "exhausted",
        pages,
        paging,
      };
    }
    const last = lastTimestamp(page.values);
    if (last === undefined) {
      return {
        nodeId: request.nodeId,
        values,
        end: "no-continuation",
        pages,
        paging,
      };
    }
    /*
     * A page with no token: advance past the last value and read on, as asyncua requires.
     *
     * `paging` names what the read was paged BY, so a server that handed back tokens keeps that
     * name even though the request that found the window empty was addressed by timestamp: the
     * last request is the one that ends a read, not the one that pages it.
     */
    if (!tokenPaged) paging = "timestamp";
    start = new Date(last.getTime() + 1);
    point = undefined;
  }
}

/**
 * What the result's end reason tells a reader, in words.
 *
 * A refusal carries the server's own status code, so the sentence is the one the error table writes
 * for it: "that node keeps no history" rather than "the window held nothing".
 *
 * EVERY SENTENCE STARTS WITH A CAPITAL, because this is the whole message now: it is the `message`
 * of the result's one `warnings` entry, drawn on its own beside the grid. Two of the four used to
 * start lowercase, which is what a FRAGMENT looks like - they were written when this text was
 * appended to something else - and a lowercase first word beside a row count reads as a cut-off
 * line rather than as a sentence.
 */
export function historyEndSentence(end: OpcuaHistoryEnd, shown: number, statusCode?: string): string {
  switch (end) {
    case "refused":
      return statusCode === undefined
        ? `${shown.toLocaleString("en-US")} values were read, and the server refused the rest.`
        : `${statusSentence(statusCode)}${shown === 0 ? "" : ` ${shown.toLocaleString("en-US")} values were read before it.`}`;
    case "exhausted":
      return `The server had no more values in this window; ${shown.toLocaleString("en-US")} were read.`;
    case "value-cap":
      return (
        `The read reached its cap of ${shown.toLocaleString("en-US")} values, and the node holds more. ` +
        "A narrower window reads the rest: a server appends history while it is read, so a window with no end has none."
      );
    case "no-continuation":
      return (
        `${shown.toLocaleString("en-US")} values were read, and the rest of the window is unreachable: the server ` +
        "filled a page and handed back neither a continuation point nor a source timestamp to continue from."
      );
    case "request-budget":
      return (
        `${shown.toLocaleString("en-US")} values were read, and the read stopped after ` +
        `${OPCUA_HISTORY_MAX_REQUESTS.toLocaleString("en-US")} requests: this server answers so few values per ` +
        "request that reading the rest would be a storm rather than a read. A narrower window asks it less."
      );
    case "empty-pages":
      return (
        `${shown.toLocaleString("en-US")} values were read, and the read stopped: the server answered more ` +
        `than ${OPCUA_HISTORY_EMPTY_PAGE_LIMIT.toLocaleString("en-US")} pages in a row that held no values and ` +
        "a continuation point each, which is a page that moves nothing. A narrower window asks the server a question it can answer."
      );
  }
}
