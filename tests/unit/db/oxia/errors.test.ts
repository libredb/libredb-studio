/**
 * The Oxia provider's one error table (SB1-6): `toOxiaError`, the adapter's half, from a grpc-js status, a runtime
 * error or the call's own abort to an `OxiaError`; `toProviderError`, the provider's half, from an `OxiaError` to the
 * repository's classes with a sentence that carries no server text (SB1-6.2); and the sentences other modules quote.
 *
 * No grpc-js is loaded here: its failures are built as the plain objects grpc-js raises, `{ code, details, metadata }`.
 * Every status carries a server-text canary and a token-shaped canary, and no sentence may hold either.
 */
import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import type { OxiaRpc } from "@/lib/db/providers/keyvalue/oxia/client";
import { OXIA_RECEIVE_CAP_BYTES, OXIA_TYPE } from "@/lib/db/providers/keyvalue/oxia/constants";
import {
  deadlineSeconds,
  namespaceNotFoundSentence,
  OXIA_ADAPTER_INTERNAL_KEY_SENTENCE,
  OXIA_HEALTH_NO_SHARD_MAP,
  OXIA_INDEX_NAME_SENTENCE,
  OXIA_LIST_RECEIVE_CAP_SENTENCE,
  OXIA_LONE_SURROGATE_SENTENCE,
  OXIA_STALLED_PAGE_SENTENCE,
  OxiaError,
  type OxiaErrorCategory,
  type OxiaErrorConnection,
  type OxiaErrorFields,
  type OxiaSnapshotProblem,
  OxiaUnsentStatus,
  receiveCapNotice,
  recordChangedSentence,
  runBudgetNotice,
  silentAssignmentsSentence,
  snapshotInvalidSentence,
  toOxiaError,
  toProviderError,
} from "@/lib/db/providers/keyvalue/oxia/errors";
import { SNAPSHOT_PROBLEM_REASONS, type SnapshotProblem } from "@/lib/db/providers/keyvalue/oxia/routing";

const CANARY = "CANARY-SERVER-TEXT";
/** A token-shaped canary: a JWT with header {"alg":"none"} and payload {"sub":"x"}. */
const TOKEN_CANARY = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"x"}').toString("base64url")}.`;
const status = (code: number, details = `${CANARY} ${TOKEN_CANARY}`) => ({ code, details, metadata: {} });
const CONNECTION: OxiaErrorConnection = {
  host: "oxia.example",
  port: 6648,
  sentAuthority: "oxia.example:6648",
  loopback: false,
  tunnelled: false,
  runtimeReportsTlsCause: true,
  receiveCapBytes: OXIA_RECEIVE_CAP_BYTES,
  timeoutMs: 10_000,
  namespace: "default",
  listsDataServers: false,
};
const word = (error: unknown, operation = "get", connection = CONNECTION) =>
  toProviderError(error, { operation, connection });
const SHARD = { id: "2", leader: "oxia-1.example:6648" };

const aborted = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

/** A runtime error with a system code, as Node raises a socket or TLS failure. */
function systemError(code: string): Error {
  return Object.assign(new Error(`connect ${code} ${CANARY}`), { code });
}

function expectCanaryFree(message: string): void {
  expect(message).not.toContain(CANARY);
  expect(message).not.toContain(TOKEN_CANARY);
}

function expectOxia(error: Error): void {
  expect((error as { provider?: string }).provider as string).toBe("oxia");
}

const SHARD_RPCS: readonly OxiaRpc[] = ["Read", "List", "RangeScan"];
const ALL_RPCS: readonly OxiaRpc[] = ["GetShardAssignments", "Read", "List", "RangeScan", "Health/Check"];

/** The TLS causes of grpc-js's "No connection established. Last error: ..." in Node's and Bun's texts. */
const TLS_CAUSE_TEXTS: ReadonlyArray<readonly [string, OxiaErrorFields["tlsFailure"]]> = [
  [
    "Error: write EPROTO 40B8:error:0A000415:SSL routines:ssl3_read_bytes:sslv3 alert certificate expired",
    "client-certificate-expired",
  ],
  ["Error: write EPROTO alert certificate required", "client-certificate-required"],
  ["Error: write EPROTO alert unknown ca", "client-certificate-refused"],
  ["Error: write EPROTO alert bad certificate", "client-certificate-refused"],
  ["Error [ERR_TLS_CERT_ALTNAME_INVALID]: Hostname/IP does not match certificate's altnames", "name"],
  ["Error: unable to verify the first certificate", "chain"],
  ["Error: self signed certificate", "chain"],
  ["Error: self-signed certificate in certificate chain", "chain"],
  ["Error: unable to get local issuer certificate", "chain"],
  ["Error: write EPROTO wrong version number", "not-tls"],
  ["Error: write EPROTO WRONG_VERSION_NUMBER", "not-tls"],
  ["Error: write EPROTO packet length too long", "not-tls"],
  ["Error: certificate has expired", undefined],
  ["Error: Setting the TLS ServerName to an IP address is not permitted", undefined],
];

