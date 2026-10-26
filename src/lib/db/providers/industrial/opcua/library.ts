/**
 * The library bridge: the only module in this repository that imports `node-opcua-client` (#1677 O-S1).
 *
 * WHAT IT IS FOR. `session.ts` states this provider's rules over the `OpcuaLibraryBridge` interface
 * and never touches a library object. This file is that interface filled in, so the eight-service
 * seam stays a type: a caller reaching for `write`, `call` or `createSubscription2` would have to
 * widen the interface there first, which is a reviewable change rather than a forgettable one.
 *
 * THREE LIBRARY DEFAULTS ARE OVERRIDDEN HERE, each because it was measured and each in the opposite
 * direction from the default:
 *
 *  1. The certificate manager. `getDefaultCertificateManager` is built with
 *     `automaticallyAcceptUnknownCertificate: true` and shared process-wide: a SignAndEncrypt
 *     connect to a server nobody had ever seen succeeded and wrote that server's certificate into
 *     `PKI/trusted/certs`, and after the server was recreated with a new certificate the next
 *     connect trusted that one too, with no prompt. Part 4 6.1.3: "Applications shall never
 *     communicate with another application that they do not trust."
 *  2. The PKI location. The default is the platform's config directory, which in the product image
 *     is `/nonexistent` and cannot be created (uid 1001, `EACCES`). The root is given explicitly.
 *  3. `endpointMustExist`. True makes the connect fail whenever the server advertises an endpoint
 *     URL different from the typed one, which is every OPC PLC and every Milo behind a port map.
 *     False, with the endpoint never taken from GetEndpoints, is what O-S7 asks for.
 *
 * AND ONE LIBRARY DEFECT IS WHY THIS IMPORT IS LATE. `node-opcua-hostname` calls `prepareFQDN()` at
 * module scope without awaiting it, and inside it `dns.lookupService(ip, 0, …)` is called with
 * whatever `dns.lookup(os.hostname())` answered. Measured on the development host: Node 24.14.0
 * answered `::1` and nothing happened; Bun 1.4.2 answered `fe80::18aa:2794:76e0:ef24%15`, and
 * `lookupService` threw `ERR_INVALID_ARG_VALUE` inside the callback, where the library's own
 * try/catch cannot see it. Bun printed it and survived; a test runner attributed it to whichever
 * test happened to be running. So `factory.ts` imports this module when a session is opened rather
 * than when a provider is built, and nothing that merely constructs a provider loads the library.
 */
import { createHash } from "node:crypto";
// FIRST, and that is the whole point of it: the guard has to be installed before the library is
// evaluated, because the library resolves this host's name at import time (see hostname-guard.ts).
import "./hostname-guard";
// The certificate manager lives in its own package of the same library; it is the one the client
// takes, and the strict construction below is the whole point of naming it here (O-S2).
import { OPCUACertificateManager } from "node-opcua-certificate-manager";
import {
  HistoryReadRequest,
  HistoryReadValueId,
  MessageSecurityMode,
  NodeClass,
  OPCUAClient,
  ReadRawModifiedDetails,
  TimestampsToReturn,
  UserTokenType,
  type BrowseResult,
  type ClientSession,
  type DataValue,
  type HistoryReadResult,
  type UserIdentityInfo,
} from "node-opcua-client";
import { OPCUA_LIMIT_NODES, OPCUA_POLICY_NONE, OPCUA_READ_ATTRIBUTES } from "./constants";
import type { OpcuaDataValue, OpcuaEndpoint, OpcuaReadOnlyClient, OpcuaServerLimits } from "./client";
import type { OpcuaConnectionOptions } from "./connection";
import { openReadOnlySession, OPCUA_TRANSPORT_SETTINGS, type OpcuaLibraryBridge } from "./session";

/**
 * The bridge over `node-opcua-client` 2.187.16, and the only code in this repository that imports it.
 *
 * It is the three overrides at the top of this file in executable form: a STRICT certificate
 * manager rooted where the installation says, `endpointMustExist: false`, and the typed endpoint
 * rather than the advertised one. Everything it hands back is already in this provider's own shape,
 * so nothing above it ever sees a library object - which is what keeps the eight-service seam a
 * type rather than a convention.
 */
