/**
 * The session over the library, and the three defaults it overrides (#1677 O-S1, O-S2, O-S7).
 *
 * No server and no library here: the bridge is substituted, which is what the bridge exists for.
 * What is asserted is the provider's own rules, each measured against a real server first.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { OpcuaEndpoint } from "@/lib/db/providers/industrial/opcua/client";
import type { OpcuaConnectionOptions } from "@/lib/db/providers/industrial/opcua/connection";
import {
  openReadOnlySession,
  OPCUA_TRANSPORT_SETTINGS,
  type OpcuaLibraryBridge,
} from "@/lib/db/providers/industrial/opcua/session";

const NONE = "http://opcfoundation.org/UA/SecurityPolicy#None";
const B256 = "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256";
const PLC_THUMB = "b9432ed131e30092d2a0619284763a403c33fc3929546728864b27b475c9529a";

function endpoint(mode: OpcuaEndpoint["securityMode"], thumb?: string): OpcuaEndpoint {
  return {
    // The advertised URL is a container hostname, as both OPC PLC and Milo answer.
    advertisedUrl: "opc.tcp://9b9677b09793:50000/",
    securityMode: mode,
    securityPolicyUri: mode === "None" ? NONE : B256,
    ...(thumb === undefined ? {} : { serverCertificateThumbprint: thumb }),
    userIdentityTokens: [{ tokenType: "Anonymous", securityPolicyUri: NONE }],
  };
}

function options(over: Partial<OpcuaConnectionOptions> = {}): OpcuaConnectionOptions {
  return {
    endpointUrl: "opc.tcp://127.0.0.1:54840/",
    host: "127.0.0.1",
    port: 54840,
    mode: "SignAndEncrypt",
    identity: "anonymous",
    pkiRoot: "/app/data/opcua-pki",
    tunnelled: false,
    ...over,
  };
}

function bridge(
  endpoints: readonly OpcuaEndpoint[],
  record: {
    opened: number;
    closed: number;
    browseNextRelease: boolean[];
    history: unknown[];
    options: OpcuaConnectionOptions[];
    /** What `close(deleteSubscriptions)` was asked for, once per close. */
    closeArgs?: (boolean | undefined)[];
  },
): OpcuaLibraryBridge {
  return {
    readEndpoints: async () => endpoints,
    openSession: async (opened) => {
      record.opened += 1;
      record.options.push(opened);
      return {
        browse: async () => [],
        browseNext: async (_points, release) => {
          record.browseNextRelease.push(release);
          return [];
        },
        read: async () => [],
        historyRead: async (request) => {
          record.history.push(request);
          return [];
        },
        close: async (deleteSubscriptions) => {
          record.closed += 1;
          record.closeArgs?.push(deleteSubscriptions);
        },
      };
    },
    readLimits: async () => ({ maxNodesPerRead: 2_500 }),
    shapeBrowse: () => [],
    shapeRead: () => [],
    shapeHistory: (_answers, nodeId) => ({
      nodeId,
      values: [],
      statusCode: "Good",
    }),
  };
}

const fresh = () => ({
  opened: 0,
  closed: 0,
  browseNextRelease: [] as boolean[],
  history: [] as unknown[],
  options: [] as OpcuaConnectionOptions[],
});

describe("the security mode is never weakened", () => {
  /** No fallback: a connection meant to be encrypted must not become an unencrypted one. */
  test("a server offering no such mode is refused, and the refusal lists what it does offer", async () => {
    const record = fresh();
    await expect(
      openReadOnlySession(bridge([endpoint("None")], record), options({ mode: "SignAndEncrypt" })),
    ).rejects.toThrow(/offers no SignAndEncrypt endpoint/);
    // And the sentence names the policies too, because an endpoint is a mode AND a policy.
    await expect(
      openReadOnlySession(bridge([endpoint("None")], record), options({ mode: "SignAndEncrypt" })),
    ).rejects.toThrow(/with the policies: None/);
    await expect(
      openReadOnlySession(bridge([endpoint("None")], record), options({ mode: "SignAndEncrypt" })),
    ).rejects.toThrow(/It offers the modes: None/);
    // And nothing was opened.
    expect(record.opened).toBe(0);
  });

  test("the matching mode opens a session", async () => {
    const record = fresh();
    await openReadOnlySession(bridge([endpoint("None"), endpoint("SignAndEncrypt", PLC_THUMB)], record), options());
    expect(record.opened).toBe(1);
  });
});

