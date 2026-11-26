/**
 * The one ordered open check (issue #2537): what core refuses before a session of any engine opens, read from the
 * engine's record (`EngineRecord` in ./server-catalog), its grants, its connection tables and its offers, and never from
 * a table keyed by type or from who serves the engine. Every engine opens through the one open function (`openEngine`
 * in src/lib/provider-host/open-engine.ts), which runs `assertOpenable` before the record's open, a legacy engine's
 * provider and a package engine's session alike, so one connection is refused by one sentence whichever source serves
 * its engine. The editor's session of a package's record also runs it before its cache key
 * (`getOrCreateEditorSession` in ./factory), on the context it then opens with. Test Connection's one-shot open
 * (`openEngineOnce` in ./factory, read by `testConnection` in src/lib/api/test-connection.ts) runs it through the one
 * open function, in the same turn its budget starts, before anything is awaited.
 *
 * IN THIS ORDER, the first refusal thrown, each a `DatabaseConfigError` naming the engine by `legacyProviderType`
 * (./server-catalog), a legacy record's type and nothing for a package record's:
 *
 * 1. enabled: a set `LIBREDB_ENABLED_PROVIDERS` that leaves the record's id out (`assertProviderEnabled`);
 * 2. read-only: a `readOnly` that is not a boolean, or true where `grants.readOnlyEnforced` is false
 *    (`assertReadOnlyHonoured`);
 * 3. claims: a refusal `grants.ungrantedRefusals` holds (`assertClaimsGranted`);
 * 4. the connection is plain data (`assertConnectionIsPlainData` in ./provider-connection, a present tunnel first);
 * 5. the execution context is plain data (`assertExecutionContextIsPlainData`);
 * 6. an owner without a whole pool size (`assertOwnerPoolHonoured`);
 * 7. a denied file-access posture where `grants.deniedFileAccessRefusal` refuses one;
 * 8. the SSH tunnel: for a record whose `offers.sshTunnel` is true, core's decision with the record's `grants.sshTunnel`
 *    (`assertProviderTunnel` in ./tunnel-decision), a tunnel that is on required to have been opened to connect; for a
 *    record that offers none, a tunnel that is on is refused (`NO_TUNNEL`), and one that is off must hold its `host`
 *    and `username` as text, which the cache key's route frames;
 * 9. host files: for a record whose `offers.hostFiles` is false, a field `grants.hostPathFields` names, set; a record
 *    that offers host files refuses nothing here, since its open admits each file by name after the check;
 * 10. the process's egress decision (./egress-decision), an invalid setting refused;
 * 11. Studio's storage location (`storageLocation` in @/lib/data-dir), taken so the first open of a process with no
 *     boot hook takes it, whatever its engine;
 * 12. to connect only: a field `connection.refused` names, set;
 * 13. to connect only: a required secret the record's field rules declare, left blank (`requiredSecretOf` in
 *     ./connection-field-rules).
 *
 * `purpose` is `"connect"` for an open that may connect, a package's open always, and `"declarations"` for a legacy
 * provider built only to read what it declares (`readProviderDeclarations` in ./factory), which skips 12 and 13 and
 * takes a tunnel that is on and was not opened, since it never signs in and never hands its provider out.
 *
 * Wording reads the record's offers: the read-only and owner-pool sentences name a provider for a record that offers a
 * legacy provider and a provider package's engine or session for one that does not, and the tunnel and host file
 * refusals follow `offers.sshTunnel` and `offers.hostFiles`. Every refusal `assertOpenable` throws is marked not-sent:
 * nothing was opened. The step functions it exports are the ones the factory's entry points also run ahead of their
 * cache key or tunnel (`openWritable`, `acquireExecutionProfileProvider`, `withOneShotTunnel`); there they mark
 * nothing, as before.
 *
 * The record's open refuses further after the check: a legacy build admits the connection's file and host paths and
 * reads trust material (`openLegacyEngine` in src/lib/provider-host/legacy-adapter/open.ts), and a package's open
 * context refuses a value form or a TLS mode it cannot hand on (src/lib/provider-host/open-context.ts).
 */
import { storageLocation } from "@/lib/data-dir";
import { requiredSecretOf } from "./connection-field-rules";
import { egressDecision } from "./egress-decision";
import { enabledProviderTypes } from "./enabled-providers";
import { DatabaseConfigError, markNotSent } from "./errors";
import { assertConnectionIsPlainData, assertExecutionContextIsPlainData } from "./provider-connection";
import { type EngineConnection, type EngineRecord, legacyProviderType } from "./server-catalog";
import { assertProviderTunnel } from "./tunnel-decision";
import type { ProviderExecutionContext } from "./types";