describe("toOxiaError: the adapter's half", () => {
  test("100 is not-initialized", () => {
    const error = toOxiaError(status(100), "Read", undefined, SHARD);
    expect(error.category).toBe("not-initialized");
    expect(error.grpcCode).toBe(100);
  });

  test("101, 102, 104, 112, 9 and 10 on a shard are leader-changing with the shard", () => {
    for (const code of [101, 102, 104, 112, 9, 10]) {
      const error = toOxiaError(status(code), "List", undefined, SHARD);
      expect(error.category).toBe("leader-changing");
      expect(error.shardId).toBe("2");
      expect(error.leader).toBe("oxia-1.example:6648");
      expect(error.grpcCode).toBe(code);
    }
  });

  test("the same six without a shard are unknown: a shard row needs a shard", () => {
    for (const code of [101, 102, 104, 112, 9, 10]) {
      const error = toOxiaError(status(code), "GetShardAssignments");
      expect(error.category).toBe("unknown");
      expect(error.grpcCode).toBe(code);
      expect(error.shardId).toBeUndefined();
    }
  });

  test("106 on a shard is not-leader with the shard; without one it is unknown", () => {
    const error = toOxiaError(status(106), "Read", undefined, SHARD);
    expect(error.category).toBe("not-leader");
    expect(error.shardId).toBe("2");
    expect(error.leader).toBe("oxia-1.example:6648");
    expect(toOxiaError(status(106), "GetShardAssignments").category).toBe("unknown");
  });

  test("103 is server-cancelled", () => {
    expect(toOxiaError(status(103), "Read", undefined, SHARD).category).toBe("server-cancelled");
  });

  test("105, 107, 108, 109 and 111 are server-state with the code", () => {
    for (const code of [105, 107, 108, 109, 111]) {
      const error = toOxiaError(status(code), "List", undefined, SHARD);
      expect(error.category).toBe("server-state");
      expect(error.grpcCode).toBe(code);
    }
  });

  test("110 and 5 on GetShardAssignments are namespace-not-found", () => {
    expect(toOxiaError(status(110), "GetShardAssignments").category).toBe("namespace-not-found");
    expect(toOxiaError(status(5), "GetShardAssignments").category).toBe("namespace-not-found");
  });

  test("5 on Read, List and RangeScan with a shard is shard-not-found", () => {
    for (const rpc of SHARD_RPCS) {
      const error = toOxiaError(status(5), rpc, undefined, SHARD);
      expect(error.category).toBe("shard-not-found");
      expect(error.shardId).toBe("2");
    }
  });

  test("5 on Health/Check, or on a shard RPC without its shard, is unknown", () => {
    expect(toOxiaError(status(5), "Health/Check").category).toBe("unknown");
    expect(toOxiaError(status(5), "Read").category).toBe("unknown");
  });

  test("3 is invalid-argument, 7 permission-denied, 12 unimplemented", () => {
    expect(toOxiaError(status(3), "Read", undefined, SHARD).category).toBe("invalid-argument");
    expect(toOxiaError(status(7), "GetShardAssignments").category).toBe("permission-denied");
    expect(toOxiaError(status(12), "GetShardAssignments").category).toBe("unimplemented");
  });

  test("14 with server text is not-initialized", () => {
    expect(toOxiaError(status(14), "GetShardAssignments").category).toBe("not-initialized");
  });

  test("16 is unauthenticated, its cause read from the closed prefix list", () => {
    const rows: ReadonlyArray<readonly [string, OxiaErrorFields["authCause"]]> = [
      ["empty token", "empty-token"],
      ["malformed token: x", "malformed-token"],
      ["unknown issuer x", "unknown-issuer"],
      ["forbidden audience x", "forbidden-audience"],
      ["failed to verify signature: x", "bad-signature"],
      ["oidc: token is expired (Token Expiry: x)", "expired"],
      ["username not found", "no-username"],
      [CANARY, "other"],
    ];
    for (const [details, cause] of rows) {
      const error = toOxiaError(status(16, details), "GetShardAssignments");
      expect(error.category).toBe("unauthenticated");
      expect(error.authCause).toBe(cause);
    }
  });

  test("4 with each pre-send marker and no remote_addr is not-connected", () => {
    for (const marker of ["waiting for name resolution", "waiting for metadata filters", "Waiting for LB pick"]) {
      const error = toOxiaError(status(4, `Deadline exceeded after 3.0s,${marker}`), "Read", undefined, SHARD);
      expect(error.category).toBe("not-connected");
    }
  });

  test("4 after the call started is silent-assignments on GetShardAssignments, else deadline-exceeded", () => {
    const started = status(4, "Deadline exceeded after 3.0s,remote_addr=127.0.0.1:6648");
    expect(toOxiaError(started, "GetShardAssignments").category).toBe("silent-assignments");
    const onShard = toOxiaError(started, "Read", undefined, SHARD);
    expect(onShard.category).toBe("deadline-exceeded");
    expect(onShard.shardId).toBe("2");
    const marked = status(4, "Deadline exceeded after 3.0s,Waiting for LB pick,remote_addr=127.0.0.1:6648");
    expect(toOxiaError(marked, "Read", undefined, SHARD).category).toBe("deadline-exceeded");
  });

  test("1 with the signal aborted is cancelled", () => {
    const error = toOxiaError(status(1, "Cancelled on client"), "Read", aborted(), SHARD);
    expect(error.category).toBe("cancelled");
    expect(error.unsent).toBeUndefined();
    expect(error.grpcCode).toBe(1);
  });

  test("the transport's unsent notice with the signal aborted is cancelled and unsent", () => {
    const unsent = new OxiaUnsentStatus({
      code: 1,
      details: "Cancelled on client",
      message: "1 CANCELLED: Cancelled on client",
    });
    expect(unsent.name).toBe("OxiaUnsentStatus");
    expect(unsent.code).toBe(1);
    expect(unsent.details).toBe("Cancelled on client");
    const error = toOxiaError(unsent, "List", aborted(), SHARD);
    expect(error.category).toBe("cancelled");
    expect(error.unsent).toBe(true);
  });

  test("the signal's own reason, thrown before the request left, is cancelled and unsent", () => {
    const signal = aborted();
    const error = toOxiaError(signal.reason, "Read", signal, SHARD);
    expect(error.category).toBe("cancelled");
    expect(error.unsent).toBe(true);
    expect(error.grpcCode).toBeUndefined();
  });

  test("1 with the signal not aborted is server-cancelled", () => {
    expect(toOxiaError(status(1), "Read", new AbortController().signal, SHARD).category).toBe("server-cancelled");
    expect(toOxiaError(status(1), "Read").category).toBe("server-cancelled");
  });

  test("8: the receive-cap texts, the ping GOAWAY, and any other", () => {
    const cap = toOxiaError(status(8, "Received message larger than max (17000000 vs 16777216)"), "List");
    expect(cap.category).toBe("receive-cap");
    expect(cap.rpc).toBe("List");
    expect(
      toOxiaError(status(8, "Response message decompresses to a size larger than 16777216"), "Read").category,
    ).toBe("receive-cap");
    expect(toOxiaError(status(8, "Bandwidth exhausted or memory limit exceeded"), "Read").category).toBe(
      "connection-dropped",
    );
    const other = toOxiaError(status(8), "Read");
    expect(other.category).toBe("unknown");
    expect(other.grpcCode).toBe(8);
  });

  test("14: grpc-js's local prefixes", () => {
    expect(toOxiaError(status(14, "Connection dropped"), "Read").category).toBe("connection-dropped");
    expect(toOxiaError(status(14, "Channel closed before call started"), "Read").category).toBe("closed");
    expect(toOxiaError(status(14, "Name resolution failed for target dns:nope.example:6648"), "Read").category).toBe(
      "dns",
    );
    const lastError = "No connection established. Last error: ";
    expect(toOxiaError(status(14, `${lastError}Error: getaddrinfo ENOTFOUND nope.example`), "Read").category).toBe(
      "dns",
    );
    expect(toOxiaError(status(14, `${lastError}Error: getaddrinfo EAI_AGAIN nope.example`), "Read").category).toBe(
      "dns",
    );
    expect(toOxiaError(status(14, `${lastError}Error: connect ECONNREFUSED 127.0.0.1:6648`), "Read").category).toBe(
      "refused",
    );
    expect(toOxiaError(status(14, `${lastError}something else`), "Read").category).toBe("not-connected");
  });

  test("14 with each TLS cause is tls with its failure", () => {
    for (const [cause, failure] of TLS_CAUSE_TEXTS) {
      const error = toOxiaError(status(14, `No connection established. Last error: ${cause}`), "GetShardAssignments");
      expect(error.category).toBe("tls");
      expect(error.tlsFailure).toBe(failure);
    }
  });

  test("any other code is unknown with the code", () => {
    const error = toOxiaError(status(2), "Read");
    expect(error.category).toBe("unknown");
    expect(error.grpcCode).toBe(2);
  });

  test("a runtime error's system code", () => {
    const rows: ReadonlyArray<readonly [string, OxiaErrorCategory, OxiaErrorFields["tlsFailure"]]> = [
      ["ECONNREFUSED", "refused", undefined],
      ["ENOTFOUND", "dns", undefined],
      ["EAI_AGAIN", "dns", undefined],
      ["EHOSTUNREACH", "not-connected", undefined],
      ["ENETUNREACH", "not-connected", undefined],
      ["ETIMEDOUT", "not-connected", undefined],
      ["ECONNRESET", "unavailable", undefined],
      ["EPIPE", "unavailable", undefined],
      ["ERR_TLS_CERT_ALTNAME_INVALID", "tls", "name"],
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls", "chain"],
      ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls", "chain"],
      ["SELF_SIGNED_CERT_IN_CHAIN", "tls", "chain"],
      ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls", "chain"],
      ["CERT_HAS_EXPIRED", "tls", undefined],
      ["ERR_SSL_WRONG_VERSION_NUMBER", "tls", "not-tls"],
      ["EWHATEVER", "unknown", undefined],
    ];
    for (const [code, category, failure] of rows) {
      const error = toOxiaError(systemError(code), "Read");
      expect(error.category).toBe(category);
      expect(error.tlsFailure).toBe(failure);
      expect(error.grpcCode).toBeUndefined();
    }
  });

  test("grpc-js's compressed-flag error, with code and details present and undefined, is unknown", () => {
    const flagged = Object.assign(new Error("x"), { code: undefined, details: undefined });
    const error = toOxiaError(flagged, "Read");
    expect(error.category).toBe("unknown");
    expect(error.grpcCode).toBeUndefined();
  });

  test("a value that is not an Error is unknown", () => {
    for (const value of ["a string", 42, undefined]) {
      const error = toOxiaError(value, "Read");
      expect(error.category).toBe("unknown");
      expect(error.grpcCode).toBeUndefined();
    }
  });

  test("an OxiaError passes through as the same object", () => {
    const error = new OxiaError("closed");
    expect(toOxiaError(error, "Read")).toBe(error);
  });

  test("every answer carries the given rpc", () => {
    for (const rpc of ALL_RPCS) {
      expect(toOxiaError(status(2), rpc).rpc).toBe(rpc);
      expect(toOxiaError(systemError("EPIPE"), rpc).rpc).toBe(rpc);
      expect(toOxiaError("x", rpc).rpc).toBe(rpc);
    }
  });

  test("OxiaError names no server text, and a re-wrap keeps every field and adds answered", () => {
    const error = toOxiaError(status(8, "Received message larger than max (1 vs 2)"), "Read", undefined, SHARD);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OxiaError");
    expect(error.message).toBe("The Oxia client failed (receive-cap)");
    const rewrapped = new OxiaError(error.category, { ...error, answered: 3 });
    expect(rewrapped.category).toBe("receive-cap");
    expect(rewrapped.grpcCode).toBe(8);
    expect(rewrapped.rpc).toBe("Read");
    expect(rewrapped.answered).toBe(3);
    expect(Object.keys(rewrapped).sort()).toEqual(["answered", "category", "grpcCode", "name", "rpc"]);
    const full: Required<OxiaErrorFields> = {
      grpcCode: 1,
      unsent: true,
      tlsFailure: "chain",
      authCause: "other",
      answered: 1,
      shardId: "1",
      leader: "a.example:1",
      rpc: "List",
      snapshotProblem: "too-large",
      sentence: "S",
    };
    expect(new OxiaError("unknown", full)).toMatchObject(full);
  });
});

