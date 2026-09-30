/**
 * The etcd error table (spec 5.6), driven row by row through `createErrorResponse`.
 *
 * The texts below are etcd's own (SRC `etcd__api_v3rpc_rpctypes_error.go`, R06 section 5) and the
 * grpc-js and runtime texts R07 measured (`07-MEASUREMENTS-grpc.md`: "No connection established"
 * near 1214-1257 and 1397-1444, "waiting for name resolution" near 1272, "Received message larger
 * than max" near 1286, "Cancelled on client" near 1727, "Connection dropped" near 1825 and a
 * post-send "remote_addr=" deadline near 1827). Rows the KE6 captures of Task 2b re-confirm under
 * Node and Bun, and must be re-pinned from them when they land: every "No connection established"
 * row (the TLS causes and Bun's bare "Failed to connect"), the TLS-against-a-plaintext-port row
 * (re-pinned: etcd's port closes the socket before the handshake, which a forward whose far end
 * refused does too, so it names no TLS cause; "wrong version number" is a server that answered
 * with bytes that are not TLS, which R07 did not measure), the pre-send and post-send deadlines,
 * "Connection dropped", the client's receive cap, "no leader" under `hasleader`, and the watch
 * `cancel_reason` forms. The KE6 captures whose details carry an address are read as captured, and
 * each message they give names no address or port but the configured endpoint's (D-T11-12).
 */
import { describe, expect, test } from "bun:test";
import { createErrorResponse } from "@/lib/api/errors";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { EtcdError, type EtcdErrorCategory } from "@/lib/db/providers/keyvalue/etcd/client";
import {
  cancelReasonToEtcdError,
  type EtcdErrorConnection,
  type EtcdErrorContext,
  etcdWords,
  leaseNotFoundError,
  toEtcdError,
  toProviderError,
  watchEndError,
  writeNotApplied,
} from "@/lib/db/providers/keyvalue/etcd/errors";
import { etcdFixture } from "../../../helpers/etcd-fixtures";

const UNKNOWN_OUTCOME = "The write may have been applied: read the key again before you run the command again.";

const PLAINTEXT: EtcdErrorConnection = {
  host: "etcd.test",
  port: 2379,
  runtimeReportsTlsCause: true,
  receiveCapBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000,
};
const TLS_NO_CERT: EtcdErrorConnection = { ...PLAINTEXT, tls: { serverName: "etcd.test", clientCertificate: false } };
const TLS_CERT: EtcdErrorConnection = { ...PLAINTEXT, tls: { serverName: "etcd.test", clientCertificate: true } };

/**
 * A TLS connection whose socket closed before the handshake, as Bun and Node both report it: etcd's
 * plaintext port on a TLS hello (KE6, etcd/error-tls-to-plaintext), and a local listener that
 * accepts and ends the socket, as an SSH tunnel's forward does when its far end refuses
 * (src/lib/ssh/tunnel.ts), measured through the adapter in Task 13's repair.
 */
const CLOSED_BEFORE_HANDSHAKE =
  "No connection established. Last error: Error: Client network socket disconnected before secure TLS connection was established. Resolution note: ";

function read(command = "get", connection: EtcdErrorConnection = PLAINTEXT): EtcdErrorContext {
  return { command, write: false, connection };
}
function write(command = "put", connection: EtcdErrorConnection = PLAINTEXT): EtcdErrorContext {
  return { command, write: true, connection };
}

/** A grpc-js ServiceError as the library rejects with it: `code`, `details`, and a message built from both. */
function grpc(code: number, details: string): Error {
  return Object.assign(new Error(`${code} STATUS: ${details}`), { code, details, metadata: {} });
}

/** A Node system error, as a socket or TLS failure raises it. */
function systemError(code: string): Error {
  return Object.assign(new Error(`${code} happened at 10.9.8.7:2379`), { code });
}

/** An IPv4 literal, an IPv6 literal, a port, and grpc-js's peer field. */
const ADDRESS_LIKE = [
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{1,4}/gi,
  /:\d+\b/g,
  /remote_addr/g,
];

/**
 * What a message holds that reads as an address, a port or one of `names`, once the configured endpoint
 * and TLS identity, which 5.6's sentences may name (D-T11-12), are taken out of it.
 */
function strayAddresses(message: string, connection: EtcdErrorConnection, names: readonly string[] = []): string[] {
  const configured = [`${connection.host}:${connection.port}`, connection.tls?.serverName ?? connection.host];
  const rest = configured.reduce((text, allowed) => text.split(allowed).join(" "), message);
  return [
    ...ADDRESS_LIKE.flatMap((pattern) => rest.match(pattern) ?? []),
    ...names.filter((name) => rest.includes(name)),
  ];
}

async function respond(error: Error): Promise<{ status: number; body: { error: string; retryable?: boolean } }> {
  const response = createErrorResponse(error);
  return { status: response.status, body: await response.json() };
}

