/**
 * Governance snapshots for the tests of grant enforcement: admitted connections and the effective grants of each
 * subject, built directly instead of loaded, so a test states exactly which subject holds which grant until when.
 *
 * A record has the shape admission gives it (src/lib/governance/admission.ts): the `seed:` id every connection route
 * resolves, `managed: true`, every role, and the server-only `literal` marker. The loader itself, admission and the
 * effective grant rules are tested in tests/unit/lib/governance/snapshot.test.ts and admission.test.ts.
 */
import type { AdmittedConnection } from "@/lib/governance/admission";
import type { EffectiveGrant, GovernanceSnapshot } from "@/lib/governance/state";
import type { ManagedConnection } from "@/lib/seed/types";

/** The read credential of every connection built here. */
export const READ_CREDENTIAL = { user: "reader", password: "example-only-read-password" } as const;
/** The write credential of every connection built here that has one. */
export const WRITE_CREDENTIAL = { user: "writer", password: "example-only-write-password" } as const;

interface ConnectionOptions {
  readonly name?: string;
  /** Give the connection a write credential as well. */
  readonly write?: boolean;
  /** Fields merged into both records, such as a TLS client key or a connection string. */
  readonly extra?: Partial<ManagedConnection>;
}

/** An admitted PostgreSQL connection with a record for its read credential, and for its write credential if asked. */
export function admittedConnection(id: string, options: ConnectionOptions = {}): AdmittedConnection {
  const record = (credential: { readonly user: string; readonly password: string }): ManagedConnection => ({
    id: `seed:${id}`,
    seedId: id,
    name: options.name ?? `Connection ${id}`,
    type: "postgres",
    host: `${id}.db.example.internal`,
    port: 5432,
    database: id,
    environment: "production",
    ...credential,
    ...options.extra,
    managed: true,
    roles: ["*"],
    createdAt: new Date("2026-10-15T08:00:00.000Z"),
    literal: true,
  });
  return { id, read: record(READ_CREDENTIAL), ...(options.write ? { write: record(WRITE_CREDENTIAL) } : {}) };
}

/** One effective grant: what `subject` may do on `connection`, until `expiresAt` in epoch ms, or for good. */
export interface GrantSpec {
  readonly subject: string;
  readonly connection: AdmittedConnection;
  readonly level: "read" | "write";
  readonly expiresAt?: number | null;
}

/** A snapshot that admitted `connections` and holds exactly `grants`, loaded at `loadedAt`. */
export function grantedSnapshot(
  connections: readonly AdmittedConnection[],
  grants: readonly GrantSpec[],
  loadedAt: number = Date.now(),
): GovernanceSnapshot {
  const bySubject = new Map<string, Map<string, EffectiveGrant>>();
  for (const { subject, connection, level, expiresAt = null } of grants) {
    const ofSubject = bySubject.get(subject) ?? new Map<string, EffectiveGrant>();
    ofSubject.set(connection.id, { connection, level, expiresAt });
    bySubject.set(subject, ofSubject);
  }
  return {
    loadedAt,
    contractVersion: 1,
    publishedVersions: [1],
    connections: new Map(connections.map((connection) => [connection.id, connection])),
    skipped: [],
    grants: bySubject,
    revocations: new Map(),
    settings: [],
    canaries: [],
  };
}