/** An error built for the provider's half. */
const oxia = (category: OxiaErrorCategory, fields?: OxiaErrorFields) => new OxiaError(category, fields);

interface Row {
  readonly name: string;
  readonly error: OxiaError;
  readonly connection?: OxiaErrorConnection;
  readonly operation?: string;
  readonly kind: new (...args: never[]) => Error;
  readonly message: string;
}

const TLS = { serverName: "oxia.example", clientCertificate: false, ca: true };
const UNAUTHENTICATED_SENTENCES: ReadonlyArray<readonly [NonNullable<OxiaErrorFields["authCause"]>, string]> = [
  ["empty-token", "This Oxia server requires a token: paste one under Token."],
  ["malformed-token", "Oxia could not read the Token as a JWT: paste the whole token under Token."],
  [
    "unknown-issuer",
    "Oxia does not trust the issuer of the Token: use a token from an issuer this server is configured for.",
  ],
  [
    "forbidden-audience",
    "The Token was issued for an audience this Oxia server does not accept: use a token issued for this server.",
  ],
  ["bad-signature", "Oxia could not verify the Token's signature: use a token signed by a key this server trusts."],
  ["expired", "The Token expired: paste a current token under Token."],
  [
    "no-username",
    "Oxia accepted the Token's signature but found no user name in it: use a token that carries the claim this server reads as the user name.",
  ],
  ["other", "Oxia refused the Token."],
];

