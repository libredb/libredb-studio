/**
 * What an agent's Modbus read sends and answers: one admitted request (`agent-statement.ts`), costed and bounded
 * before anything is sent, paced on its device (`agent-pacing.ts`), run through the console's own reader (`read.ts`)
 * over a socket opened for that read alone and destroyed when it ends, and answered as the console answers it.
 *
 * WHAT IS SENT. Only what the console sends: the four read function codes, chosen by the table and never by the
 * request, and the identification request 43/14, each built by `pdu.ts` and re-read by the valve before
 * `socket.write`. No function here names a function code.
 *
 * VALUES ARE ANSWERED. A register, a coil and an identification object are the device's own readings, and Modbus has
 * no credential to withhold, so the agent answers them exactly as the console renders them: numbers and booleans as
 * decoded under the register map, and an identification object as text only when its bytes round-trip as text with no
 * control byte, hex otherwise. Every result travels to the model inside the untrusted-content fence.
 *
 * WHAT IS BOUNDED BEFORE THE SOCKET. The rows a points or block read answers are known from the request, so a read
 * past the row budget is refused before anything is sent. Each read costs a known number of device requests (one per
 * planned block, one for a raw block, and the identification walk's most, `MAX_IDENTIFICATION_ROUNDS`), charged to the
 * run's ledger (`ReadOnlyStatementBudget.readAllowance`, one unit per device request) once the read's turn on the
 * device has come and before it dials, and refused when the run would pass `MODBUS_AGENT_RUN_REQUESTS`. The ledger is
 * the run's own and survives a resume; a budget that carries none is refused.
 *
 * WHAT IS BOUNDED AFTER. An identification answer's rows are the device's, so they are checked against the row budget
 * once read; a walk the round bound cuts short is refused rather than answered in part; every result is held to the
 * byte budget. The read's time budget starts when the read is asked for and covers its wait for its turn, the gap and
 * the read itself; past it the read is refused in Studio's words and its socket destroyed. A device's silence, its
 * exception and an answer that cannot be read are each worded by their category, never by the device's bytes.
 */