describe("the certificate pin is checked before the session exists (O-S2)", () => {
  test("a different certificate is refused with no session opened", async () => {
    const record = fresh();
    const other = "0".repeat(64);
    await expect(
      openReadOnlySession(
        bridge([endpoint("SignAndEncrypt", other)], record),
        options({ pinnedThumbprint: PLC_THUMB }),
      ),
    ).rejects.toThrow(DatabaseConfigError);
    expect(record.opened).toBe(0);
  });

  test("the pinned certificate opens a session", async () => {
    const record = fresh();
    await openReadOnlySession(
      bridge([endpoint("SignAndEncrypt", PLC_THUMB)], record),
      options({ pinnedThumbprint: PLC_THUMB }),
    );
    expect(record.opened).toBe(1);
  });

  /** In None mode the library never calls checkCertificate, so a pin there is refused up front. */
  test("a pin with no certificate presented is refused", async () => {
    const record = fresh();
    await expect(
      openReadOnlySession(bridge([endpoint("None")], record), options({ mode: "None", pinnedThumbprint: PLC_THUMB })),
    ).rejects.toThrow(/None security mode/);
    expect(record.opened).toBe(0);
  });
});

describe("history reads are built explicitly, never left to the library", () => {
  test("a page size, isReadModified false and returnBounds false are all set", async () => {
    const record = fresh();
    const client = await openReadOnlySession(bridge([endpoint("SignAndEncrypt", PLC_THUMB)], record), options());
    await client.historyRead({ nodeId: "ns=3;s=H", valuesPerPage: 500 });
    const sent = record.history[0] as Record<string, unknown>;
    expect(sent.valuesPerPage).toBe(500);
    expect(sent.isReadModified).toBe(false);
    // The library defaults this TRUE, which on open62541 returned two null-valued bound rows.
    expect(sent.returnBounds).toBe(false);
  });

  /**
   * THE LIBRARY'S CONVENIENCE CANNOT DO THIS, which is why the seam names HistoryRead itself:
   * `readHistoryValue`'s options are `numValuesPerNode`, `returnBounds`, `isReadModified` and
   * `timestampsToReturn`, so a `releaseContinuationPoints` passed there is dropped and the server's
   * slot stays held until the session closes - one of a hundred OPC PLC shares with the plant.
   */
  test("a release names releaseContinuationPoints, so the server's slot is handed back", async () => {
    const record = fresh();
    const client = await openReadOnlySession(bridge([endpoint("SignAndEncrypt", PLC_THUMB)], record), options());
    await client.releaseHistoryContinuationPoint({
      nodeId: "ns=3;s=H",
      continuationPoint: new Uint8Array([1]),
      valuesPerPage: 500,
    });
    const sent = record.history[0] as Record<string, unknown>;
    expect(sent.releaseContinuationPoints).toBe(true);
    expect(sent.continuationPoint).toEqual(new Uint8Array([1]));
    // A continued read carries the same details as the first one (Part 4 5.10.3).
    expect(sent.isReadModified).toBe(false);
    expect(sent.returnBounds).toBe(false);
  });
});