const REFUSED =
  "Nothing accepted a connection at oxia.example:6648: check Host and Port, and that Oxia's public port (6648 by default) is published.";
const NAME = "The certificate does not name oxia.example: connect by a name or address the certificate carries.";

const ROWS: readonly Row[] = [
  {
    name: "not-initialized",
    error: oxia("not-initialized"),
    kind: ConnectionError,
    message:
      "Oxia is not ready to serve this namespace yet: its data server has no shard assignments from the coordinator. Try again shortly.",
  },
  {
    name: "leader-changing",
    error: oxia("leader-changing", { shardId: "2", leader: SHARD.leader }),
    kind: QueryError,
    message: "Shard 2's leadership is changing on the server, so the get stopped: run it again.",
  },
  {
    name: "not-leader",
    error: oxia("not-leader", { shardId: "2", leader: "oxia-1.example:6648" }),
    kind: QueryError,
    message:
      "The data server at oxia-1.example:6648 is no longer the leader of shard 2, so the get stopped: run it again, and Studio reads the shard map afresh.",
  },
  {
    name: "server-cancelled",
    error: oxia("server-cancelled"),
    kind: QueryError,
    message: "The server cancelled the get: run it again.",
  },
  {
    name: "server-state",
    error: oxia("server-state", { grpcCode: 105 }),
    kind: QueryError,
    message: "Oxia answered the get with state error 105, which a read does not expect.",
  },
  {
    name: "namespace-not-found",
    error: oxia("namespace-not-found"),
    connection: { ...CONNECTION, namespace: "Tenant" },
    kind: DatabaseConfigError,
    message:
      "No namespace Tenant on this server (names are case sensitive). Namespace is set on the connection; empty means default, the only namespace of oxia standalone. A cluster's namespaces are in its coordinator configuration.",
  },
  {
    name: "shard-not-found",
    error: oxia("shard-not-found", { shardId: "2" }),
    kind: QueryError,
    message:
      "Shard 2 is not on the server any more (the shard map changed, for example by a split): run it again, and Studio reads the shard map afresh.",
  },
  {
    name: "invalid-argument",
    error: oxia("invalid-argument"),
    kind: QueryError,
    message: "Oxia refused the get's request as invalid.",
  },
  {
    name: "permission-denied",
    error: oxia("permission-denied"),
    kind: ConnectionError,
    message:
      "This Oxia server checks the address clients dial and refused oxia.example:6648: connect by an address its operator allows.",
  },
  {
    name: "unimplemented",
    error: oxia("unimplemented"),
    kind: ConnectionError,
    message:
      "The server at oxia.example:6648 does not serve Oxia's client API: check that Port is the data server's public port (6648 by default), not the admin port (6651) or the metrics port.",
  },
  {
    name: "not-connected, plaintext",
    error: oxia("not-connected"),
    kind: ConnectionError,
    message:
      "No Oxia answered a plaintext connection at oxia.example:6648. If this Oxia serves TLS, choose an SSL mode under SSL / TLS; otherwise check the host, the port and the tunnel.",
  },
  {
    name: "not-connected, TLS, cause reported",
    error: oxia("not-connected"),
    connection: { ...CONNECTION, tls: TLS },
    kind: ConnectionError,
    message:
      "No Oxia answered a TLS connection at oxia.example:6648: check the host, the port, the SSL mode and the tunnel.",
  },
  {
    name: "not-connected, TLS, no cause, a client certificate",
    error: oxia("not-connected"),
    connection: { ...CONNECTION, tls: { ...TLS, clientCertificate: true }, runtimeReportsTlsCause: false },
    kind: ConnectionError,
    message:
      "No TLS connection to Oxia at oxia.example:6648 was established, and this runtime does not report why: check the host, the port, the SSL mode, the client certificate and the tunnel.",
  },
  {
    name: "not-connected, TLS, no cause, no client certificate",
    error: oxia("not-connected"),
    connection: { ...CONNECTION, tls: TLS, runtimeReportsTlsCause: false },
    kind: ConnectionError,
    message:
      "No TLS connection to Oxia at oxia.example:6648 was established, and this runtime does not report why. No client certificate is configured: if this Oxia requires one, add it under SSL / TLS; otherwise check the host, the port, the SSL mode and the tunnel.",
  },
  { name: "refused", error: oxia("refused"), kind: ConnectionError, message: REFUSED },
  {
    name: "refused, loopback",
    error: oxia("refused"),
    connection: { ...CONNECTION, host: "localhost", sentAuthority: "localhost:6648", loopback: true },
    kind: ConnectionError,
    message:
      "Nothing accepted a connection at localhost:6648: check Host and Port, and that Oxia's public port (6648 by default) is published. If Studio runs in a container, localhost is the container itself: use the address of the machine Oxia runs on (with Docker Desktop, host.docker.internal).",
  },
  {
    name: "dns",
    error: oxia("dns"),
    kind: ConnectionError,
    message:
      "Studio could not resolve oxia.example: check Host. If Studio runs in a container, the name must resolve inside that container.",
  },
  {
    name: "tls, chain",
    error: oxia("tls", { tlsFailure: "chain" }),
    connection: { ...CONNECTION, tls: TLS },
    kind: ConnectionError,
    message:
      "The server's certificate is not signed by the CA under SSL / TLS: paste the CA that issued Oxia's certificate.",
  },
  {
    // verify-full with no CA pasted checks the chain against the system roots, so no CA under SSL / TLS failed it
    // (ruling R35).
    name: "tls, chain, no CA pasted",
    error: oxia("tls", { tlsFailure: "chain" }),
    connection: { ...CONNECTION, tls: { ...TLS, ca: false } },
    kind: ConnectionError,
    message:
      "The server's certificate is not signed by a CA this machine trusts: paste the CA that issued Oxia's certificate under SSL / TLS.",
  },
  {
    name: "tls, name",
    error: oxia("tls", { tlsFailure: "name" }),
    connection: { ...CONNECTION, tls: TLS },
    kind: ConnectionError,
    message: NAME,
  },
  {
    name: "tls, name, no TLS view: the host",
    error: oxia("tls", { tlsFailure: "name" }),
    kind: ConnectionError,
    message: NAME,
  },
  {
    name: "tls, name, a cluster",
    error: oxia("tls", { tlsFailure: "name" }),
    connection: { ...CONNECTION, tls: TLS, listsDataServers: true },
    kind: ConnectionError,
    message: `${NAME} A cluster's certificate must also name every data server's advertised host.`,
  },
  {
    name: "tls, not-tls",
    error: oxia("tls", { tlsFailure: "not-tls" }),
    kind: ConnectionError,
    message: "This port did not answer TLS: set SSL mode to disable, or use Oxia's TLS port.",
  },
  {
    name: "tls, client-certificate-required, one configured",
    error: oxia("tls", { tlsFailure: "client-certificate-required" }),
    connection: { ...CONNECTION, tls: { ...TLS, clientCertificate: true } },
    kind: ConnectionError,
    message: "Oxia asked for a client certificate and did not accept the one configured under SSL / TLS.",
  },
  {
    name: "tls, client-certificate-required, none configured",
    error: oxia("tls", { tlsFailure: "client-certificate-required" }),
    connection: { ...CONNECTION, tls: TLS },
    kind: ConnectionError,
    message:
      "This Oxia requires a client certificate, and none is configured: add the client certificate and key under SSL / TLS.",
  },
  {
    name: "tls, client-certificate-refused",
    error: oxia("tls", { tlsFailure: "client-certificate-refused" }),
    kind: ConnectionError,
    message:
      "Oxia refused the client certificate under SSL / TLS: it must be issued for client authentication by the CA Oxia trusts.",
  },
  {
    name: "tls, client-certificate-expired",
    error: oxia("tls", { tlsFailure: "client-certificate-expired" }),
    kind: ConnectionError,
    message:
      "Oxia refused the client certificate under SSL / TLS because it has expired (client certificate expired): paste a current one.",
  },
  {
    name: "tls, no failure",
    error: oxia("tls"),
    kind: ConnectionError,
    message: "The TLS connection to Oxia failed.",
  },
  ...UNAUTHENTICATED_SENTENCES.map(
    ([cause, message]): Row => ({
      name: `unauthenticated, ${cause}`,
      error: oxia("unauthenticated", { authCause: cause }),
      kind: AuthenticationError,
      message,
    }),
  ),
  {
    name: "unauthenticated, expired, the token's own exp read",
    error: oxia("unauthenticated", { authCause: "expired" }),
    connection: { ...CONNECTION, tokenExpiry: "2026-10-04T00:00:00.000Z" },
    kind: AuthenticationError,
    message: "The Token expired at 2026-10-04T00:00:00.000Z: paste a current token under Token.",
  },
  {
    name: "deadline-exceeded",
    error: oxia("deadline-exceeded"),
    kind: TimeoutError,
    message: "The get reached its deadline of 10,000 ms.",
  },
  {
    name: "cancelled",
    error: oxia("cancelled"),
    kind: QueryCancelledError,
    message: "The get was cancelled.",
  },
  {
    name: "cancelled, unsent",
    error: oxia("cancelled", { unsent: true }),
    kind: QueryCancelledError,
    message: "The get was cancelled before Studio sent it.",
  },
  {
    name: "receive-cap on List",
    error: oxia("receive-cap", { rpc: "List" }),
    kind: QueryError,
    message: OXIA_LIST_RECEIVE_CAP_SENTENCE,
  },
  ...(["Read", "RangeScan", "GetShardAssignments"] as const).map(
    (rpc): Row => ({
      name: `receive-cap on ${rpc}`,
      error: oxia("receive-cap", { rpc }),
      kind: QueryError,
      message: "The server sent a message larger than the 16 MiB receive cap during the get.",
    }),
  ),
  {
    name: "unknown, code 8",
    error: oxia("unknown", { grpcCode: 8 }),
    kind: QueryError,
    message: "Oxia refused the get for lack of resources (gRPC code 8).",
  },
  {
    name: "connection-dropped",
    error: oxia("connection-dropped"),
    kind: ConnectionError,
    message: "The connection to Oxia was lost during the get: run it again.",
  },
  {
    name: "unavailable",
    error: oxia("unavailable"),
    kind: ConnectionError,
    message: "The connection to Oxia was lost during the get: run it again.",
  },
  {
    name: "closed",
    error: oxia("closed"),
    kind: ConnectionError,
    message: "This connection to Oxia is closed: connect again.",
  },
  {
    name: "silent-assignments",
    error: oxia("silent-assignments"),
    operation: "connection test",
    kind: ConnectionError,
    message: silentAssignmentsSentence(10),
  },
  ...([...Object.keys(SNAPSHOT_PROBLEM_REASONS), "too-large"] as OxiaSnapshotProblem[]).map(
    (problem): Row => ({
      name: `snapshot-invalid, ${problem}`,
      error: oxia("snapshot-invalid", { snapshotProblem: problem }),
      kind: QueryError,
      message: snapshotInvalidSentence(problem),
    }),
  ),
  {
    name: "leader-refused",
    error: oxia("leader-refused", { sentence: "S" }),
    kind: QueryError,
    message: "S",
  },
  {
    name: "malformed",
    error: oxia("malformed"),
    kind: QueryError,
    message: "Oxia's answer to the get was not in the form Studio reads, so nothing was shown.",
  },
  {
    name: "record-changed",
    error: oxia("record-changed"),
    kind: QueryError,
    message: recordChangedSentence("get"),
  },
  {
    name: "unknown, code 2",
    error: oxia("unknown", { grpcCode: 2 }),
    kind: QueryError,
    message: "The get failed with gRPC code 2.",
  },
  {
    name: "unknown, no code",
    error: oxia("unknown"),
    kind: QueryError,
    message: "The get failed, and the failure carried no gRPC code.",
  },
];