import { ConnectionError, DatabaseConfigError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import {
  byteBudgetSentence,
  measureResultBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import { MODBUS_AGENT_DEVICE_GAP_MS, ModbusPacingTimeout, type ModbusDevicePacer, deviceKey } from "./agent-pacing";
import { socketWire, type Dialer, type Endpoint, type ModbusSocket } from "./client";
import { MAX_IDENTIFICATION_ROUNDS, REQUEST_TIMEOUT_MS } from "./constants";
import { ModbusIdentificationError } from "./identification";
import { EXCEPTION_SENTENCES } from "./pdu";
import { planReads } from "./plan";
import { ModbusExceptionError, ModbusWalkBoundError, runRead, type ReadRows } from "./read";
import type { MapPoint, ParsedMap } from "./register-map";
import type { ReadRequest } from "./request";
import { ModbusSession, ModbusTimeout } from "./session";
import { ModbusDecodeError, REGISTERS_OF_TYPE } from "./values";

/** How far past the session's request timer the socket's own timer is set on the agent path. */
const SOCKET_TIMER_MARGIN_MS = 1000;

/** The most device requests one agent run may send to Modbus devices, across all its reads and resumes. */
export const MODBUS_AGENT_RUN_REQUESTS = 64;

const STUDIO = "This is Studio's refusal, not the device's answer.";
const NOTHING_SENT = "Nothing was sent.";

export const MODBUS_AGENT_FAILURE_SENTENCES = {
  /** A points or block read whose rows, known from the request, pass the row budget. */
  overRows: (rows: number, allowed: number): string =>
    `${rowBudgetSentence(rows, allowed)}: the read answers one row per point or per item of the block, so it was refused before anything was sent rather than cut; ask for fewer points or a shorter block. ${STUDIO}`,
  /** An answer whose rows the device decided, an identification answer, past the row budget. */
  overAnswerRows: (rows: number, allowed: number): string =>
    `${rowBudgetSentence(rows, allowed)}: the device answered more rows than the row budget, so they were refused rather than cut; for identification objects ask for a lower level (basic or regular). ${STUDIO}`,
  /** The run's count of device requests would pass its bound. */
  requestBound: (cost: number, left: number): string =>
    `Read-only execution exceeded the device request bound: this read sends up to ${cost} requests to the device and this run has ${left} of the ${MODBUS_AGENT_RUN_REQUESTS} Studio allows one agent run on Modbus devices, so it was refused before anything was sent; read fewer points, one block, or answer from what the run has read. ${STUDIO}`,
  /** A budget that carries no run ledger, so the request bound cannot be kept. */
  noLedger: `A Modbus agent read counts its device requests against the run it belongs to, and this read carries no run, so it was refused. ${NOTHING_SENT} ${STUDIO}`,
  /** The read's turn on the device would come after its time budget. */
  waited: (ms: number): string =>
    `${TIME_BUDGET_PREFIX}: the read waited ${ms}ms of Studio's time budget for one read for its turn on this device, behind another agent read of it or the ${MODBUS_AGENT_DEVICE_GAP_MS}ms gap Studio keeps after one so the plant's own client can reach a device that serves one client at a time, and its turn would come after the budget, so it was refused. ${NOTHING_SENT} ${STUDIO}`,
  /** The read was still running when its time budget ran out. */
  deadline: (ms: number): string =>
    `${TIME_BUDGET_PREFIX}: the read did not finish within ${ms}ms, Studio's time budget for one read, which covers its wait for its turn on this device and the read itself, so it was refused rather than answered in part and its connection closed. ${STUDIO}`,
  /** An identification walk the round bound cut short. */
  walkBound: `Read-only execution exceeded the identification walk's bound: the device was still sending identification objects after ${MAX_IDENTIFICATION_ROUNDS} requests, so the walk was refused rather than answered in part; ask for a lower level (basic or regular). ${STUDIO}`,
  silence: `The device did not answer one of the read's requests within ${REQUEST_TIMEOUT_MS}ms, so the read was not answered. A Modbus TCP connection stays open when a device loses power, so silence is all a dead device, a wrong unit behind a gateway or a device busy with another client shows.`,
  refused: (code: number): string =>
    `The device refused the read with Modbus exception code ${code}: ${EXCEPTION_SENTENCES[code] ?? "a code this provider has no sentence for."}`,
  unreachable: "The device could not be reached, or it ended the connection before the read was answered.",
  unreadable: "The device's answer could not be read as a Modbus answer to this read, so it was not answered.",
  decode:
    "A value the device sent does not decode as the register map declares it (its type, its word or byte order), so the read was not answered; the map's declaration is the thing to check.",
  settings: "This connection's address or settings could not be used for the read, so nothing was sent.",
} as const;

const F = MODBUS_AGENT_FAILURE_SENTENCES;

/** A refusal or failure worded by Studio. The class tells a caller that nothing in it came from the device's bytes. */
export class ModbusAgentError extends QueryError {
  constructor(message: string) {
    super(message, "modbus");
    this.name = "ModbusAgentError";
    Object.setPrototypeOf(this, ModbusAgentError.prototype);
  }
}

/** A refusal Studio makes before anything is sent. */
class ModbusAgentRefusal extends RefusedBeforeSendError {
  constructor(message: string) {
    super(message, "modbus");
    this.name = "ModbusAgentRefusal";
    Object.setPrototypeOf(this, ModbusAgentRefusal.prototype);
  }
}

const refuse = (sentence: string): never => {
  throw new ModbusAgentRefusal(sentence);
};

const fail = (sentence: string): never => {
  throw new ModbusAgentError(sentence);
};

/** The points a points read names, in the map's own declaration. */
function pointsOf(plan: Extract<ReadRequest, { kind: "points" }>, map: ParsedMap): MapPoint[] {
  const byName = new Map(map.points.map((point) => [point.name, point]));
  return plan.names.flatMap((name) => byName.get(name) ?? []);
}

/** The most device requests a read sends: one per block, one for a raw block, the walk's bound for identification. */
export function deviceRequestsOf(plan: ReadRequest, map: ParsedMap): number {
  switch (plan.kind) {
    case "points":
      return planReads(pointsOf(plan, map)).length;
    case "range":
      return 1;
    case "identify":
      return MAX_IDENTIFICATION_ROUNDS;
  }
}

/** The rows a read answers, when the request alone decides them; an identification answer's are the device's. */
function rowsOf(plan: ReadRequest): number | undefined {
  switch (plan.kind) {
    case "points":
      return plan.names.length;
    case "range":
      return plan.type === undefined ? plan.count : Math.floor(plan.count / (REGISTERS_OF_TYPE[plan.type] ?? 1));
    case "identify":
      return undefined;
  }
}

/** What one agent read needs besides its request: the connection's map, its device, and the read's own deadline. */
export interface ModbusAgentReadInput {
  readonly plan: ReadRequest;
  readonly map: ParsedMap;
  readonly endpoint: Endpoint;
  /** The unit a shape that names none reads at: the map's first, as the console reads it. */
  readonly unitId: number;
  readonly budget: ReadOnlyStatementBudget;
  /** When the read was asked for, on `performance.now()`'s clock; the time budget runs from here. */
  readonly startedAt: number;
}

export interface ModbusAgentReadSeams {
  readonly dial: Dialer;
  readonly pacer: ModbusDevicePacer;
}

/** A failure of the read worded by its category; Studio's own refusals pass as they are, and a defect rises unchanged. */
function categorized(error: unknown): unknown {
  if (error instanceof ModbusAgentError || error instanceof RefusedBeforeSendError) return error;
  if (error instanceof ModbusWalkBoundError) return new ModbusAgentError(F.walkBound);
  if (error instanceof ModbusTimeout) return new ModbusAgentError(F.silence);
  if (error instanceof ModbusExceptionError) return new ModbusAgentError(F.refused(error.exceptionCode));
  if (error instanceof ModbusDecodeError) return new ModbusAgentError(F.decode);
  if (error instanceof ConnectionError) return new ModbusAgentError(F.unreachable);
  if (error instanceof DatabaseConfigError) return new ModbusAgentError(F.settings);
  if (error instanceof ModbusIdentificationError || error instanceof QueryError) {
    return new ModbusAgentError(F.unreadable);
  }
  return error;
}

/**
 * Runs one admitted agent read: the row and request bounds before its turn, the pacer's turn, the request bound again
 * and its charge, then the read over a socket of its own, raced against what is left of the time budget.
 */
export async function runModbusAgentRead(input: ModbusAgentReadInput, seams: ModbusAgentReadSeams): Promise<ReadRows> {
  const { plan, map, endpoint, budget } = input;
  const ms = budget.statementTimeoutMs;
  const rows = rowsOf(plan);
  if (rows !== undefined && rows > budget.maxResultRows) refuse(F.overRows(rows, budget.maxResultRows));
  const allowance = budget.readAllowance;
  if (allowance === undefined) return refuse(F.noLedger);
  const cost = deviceRequestsOf(plan, map);
  const left = (): number => Math.max(0, MODBUS_AGENT_RUN_REQUESTS - allowance.spent());
  if (cost > left()) refuse(F.requestBound(cost, left()));
  const deadlineAt = input.startedAt + ms;
  try {
    return await seams.pacer.run(deviceKey(endpoint.host, endpoint.port), deadlineAt, async () => {
      // Checked again on the turn, synchronously with the charge: another read of the run may have spent meanwhile.
      if (cost > left()) refuse(F.requestBound(cost, left()));
      allowance.charge(cost, `a Modbus read of ${cost} device requests`);
      return await readOnDevice(input, seams.dial, deadlineAt);
    });
  } catch (error) {
    if (error instanceof ModbusPacingTimeout) throw new ModbusAgentRefusal(F.waited(error.waitedMs));
    throw categorized(error);
  }
}

/**
 * The read itself, over a socket of its own, refused at the deadline. The socket is destroyed before this settles, so
 * the device's lane is held until it is: a dial still in flight at the deadline is awaited, for at most the dial's own
 * bound, and destroyed once it opens.
 */
async function readOnDevice(input: ModbusAgentReadInput, dial: Dialer, deadlineAt: number): Promise<ReadRows> {
  const ms = input.budget.statementTimeoutMs;
  const left = deadlineAt - performance.now();
  if (left <= 0) return refuse(F.waited(ms));
  const opened = dial(input.endpoint);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ModbusAgentError(F.deadline(ms))), left);
  });
  // The session's own request timer words a device's silence; the socket's timer is set past it so the two never
  // race and silence is never worded as an unreachable device.
  const work = opened.then((socket) =>
    runRead(
      input.plan,
      input.map,
      new ModbusSession(socketWire(socket, input.endpoint, REQUEST_TIMEOUT_MS + SOCKET_TIMER_MARGIN_MS)),
      input.unitId,
      { refuseCutWalk: true },
    ),
  );
  // The loser of the race settles later with nobody listening; it is read here so it is never an unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
    await opened.then(
      (socket) => {
        socket.destroy();
      },
      () => undefined,
    );
  }
}

/** The answer of one read as a result: refused past the row or byte budget rather than cut, its warnings kept. */
export function modbusAgentResult(read: ReadRows, budget: ReadOnlyStatementBudget, executionTime: number): QueryResult {
  const rows = read.rows.map((row) => ({ ...row }));
  // Only an identification answer can get here past the budget: a points or block read was refused before its socket.
  if (rows.length > budget.maxResultRows) fail(F.overAnswerRows(rows.length, budget.maxResultRows));
  const bytes = measureResultBytes(rows);
  if (bytes > budget.maxResultBytes) fail(byteBudgetSentence(bytes, budget.maxResultBytes));
  return {
    fields: [...read.fields],
    rows,
    rowCount: rows.length,
    executionTime,
    ...(read.warnings.length === 0 ? {} : { warnings: read.warnings.map((message) => ({ message })) }),
  };
}