describe("toEtcdError: etcd's answers, by code and message together", () => {
  const rows: Array<[number, string, EtcdErrorCategory]> = [
    [14, "etcdserver: no leader", "no-leader"],
    [16, "etcdserver: invalid auth token", "unauthenticated"],
    [3, "etcdserver: user name is empty", "unauthenticated"],
    [3, "etcdserver: revision of auth store is old", "unauthenticated"],
    [3, "etcdserver: authentication failed, invalid user ID or password", "auth-failed"],
    [2, "auth: authentication failed, password was given for no password user", "auth-failed"],
    [7, "etcdserver: permission denied", "permission-denied"],
    [7, "a proxy in front of etcd denied the call", "permission-denied"],
    [11, "etcdserver: mvcc: required revision has been compacted", "compacted"],
    [11, "etcdserver: mvcc: required revision is a future revision", "future-revision"],
    [3, "etcdserver: request is too large", "request-too-large"],
    [8, "grpc: received message larger than max (3145771 vs. 2097152)", "request-too-large"],
    [3, "etcdserver: too many operations in txn request", "too-many-ops"],
    [3, "etcdserver: duplicate key given in txn request", "duplicate-key"],
    [8, "etcdserver: too many requests", "too-many-requests"],
    [8, "etcdserver: mvcc: database space exceeded", "no-space"],
    [8, "Received message larger than max (104976480 vs 4194304)", "resource-exhausted"],
    [5, "etcdserver: requested lease not found", "lease-not-found"],
    [3, "etcdserver: key is not provided", "invalid-argument"],
    [11, "etcdserver: too large lease TTL", "invalid-argument"],
    [9, "etcdserver: authentication is not enabled", "failed-precondition"],
    [9, "etcdserver: user name not found", "failed-precondition"],
    [14, "etcdserver: leader changed", "unavailable"],
    [14, "etcdserver: server stopped", "unavailable"],
    [14, "etcdserver: request timed out", "unavailable"],
    [14, "etcdserver: request timed out, possibly due to previous leader failure", "unavailable"],
    [14, "etcdserver: request timed out, possibly due to connection lost", "unavailable"],
    [14, "etcdserver: request timed out, waiting for the applied index took too long", "unavailable"],
    [14, "Connection dropped", "unavailable"],
    [
      14,
      "No connection established. Last error: Failed to connect (2026-09-30T00:28:17.961Z). Resolution note: ",
      "not-connected",
    ],
    [
      14,
      "No connection established. Last error: Error: connect ECONNREFUSED 127.0.0.1:23793. Resolution note: ",
      "not-connected",
    ],
    [14, "round_robin: No connection established. Last error: null", "not-connected"],
    // grpc-js 1.14.5's own pre-send texts: its DNS resolver's failure (`resolver-dns.ts`), and a call close()
    // found still waiting for its pick (`internal-channel.ts`), measured through the adapter in grpc-client.test.ts.
    [14, "Name resolution failed for target dns:etcd.invalid:2379", "not-connected"],
    [14, "Channel closed before call started", "closed"],
    [4, "Deadline exceeded after 0.000s,waiting for name resolution", "not-connected"],
    [4, "Deadline exceeded after 3.002s,LB pick: 0.001s,Waiting for LB pick", "not-connected"],
    [4, "Deadline exceeded after 0.000s,waiting for metadata filters", "not-connected"],
    [4, "Deadline exceeded after 3.000s,remote_addr=127.0.0.1:23794", "deadline-exceeded"],
    [4, "Deadline exceeded after 3.000s,waiting for name resolution,remote_addr=127.0.0.1:23794", "deadline-exceeded"],
    [4, "etcdserver: context deadline exceeded", "deadline-exceeded"],
    // grpc-go's answer when etcd hands it a raw context error (SRC `v3rpc/util.go` togRPCError).
    [4, "context deadline exceeded", "deadline-exceeded"],
    // grpc-js's bare text (`resolving-call.ts`, `single-subchannel-channel.ts`), with no pre-send marker.
    [4, "Deadline exceeded", "deadline-exceeded"],
    // A CANCELLED the call's own signal did not cause is not the caller's cancel.
    [1, "Cancelled on client", "cancelled-elsewhere"],
    [1, "etcdserver: request canceled", "cancelled-elsewhere"],
    [15, "etcdserver: corrupt cluster", "unknown"],
    [16, "a proxy refused the credentials", "unknown"],
    [8, "some other exhaustion", "unknown"],
    [5, "etcdserver: member not found", "unknown"],
    [2, "grpc: an unknown failure", "unknown"],
  ];
  for (const [code, details, category] of rows) {
    test(`${code} "${details}" is ${category}, keeping the code and the text`, () => {
      const mapped = toEtcdError(grpc(code, details));
      expect(mapped).toBeInstanceOf(EtcdError);
      expect(mapped.category).toBe(category);
      expect(mapped.detail).toBe(details);
      expect(mapped.grpcCode).toBe(code);
      expect(mapped.tlsFailure).toBeUndefined();
    });
  }

  test("an etcd text under a code etcd does not give it is not that answer", () => {
    expect(toEtcdError(grpc(3, "etcdserver: no leader")).category).toBe("invalid-argument");
    expect(toEtcdError(grpc(14, "etcdserver: invalid auth token")).category).toBe("unavailable");
    expect(toEtcdError(grpc(9, "etcdserver: request is too large")).category).toBe("failed-precondition");
  });

  test("an EtcdError passes through as the same object", () => {
    const error = new EtcdError("closed", "The client is closed");
    expect(toEtcdError(error)).toBe(error);
  });
});

describe("toEtcdError: TLS causes inside grpc-js's 'No connection established' (spec E5)", () => {
  const rows: Array<[string, EtcdError["tlsFailure"]]> = [
    ["Error: unable to verify the first certificate", "chain"],
    [
      "Error: unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca",
      "chain",
    ],
    ["Error: self-signed certificate", "chain"],
    ["Error: unable to get local issuer certificate", "chain"],
    [
      "Error [ERR_TLS_CERT_ALTNAME_INVALID]: Hostname/IP does not match certificate's altnames: IP: 10.0.0.6 is not in the cert's list: 10.0.0.5",
      "name",
    ],
    [
      "00B2EF4F0A7F0000:error:0A00045C:SSL routines:ssl3_read_bytes:tlsv13 alert certificate required:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:918:SSL alert number 116\n (2026-09-30T00:28:27.834Z)",
      "client-certificate-required",
    ],
    [
      "00B2EF4F0A7F0000:error:0A000418:SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:918:SSL alert number 48\n (2026-09-30T00:28:27.852Z)",
      "client-certificate-refused",
    ],
    ["error:0A000412:SSL routines::sslv3 alert bad certificate", "client-certificate-refused"],
    ["error:0A00010B:SSL routines::wrong version number", "not-tls"],
    ["error:0A0000C6:SSL routines::packet length too long", "not-tls"],
    ["Error: certificate has expired", undefined],
    [
      "TypeError [ERR_INVALID_ARG_VALUE]: The property 'options.servername' Setting the TLS ServerName to an IP address is not permitted.. Received '127.0.0.1'",
      undefined,
    ],
  ];
  for (const [lastError, failure] of rows) {
    test(`"${lastError.slice(0, 60)}" is a tls failure of ${failure ?? "no named part"}`, () => {
      const details = `No connection established. Last error: ${lastError}. Resolution note: `;
      const mapped = toEtcdError(grpc(14, details));
      expect(mapped.category).toBe("tls");
      expect(mapped.tlsFailure).toBe(failure);
      expect(mapped.detail).toBe(details);
      expect(mapped.grpcCode).toBe(14);
    });
  }

  test("a TLS text outside 'No connection established' is not read as a TLS failure", () => {
    expect(toEtcdError(grpc(14, "unable to verify the first certificate")).category).toBe("unavailable");
  });

  test("a socket closed before the handshake names no TLS cause: etcd's plaintext port and a refused forward close it alike", () => {
    const mapped = toEtcdError(grpc(14, CLOSED_BEFORE_HANDSHAKE));
    expect(mapped.category).toBe("not-connected");
    expect(mapped.tlsFailure).toBeUndefined();
    expect(mapped.detail).toBe(CLOSED_BEFORE_HANDSHAKE);
    expect(mapped.grpcCode).toBe(14);
  });
});

describe("toEtcdError: the call's own abort, told apart by the signal's reason (spec 5.6)", () => {
  test("a CANCELLED answer under a signal aborted by its timeout is a deadline", () => {
    const controller = new AbortController();
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const mapped = toEtcdError(grpc(1, "Cancelled on client"), controller.signal);
    expect(mapped.category).toBe("deadline-exceeded");
    expect(mapped.detail).toBe("Cancelled on client");
    expect(mapped.grpcCode).toBe(1);
  });

  test("a CANCELLED answer under a signal aborted for any other reason is a cancel", () => {
    const controller = new AbortController();
    controller.abort();
    expect(toEtcdError(grpc(1, "Cancelled on client"), controller.signal).category).toBe("cancelled");
  });

  test("the signal's own reason, rejected before any call, is classified by that reason", () => {
    const timedOut = new AbortController();
    const reason = new DOMException("The operation timed out.", "TimeoutError");
    timedOut.abort(reason);
    const mapped = toEtcdError(reason, timedOut.signal);
    expect(mapped.category).toBe("deadline-exceeded");
    expect(mapped.detail).toBe("The operation timed out.");
    expect(mapped.grpcCode).toBeUndefined();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(toEtcdError(cancelled.signal.reason, cancelled.signal).category).toBe("cancelled");
  });

  test("an answer other than CANCELLED under an aborted signal keeps its own classification", () => {
    const controller = new AbortController();
    controller.abort();
    expect(toEtcdError(grpc(7, "etcdserver: permission denied"), controller.signal).category).toBe("permission-denied");
  });

  test("a CANCELLED answer under a signal that did not abort is not the caller's cancel", () => {
    const timedOut = new AbortController();
    expect(toEtcdError(grpc(1, "Cancelled on client"), timedOut.signal).category).toBe("cancelled-elsewhere");
  });
});