const SECURITY_MODES: Readonly<Record<OpcuaConnectionOptions["mode"], MessageSecurityMode>> = Object.freeze({
  None: MessageSecurityMode.None,
  Sign: MessageSecurityMode.Sign,
  SignAndEncrypt: MessageSecurityMode.SignAndEncrypt,
});

/**
 * The SHA-256 thumbprint of a DER certificate as 64 lowercase hex: what a pin is written in (O-S2).
 *
 * SHA-256 AND NOT SHA-1, which is what an OPC UA thumbprint usually means and what this computed
 * first. Two scanners read the SHA-1 as a weak algorithm on a trust path and both were right that
 * the algorithm is weak, whatever the pin's threat model is: defeating a pin of an existing
 * certificate needs a second preimage, which SHA-1 still resists, but there is no reason to write a
 * NEW pin in a hash whose collision resistance is broken. Nothing shipped with a SHA-1 pin, so
 * nothing had to be kept working. An operator reads the value out of
 * `openssl x509 -fingerprint -sha256`, and the digest HAS TO BE NAMED: measured on OpenSSL 3.6.3,
 * `-fingerprint` with no digest still prints the SHA-1 one. That command prints upper case with
 * colons, `B9:43:2E:...`, which `normaliseThumbprint` takes as it stands.
 */
function thumbprintOf(der: Buffer | Uint8Array | null | undefined): string | undefined {
  if (der === null || der === undefined || der.length === 0) return undefined;
  return createHash("sha256").update(Buffer.from(der)).digest("hex");
}

/** The status code's own name, which is what the error table is keyed on, never the object. */
function statusName(status: { readonly name?: string | null; toString(): string } | null | undefined): string {
  if (status === null || status === undefined) return "BadNoAnswer";
  return status.name ?? status.toString();
}

/** An instant as ISO 8601, or absent where the server sent none. */
function instant(when: Date | null | undefined): string | undefined {
  return when === null || when === undefined ? undefined : when.toISOString();
}

/**
 * The certificate manager, built strict and rooted where the installation says (O-S2, O-S4).
 *
 * `automaticallyAcceptUnknownCertificate` is FALSE here against the library's own default of true:
 * measured, the shared default manager accepted a server nobody had ever seen on a SignAndEncrypt
 * connect, wrote its certificate into `PKI/trusted/certs`, and then trusted a different certificate
 * from the same host after the server was recreated, with no prompt. Part 4 6.1.3: "Applications
 * shall never communicate with another application that they do not trust."
 */
async function certificateStore(root: string): Promise<OPCUACertificateManager> {
  const manager = new OPCUACertificateManager({
    rootFolder: root,
    automaticallyAcceptUnknownCertificate: false,
  });
  /*
   * NOTHING IS WRITTEN HERE, measured: with the root's parent read-only, both the construction and
   * this call succeed and the `EACCES` arrives later, from the dial - the manager creates its
   * directories lazily. So the refusal for a root that cannot be written is `session.ts`'s, where the
   * dial's throw is translated, and not this function's.
   */
  await manager.initialize();
  return manager;
}

/**
 * A client for one dial, in one security mode and one policy.
 *
 * THE MODE AND THE POLICY TRAVEL TOGETHER, and getting that wrong is why this takes both: the
 * library matches the endpoint by the PAIR. Measured against OPC PLC 2.15.10: a dial asking for
 * `Sign` while the policy stayed `#None` answered "Cannot find an Endpoint matching security
 * mode: 2 policy: …#None" and never reached the server's Sign endpoints at all, and a GetEndpoints
 * dial that carried the connection's `Basic256Sha256` with mode None answered
 * `BadSecurityChecksFailed` because the unsecured channel presents no certificate to verify. So
 * the first dial is None+None, and the session's dial carries the policy of the endpoint chosen.
 */
async function clientFor(
  options: OpcuaConnectionOptions,
  mode: MessageSecurityMode,
  policyUri: string,
): Promise<OPCUAClient> {
  return OPCUAClient.create({
    applicationName: "LibreDB Studio",
    clientCertificateManager: await certificateStore(options.pkiRoot),
    ...(options.clientCertificatePath === undefined ? {} : { certificateFile: options.clientCertificatePath }),
    ...(options.clientPrivateKeyPath === undefined ? {} : { privateKeyFile: options.clientPrivateKeyPath }),
    securityMode: mode,
    securityPolicy: policyUri,
    // False, and the endpoint is never taken from GetEndpoints either (O-S7): true fails the connect
    // whenever the server advertises a URL other than the typed one, which is every OPC PLC and
    // every Milo behind a port map.
    endpointMustExist: false,
    transportSettings: OPCUA_TRANSPORT_SETTINGS,
    // One dial, no retry loop: a refusal is a sentence for the reader rather than a reconnect.
    connectionStrategy: { maxRetry: 0 },
  });
}