describe("toProviderError: the closed table (SB1-6.3)", () => {
  for (const row of ROWS) {
    test(row.name, () => {
      const answer = word(row.error, row.operation, row.connection);
      expect(answer).toBeInstanceOf(row.kind);
      expect(answer.message).toBe(row.message);
      expectOxia(answer);
    });
  }

  test("a ConnectionError carries the configured host and port", () => {
    const answer = word(oxia("refused")) as ConnectionError;
    expect(answer.host).toBe("oxia.example");
    expect(answer.port).toBe(6648);
  });

  test("under a tunnel the sentences name the configured far end, and permission-denied the sent authority", () => {
    const tunnelled: OxiaErrorConnection = {
      ...CONNECTION,
      host: "oxia.internal",
      sentAuthority: "127.0.0.1:41000",
      tunnelled: true,
    };
    const at = (category: OxiaErrorCategory) => word(oxia(category), "get", tunnelled).message;
    expect(at("refused")).toStartWith("Nothing accepted a connection at oxia.internal:6648:");
    expect(at("unimplemented")).toStartWith("The server at oxia.internal:6648 does not serve");
    expect(at("not-connected")).toStartWith("No Oxia answered a plaintext connection at oxia.internal:6648.");
    expect(at("dns")).toStartWith("Studio could not resolve oxia.internal:");
    expect(at("permission-denied")).toBe(
      "This Oxia server checks the address clients dial and refused 127.0.0.1:41000: connect by an address its operator allows.",
    );
    expect((word(oxia("refused"), "get", tunnelled) as ConnectionError).host).toBe("oxia.internal");
  });

  test("a TimeoutError carries the deadline the call ran under", () => {
    expect((word(oxia("deadline-exceeded")) as TimeoutError).timeout).toBe(10_000);
  });

  test("every category has a row", () => {
    const categories = new Set(ROWS.map((row) => row.error.category));
    const all: readonly OxiaErrorCategory[] = [
      "not-connected",
      "dns",
      "refused",
      "tls",
      "unauthenticated",
      "permission-denied",
      "unimplemented",
      "namespace-not-found",
      "not-initialized",
      "leader-changing",
      "not-leader",
      "shard-not-found",
      "server-cancelled",
      "server-state",
      "invalid-argument",
      "deadline-exceeded",
      "cancelled",
      "receive-cap",
      "connection-dropped",
      "unavailable",
      "closed",
      "silent-assignments",
      "snapshot-invalid",
      "leader-refused",
      "malformed",
      "record-changed",
      "unknown",
    ];
    expect([...categories].sort()).toEqual([...all].sort());
  });

  test("a DatabaseConfigError with no provider gets oxia", () => {
    const answer = word(new DatabaseConfigError("x"));
    expect(answer).toBeInstanceOf(DatabaseConfigError);
    expect(answer.message).toBe("x");
    expectOxia(answer);
    const tagged = new DatabaseConfigError("y", OXIA_TYPE);
    expect(word(tagged)).toBe(tagged);
  });

  test("a QueryError raised by the walks or the adapter passes through", () => {
    const stalled = new QueryError(OXIA_STALLED_PAGE_SENTENCE, OXIA_TYPE);
    expect(word(stalled)).toBe(stalled);
  });

  test("any other Error passes through as itself", () => {
    const defect = new TypeError("x");
    expect(word(defect)).toBe(defect);
  });

  test("a thrown value that is not an Error is a defect", () => {
    const answer = word("x");
    expect(answer).toBeInstanceOf(Error);
    expect(answer).not.toBeInstanceOf(QueryError);
    expect(answer.message).toBe("The Oxia provider received a thrown value that is not an Error.");
  });

  test("every row through the adapter's half keeps the canaries out", () => {
    const codes = [...Array.from({ length: 17 }, (_, code) => code), ...Array.from({ length: 13 }, (_, i) => 100 + i)];
    for (const code of codes) {
      for (const rpc of ALL_RPCS) {
        for (const signal of [undefined, aborted()]) {
          const shard = SHARD_RPCS.includes(rpc) ? SHARD : undefined;
          const answer = word(toOxiaError(status(code), rpc, signal, shard));
          expectCanaryFree(answer.message);
          expectOxia(answer);
        }
      }
    }
    for (const [cause] of TLS_CAUSE_TEXTS) {
      const failure = status(14, `No connection established. Last error: ${cause} ${CANARY} ${TOKEN_CANARY}`);
      expectCanaryFree(word(toOxiaError(failure, "Read", undefined, SHARD)).message);
    }
    expectCanaryFree(word(toOxiaError(systemError("EWHATEVER"), "Read")).message);
  });

  test("deadlineSeconds rounds up, and never below one second", () => {
    expect([0, 1, 1_000, 2_500, 10_000, 10_001].map(deadlineSeconds)).toEqual([1, 1, 1, 3, 10, 11]);
    const answer = word(oxia("silent-assignments"), "connection test", { ...CONNECTION, timeoutMs: 2_500 });
    expect(answer.message).toContain("within 3 s,");
  });

  test("the TLS failures of the adapter's text", () => {
    const expected: Readonly<Record<string, string>> = {
      "client-certificate-expired":
        "Oxia refused the client certificate under SSL / TLS because it has expired (client certificate expired): paste a current one.",
      "client-certificate-required":
        "This Oxia requires a client certificate, and none is configured: add the client certificate and key under SSL / TLS.",
      "client-certificate-refused":
        "Oxia refused the client certificate under SSL / TLS: it must be issued for client authentication by the CA Oxia trusts.",
      name: NAME,
      chain:
        "The server's certificate is not signed by the CA under SSL / TLS: paste the CA that issued Oxia's certificate.",
      "not-tls": "This port did not answer TLS: set SSL mode to disable, or use Oxia's TLS port.",
      none: "The TLS connection to Oxia failed.",
    };
    for (const [cause, failure] of TLS_CAUSE_TEXTS) {
      const failed = status(14, `No connection established. Last error: ${cause}`);
      const answer = word(toOxiaError(failed, "GetShardAssignments"), "connection test", {
        ...CONNECTION,
        tls: TLS,
      });
      expect(answer).toBeInstanceOf(ConnectionError);
      expect(answer.message).toBe(expected[failure ?? "none"]);
    }
  });
});