describe("toEtcdError: runtime socket and TLS errors, by their code", () => {
  const rows: Array<[string, EtcdErrorCategory, EtcdError["tlsFailure"]]> = [
    ["ECONNREFUSED", "not-connected", undefined],
    ["ENOTFOUND", "not-connected", undefined],
    ["EHOSTUNREACH", "not-connected", undefined],
    ["ENETUNREACH", "not-connected", undefined],
    ["EAI_AGAIN", "not-connected", undefined],
    ["ECONNRESET", "unavailable", undefined],
    ["EPIPE", "unavailable", undefined],
    ["ETIMEDOUT", "unavailable", undefined],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls", "name"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls", "chain"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls", "chain"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "tls", "chain"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls", "chain"],
    ["CERT_HAS_EXPIRED", "tls", undefined],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "tls", "not-tls"],
  ];
  for (const [code, category, failure] of rows) {
    test(`${code} is ${category}${failure ? ` (${failure})` : ""}, carrying the code and not the address`, () => {
      const mapped = toEtcdError(systemError(code));
      expect(mapped.category).toBe(category);
      expect(mapped.tlsFailure).toBe(failure);
      expect(mapped.detail).toBe(code);
      expect(mapped.grpcCode).toBeUndefined();
    });
  }

  test("a system error with a code this table does not name is unknown, keeping the code and the message", () => {
    const mapped = toEtcdError(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    expect(mapped.category).toBe("unknown");
    expect(mapped.detail).toBe("ENOSPC: disk full");
    const inherited = toEtcdError(Object.assign(new Error("odd"), { code: "toString" }));
    expect(inherited).toMatchObject({ category: "unknown", detail: "toString: odd" });
  });

  test("anything else is unknown, with its message or its text", () => {
    expect(toEtcdError(new TypeError("x is undefined"))).toMatchObject({
      category: "unknown",
      detail: "x is undefined",
    });
    expect(toEtcdError("a thrown string")).toMatchObject({ category: "unknown", detail: "a thrown string" });
    expect(toEtcdError({ code: "not-a-status-code" })).toMatchObject({
      category: "unknown",
      detail: "[object Object]",
    });
  });
});

describe("cancelReasonToEtcdError: a watch cancelled in-band (spec 5.3, E4)", () => {
  test("reads grpc-go's 'rpc error: code = <Code> desc = <message>' form by its code and message", () => {
    const rows: Array<[string, EtcdErrorCategory, number]> = [
      ["rpc error: code = Unauthenticated desc = etcdserver: invalid auth token", "unauthenticated", 16],
      ["rpc error: code = InvalidArgument desc = etcdserver: revision of auth store is old", "unauthenticated", 3],
      ["rpc error: code = InvalidArgument desc = etcdserver: user name is empty", "unauthenticated", 3],
      ["rpc error: code = PermissionDenied desc = etcdserver: permission denied", "permission-denied", 7],
      ["rpc error: code = Canceled desc = etcdserver: watch canceled", "cancelled-elsewhere", 1],
      ["rpc error: code = Unknown desc = something new", "unknown", 2],
      ["rpc error: code = NotACode desc = etcdserver: permission denied", "unknown", 2],
      ["rpc error: code = constructor desc = etcdserver: permission denied", "unknown", 2],
    ];
    for (const [reason, category, code] of rows) {
      const mapped = cancelReasonToEtcdError(reason);
      expect(mapped.category).toBe(category);
      expect(mapped.grpcCode).toBe(code);
      expect(mapped.detail).toBe(reason.slice(reason.indexOf(" desc = ") + 8));
    }
  });

  test("reads a bare etcd message by the code etcd gives it", () => {
    const mapped = cancelReasonToEtcdError("etcdserver: mvcc: required revision has been compacted");
    expect(mapped).toMatchObject({ category: "compacted", grpcCode: 11 });
    expect(cancelReasonToEtcdError("etcdserver: invalid auth token")).toMatchObject({
      category: "unauthenticated",
      grpcCode: 16,
    });
  });

  test("a bare text etcd does not define is unknown, kept verbatim", () => {
    const mapped = cancelReasonToEtcdError("the watcher went away");
    expect(mapped.category).toBe("unknown");
    expect(mapped.detail).toBe("the watcher went away");
    expect(mapped.grpcCode).toBeUndefined();
  });
});

