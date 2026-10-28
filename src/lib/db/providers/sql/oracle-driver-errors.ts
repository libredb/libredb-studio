import type { AccessRefusal, DriverErrorClassifier } from "@/lib/db/driver-errors/types";

/**
 * What `oracledb` errors say, for `mapDatabaseError` (`src/lib/db/map-database-error.ts`) to classify them: Thin-mode
 * refusals (#538), the error numbers of a refused statement and of a refused caller, and the ORA- words of a connection
 * the listener refused and of a missing table.
 */

/**
 * The one remedy every Thin-mode refusal shares, written once. Both the reason
 * strings below and the constructor's load failures point at the same place, and
 * two prose copies of one instruction drift.
 */
const ORACLE_THICK_MODE_REMEDY =
  "Thick mode is the remedy: set ORACLE_CLIENT_LIB_DIR to an installed Oracle Instant Client " +
  "directory (on Linux the directory must also be on the loader path). See " +
  "docs/providers/oracle.md section 4.4.";

/**
 * Why node-oracledb's Thin mode refused this connection, or `null` if the error
 * is not a Thin-mode refusal at all.
 *
 * These are the messages a DBA turns into "you must use Thick mode", and until
 * #538 only `NJS-138` was recognised. The rest fell through to the generic
 * retryable `ConnectionError`, which tells the operator to try again for a
 * condition that will never clear on its own - the exact defect #228 fixed for
 * `NJS-138`.
 *
 * `message` is expected already lower-cased (`mapDatabaseError` does that once).
 */
export function describeOracleThinModeRefusal(message: string): string | null {
  if (message.includes("njs-138")) {
    return "Oracle server version predates 12.1, which Thin mode does not support";
  }
  if (message.includes("njs-116")) {
    return (
      "the account's password verifier is 10G-only, and Thin mode can only use a 12C verifier. " +
      "A DBA can fix this without Thick mode by resetting the account's password, which writes " +
      "a 12C verifier (given a suitable SQLNET.ALLOWED_LOGON_VERSION_SERVER)"
    );
  }
  if (message.includes("njs-533")) {
    return (
      "the server requires Oracle Native Network Encryption or data integrity checksumming, " +
      "which Thin mode does not implement"
    );
  }
  if (message.includes("njs-529")) {
    // ERR_WALLET_TYPE_NOT_SUPPORTED in the driver's lib/errors.js. Its text says
    // nothing about Thin mode, so the generic substring below never catches it,
    // and it is the one refusal here with a way out that costs nothing: Thin
    // mode reads PEM, so converting the wallet is enough.
    return (
      "Thin mode reads only a PEM wallet, and this one is not PEM (typically an sso-only " +
      "cwallet.sso). Converting it to ewallet.pem avoids Thick mode entirely " +
      "(orapki wallet pkcs12_to_pem, or openssl against the PKCS#12); otherwise use Thick mode, " +
      "which reads the sso wallet as it stands"
    );
  }
  if (message.includes("njs-089")) {
    // Measured against node-oracledb 6.10.0's own source rather than assumed:
    // NJS-089 is raised for CLIENT-side features (heterogeneous pooling in
    // lib/thin/pool.js, some database object types in lib/thin/dbObject.js,
    // Advanced Queuing in aqArray.js and aqBase.js, a few protocol features in
    // withData.js). It is not the code for Kerberos, LDAP naming or a wallet.
    return "this uses a client-side feature Thin mode does not implement";
  }
  if (message.includes("not supported by node-oracledb in thin mode")) {
    return "the driver reports a feature Thin mode does not implement";
  }
  return null;
}

/**
 * What to tell the operator when `initOracleClient({ libDir })` throws.
 *
 * The old message said one thing for every failure - "verify the path points at
 * an installed Instant Client 'lib' directory" - and for the two failures that
 * actually happen that advice is wrong in both directions:
 *
 * - `NJS-045` is not about the path at all. It means this build has no
 *   node-oracledb Thick-mode addon to load, which is a defect of how the app was
 *   packaged, not of anything the operator configured. The operator can stare at
 *   a perfectly good Instant Client directory forever.
 * - `DPI-1047` means the addon loaded and then could not pull in the client
 *   libraries. On Linux that is almost never a wrong path: `libclntsh.so` has no
 *   RUNPATH, so its siblings (`libnnz*.so`, `libclntshcore.so`) are found only
 *   through the system library search path, and node-oracledb's own
 *   documentation says never to rely on `libDir` there.
 *
 * Exported so the mapping is testable without constructing a provider.
 */
