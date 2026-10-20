import { isDeepStrictEqual } from "node:util";
import type { DatabaseConnection } from "@/lib/types";
import type { Posture } from "../protocol";

/** What connection/open stored for one connection: the connection as revived, and the posture it was opened under. */
export interface OpenRecord {
  connection: DatabaseConnection;
  posture: Posture;
}

/** The connections connection/open opened in this process, by id; lost with the process. */
export class ConnectionRegistry {
  private readonly records = new Map<string, OpenRecord>();

  get(connectionId: string): OpenRecord | undefined {
    return this.records.get(connectionId);
  }

  /** Stores the record under its connection's id, replacing any record stored there. */
  set(record: OpenRecord): void {
    this.records.set(record.connection.id, record);
  }

  delete(connectionId: string): void {
    this.records.delete(connectionId);
  }

  /** Whether a record is stored for this record's id and is not deep-strict-equal to it. */
  differs(record: OpenRecord): boolean {
    const stored = this.records.get(record.connection.id);
    return stored !== undefined && !isDeepStrictEqual(stored, record);
  }
}

/** The sentence for an id no record is stored under, which the host side reopens on (CONNECTION_NOT_OPEN). */
export function notOpenSentence(connectionId: string): string {
  return `No connection with id "${connectionId}" is open in this LibreDB backend.`;
}