describe("toProviderError: the connection classes (ConnectionError, 503, retryable)", () => {
  test("a plaintext channel no etcd answered names the endpoint and says TLS may be missing", async () => {
    const error = toEtcdError(
      grpc(14, "No connection established. Last error: Failed to connect (t). Resolution note: "),
    );
    const mapped = toProviderError(error, write());
    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toBe(
      "No etcd answered a plaintext connection at etcd.test:2379. If this etcd serves TLS (kubeadm and k3s always do), choose an SSL mode under SSL / TLS; otherwise check the host, the port and the tunnel. (No connection established. Last error: Failed to connect (t). Resolution note: )",
    );
    expect(mapped).toMatchObject({ provider: "etcd", host: "etcd.test", port: 2379 });
    expect(await respond(mapped)).toMatchObject({ status: 503, body: { retryable: true } });
  });

  test("an IPv6 endpoint is written bracketed", () => {
    const mapped = toProviderError(
      new EtcdError("not-connected", "ECONNREFUSED"),
      read("get", { ...PLAINTEXT, host: "::1" }),
    );
    expect(mapped.message).toStartWith("No etcd answered a plaintext connection at [::1]:2379.");
  });

  test("a TLS channel no etcd answered, where the runtime reports the cause", () => {
    const mapped = toProviderError(new EtcdError("not-connected", "ECONNREFUSED"), read("get", TLS_NO_CERT));
    expect(mapped.message).toBe(
      "No etcd answered a TLS connection at etcd.test:2379: check the host, the port, the SSL mode and the tunnel. (ECONNREFUSED)",
    );
  });

  test("under a runtime that reports no TLS cause (Bun), a missing client certificate is named from the configuration", () => {
    const connection = { ...TLS_NO_CERT, runtimeReportsTlsCause: false };
    const mapped = toProviderError(new EtcdError("not-connected", "Failed to connect"), read("get", connection));
    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toBe(
      "No TLS connection to etcd at etcd.test:2379 was established, and this runtime does not report why. No client certificate is configured: if this etcd requires one (--client-cert-auth), add it under SSL / TLS; otherwise check the host, the port, the SSL mode and the tunnel. (Failed to connect)",
    );
  });

  test("a socket closed before the handshake names the host, the port, the SSL mode and the tunnel, never a port without TLS", () => {
    const error = toEtcdError(grpc(14, CLOSED_BEFORE_HANDSHAKE));
    const sentences: Array<[EtcdErrorConnection, string]> = [
      [
        TLS_NO_CERT,
        "No etcd answered a TLS connection at etcd.test:2379: check the host, the port, the SSL mode and the tunnel.",
      ],
      [
        { ...TLS_NO_CERT, runtimeReportsTlsCause: false },
        "No TLS connection to etcd at etcd.test:2379 was established, and this runtime does not report why. No client certificate is configured: if this etcd requires one (--client-cert-auth), add it under SSL / TLS; otherwise check the host, the port, the SSL mode and the tunnel.",
      ],
    ];
    for (const [connection, sentence] of sentences) {
      const mapped = toProviderError(error, write("put", connection));
      expect(mapped).toBeInstanceOf(ConnectionError);
      expect(mapped.message).toBe(`${sentence} (${CLOSED_BEFORE_HANDSHAKE})`);
    }
  });

  test("under a runtime that reports no TLS cause, with a client certificate configured", () => {
    const connection = { ...TLS_CERT, runtimeReportsTlsCause: false };
    const mapped = toProviderError(new EtcdError("not-connected", "Failed to connect"), read("get", connection));
    expect(mapped.message).toBe(
      "No TLS connection to etcd at etcd.test:2379 was established, and this runtime does not report why: check the host, the port, the SSL mode, the certificates and the tunnel. (Failed to connect)",
    );
  });

  const tlsRows: Array<[EtcdError["tlsFailure"], EtcdErrorConnection, string]> = [
    ["chain", TLS_NO_CERT, "The server's certificate is not signed by the CA under SSL / TLS: paste the etcd CA."],
    [
      "name",
      { ...TLS_NO_CERT, tls: { serverName: "10.0.0.5", clientCertificate: false } },
      "The certificate does not name 10.0.0.5: connect by a name or address the certificate carries.",
    ],
    ["not-tls", TLS_NO_CERT, "This port did not answer TLS: set SSL mode to disable, or use etcd's TLS port."],
    [
      "client-certificate-required",
      TLS_NO_CERT,
      "This etcd requires a client certificate (--client-cert-auth), and none is configured: add the client certificate and key under SSL / TLS (shown in verify-ca and verify-full).",
    ],
    [
      "client-certificate-required",
      TLS_CERT,
      "etcd asked for a client certificate and did not accept the one configured under SSL / TLS.",
    ],
    [
      "client-certificate-refused",
      TLS_CERT,
      "etcd refused the client certificate under SSL / TLS: it must be issued by the CA etcd trusts for clients (--trusted-ca-file).",
    ],
    [undefined, TLS_NO_CERT, "The TLS connection to etcd failed."],
  ];
  for (const [failure, connection, sentence] of tlsRows) {
    test(`a TLS failure of ${failure ?? "no named part"} carries the provider's sentence, then the runtime's text`, async () => {
      const mapped = toProviderError(new EtcdError("tls", "runtime text", 14, failure), write("put", connection));
      expect(mapped).toBeInstanceOf(ConnectionError);
      expect(mapped.message).toBe(`${sentence} (runtime text)`);
      expect(await respond(mapped)).toMatchObject({ status: 503, body: { retryable: true } });
    });
  }

  test("a name failure on a plaintext connection names the host, since there is no TLS identity", () => {
    const mapped = toProviderError(new EtcdError("tls", "x", 14, "name"), read());
    expect(mapped.message).toStartWith("The certificate does not name etcd.test:");
  });

  for (const context of [read(), write()]) {
    test(`no leader is a lost quorum for a ${context.write ? "write" : "read"}, since nothing was applied`, async () => {
      const mapped = toProviderError(toEtcdError(grpc(14, "etcdserver: no leader")), context);
      expect(mapped).toBeInstanceOf(ConnectionError);
      expect(mapped.message).toBe(
        "The etcd member this connection reaches has no leader: the cluster has lost quorum, so nothing was applied. Bring the stopped members back, then run the command again. (etcd: no leader)",
      );
      expect(await respond(mapped)).toMatchObject({ status: 503, body: { retryable: true } });
    });
  }

  test("every Unavailable a read meets is a ConnectionError", async () => {
    const mapped = toProviderError(toEtcdError(grpc(14, "etcdserver: request timed out")), read("get"));
    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toBe("etcd did not answer the get. (etcd: request timed out)");
    expect(await respond(mapped)).toMatchObject({ status: 503, body: { retryable: true } });
  });

  test("a closed client is a ConnectionError", () => {
    const mapped = toProviderError(new EtcdError("closed", "The client is closed"), write());
    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toBe("This connection to etcd is closed: connect again. (The client is closed)");
  });
});