describe("browse", () => {
  test("follows hierarchical references forward by default, and inverse only when asked, in full requests", async () => {
    const sent: unknown[] = [];
    const base = bridge([endpoint("SignAndEncrypt", PLC_THUMB)], fresh());
    const client = await openReadOnlySession(
      {
        ...base,
        openSession: async (opened) => ({
          ...(await base.openSession(opened)),
          browse: async (nodes) => {
            sent.push(...nodes);
            return [];
          },
        }),
      },
      options(),
    );
    await client.browse(["i=85"]);
    await client.browse(["ns=3;s=SlowUInt1"], "inverse");
    await client.browse(["i=2253"], "forward");
    const request = (nodeId: string, browseDirection: number) => ({
      nodeId,
      referenceTypeId: "i=33",
      includeSubtypes: true,
      browseDirection,
      resultMask: 63,
    });
    expect(sent).toEqual([request("i=85", 0), request("ns=3;s=SlowUInt1", 1), request("i=2253", 0)]);
  });
});

describe("browse continuation points", () => {
  test("following one does not release it, and releasing one does", async () => {
    const record = fresh();
    const client = await openReadOnlySession(bridge([endpoint("SignAndEncrypt", PLC_THUMB)], record), options());
    await client.browseNext([new Uint8Array([1])]);
    await client.releaseBrowseContinuationPoints([new Uint8Array([2])]);
    expect(record.browseNextRelease).toEqual([false, true]);
  });
});

describe("closing", () => {
  test("the session is closed and the server's subscriptions deleted with it", async () => {
    const record = fresh();
    const client = await openReadOnlySession(bridge([endpoint("SignAndEncrypt", PLC_THUMB)], record), options());
    await client.close();
    expect(record.closed).toBe(1);
  });
});

describe("the transport's own ceiling", () => {
  /** An answer over this closes the channel for good, so the batch sizes stay inside it. */
  test("the message size is stated, because exceeding it is not recoverable", () => {
    expect(OPCUA_TRANSPORT_SETTINGS.maxMessageSize).toBe(2 * 1024 * 1024);
  });

  /**
   * AND THE CHUNK COUNT IS PINNED AT 0, WHICH MEANS NO LIMIT. `node-opcua-transport` reads
   * `transportSettings.maxChunkCount || ClientTransportBase.defaultMaxChunk` and its own default is
   * `0 // 0 - no limits`, so 0 passes nothing - while 1 would cap an answer at a single chunk and
   * break nearly every real Browse. Only the size was pinned here, so changing this field was
   * invisible: a mutation to 1 passed every test.
   */
  test("the chunk count is 0, which is the library's own word for no limit", () => {
    expect(OPCUA_TRANSPORT_SETTINGS.maxChunkCount).toBe(0);
  });
});

/**
 * EVERY LIBRARY THROW BECOMES THIS PROVIDER'S OWN SENTENCE, MESSAGE ONLY (O-S8).
 *
 * The Error the client raises carries `request` and `response`, so serialising it emits the
 * ActivateSessionRequest and the username inside it. Only the message crosses out of here, and a
 * message carrying a status code becomes that code's sentence rather than the library's wording.
 */
/**
 * THE TWO REFUSALS ON THE WAY TO A SESSION THAT USED TO BE THE LIBRARY'S OWN WORDS.
 *
 * GetEndpoints was the one library call in `session.ts` with no guard on it, and it is the first
 * one made - so the most ordinary failure on a plant floor, a wrong host or port, was the one case
 * the provider did not own: measured through the query route against a closed port, HTTP 500
 * `INTERNAL_ERROR` carrying three lines of library prose and a newline inside the JSON error field.
 * And a username against a server that offers Anonymous only - which the fixture does - came back
 * as "Cannot find USERNAME user token policy in end point description", node-opcua's internal
 * string, grammar mistake included.
 */