describe("the sentences other modules quote", () => {
  test("runBudgetNotice", () => {
    expect(runBudgetNotice("range-scan", 3)).toBe(
      "The result stopped after 3 records, at the 8 MiB of keys and values a console result holds: narrow the range, or list the keys and get the values one by one.",
    );
    expect(runBudgetNotice("list", 3)).toBe(
      "The result stopped after 3 keys, at the 8 MiB of keys a console result holds: narrow the range.",
    );
  });

  test("receiveCapNotice", () => {
    expect(receiveCapNotice(3)).toBe(
      "A record in this range is larger than the 16 MiB receive cap, so range-scan stopped after 3 records: list the keys with list, then read each with get, which shows such a value's version and withholds the value.",
    );
  });

  test("recordChangedSentence", () => {
    expect(recordChangedSentence("get")).toBe(
      "The record this get selected changed while this command ran: run it again.",
    );
  });

  test("silentAssignmentsSentence names no restart", () => {
    const sentence = silentAssignmentsSentence(10);
    expect(sentence).toBe(
      "The server accepted the connection but its shard map did not arrive within 10 s, so nothing was read. A data server that has not yet received its shard assignments from the coordinator answers this way: check the coordinator, then try again.",
    );
    expect(sentence).not.toContain("restart");
  });

  test("namespaceNotFoundSentence", () => {
    expect(namespaceNotFoundSentence("Tenant")).toBe(
      "No namespace Tenant on this server (names are case sensitive). Namespace is set on the connection; empty means default, the only namespace of oxia standalone. A cluster's namespaces are in its coordinator configuration.",
    );
  });

  test("snapshotInvalidSentence for each problem", () => {
    const problems = Object.keys(SNAPSHOT_PROBLEM_REASONS) as SnapshotProblem[];
    expect(problems).toHaveLength(9);
    for (const problem of problems) {
      const lead = `The server's shard map is not one Studio can route by (${SNAPSHOT_PROBLEM_REASONS[problem]}), so nothing was read.`;
      expect(snapshotInvalidSentence(problem)).toBe(
        problem === "no-shards" ? `${lead} The namespace may still be starting: try again shortly.` : lead,
      );
    }
    expect(snapshotInvalidSentence("too-large")).toBe(
      "The server's shard map is not one Studio can route by (the shard map is larger than 16 MiB), so nothing was read.",
    );
  });

  test("the six exported constants, verbatim", () => {
    expect(OXIA_STALLED_PAGE_SENTENCE).toBe(
      "A shard's keys are too large for one page of the Keys panel: narrow the walk with a prefix.",
    );
    expect(OXIA_LIST_RECEIVE_CAP_SENTENCE).toBe(
      "The server sent a list message larger than the 16 MiB receive cap: narrow the walk with a prefix.",
    );
    expect(OXIA_HEALTH_NO_SHARD_MAP).toBe("The server answers health but serves no shard map");
    expect(OXIA_ADAPTER_INTERNAL_KEY_SENTENCE).toBe(
      "Keys under __oxia/ are Oxia's own internal records, which Studio does not read.",
    );
    expect(OXIA_LONE_SURROGATE_SENTENCE).toBe(
      "The key holds a lone UTF-16 surrogate, which is not text and names no Oxia key: type it again.",
    );
    expect(OXIA_INDEX_NAME_SENTENCE).toBe('An index name is one word without "/", at most 300 bytes.');
  });
});