describe("toProviderError: a write whose outcome is unknown (QueryError, 400, no retryable)", () => {
  const rows: Array<[string, EtcdError, string]> = [
    [
      "Connection dropped",
      toEtcdError(grpc(14, "Connection dropped")),
      "etcd did not confirm the put: the connection failed after the request was sent. (Connection dropped)",
    ],
    [
      "request timed out",
      toEtcdError(grpc(14, "etcdserver: request timed out")),
      "etcd did not confirm the put: the connection failed after the request was sent. (etcd: request timed out)",
    ],
    [
      "server stopped",
      toEtcdError(grpc(14, "etcdserver: server stopped")),
      "etcd did not confirm the put: the connection failed after the request was sent. (etcd: server stopped)",
    ],
    [
      "a reset socket",
      toEtcdError(systemError("ECONNRESET")),
      "etcd did not confirm the put: the connection failed after the request was sent. (ECONNRESET)",
    ],
    [
      "a post-send deadline",
      toEtcdError(grpc(4, "Deadline exceeded after 3.000s,remote_addr=127.0.0.1:23794")),
      // The peer is dropped: through a tunnel it is the local forward (D-T11-12).
      "The put reached its deadline before etcd answered. (Deadline exceeded after 3.000s)",
    ],
    [
      "grpc-go's context deadline",
      toEtcdError(grpc(4, "context deadline exceeded")),
      "The put reached its deadline before etcd answered. (context deadline exceeded)",
    ],
    [
      "grpc-js's bare deadline",
      toEtcdError(grpc(4, "Deadline exceeded")),
      "The put reached its deadline before etcd answered. (Deadline exceeded)",
    ],
    [
      "etcd's request canceled",
      toEtcdError(grpc(1, "etcdserver: request canceled")),
      "The put was cancelled after it was sent. (etcd: request canceled)",
    ],
    [
      "a renewal answer, until KE12 shows it was not applied",
      toEtcdError(grpc(16, "etcdserver: invalid auth token")),
      "etcd did not accept this connection's sign-in for the put. (etcd: invalid auth token)",
    ],
    [
      "an answer outside the closed list",
      toEtcdError(grpc(5, "etcdserver: requested lease not found")),
      "etcd answered the put: lease not found or expired. (etcd: requested lease not found)",
    ],
    [
      "an unclassified answer",
      toEtcdError(grpc(15, "etcdserver: corrupt cluster")),
      "The put failed. (etcd: corrupt cluster)",
    ],
    [
      "a compacted revision",
      toEtcdError(grpc(11, "etcdserver: mvcc: required revision has been compacted")),
      "The put asked for a revision etcd has compacted: ask for a later revision. (etcd: mvcc: required revision has been compacted)",
    ],
  ];
  for (const [name, error, lead] of rows) {
    test(`${name}: the provider's words, etcd's, then that the write may have been applied`, async () => {
      const mapped = toProviderError(error, write("put"));
      expect(mapped).toBeInstanceOf(QueryError);
      expect(mapped.message).toBe(`${lead} ${UNKNOWN_OUTCOME}`);
      const response = await respond(mapped);
      expect(response.status).toBe(400);
      expect(response.body.retryable).toBeUndefined();
      expect(response.body.error).toBe(mapped.message);
    });
  }

  test("a cancel of a write in flight is an unknown outcome, never a QueryCancelledError", () => {
    const controller = new AbortController();
    controller.abort();
    const mapped = toProviderError(toEtcdError(grpc(1, "Cancelled on client"), controller.signal), write("del"));
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped.message).toBe(`The del was cancelled after it was sent. (Cancelled on client) ${UNKNOWN_OUTCOME}`);
  });

  test("a write that never left the client is a ConnectionError, not an unknown outcome", () => {
    const pre = toEtcdError(grpc(4, "Deadline exceeded after 0.000s,waiting for name resolution"));
    const mapped = toProviderError(pre, write("put"));
    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).not.toContain(UNKNOWN_OUTCOME);
  });

  test("the answers of the closed list carry no unknown-outcome sentence: etcd refused them before applying", () => {
    const closedList = [
      grpc(3, "etcdserver: request is too large"),
      grpc(8, "grpc: received message larger than max (3145771 vs. 2097152)"),
      grpc(3, "etcdserver: too many operations in txn request"),
      grpc(3, "etcdserver: duplicate key given in txn request"),
      grpc(8, "etcdserver: too many requests"),
      grpc(7, "etcdserver: permission denied"),
    ];
    for (const answer of closedList) {
      const mapped = toProviderError(toEtcdError(answer), write("put"));
      expect(mapped).toBeInstanceOf(QueryError);
      expect(mapped.message).not.toContain(UNKNOWN_OUTCOME);
    }
  });

  test("spec 5.6: 'database space exceeded' carries the sentence, and 'request is too large' does not", () => {
    const space = toProviderError(toEtcdError(grpc(8, "etcdserver: mvcc: database space exceeded")), write("put"));
    expect(space.message).toBe(
      `etcd's database is over its space quota. (etcd: mvcc: database space exceeded) An admin compacts history, defragments every member that alarm list names, one at a time through a connection to each member, and then disarms the alarm, from the Global Operations cards of Admin > Operations. ${UNKNOWN_OUTCOME}`,
    );
    const timedOut = toProviderError(toEtcdError(grpc(14, "etcdserver: request timed out")), write("put"));
    expect(timedOut.message).toEndWith(UNKNOWN_OUTCOME);
    const tooLarge = toProviderError(toEtcdError(grpc(3, "etcdserver: request is too large")), write("put"));
    expect(tooLarge.message).toBe(
      "etcd refused the put: the request is larger than etcd accepts. (etcd: request is too large)",
    );
  });
});