describe("the dial itself", () => {
  function failingEndpoints(error: unknown): OpcuaLibraryBridge {
    return {
      readEndpoints: async () => {
        throw error;
      },
      openSession: async () => {
        throw new Error("the session must not be opened when GetEndpoints failed");
      },
      readLimits: async () => ({}),
      shapeBrowse: () => [],
      shapeRead: () => [],
      shapeHistory: (_answers, nodeId) => ({
        nodeId,
        values: [],
        statusCode: "Good",
      }),
    };
  }

  test("a dead endpoint is a config error naming the address, on one line", async () => {
    // The shape node-opcua really throws: three lines, with the reason on the last one.
    const dial = new Error(
      "The connection cannot be established with server opc.tcp://127.0.0.1:54999/ .\n" +
        "Please check that the server is up and running or your network configuration.\n" +
        "Err = (connect ECONNREFUSED 127.0.0.1:54999)",
    );
    const open = openReadOnlySession(failingEndpoints(dial), options({ endpointUrl: "opc.tcp://127.0.0.1:54999/" }));
    await expect(open).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(open).rejects.toThrow(/could not be opened to opc.tcp:\/\/127.0.0.1:54999\//);
    // One line: a newline in a JSON error field is read by nothing that draws it.
    try {
      await open;
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("\n");
      // The library already said to check the server, so the sentence does not say it twice.
      expect(String((error as Error).message).match(/[Cc]heck/g)).toHaveLength(1);
    }
  });

  /*
   * THE PEER WRITES THIS TEXT AND IS NOT AUTHENTICATED YET, which is why the flattening has to be
   * linear. The pattern was `\s*\n\s*`, where `\s` already matches a newline, so the first group ate
   * a whole whitespace run, failed to find the newline it still needed, and gave one character back
   * per attempt at every start position. Measured against a run of spaces ending in a non-space:
   * 2.6ms at 2,000 characters, 31.8ms at 8,000, 454ms at 32,000 and 7.9 SECONDS at 128,000, against
   * 0.07ms for `\s+` at that last size. The bound below is 1 second, which the old pattern misses by
   * eight times over on this machine and by more on a slower one, and which the new one clears by
   * four orders of magnitude.
   */
  test("a dial failure padded with whitespace is flattened in linear time, not quadratic", async () => {
    const hostile = new Error(`Err = (${" ".repeat(128_000)}x)`);
    const started = performance.now();
    const open = openReadOnlySession(failingEndpoints(hostile), options({ endpointUrl: "opc.tcp://h:4840/" }));
    await expect(open).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(performance.now() - started).toBeLessThan(1000);
    try {
      await open;
    } catch (error) {
      // Collapsed to one space, so the run never reaches whatever draws the message either.
      expect(String((error as Error).message)).toContain("Err = ( x)");
    }
  });

  test("a status code in a dial failure still becomes that code's own sentence", async () => {
    await expect(
      openReadOnlySession(failingEndpoints(new Error("BadCertificateUntrusted")), options()),
    ).rejects.toThrow(/not trusted by this connection/);
  });

  /** And where the library gave no remedy, the sentence adds one. */
  test("a dial failure with no advice in it gains the remedy", async () => {
    await expect(openReadOnlySession(failingEndpoints(new Error("socket hang up")), options())).rejects.toThrow(
      /Check the endpoint URL, and whether anything between here and the server refuses that port/,
    );
  });

  test("a username against a server that offers no UserName token is refused in our own words", async () => {
    const anonymousOnly = bridge([endpoint("None", PLC_THUMB)], fresh());
    const open = openReadOnlySession(
      anonymousOnly,
      options({
        mode: "None",
        identity: "username",
        user: "plant-reader",
        password: "s3cret",
        host: "127.0.0.1",
      }),
    );
    await expect(open).rejects.toThrow(/takes no username on its None endpoint: it accepts Anonymous/);
    await expect(open).rejects.toBeInstanceOf(DatabaseConfigError);
    // O-S8: the credential is in neither the message nor the remedy.
    try {
      await open;
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("s3cret");
      expect(String((error as Error).message)).not.toContain("plant-reader");
    }
  });

  /** The control: the same server with no username opens, so the refusal is about the token list. */
  test("the same server with no username opens", async () => {
    const client = await openReadOnlySession(bridge([endpoint("None", PLC_THUMB)], fresh()), options({ mode: "None" }));
    expect(await client.endpoints()).toHaveLength(1);
    await client.close();
  });
});

describe("a library throw becomes a sentence, and the code in it is read", () => {
  function throwingBridge(error: unknown, endpoints: readonly OpcuaEndpoint[]): OpcuaLibraryBridge {
    return {
      readEndpoints: async () => endpoints,
      openSession: async () => ({
        browse: async () => {
          throw error;
        },
        browseNext: async () => {
          throw error;
        },
        read: async () => {
          throw error;
        },
        historyRead: async () => {
          throw error;
        },
        close: async () => undefined,
      }),
      readLimits: async () => {
        throw error;
      },
      shapeBrowse: () => [],
      shapeRead: () => [],
      shapeHistory: (_answers, nodeId) => ({
        nodeId,
        values: [],
        statusCode: "Good",
      }),
    };
  }

  test("a message naming a Bad code answers that code's own sentence", async () => {
    const client = await openReadOnlySession(
      throwingBridge(new Error("the server answered BadNodeIdUnknown for ns=3;s=Gone"), [
        endpoint("SignAndEncrypt", PLC_THUMB),
      ]),
      options(),
    );
    await expect(client.read(["ns=3;s=Gone"])).rejects.toThrow(/BadNodeIdUnknown/);
    // The remedy travels with it: a namespace index moves between restarts.
    await expect(client.read(["ns=3;s=Gone"])).rejects.toThrow(/namespace index/);
  });

  test("a message with no code at all says which call failed, and nothing of the error object", async () => {
    const carrier = new Error("socket hang up");
    // The shape the library really throws: the request rides on the error, and the username with it.
    (carrier as unknown as { request: unknown }).request = {
      userIdentityToken: { userName: "plant-reader" },
    };
    const client = await openReadOnlySession(
      throwingBridge(carrier, [endpoint("SignAndEncrypt", PLC_THUMB)]),
      options(),
    );
    await expect(client.browse(["i=85"])).rejects.toThrow(/A browse failed: socket hang up/);
    try {
      await client.limits();
      throw new Error("the limits read did not fail");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("plant-reader");
    }
  });

  /**
   * A LIBRARY THROW WITH AN EMPTY MESSAGE STILL HAS TO SAY SOMETHING. Measured against the real
   * server: `{ "read": ["g=------------------------------------"] }` was accepted by the old node-id
   * grammar, the library refused to encode it, and the Error it threw carried an EMPTY message - so
   * the reader was answered "A read failed: " with nothing after the colon. The grammar now refuses
   * that id before the request, and this is the other half: whatever else arrives empty, the
   * sentence still names the call and says the library gave no reason.
   */
  test("a throw with no message at all names the call and says the library gave no reason", async () => {
    const client = await openReadOnlySession(
      throwingBridge(new Error(""), [endpoint("SignAndEncrypt", PLC_THUMB)]),
      options(),
    );
    await expect(client.read(["ns=3;s=X"])).rejects.toThrow(/A read failed, and the client library gave no reason/);
    // And it says what to look at, rather than stopping at "no reason".
    await expect(client.read(["ns=3;s=X"])).rejects.toThrow(/node id the library refuses to encode/);
  });

  /**
   * THE SESSION IS CLOSED WITH `deleteSubscriptions` TRUE, and the flag is asserted because nothing
   * else would notice it changing: this provider creates no subscription, so the server has nothing
   * to delete today - and asking anyway is what makes a server drop whatever it holds for the
   * session rather than leaving it to a timeout, on a server or a future version that does. Found
   * as a surviving mutation: flipping `session.close(true)` to `false` passed the whole suite.
   */
  test("the library session is closed with deleteSubscriptions true", async () => {
    const record = { ...fresh(), closeArgs: [] as (boolean | undefined)[] };
    const client = await openReadOnlySession(bridge([endpoint("SignAndEncrypt", PLC_THUMB)], record), options());
    await client.close();
    expect(record.closed).toBe(1);
    expect(record.closeArgs).toEqual([true]);
  });

  /**
   * THE CLOSE IS GUARDED TOO, and this is the call where it matters most: the Error the library
   * raises on a failing close carries the request that produced it, so an unguarded close would put
   * the ActivateSessionRequest - and the username inside it - into whatever logged the failure. The
   * guard was written and nothing tested it, which is how it could have been removed silently.
   */
  test("a close that throws reports which call failed and nothing of the error object", async () => {
    const carrier = new Error("BadConnectionClosed while closing");
    (carrier as unknown as { request: unknown }).request = {
      userIdentityToken: { userName: "plant-reader" },
    };
    const bridgeThatFailsOnClose: OpcuaLibraryBridge = {
      ...throwingBridge(carrier, [endpoint("SignAndEncrypt", PLC_THUMB)]),
      openSession: async () => ({
        browse: async () => [],
        browseNext: async () => [],
        read: async () => [],
        historyRead: async () => [],
        close: async () => {
          throw carrier;
        },
      }),
    };
    const client = await openReadOnlySession(bridgeThatFailsOnClose, options());
    try {
      await client.close();
      throw new Error("the close did not fail");
    } catch (error) {
      const message = String((error as Error).message);
      // The code in the message is read, as it is on every other call.
      expect(message).toContain("BadConnectionClosed");
      expect(message).not.toContain("plant-reader");
    }
  });

  test("a history continuation sends the window it was given, and the page comes back shaped", async () => {
    const record = fresh();
    const client = await openReadOnlySession(bridge([endpoint("SignAndEncrypt", PLC_THUMB)], record), options());
    const start = new Date("2026-10-12T00:00:00.000Z");
    const end = new Date("2026-10-12T01:00:00.000Z");
    const page = await client.historyReadNext({
      nodeId: "ns=3;s=H",
      continuationPoint: new Uint8Array([7]),
      startTime: start,
      endTime: end,
      valuesPerPage: 500,
    });
    expect(page.nodeId).toBe("ns=3;s=H");
    const sent = record.history[0] as Record<string, unknown>;
    expect(sent.continuationPoint).toEqual(new Uint8Array([7]));
    expect((sent.startTime as Date).getTime()).toBe(start.getTime());
    expect((sent.endTime as Date).getTime()).toBe(end.getTime());
    expect(sent.releaseContinuationPoints).toBeUndefined();
  });
});

/**
 * THE ENDPOINT IS A MODE AND A POLICY, and dialling one without the other reaches no endpoint.
 *
 * Measured against OPC PLC 2.15.10, which offers seven endpoints for three modes: a `SignAndEncrypt`
 * connection whose policy stayed at the library default answered "Cannot find an Endpoint matching
 * security mode: 3 policy: …#None" and never opened. The policy of the endpoint chosen here is what
 * the session dials with, unless the reader named one.
 */
describe("the chosen endpoint's policy is what the session dials with", () => {
  const BASIC = "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256";

  test("the policy travels with the mode when the reader named none", async () => {
    const record = fresh();
    await openReadOnlySession(bridge([endpoint("None"), endpoint("SignAndEncrypt", PLC_THUMB)], record), options());
    expect(record.options[0]?.policyUri).toBe(BASIC);
  });

  test("a policy the reader named is kept, and the endpoint must carry it", async () => {
    const record = fresh();
    await openReadOnlySession(bridge([endpoint("SignAndEncrypt", PLC_THUMB)], record), options({ policyUri: BASIC }));
    expect(record.options[0]?.policyUri).toBe(BASIC);

    const other = fresh();
    await expect(
      openReadOnlySession(
        bridge([endpoint("SignAndEncrypt", PLC_THUMB)], other),
        options({
          policyUri: "http://opcfoundation.org/UA/SecurityPolicy#Aes256_Sha256_RsaPss",
        }),
      ),
    ).rejects.toThrow(/offers no SignAndEncrypt endpoint with the policy/);
    expect(other.opened).toBe(0);
  });
});

/**
 * O-S3, WIRED: a credential that would cross the network unprotected is refused before the session.
 *
 * The refusal cannot be made where the connection is read, because whether the password is
 * protected depends on the server's UserName token policy, which only GetEndpoints answers (Part 4
 * 7.41). Measured through a proxy against stock asyncua, whose token declares None: without this,
 * the password crossed the wire in the clear.
 */
describe("a password that would cross the network unprotected", () => {
  const NONE_TOKEN: OpcuaEndpoint["userIdentityTokens"] = [
    {
      tokenType: "UserName",
      securityPolicyUri: "http://opcfoundation.org/UA/SecurityPolicy#None",
    },
  ];

  function withTokens(mode: OpcuaEndpoint["securityMode"], tokens: OpcuaEndpoint["userIdentityTokens"]): OpcuaEndpoint {
    return { ...endpoint(mode, PLC_THUMB), userIdentityTokens: tokens };
  }

  test("is refused, and nothing is opened", async () => {
    const record = fresh();
    await expect(
      openReadOnlySession(
        bridge([withTokens("None", NONE_TOKEN)], record),
        options({
          mode: "None",
          identity: "username",
          user: "reader",
          password: "secret",
          host: "plc.example.net",
        }),
      ),
    ).rejects.toThrow(/nothing encrypting it/);
    expect(record.opened).toBe(0);
  });

  test("a token with its own policy protects it, so the same connection opens", async () => {
    const record = fresh();
    const token: OpcuaEndpoint["userIdentityTokens"] = [
      {
        tokenType: "UserName",
        securityPolicyUri: "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256",
      },
    ];
    await openReadOnlySession(
      bridge([withTokens("None", token)], record),
      options({
        mode: "None",
        identity: "username",
        user: "reader",
        password: "secret",
        host: "plc.example.net",
      }),
    );
    expect(record.opened).toBe(1);
  });

  test("an encrypted channel protects it too, whatever the token declares", async () => {
    const record = fresh();
    await openReadOnlySession(
      bridge([withTokens("SignAndEncrypt", NONE_TOKEN)], record),
      options({
        identity: "username",
        user: "reader",
        password: "secret",
        host: "plc.example.net",
      }),
    );
    expect(record.opened).toBe(1);
  });

  test("loopback and a tunnel are exempt, because the credential does not cross a network", async () => {
    for (const over of [{ host: "127.0.0.1" }, { host: "plc.example.net", tunnelled: true }]) {
      const record = fresh();
      await openReadOnlySession(
        bridge([withTokens("None", NONE_TOKEN)], record),
        options({
          mode: "None",
          identity: "username",
          user: "reader",
          password: "secret",
          ...over,
        }),
      );
      expect(record.opened).toBe(1);
    }
  });
});

/**
 * THE CONNECT PATH IS TRANSLATED TOO (O-S8). Measured before it was: a dead port, a mode mismatch
 * and a username where the server offers no UserName token each arrived as the library's own Error,
 * so five of the nine codes the error table maps as configuration errors could never be produced -
 * and the library's Error is the one that carries the ActivateSessionRequest.
 */
describe("a library throw while the session is being opened", () => {
  function failingToOpen(error: unknown, endpoints: readonly OpcuaEndpoint[]): OpcuaLibraryBridge {
    return {
      readEndpoints: async () => endpoints,
      openSession: async () => {
        throw error;
      },
      readLimits: async () => ({}),
      shapeBrowse: () => [],
      shapeRead: () => [],
      shapeHistory: (_answers, nodeId) => ({
        nodeId,
        values: [],
        statusCode: "Good",
      }),
    };
  }

  test("a status code in the message becomes that code's sentence", async () => {
    await expect(
      openReadOnlySession(
        failingToOpen(new Error("ActivateSession failed: BadUserAccessDenied"), [
          endpoint("SignAndEncrypt", PLC_THUMB),
        ]),
        options(),
      ),
    ).rejects.toThrow(/the username or password is wrong/i);
  });

  test("a message with no code says the connection could not be opened, and nothing of the error object", async () => {
    const carrier = new Error("connect ECONNREFUSED 127.0.0.1:54840");
    (carrier as unknown as { request: unknown }).request = {
      userIdentityToken: { userName: "plant-reader" },
    };
    try {
      await openReadOnlySession(failingToOpen(carrier, [endpoint("SignAndEncrypt", PLC_THUMB)]), options());
      throw new Error("the connect did not fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("This connection could not be opened");
      expect(message).toContain("ECONNREFUSED");
      expect(message).not.toContain("plant-reader");
    }
  });

  /*
   * A DIRECTORY FAULT IS NOT AN ENDPOINT FAULT. The certificate manager creates its directories
   * lazily - measured live, both its construction and `initialize()` succeed under a read-only
   * parent - so an unwritable PKI root arrives as the DIAL's throw, and was answered with "This
   * connection could not be opened to opc.tcp://... Check the endpoint URL" about a server that was
   * listening. `tests/live/opcua-live-check.ts` makes the same measurement against a real server
   * with a read-only directory; this is the rule without one.
   */
  test("a dial that failed on the PKI directory names the directory and the variable, not the endpoint", async () => {
    const root = "/app/data/opcua-pki";
    const thrown = new Error(`EACCES: permission denied, mkdir '${root}'`);
    try {
      await openReadOnlySession(failingToOpen(thrown, [endpoint("SignAndEncrypt", PLC_THUMB)]), options());
      throw new Error("the connect did not fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("certificate directory could not be prepared");
      expect(message).toContain(root);
      expect(message).toContain("LIBREDB_OPCUA_PKI_ROOT");
      expect(message).not.toContain("could not be opened to");
    }
  });

  /*
   * A ROOT WITH TWO SPACES IN IT STILL MATCHES, because the message it is compared against has had
   * every whitespace run collapsed to one. Without flattening the root the same way, this case fell
   * through to the generic endpoint sentence about a server that was listening - the exact failure
   * the test above exists to prevent, reopened by a directory somebody named with a double space.
   */
  test("a PKI root holding two spaces is still recognised in the flattened message", async () => {
    const root = "/Volumes/plant  data/opcua-pki";
    const thrown = new Error(`EACCES: permission denied, mkdir '${root}'`);
    try {
      await openReadOnlySession(
        failingToOpen(thrown, [endpoint("SignAndEncrypt", PLC_THUMB)]),
        options({ pkiRoot: root }),
      );
      throw new Error("the connect did not fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("certificate directory could not be prepared");
      // The sentence prints the REAL root, not the flattened one it was matched by.
      expect(message).toContain(root);
      expect(message).not.toContain("could not be opened to");
    }
  });

  /* Both halves are required, so an unrelated EACCES keeps the endpoint's own sentence. */
  test("an EACCES that does not name this connection's PKI root stays the endpoint's refusal", async () => {
    const thrown = new Error("EACCES: permission denied, open '/etc/ssh/id_ed25519'");
    try {
      await openReadOnlySession(failingToOpen(thrown, [endpoint("SignAndEncrypt", PLC_THUMB)]), options());
      throw new Error("the connect did not fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("This connection could not be opened");
      expect(message).not.toContain("certificate directory");
    }
  });
});