/** One identity token for ActivateSession, from the fields the dialog filled. */
function identityOf(options: OpcuaConnectionOptions): UserIdentityInfo {
  if (options.identity === "anonymous" || options.user === undefined) return { type: UserTokenType.Anonymous };
  return {
    type: UserTokenType.UserName,
    userName: options.user,
    password: options.password ?? "",
  };
}

/** The library's own bridge: every call out of it is already in this provider's shape. */
export const OPCUA_LIBRARY_BRIDGE: OpcuaLibraryBridge = {
  /**
   * GetEndpoints, on its own unsecured channel and before any session exists.
   *
   * An unsecured channel because this is the call that READS the server's certificate: a pin cannot
   * be checked against a channel that is already secured by it. The client is disconnected before
   * this returns, so nothing is left open on the way to the session.
   */
  readEndpoints: async (options) => {
    // None AND #None: this is the call that READS the server's certificate, so the channel carrying
    // it cannot be secured by one. Measured: None with the connection's own policy answered
    // BadSecurityChecksFailed, and the server logged BadCertificateInvalid, "the sender's
    // certificate was not specified".
    const client = await clientFor(options, MessageSecurityMode.None, OPCUA_POLICY_NONE);
    try {
      await client.connect(options.endpointUrl);
      const endpoints = await client.getEndpoints();
      // oxlint-disable-next-line no-map-spread -- each answer is a NEW object in this provider's own shape, never a library object with fields added to it.
      return endpoints.map((endpoint) => ({
        // Recorded and never dialled: OPC PLC advertises its own container name here.
        advertisedUrl: endpoint.endpointUrl ?? "",
        securityMode: MessageSecurityMode[endpoint.securityMode] as OpcuaEndpoint["securityMode"],
        securityPolicyUri: endpoint.securityPolicyUri ?? "",
        ...(endpoint.serverCertificate === null || endpoint.serverCertificate === undefined
          ? {}
          : {
              serverCertificate: new Uint8Array(endpoint.serverCertificate),
              serverCertificateThumbprint: thumbprintOf(endpoint.serverCertificate),
            }),
        userIdentityTokens: (endpoint.userIdentityTokens ?? []).map((token) => ({
          tokenType: UserTokenType[token.tokenType] as "Anonymous" | "UserName" | "Certificate" | "IssuedToken",
          // Null means the channel's own policy, which is the distinction Part 4 7.41 draws and the
          // one a plaintext refusal turns on: stock asyncua declares None here.
          securityPolicyUri: token.securityPolicyUri ?? null,
        })),
      }));
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  },

  /**
   * Connect and activate one session, closing the channel with it.
   *
   * The returned object is the narrow `LibrarySession` and nothing else, so even inside this file a
   * later edit cannot reach `write`, `call` or `createSubscription2` without widening that interface
   * first. Its `close` closes the session AND disconnects the client: a session closed with the
   * channel left open holds a socket the server counts.
   */
  openSession: async (options) => {
    // The policy of the endpoint the session chose, which `session.ts` resolved from GetEndpoints:
    // a mode without its policy matches no endpoint (see `clientFor`).
    const client = await clientFor(options, SECURITY_MODES[options.mode], options.policyUri ?? OPCUA_POLICY_NONE);
    await client.connect(options.endpointUrl);
    let session: ClientSession;
    try {
      session = await client.createSession(identityOf(options));
    } catch (error) {
      await client.disconnect().catch(() => undefined);
      throw error;
    }
    return {
      browse: async (nodesToBrowse) => client_browse(session, nodesToBrowse),
      browseNext: async (points, release) => session.browseNext(points as Buffer[], release),
      // `read` is overloaded on a single node, so the answer is always read back as the list it is.
      read: async (nodesToRead) => (await session.read(nodesToRead as never)) as unknown as readonly unknown[],
      // HistoryRead itself: the library's `readHistoryValue` convenience takes no
      // `releaseContinuationPoints`, so a release through it would hold the server's slot until the
      // session closed. The request is built here and nowhere else.
      historyRead: async (request) => {
        const response = (await session.historyRead(
          new HistoryReadRequest({
            historyReadDetails: new ReadRawModifiedDetails({
              isReadModified: request.isReadModified,
              returnBounds: request.returnBounds,
              numValuesPerNode: request.valuesPerPage,
              startTime: request.startTime ?? new Date(0),
              endTime: request.endTime ?? new Date(),
            }),
            // Both timestamps, because a row shows both and a history read is where they differ.
            timestampsToReturn: TimestampsToReturn.Both,
            releaseContinuationPoints: request.releaseContinuationPoints ?? false,
            nodesToRead: [
              new HistoryReadValueId({
                nodeId: request.nodeId,
                ...(request.continuationPoint === undefined
                  ? {}
                  : { continuationPoint: Buffer.from(request.continuationPoint) }),
              }),
            ],
          }),
        )) as { results?: readonly unknown[] };
        return response.results ?? [];
      },
      close: async (deleteSubscriptions) => {
        try {
          await session.close(deleteSubscriptions ?? true);
        } finally {
          await client.disconnect();
        }
      },
    };
  },

  /**
   * The server's published operational limits, read once per session.
   *
   * Every one of the five is read in ONE request, and every answer that is not Good with a non-zero
   * number is reported as absent: Part 5 6.3.11 says a provided limit "shall have a non zero value",
   * and three of the four servers measured break it (open62541 publishes eight zeros, asyncua six
   * empty Variants, OPC PLC MaxSessions as 0). `statedLimit` is what turns that into "no limit".
   */
  readLimits: async (session) => {
    const names = Object.keys(OPCUA_LIMIT_NODES) as (keyof typeof OPCUA_LIMIT_NODES)[];
    const answers = (await session.read(
      names.map((name) => ({
        nodeId: OPCUA_LIMIT_NODES[name],
        attributeId: 13,
      })) as never,
    )) as unknown as readonly DataValue[];
    const limits: Record<string, number | undefined> = {};
    for (const [at, name] of names.entries()) {
      const answer = answers[at];
      const value: unknown = answer?.value?.value;
      limits[name] = statusName(answer?.statusCode) === "Good" && typeof value === "number" ? value : undefined;
    }
    return limits as OpcuaServerLimits;
  },

  /** Browse answers in this provider's shape, with the folder flag derived from the node class. */
  shapeBrowse: (answers, nodeIds) =>
    // oxlint-disable-next-line no-map-spread -- a row is a new object, built from the ten answers; nothing of the library's is modified.
    (answers as unknown as readonly BrowseResult[]).map((answer, at) => ({
      nodeId: nodeIds[at] ?? "",
      references: (answer.references ?? []).map((reference) => ({
        // `nsu=` where the server gave one, because a namespace INDEX is a per-session position.
        nodeId: reference.nodeId.toString(),
        browseName: reference.browseName.name ?? "",
        displayName: reference.displayName?.text ?? reference.browseName.name ?? "",
        nodeClass: NodeClass[reference.nodeClass] ?? "Unspecified",
        referenceTypeId: reference.referenceTypeId.toString(),
        // Derived, because a server publishes no such flag; Method is the one class never browsed.
        mayHaveChildren: NodeClass[reference.nodeClass] !== "Method",
      })),
      ...(answer.continuationPoint === null || answer.continuationPoint === undefined
        ? {}
        : { continuationPoint: new Uint8Array(answer.continuationPoint) }),
      statusCode: statusName(answer.statusCode),
    })),

  /**
   * Read answers in this provider's shape: nine attributes back to one row per node.
   *
   * The answers arrive in the order the request named them, node by node and attribute by attribute,
   * which is what `OPCUA_READ_ATTRIBUTES` fixes. A node whose Value is Bad is still a row: its
   * status travels with it, because dropping it would say the node does not exist.
   */
  shapeRead: (answers, nodeIds) => {
    const per = OPCUA_READ_ATTRIBUTES.length;
    const values = answers as unknown as readonly DataValue[];
    return nodeIds.map((nodeId, at) => {
      const slice = values.slice(at * per, at * per + per);
      const [
        value,
        nodeClass,
        dataType,
        valueRank,
        arrayDimensions,
        accessLevel,
        userAccessLevel,
        historizing,
        description,
        displayName,
      ] = slice;
      const numberOf = (answer: DataValue | undefined): number | undefined =>
        typeof answer?.value?.value === "number" ? answer.value.value : undefined;
      const textOf = (answer: DataValue | undefined): string | undefined => {
        const raw: unknown = answer?.value?.value;
        if (typeof raw === "string") return raw;
        if (raw !== null && typeof raw === "object" && "text" in raw) {
          const text = (raw as { text?: string | null }).text;
          return text ?? undefined;
        }
        return undefined;
      };
      const dimensions: unknown = arrayDimensions?.value?.value;
      return {
        nodeId,
        value: value?.value?.value ?? null,
        // The server's own word for what this node is, so a Source tab never calls a Method a
        // Variable: the attribute answers the NodeClass number, which the enum names.
        ...(typeof nodeClass?.value?.value === "number"
          ? { nodeClass: NodeClass[nodeClass.value.value] ?? "Unspecified" }
          : {}),
        ...(dataType?.value?.value === null || dataType?.value?.value === undefined
          ? {}
          : { dataTypeId: String(dataType.value.value) }),
        ...(numberOf(valueRank) === undefined ? {} : { valueRank: numberOf(valueRank) }),
        // A numeric array arrives from the library as a TYPED array, not an Array: measured, the
        // ArrayDimensions of a 100x100 matrix answer as a `Uint32Array`, which `Array.isArray`
        // reads as false and `JSON.stringify` writes as an object keyed by index.
        ...(Array.isArray(dimensions) || ArrayBuffer.isView(dimensions)
          ? {
              arrayDimensions: Array.from(dimensions as ArrayLike<number>, Number),
            }
          : {}),
        ...(numberOf(accessLevel) === undefined ? {} : { accessLevel: numberOf(accessLevel) }),
        ...(numberOf(userAccessLevel) === undefined ? {} : { userAccessLevel: numberOf(userAccessLevel) }),
        ...(typeof historizing?.value?.value === "boolean" ? { historizing: historizing.value.value } : {}),
        ...(textOf(description) === undefined ? {} : { description: textOf(description) }),
        ...(textOf(displayName) === undefined ? {} : { displayName: textOf(displayName) }),
        ...(instant(value?.sourceTimestamp) === undefined ? {} : { sourceTimestamp: instant(value?.sourceTimestamp) }),
        ...(instant(value?.serverTimestamp) === undefined ? {} : { serverTimestamp: instant(value?.serverTimestamp) }),
        statusCode: statusName(value?.statusCode),
      } as OpcuaDataValue;
    });
  },

  /** One history page in this provider's shape, with the continuation point it did or did not give. */
  shapeHistory: (answers, nodeId) => {
    const [answer] = answers as unknown as readonly HistoryReadResult[];
    const data = answer?.historyData as { dataValues?: readonly DataValue[] } | undefined;
    return {
      nodeId,
      // oxlint-disable-next-line no-map-spread -- a historical value is a new object in this provider's shape, not a changed DataValue.
      values: (data?.dataValues ?? []).map((entry) => ({
        value: entry.value?.value ?? null,
        ...(instant(entry.sourceTimestamp) === undefined ? {} : { sourceTimestamp: instant(entry.sourceTimestamp) }),
        ...(instant(entry.serverTimestamp) === undefined ? {} : { serverTimestamp: instant(entry.serverTimestamp) }),
        statusCode: statusName(entry.statusCode),
      })),
      ...(answer?.continuationPoint === null || answer?.continuationPoint === undefined
        ? {}
        : { continuationPoint: new Uint8Array(answer.continuationPoint) }),
      statusCode: statusName(answer?.statusCode),
    };
  },
};

/**
 * Browse through the library, named so the call site above reads as one line.
 *
 * `session.browse` takes the descriptions this provider built in `openReadOnlySession`, which is
 * where the reference type, the direction and the result mask are decided.
 */
async function client_browse(session: ClientSession, nodesToBrowse: readonly unknown[]): Promise<readonly unknown[]> {
  return (await session.browse(nodesToBrowse as never)) as unknown as readonly unknown[];
}

/** One read-only session over the real library: what the factory hands the provider. */
export async function openLibrarySession(options: OpcuaConnectionOptions): Promise<OpcuaReadOnlyClient> {
  return openReadOnlySession(OPCUA_LIBRARY_BRIDGE, options);
}