describe("toProviderError: no address from a runtime or grpc-js text, directly or through a tunnel (D-T11-12)", () => {
  /**
   * The KE6 error captures whose details carry an address, found by an IPv4 literal, ::1 or remote_addr= in
   * tests/fixtures/etcd: each channel dialled a loopback address, as a tunnel's local forward is one, at the
   * port given here. The last column is what the detail tells the user once its address is gone.
   */
  const captures: ReadonlyArray<readonly [string, number, "plaintext" | "tls", string, readonly string[]]> = [
    ["transport/error-refused.bun", 39011, "plaintext", "ECONNREFUSED", []],
    ["transport/error-refused.node", 39011, "plaintext", "ECONNREFUSED", []],
    ["etcd/error-deadline-after-send.bun", 2379, "plaintext", "Deadline exceeded after 1.000s", []],
    ["etcd/error-deadline-after-send.node", 2379, "plaintext", "Deadline exceeded after 1.001s", []],
    // Member 3 of the cluster, at 127.0.0.4: Bun sent the call, so grpc-js names the peer after its LB pick.
    [
      "etcd-cluster/error-deadline-before-pick.bun",
      2379,
      "plaintext",
      "Deadline exceeded after 1.501s,LB pick: 0.001s",
      [],
    ],
    // The altname check names the certificate's DNS names and IPs, and the name it was asked for.
    [
      "etcd-auth/error-tls-name.bun",
      2379,
      "tls",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      ["localhost", "etcd-auth", "etcd-wrong-name"],
    ],
    [
      "etcd-auth/error-tls-name.node",
      2379,
      "tls",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      ["localhost", "etcd-auth", "etcd-wrong-name"],
    ],
  ];
  /** A direct connection names the host it dialled; through a tunnel the configured far end is another host and port. */
  const shapes = (port: number, channel: "plaintext" | "tls"): ReadonlyArray<readonly [string, EtcdErrorConnection]> =>
    [
      ["directly", { ...PLAINTEXT, host: "etcd.test", port }],
      ["through a tunnel", { ...PLAINTEXT, host: "etcd.internal", port: 12379 }],
    ].map(([shape, connection]) => {
      const facts = connection as EtcdErrorConnection;
      return [
        shape as string,
        channel === "tls" ? { ...facts, tls: { serverName: facts.host, clientCertificate: false } } : facts,
      ] as const;
    });

  for (const [name, port, channel, reduced, names] of captures) {
    for (const [shape, connection] of shapes(port, channel)) {
      for (const context of [read("get", connection), write("put", connection)]) {
        test(`${name}, ${shape}, for a ${context.write ? "write" : "read"}: the configured endpoint only, and the detail's words`, () => {
          const detail = (etcdFixture<Error>(name) as Error & { details: string }).details;
          // The premise: the capture carries the loopback address this rule keeps out.
          expect(detail).toMatch(/\b127(?:\.\d{1,3}){3}\b/);
          const mapped = toProviderError(toEtcdError(etcdFixture(name)), context);
          expect(mapped.message).toContain(` (${reduced})`);
          expect(strayAddresses(mapped.message, connection, names)).toEqual([]);
        });
      }
    }
  }

  test("a refused connection still names the configured endpoint, directly and through a tunnel", () => {
    const refused = toEtcdError(etcdFixture("transport/error-refused.node"));
    expect(toProviderError(refused, read("get", { ...PLAINTEXT, port: 39011 })).message).toStartWith(
      "No etcd answered a plaintext connection at etcd.test:39011.",
    );
    expect(toProviderError(refused, read("get", { ...PLAINTEXT, host: "10.0.0.5" })).message).toStartWith(
      "No etcd answered a plaintext connection at 10.0.0.5:2379.",
    );
  });

  test.each([
    ["an Error's text", "Error: connect ECONNREFUSED 10.0.0.5:2379", "ECONNREFUSED"],
    // A socket error on the HTTP/2 session: its message and a timestamp (grpc-js transport.ts), as Task 13 met it.
    ["a session error's message", "connect ECONNRESET 127.0.0.1:42919 (2026-09-30T16:31:03.606Z)", "ECONNRESET"],
    ["a name lookup", "Error: getaddrinfo ENOTFOUND etcd.internal", "ENOTFOUND"],
    ["a lookup that may succeed later", "Error: getaddrinfo EAI_AGAIN etcd.internal", "EAI_AGAIN"],
    [
      "a Node error naming its code in brackets",
      "Error [ERR_TLS_CERT_ALTNAME_INVALID]: Hostname/IP does not match certificate's altnames: IP: 10.0.0.6 is not in the cert's list: 10.0.0.5",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ],
    [
      "a TypeError naming its code in brackets",
      "TypeError [ERR_INVALID_ARG_VALUE]: The property 'options.servername' Setting the TLS ServerName to an IP address is not permitted.. Received '127.0.0.1'",
      "ERR_INVALID_ARG_VALUE",
    ],
  ])("a runtime error grpc-js carries as its last error, %s, is its system code alone", (_label, lastError, code) => {
    const pickFirst = `No connection established. Last error: ${lastError}. Resolution note: `;
    const roundRobin = `round_robin: No connection established. Last error: ${lastError}`;
    for (const details of [pickFirst, roundRobin]) {
      for (const context of [read("get", TLS_NO_CERT), write("put", TLS_NO_CERT)]) {
        const mapped = toProviderError(toEtcdError(grpc(14, details)), context);
        expect(mapped).toBeInstanceOf(ConnectionError);
        expect(mapped.message).toEndWith(` (${code})`);
      }
    }
  });

  test("a last error that names no code is kept as grpc-js wrote it, since it holds no address", () => {
    const details =
      "No connection established. Last error: Error: unable to verify the first certificate. Resolution note: ";
    const mapped = toProviderError(toEtcdError(grpc(14, details)), read("get", TLS_NO_CERT));
    expect(mapped.message).toBe(
      `The server's certificate is not signed by the CA under SSL / TLS: paste the etcd CA. (${details})`,
    );
  });

  test.each([
    ["the peer alone", "Deadline exceeded after 3.000s,remote_addr=127.0.0.1:23794", "Deadline exceeded after 3.000s"],
    [
      "the peer after an LB pick, an IPv6 one",
      "Deadline exceeded after 3.002s,LB pick: 0.001s,remote_addr=[::1]:23794",
      "Deadline exceeded after 3.002s,LB pick: 0.001s",
    ],
    [
      "the peer after a pre-send marker",
      "Deadline exceeded after 3.000s,waiting for name resolution,remote_addr=127.0.0.1:23794",
      "Deadline exceeded after 3.000s,waiting for name resolution",
    ],
  ])("a deadline's remote_addr is dropped and the rest of grpc-js's text kept: %s", (_label, details, kept) => {
    const timeout = toProviderError(toEtcdError(grpc(4, details)), read("get"));
    expect(timeout).toBeInstanceOf(TimeoutError);
    expect(timeout.message).toBe(`The get reached its deadline of 60,000 ms. (${kept})`);
    const unknown = toProviderError(toEtcdError(grpc(4, details)), write("put"));
    expect(unknown.message).toBe(`The put reached its deadline before etcd answered. (${kept}) ${UNKNOWN_OUTCOME}`);
  });

  test("a name that did not resolve is said without the target grpc-js dialled", () => {
    const mapped = toProviderError(
      toEtcdError(grpc(14, "Name resolution failed for target dns:etcd.invalid:2379")),
      read(),
    );
    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped.message).toBe(
      "No etcd answered a plaintext connection at etcd.test:2379. If this etcd serves TLS (kubeadm and k3s always do), choose an SSL mode under SSL / TLS; otherwise check the host, the port and the tunnel. (Name resolution failed)",
    );
  });

  test("a system error of a code the table does not name keeps no address its message names, even on a write", () => {
    const socket = Object.assign(new Error("connect EADDRNOTAVAIL 127.0.0.1:40001 - Local (0.0.0.0:0)"), {
      code: "EADDRNOTAVAIL",
    });
    const mapped = toEtcdError(socket);
    expect(mapped).toMatchObject({ category: "unknown", detail: "EADDRNOTAVAIL" });
    const message = toProviderError(mapped, write("put")).message;
    expect(message).toBe(`The put failed. (EADDRNOTAVAIL) ${UNKNOWN_OUTCOME}`);
  });

  test("the server's answers the tables name by their start keep their words, as etcd's own do (spec E16)", () => {
    const tooLarge = toEtcdError(grpc(8, "grpc: received message larger than max (3145771 vs. 2097152)"));
    expect(toProviderError(tooLarge, write("put")).message).toBe(
      "etcd refused the put: the request is larger than etcd accepts. (grpc: received message larger than max (3145771 vs. 2097152))",
    );
    const noPassword = toEtcdError(grpc(2, "auth: authentication failed, password was given for no password user"));
    expect(toProviderError(noPassword, read()).message).toBe(
      "etcd refused the sign-in: the user is unknown or the password is wrong. (auth: authentication failed, password was given for no password user)",
    );
  });
});

