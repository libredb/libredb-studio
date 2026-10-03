/**
 * `expectCalls`, the one assertion every refusal test of the vector family makes about the calls a provider sent
 * (vector-family spec 3.9, R51 U18): a phase 0 refusal leaves the log empty, and a phase 1 refusal holds exactly
 * its metadata calls, in order.
 *
 * A log is the array a fake client records into, or an object carrying that array as `calls`, the shape
 * `tests/helpers/etcd-fake-client.ts` set. An expected entry names a method, or a method and its arguments, which
 * are then compared deeply; a call recorded without arguments compares as an empty argument list.
 */
import { expect } from "bun:test";

export interface LoggedCall {
  readonly method: string;
  readonly args?: readonly unknown[];
}

export type CallLog = readonly LoggedCall[] | { readonly calls: readonly LoggedCall[] };

export type ExpectedCall = string | { readonly method: string; readonly args: readonly unknown[] };

export function expectCalls(log: CallLog, expected: readonly ExpectedCall[]): void {
  const calls: readonly LoggedCall[] = "calls" in log ? log.calls : log;
  const actual = calls.map((call, index) =>
    typeof expected[index] === "object" ? { method: call.method, args: call.args ?? [] } : call.method,
  );
  expect(actual).toEqual([...expected]);
}