export function describeOracleClientLoadFailure(libDir: string, detail: string): string {
  const lower = detail.toLowerCase();
  if (lower.includes("njs-045")) {
    return (
      `This build has no node-oracledb Thick mode binary for ${process.platform}-${process.arch}, ` +
      `so ORACLE_CLIENT_LIB_DIR=${libDir} could not be used: ${detail}. ` +
      "This is a packaging defect of the build, not a problem with the path - the driver's native " +
      "addon is missing or was resolved from a rewritten directory. Report it with the platform and " +
      "architecture above; see docs/providers/oracle.md section 4.4."
    );
  }
  if (lower.includes("dpi-1047")) {
    return (
      `The Oracle Client libraries in ORACLE_CLIENT_LIB_DIR=${libDir} could not be loaded: ${detail}. ` +
      "On Linux the directory must ALSO be on the system library search path - add it to a file under " +
      "/etc/ld.so.conf.d/ and run ldconfig, or set LD_LIBRARY_PATH before Node starts - because " +
      "libclntsh has no RUNPATH and cannot find its own siblings otherwise. On Debian 13 also check " +
      "that libaio.so.1 resolves (the distribution ships libaio.so.1t64 and the client asks for " +
      "libaio.so.1). See docs/providers/oracle.md section 4.4."
    );
  }
  return (
    `Failed to load the Oracle Instant Client from ORACLE_CLIENT_LIB_DIR=${libDir}: ${detail}. ` +
    "Verify the path points at an installed Oracle Instant Client directory " +
    "(Instant Client 19c is required to reach Oracle 11.2 servers); see " +
    "docs/providers/oracle.md section 4.4."
  );
}

/**
 * Oracle error numbers for a statement the server parsed or ran and refused (#1427): unique
 * constraint (1), the `ORA-009xx` parse and name-resolution range, NOT NULL (1400, 1407),
 * invalid number (1722), a value larger than its column (1438, 12899), date format errors
 * (1830 to 1861), check and referential constraints (2290 to 2292) and a PL/SQL compilation
 * error (6550). Insufficient privileges (1031) is an access refusal (`ORACLE_ACCESS_REFUSALS`).
 */
function isOracleStatementError(errorNum: number): boolean {
  return (
    errorNum === 1 ||
    (errorNum >= 900 && errorNum <= 999) ||
    errorNum === 1400 ||
    errorNum === 1407 ||
    errorNum === 1438 ||
    errorNum === 1722 ||
    (errorNum >= 1830 && errorNum <= 1861) ||
    (errorNum >= 2290 && errorNum <= 2292) ||
    errorNum === 6550 ||
    errorNum === 12899
  );
}

/**
 * Oracle error numbers of an access refusal, from Oracle's error help: ORA-01031 insufficient privileges and ORA-01045
 * a user without CREATE SESSION; ORA-01017 an invalid credential, ORA-01005 a null password, ORA-28000 a locked
 * account and ORA-28001 an expired one.
 */
const ORACLE_ACCESS_REFUSALS: ReadonlyMap<number, AccessRefusal> = new Map([
  [1031, "privilege"],
  [1045, "privilege"],
  [1017, "credential"],
  [1005, "credential"],
  [28000, "credential"],
  [28001, "credential"],
]);

/**
 * `oracledb`'s row. Its Thin-mode refusals are read BEFORE the access refusals on purpose: NJS-116 carries no server
 * code and its own text is "password verifier type 0x... is not supported by node-oracledb in Thin mode", so the
 * `password` word would otherwise turn a configuration problem into "wrong credentials" and send the operator to reset
 * something that is not broken. The driver puts its error number in `errorNum` (`900` for `ORA-00900`). ORA-01017 is
 * an access refusal, and its words count where the error carries no code.
 */
export const ORACLE_DRIVER_ERRORS = Object.freeze({
  driver: "oracledb",
  configRefusal: (message: string, error: Error): string | null => {
    const reason = describeOracleThinModeRefusal(message);
    return reason ? `${reason}: ${error.message}. ${ORACLE_THICK_MODE_REMEDY}` : null;
  },
  credentialWords: Object.freeze(["ora-01017"]),
  accessRefusal: (fields) =>
    typeof fields.errorNum === "number" ? ORACLE_ACCESS_REFUSALS.get(fields.errorNum) : undefined,
  carriesCode: (fields) => typeof fields.errorNum === "number",
  statementFault: (fields) =>
    typeof fields.errorNum === "number" && isOracleStatementError(fields.errorNum) ? true : undefined,
  late: (message: string, error: Error) => {
    if (message.includes("ora-12541") || message.includes("ora-12154") || message.includes("tns:")) {
      return { kind: "connection", message: `Failed to connect to Oracle: ${error.message}` };
    }
    if (message.includes("ora-00942")) {
      return { kind: "query", message: `Table or view does not exist: ${error.message}`, keepsPosition: false };
    }
    return undefined;
  },
} satisfies DriverErrorClassifier);