describe("toProviderError: a read's deadline, a cancel, authentication", () => {
  test("a read's deadline is a TimeoutError carrying the deadline, answered 408 and retryable", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("timed out", "TimeoutError"));
    const mapped = toProviderError(toEtcdError(grpc(1, "Cancelled on client"), controller.signal), read("get"));
    expect(mapped).toBeInstanceOf(TimeoutError);
    expect(mapped.message).toBe("The get reached its deadline of 60,000 ms. (Cancelled on client)");
    expect((mapped as TimeoutError).timeout).toBe(60_000);
    expect(await respond(mapped)).toMatchObject({ status: 408, body: { retryable: true } });
  });

  test("a read ended by cancelQuery is a QueryCancelledError, answered 499", async () => {
    const controller = new AbortController();
    controller.abort();
    const mapped = toProviderError(toEtcdError(grpc(1, "Cancelled on client"), controller.signal), read("watch"));
    expect(mapped).toBeInstanceOf(QueryCancelledError);
    expect(mapped.message).toBe("The watch was cancelled.");
    expect((await respond(mapped)).status).toBe(499);
  });

  for (const details of ["context deadline exceeded", "Deadline exceeded"]) {
    test(`a read's "${details}" with no pre-send marker is a TimeoutError, not a failed connection`, async () => {
      const mapped = toProviderError(toEtcdError(grpc(4, details)), read("get"));
      expect(mapped).toBeInstanceOf(TimeoutError);
      expect(mapped.message).toBe(`The get reached its deadline of 60,000 ms. (${details})`);
      expect(await respond(mapped)).toMatchObject({ status: 408, body: { retryable: true } });
    });
  }

  test("a read cancelled by etcd, under a signal that did not abort, is a QueryError in etcd's words", async () => {
    const controller = new AbortController();
    const mapped = toProviderError(
      toEtcdError(grpc(1, "etcdserver: request canceled"), controller.signal),
      read("get"),
    );
    expect(mapped).not.toBeInstanceOf(QueryCancelledError);
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped.message).toBe("The get was cancelled before etcd answered. (etcd: request canceled)");
    expect((await respond(mapped)).status).toBe(400);
  });

  test("a wrong password or an unknown user is an AuthenticationError, 401 and not retryable", async () => {
    const mapped = toProviderError(
      toEtcdError(grpc(3, "etcdserver: authentication failed, invalid user ID or password")),
      write("put"),
    );
    expect(mapped).toBeInstanceOf(AuthenticationError);
    expect(mapped.message).toBe(
      "etcd refused the sign-in: the user is unknown or the password is wrong. (etcd: authentication failed, invalid user ID or password)",
    );
    const response = await respond(mapped);
    expect(response.status).toBe(401);
    expect(response.body.retryable).toBeUndefined();
  });

  for (const [code, details] of [
    [16, "etcdserver: invalid auth token"],
    [3, "etcdserver: revision of auth store is old"],
  ] as const) {
    test(`a renewal answer raised after the one retry is an AuthenticationError for a read: ${details}`, async () => {
      const mapped = toProviderError(toEtcdError(grpc(code, details)), read("get"));
      expect(mapped).toBeInstanceOf(AuthenticationError);
      expect(mapped.message).toStartWith(
        "etcd did not accept this connection's sign-in for the get: connect again. (etcd: ",
      );
      expect((await respond(mapped)).status).toBe(401);
    });
  }
});

describe("toProviderError: PermissionDenied names the command, the range and what the user may read", () => {
  test("with the grants 4.7 read", () => {
    const mapped = toProviderError(toEtcdError(grpc(7, "etcdserver: permission denied")), {
      ...read("get"),
      range: "/app/ (prefix)",
      readable: { user: "reader", ranges: "/app/x/ (prefix), /cfg/x" },
    });
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped.message).toBe(
      "etcd refused the get on /app/ (prefix): this connection's etcd user is not granted all of it. (etcd: permission denied) etcd user reader may read: /app/x/ (prefix), /cfg/x.",
    );
  });

  test("without a range or grants", async () => {
    const mapped = toProviderError(toEtcdError(grpc(7, "etcdserver: permission denied")), read("user list"));
    expect(mapped.message).toBe(
      "etcd refused the user list: this connection's etcd user is not granted all of it. (etcd: permission denied)",
    );
    expect((await respond(mapped)).status).toBe(400);
  });
});

describe("toProviderError: answers in etcd's words (QueryError)", () => {
  const rows: Array<[string, string]> = [
    [
      "etcdserver: mvcc: required revision is a future revision",
      "The get asked for a revision etcd has not reached yet. (etcd: mvcc: required revision is a future revision)",
    ],
    [
      "etcdserver: too many operations in txn request",
      "etcd refused the get: a txn list holds more operations than etcd accepts (--max-txn-ops, 128 by default). (etcd: too many operations in txn request)",
    ],
    [
      "etcdserver: duplicate key given in txn request",
      "etcd refused the get: a txn branch modifies one key twice. (etcd: duplicate key given in txn request)",
    ],
    [
      "etcdserver: too many requests",
      "etcd refused the get: it is too far behind applying requests; run the command again shortly. (etcd: too many requests)",
    ],
    ["etcdserver: key is not provided", "etcd refused the get. (etcd: key is not provided)"],
    ["etcdserver: authentication is not enabled", "etcd refused the get. (etcd: authentication is not enabled)"],
    ["grpc: an unknown failure", "The get failed. (grpc: an unknown failure)"],
  ];
  const codes: Record<string, number> = {
    "etcdserver: mvcc: required revision is a future revision": 11,
    "etcdserver: too many operations in txn request": 3,
    "etcdserver: duplicate key given in txn request": 3,
    "etcdserver: too many requests": 8,
    "etcdserver: key is not provided": 3,
    "etcdserver: authentication is not enabled": 9,
    "grpc: an unknown failure": 2,
  };
  for (const [details, message] of rows) {
    test(`"${details}"`, async () => {
      const mapped = toProviderError(toEtcdError(grpc(codes[details], details)), read("get"));
      expect(mapped).toBeInstanceOf(QueryError);
      expect(mapped.message).toBe(message);
      expect((await respond(mapped)).status).toBe(400);
    });
  }

  test("database space exceeded on a read carries the recovery instruction and no unknown outcome", () => {
    const mapped = toProviderError(toEtcdError(grpc(8, "etcdserver: mvcc: database space exceeded")), read("get"));
    expect(mapped.message).toBe(
      "etcd's database is over its space quota. (etcd: mvcc: database space exceeded) An admin compacts history, defragments every member that alarm list names, one at a time through a connection to each member, and then disarms the alarm, from the Global Operations cards of Admin > Operations.",
    );
  });

  test("a requested lease not found reads 'lease not found or expired'", () => {
    const mapped = toProviderError(
      toEtcdError(grpc(5, "etcdserver: requested lease not found")),
      read("lease timetolive"),
    );
    expect(mapped.message).toBe(
      "etcd answered the lease timetolive: lease not found or expired. (etcd: requested lease not found)",
    );
  });
});

describe("toProviderError: an answer past the receive cap (spec E14)", () => {
  const tooLarge = () => toEtcdError(grpc(8, "Received message larger than max (9000000 vs 8388608)"));

  test("a read names the cap and asks for a narrower read", async () => {
    const mapped = toProviderError(tooLarge(), read("get"));
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped.message).toBe(
      "etcd's answer to the get is larger than this connection's receive cap of 8 MiB: narrow the read. (Received message larger than max (9000000 vs 8388608))",
    );
    expect((await respond(mapped)).status).toBe(400);
  });

  test("a put or a del says that etcd applied it, and never that it failed", () => {
    for (const command of ["put", "del"]) {
      const mapped = toProviderError(tooLarge(), write(command));
      expect(mapped.message).toBe(
        `etcd applied the ${command}, but its answer is larger than this connection's receive cap of 8 MiB and was not read. (Received message larger than max (9000000 vs 8388608)) Read the keys back to see the result.`,
      );
      expect(mapped.message).not.toContain(UNKNOWN_OUTCOME);
      expect(mapped.message).not.toContain("failed");
    }
  });

  test("a txn says that one of its branches ran and the answer naming which was not read", () => {
    const mapped = toProviderError(tooLarge(), write("txn"));
    expect(mapped.message).toBe(
      "One branch of the txn ran, but etcd's answer, which names the branch, is larger than this connection's receive cap of 8 MiB and was not read. (Received message larger than max (9000000 vs 8388608)) Read the keys back to see the result.",
    );
  });

  test("the cap is written in KiB or bytes when it is not a whole number of MiB", () => {
    const kib = toProviderError(tooLarge(), read("get", { ...PLAINTEXT, receiveCapBytes: 65_536 }));
    expect(kib.message).toContain("receive cap of 64 KiB:");
    const bytes = toProviderError(tooLarge(), read("get", { ...PLAINTEXT, receiveCapBytes: 1_000_001 }));
    expect(bytes.message).toContain("receive cap of 1,000,001 bytes:");
  });
});