/** The refusal of an SSH tunnel that is on, for an engine whose record offers no tunnel. */
const NO_TUNNEL =
  "This LibreDB Studio opens no SSH tunnel for an engine of a provider package, so it does not open this connection. Turn the tunnel off.";

/** Strips the control characters a log line's framing is made of from a caller-supplied value. */
const sanitize = (value: string) => value.replace(/[\r\n]/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

/** A `DatabaseConfigError` with `sentence`, naming `engine` by its legacy type. */
function refusal(engine: EngineRecord, sentence: string): DatabaseConfigError {
  return new DatabaseConfigError(sentence, legacyProviderType(engine));
}

/** Whether `connection` sets `field` to a value: its own property, neither undefined, null nor empty. */
function sets(connection: EngineConnection, field: string): boolean {
  if (!Object.hasOwn(connection, field)) return false;
  const value: unknown = Reflect.get(connection, field);
  return value !== undefined && value !== null && value !== "";
}

/**
 * Refuse an engine `LIBREDB_ENABLED_PROVIDERS` leaves out, before anything is built, loaded or dialled. Set membership
 * of the record's id: the list names only legacy ids, so a set list refuses every package's engine. Unset or blank
 * refuses nothing; a value that names something other than a type id raises the reader's `DatabaseConfigError`.
 */
export function assertProviderEnabled(engine: EngineRecord): void {
  const enabled = enabledProviderTypes();
  if (enabled === null || enabled.some((type) => type === engine.id)) return;
  throw refusal(engine, `The ${sanitize(engine.id)} provider is not available in this distribution of LibreDB Studio.`);
}

/**
 * Refuse a `readOnly` the engine cannot keep, before anything is built or dialled (#1089).
 *
 * A read-only connection is a promise its provider keeps by refusing every write before any request, so it is accepted
 * only where the record's `grants.readOnlyEnforced` is true, which for a legacy engine is its row of
 * `READ_ONLY_ENFORCED` (./claim-grants). Anywhere else the connection would open able to write under a mode that says
 * it cannot, which is refused rather than ignored. A value that is not a boolean is refused on every engine, because a
 * string read as true on one path and as absent on another is two modes. The message names the field and never echoes
 * the value.
 *
 * It reads the record rather than `getCapabilities()` because it runs before a provider exists, and
 * `tests/unit/db/read-only-enforced-capability.test.ts` holds the map equal to the summary of every provider's
 * `writeReach`.
 *
 * WHERE IT RUNS. In `assertOpenable`, and in the factory's entry points right after the type check, ahead of their
 * cache lookup and of `createSSHTunnel`: those open the tunnel before they build, so a refusal raised only inside the
 * build would dial the bastion for a connection it then refuses. Ahead of the lookup too, because a mode that is not a
 * boolean keys as `read-write` (`providerCacheKey`), so the lookup would hand it the connection's cached read-write
 * provider without refusing it.
 */
export function assertReadOnlyHonoured(engine: EngineRecord, connection: EngineConnection): void {
  const readOnly: unknown = connection.readOnly;
  if (readOnly === undefined) return;
  if (typeof readOnly !== "boolean") throw refusal(engine, "readOnly must be true or false.");
  if (!readOnly || engine.grants.readOnlyEnforced) return;
  const id = sanitize(engine.id);
  throw refusal(
    engine,
    engine.offers.legacyProvider
      ? `readOnly: true is refused for ${id}: its provider does not enforce a read-only mode, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.`
      : `readOnly: true is refused for ${id}: its provider package's engine does not enforce a read-only mode in this LibreDB Studio, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.`,
  );
}

/**
 * Refuse every open of an engine whose claims leave a refusal no grant covers (docs/providers/CONTRACT.md, clause
 * M-54), with the sentence its record's `grants.ungrantedRefusals` holds: an engine whose single-writer file request is
 * not Studio's grant, whose second read-write handle on one file could lose committed rows. It runs right after
 * `assertReadOnlyHonoured`, wherever that function runs, so a refused engine opens no cache entry, tunnel or provider.
 */
export function assertClaimsGranted(engine: EngineRecord): void {
  const sentence = engine.grants.ungrantedRefusals;
  if (sentence !== null) throw refusal(engine, sentence);
}

/**
 * Refuse an owner without a pool size its provider can open with (docs/GOVERNANCE.md#per-user-providers), before
 * anything is built or dialled. An owned provider or session opens its pool with `min: 0` and `max: ownerPoolMax`, so
 * the size must be a whole number from 1: pg would open its default of 10 for 0, NaN or no size at all, and a pool
 * with a negative size never hands out a connection. `editorExecutionContext` always sets the owner and the size
 * together, so the refusal reaches only a context built elsewhere.
 */
export function assertOwnerPoolHonoured(engine: EngineRecord, execution: ProviderExecutionContext): void {
  if (execution.owner === undefined) return;
  const max: unknown = execution.ownerPoolMax;
  if (typeof max === "number" && Number.isInteger(max) && max >= 1) return;
  throw refusal(
    engine,
    `ownerPoolMax must be a whole number from 1 when an owner is given: it is the most connections the owner's ${engine.offers.legacyProvider ? "provider" : "session"} may open.`,
  );
}

/**
 * Refuse a denied file-access posture (`allowExternalFileAccess: false`, the provider's own condition) where the
 * record's `grants.deniedFileAccessRefusal` refuses one, with that sentence, before the storage location, the
 * connection's file or the engine is touched (FND-2 slice 3, docs/SECURITY.md "Embedded file connection boundaries").
 * An absent posture is not a denied one.
 */
function assertFileAccessPostureHonoured(engine: EngineRecord, execution: ProviderExecutionContext): void {
  const sentence = engine.grants.deniedFileAccessRefusal;
  if (sentence !== null && execution.allowExternalFileAccess === false) throw refusal(engine, sentence);
}

/** The tunnel step (8 in the module's docblock): the record's tunnel offer decides which refusal applies. */
function assertTunnelOffered(engine: EngineRecord, connection: EngineConnection, purpose: OpenPurpose): void {
  if (engine.offers.sshTunnel) {
    assertProviderTunnel(connection, engine, purpose === "connect");
    return;
  }
  const tunnel: unknown = connection.sshTunnel;
  if (tunnel === undefined || tunnel === null) return;
  // The tunnel is plain data (step 4), so its fields are read as they stand.
  const { enabled, host, username } = tunnel as Readonly<Record<string, unknown>>;
  if (enabled !== false && enabled !== null && enabled !== undefined) throw refusal(engine, NO_TUNNEL);
  // A tunnel that is off still has its route framed into the key (`tunnelRoute`), which reads both as text.
  if (typeof host !== "string" || typeof username !== "string") {
    throw refusal(engine, "The connection's sshTunnel.host and sshTunnel.username must be text; nothing was sent.");
  }
}

/** The host files step (9 in the module's docblock). */
function assertHostFilesOffered(engine: EngineRecord, connection: EngineConnection): void {
  if (engine.offers.hostFiles) return;
  for (const field of engine.grants.hostPathFields) {
    if (sets(connection, field)) {
      throw refusal(
        engine,
        `This LibreDB Studio admits no host file for an engine of a provider package, so it does not hand on ${field}.`,
      );
    }
  }
}

/** Whether an open may connect (`"connect"`), or only reads a legacy provider's declarations (`"declarations"`). */
export type OpenPurpose = "connect" | "declarations";

/** The steps of `assertOpenable`, in the order of the module's docblock. */
function runOpenChecks(
  engine: EngineRecord,
  connection: EngineConnection,
  execution: ProviderExecutionContext,
  purpose: OpenPurpose,
): void {
  assertProviderEnabled(engine);
  assertReadOnlyHonoured(engine, connection);
  assertClaimsGranted(engine);
  assertConnectionIsPlainData(connection);
  assertExecutionContextIsPlainData(execution);
  assertOwnerPoolHonoured(engine, execution);
  assertFileAccessPostureHonoured(engine, execution);
  assertTunnelOffered(engine, connection, purpose);
  assertHostFilesOffered(engine, connection);
  egressDecision();
  storageLocation();
  if (purpose === "declarations") return;
  for (const [field, sentence] of Object.entries(engine.connection.refused)) {
    if (sets(connection, field)) throw refusal(engine, sentence as string);
  }
  const secret = requiredSecretOf(engine.fieldRules, connection);
  if (secret !== undefined) throw refusal(engine, secret);
}

/**
 * Refuses what core cannot open for `connection` of `engine` under `execution`, before anything is read from the host,
 * keyed or opened; see the module's docblock for the order. Every refusal answers `outcome` `not-sent`.
 *
 * @throws {DatabaseConfigError} Not-sent, with the sentence of the first check that refuses.
 */
export function assertOpenable(
  engine: EngineRecord,
  connection: EngineConnection,
  execution: ProviderExecutionContext,
  purpose: OpenPurpose,
): void {
  try {
    runOpenChecks(engine, connection, execution, purpose);
  } catch (error) {
    markNotSent(error);
    throw error;
  }
}