describe("toProviderError: what is not an EtcdError", () => {
  test("a DatabaseConfigError from the shared validators is stamped etcd", () => {
    const mapped = toProviderError(new DatabaseConfigError("bad host"), read());
    expect(mapped).toBeInstanceOf(DatabaseConfigError);
    expect(mapped).toMatchObject({ provider: "etcd", message: "bad host" });
  });

  test("a DatabaseConfigError already stamped, and a local refusal, pass through as the same object", () => {
    const stamped = new DatabaseConfigError("refused", "postgres");
    expect(toProviderError(stamped, read())).toBe(stamped);
    const refusal = new QueryError("This connection is read-only");
    expect(toProviderError(refusal, write())).toBe(refusal);
  });

  test("an internal defect surfaces as itself, never dressed up as etcd's answer", () => {
    const defect = new TypeError("x is undefined");
    expect(toProviderError(defect, read())).toBe(defect);
  });

  test("a thrown value that is not an Error becomes an Error naming it", () => {
    const mapped = toProviderError("boom", read());
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped.message).toBe("The etcd provider received a thrown value that is not an Error: boom");
  });
});

describe("writeNotApplied: the closed list of spec 4.5, and what never left the client", () => {
  test("answers etcd gives before a write can be applied, matched on code and message together", () => {
    const notApplied = [
      grpc(3, "etcdserver: request is too large"),
      grpc(3, "etcdserver: too many operations in txn request"),
      grpc(3, "etcdserver: duplicate key given in txn request"),
      grpc(8, "grpc: received message larger than max (3145771 vs. 2097152)"),
      grpc(8, "etcdserver: too many requests"),
      grpc(14, "etcdserver: no leader"),
      grpc(7, "etcdserver: permission denied"),
      grpc(14, "No connection established. Last error: Failed to connect. Resolution note: "),
      grpc(
        14,
        "No connection established. Last error: Error: unable to verify the first certificate. Resolution note: ",
      ),
    ];
    for (const answer of notApplied) expect(writeNotApplied(toEtcdError(answer))).toBe(true);
    expect(writeNotApplied(new EtcdError("closed", "closed"))).toBe(true);
  });

  test("every other answer may have been applied", () => {
    const unknown = [
      grpc(8, "etcdserver: mvcc: database space exceeded"),
      grpc(14, "etcdserver: request timed out"),
      grpc(14, "Connection dropped"),
      grpc(4, "Deadline exceeded after 3.000s,remote_addr=127.0.0.1:23794"),
      grpc(1, "etcdserver: request canceled"),
      grpc(4, "context deadline exceeded"),
      grpc(4, "Deadline exceeded"),
      grpc(16, "etcdserver: invalid auth token"),
      grpc(3, "etcdserver: revision of auth store is old"),
      grpc(3, "etcdserver: user name is empty"),
      grpc(8, "Received message larger than max (9000000 vs 8388608)"),
      grpc(5, "etcdserver: requested lease not found"),
      grpc(15, "etcdserver: corrupt cluster"),
    ];
    for (const answer of unknown) expect(writeNotApplied(toEtcdError(answer))).toBe(false);
  });
});

describe("watchEndError: how a watch ended (spec 5.3)", () => {
  test("a window that closed, and the caller's own abort, are not errors", () => {
    expect(watchEndError({ reason: "stopped" }, read("watch"))).toBeUndefined();
    expect(watchEndError({ reason: "aborted" }, read("watch"))).toBeUndefined();
  });

  test("a compacted start revision reads etcd's compacted error with the compact revision", () => {
    const mapped = watchEndError({ reason: "compacted", compactRevision: "9007199254740993" }, read("watch"));
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped?.message).toBe(
      "The watch starts at a revision etcd has compacted: watch from revision 9007199254740993 or later. (etcd: mvcc: required revision has been compacted)",
    );
  });

  test("a server cancellation is raised in etcd's words, by the table", () => {
    const denied = watchEndError(
      { reason: "canceled", cancelReason: "rpc error: code = PermissionDenied desc = etcdserver: permission denied" },
      { ...read("watch"), range: "/registry/ (prefix)" },
    );
    expect(denied).toBeInstanceOf(QueryError);
    expect(denied?.message).toBe(
      "etcd refused the watch on /registry/ (prefix): this connection's etcd user is not granted all of it. (etcd: permission denied)",
    );
    const stale = watchEndError(
      { reason: "canceled", cancelReason: "rpc error: code = Unauthenticated desc = etcdserver: invalid auth token" },
      read("watch"),
    );
    expect(stale).toBeInstanceOf(AuthenticationError);
  });

  test("a watch etcd cancelled is a QueryError in etcd's words, never the caller's own cancel", () => {
    const mapped = watchEndError(
      { reason: "canceled", cancelReason: "rpc error: code = Canceled desc = etcdserver: watch canceled" },
      read("watch"),
    );
    expect(mapped).not.toBeInstanceOf(QueryCancelledError);
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped?.message).toContain("(etcd: watch canceled)");
    expect(mapped?.message).toBe("The watch was cancelled before etcd answered. (etcd: watch canceled)");
  });
});

describe("leaseNotFoundError: the answers that arrive as data (a TTL of 0 or -1)", () => {
  test("reads 'lease not found or expired', naming the lease", async () => {
    const mapped = leaseNotFoundError("000000000000abcd", "lease keep-alive");
    expect(mapped).toBeInstanceOf(QueryError);
    expect(mapped).toMatchObject({ provider: "etcd" });
    expect(mapped.message).toBe("etcd answered the lease keep-alive: lease 000000000000abcd not found or expired.");
    expect((await respond(mapped)).status).toBe(400);
  });
});

describe("etcdWords: etcd's words after a sentence a surface words itself (spec E16)", () => {
  test("etcd's own text loses its etcdserver: prefix, and the runtime's is kept as it came", () => {
    expect(etcdWords(new EtcdError("permission-denied", "etcdserver: permission denied", 7))).toBe(
      " (etcd: permission denied)",
    );
    expect(etcdWords(new EtcdError("compacted", "etcdserver: mvcc: required revision has been compacted", 11))).toBe(
      " (etcd: mvcc: required revision has been compacted)",
    );
    expect(etcdWords(new EtcdError("not-connected", "ECONNREFUSED"))).toBe(" (ECONNREFUSED)");
  });

  test("the same words the table places after its own sentences", () => {
    const denied = new EtcdError("permission-denied", "etcdserver: permission denied", 7);
    expect(toProviderError(denied, read("get")).message.endsWith(etcdWords(denied))).toBe(true);
  });
});
