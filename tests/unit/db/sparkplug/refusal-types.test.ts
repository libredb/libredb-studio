/**
 * Every refusal's TYPE, not its message.
 *
 * A message can be rewritten without breaking anything. A type cannot: the shipped handling in
 * `providers/platform/kubernetes/objects.ts` turns a failure into `{ unavailable: error.message }`
 * only for `QueryError` and `TimeoutError`, and `isQueryError` is an `instanceof QueryError`. So a
 * refusal raised in the wrong type passes through as an unexpected failure and the sentence it
 * carries never reaches a user. These assertions are the ones that keep that from happening
 * quietly.
 */
import { describe, expect, test } from "bun:test";
import { ConnectionError, DatabaseConfigError, isQueryError, QueryError } from "@/lib/db/errors";
import { SparkplugProvider } from "@/lib/db/providers/industrial/sparkplug";
import { decodePayload, PayloadRefused } from "@/lib/db/providers/industrial/sparkplug/decode";
import { encodeSubscribe, mqttString, varint } from "@/lib/db/providers/industrial/sparkplug/encoder";
import { parseReadQuery } from "@/lib/db/providers/industrial/sparkplug/request";
import { ReadState } from "@/lib/db/providers/industrial/sparkplug/state";
import type { DatabaseConnection } from "@/lib/types";

const connection = (over: Partial<DatabaseConnection> = {}): DatabaseConnection =>
  ({ id: "c1", name: "plant", type: "mqtt", host: "broker.invalid", port: 1883, ...over }) as DatabaseConnection;
const reader = async () => ({ state: new ReadState(), endReason: "budget", messagesSeen: 0, bytesSeen: 0 });

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown, but a refusal was expected");
}

async function thrownAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown, but a refusal was expected");
}

describe("a read request's refusals are QueryErrors, so their sentence can reach a user", () => {
  test.each([
    ['{"rebirth":true}', "a rebirth request"],
    ['{"hostId":"IamHost"}', "a host id"],
    ['{"command":"x"}', "a command"],
    ['{"publish":1}', "a publish"],
    ['{"edgenode":"E1"}', "an unknown field"],
    ["not json", "text that is not JSON"],
    ["[1,2]", "a JSON array"],
    ['{"device":"D1"}', "a device with no edge node"],
    ['{"seconds":0}', "a window outside the bounds"],
    ['{"limit":0}', "a row count outside the bounds"],
    ['{"includeBirths":"yes"}', "a non-boolean flag"],
  ])("%s is refused as a QueryError (%s)", (text) => {
    const error = thrown(() => parseReadQuery(text));
    expect(error instanceof QueryError).toBe(true);
    expect(isQueryError(error)).toBe(true);
  });
});

describe("the CLASS of a connect refusal decides what the panel tells a user to do", () => {
  /*
   * THE GAP THIS CLOSES WAS MEASURED THROUGH THE ROUTE, NOT READ OFF THE CODE. With the engine
   * registered, a connection test against an address with nothing listening came back
   * `400 QUERY_ERROR`: the panel then says the request was wrong, when what was wrong was the
   * address. `ConnectionError` is the class the route turns into `503 CONNECTION_ERROR` with
   * `retryable: true`. The four sentences were already asserted to be four and to name the address;
   * NONE of them asserted the class, so the difference between "fix your request" and "nothing
   * answered" was held by nothing.
   */
  const reasonFor = async (endReason: string) => {
    const provider = new SparkplugProvider(connection({ host: "plant.example", port: 1883 }), {}, {}, async () => ({
      state: new ReadState(),
      endReason,
      messagesSeen: 0,
      bytesSeen: 0,
    }));
    return thrownAsync(() => provider.connect());
  };

  test.each([["dial-failed"], ["connect-refused"]])(
    "%s is a ConnectionError, because no session was ever open",
    async (endReason) => {
      const error = await reasonFor(endReason);
      expect(error instanceof ConnectionError).toBe(true);
      // And NOT a QueryError: the route checks ConnectionError first, but a class that was both
      // would be read as whichever branch came first, which is not a decision anyone made.
      expect(error instanceof QueryError).toBe(false);
      // The host and port are FIELDS, so a caller does not have to parse the sentence for them.
      expect((error as ConnectionError).host).toBe("plant.example");
      expect((error as ConnectionError).port).toBe(1883);
    },
  );

  test.each([["subscription-refused"], ["wildcards-unavailable"]])(
    "%s stays a QueryError, because the connection opened and it is this READ that was refused",
    async (endReason) => {
      const error = await reasonFor(endReason);
      expect(error instanceof QueryError).toBe(true);
      expect(isQueryError(error)).toBe(true);
      expect(error instanceof ConnectionError).toBe(false);
    },
  );
});

describe("a connection's own refusals are configuration errors, which is a different thing", () => {
  test.each([
    [{ host: "" }, "an empty broker address"],
    [{ port: 0 }, "a port outside 1 to 65,535"],
    [{ database: "plant/line1" }, "a group name that cannot be a filter"],
  ])("%s is refused as a DatabaseConfigError (%s)", async (over) => {
    const error = await thrownAsync(() => new SparkplugProvider(connection(over), {}, {}, reader).connect());
    // Deliberately NOT a QueryError: this is what the connection was given, not what a read asked,
    // and the shipped MQTT provider classifies the same cases the same way.
    expect(error instanceof DatabaseConfigError).toBe(true);
    expect(error instanceof QueryError).toBe(false);
  });

  test("a read before connect is a QueryError, because it is a read that failed", async () => {
    const error = await thrownAsync(() => new SparkplugProvider(connection(), {}, {}, reader).listContainers());
    expect(error instanceof QueryError).toBe(true);
  });

  test("a build with no transport dials for itself, and a dial that fails is a ConnectionError", async () => {
    // THIS TEST CHANGED ITS ANSWER, AND THE CHANGE IS THE POINT. With no seam the provider dials a
    // real socket; `broker.invalid` resolves nowhere, so this is the live form of `dial-failed`.
    // It used to assert a QueryError, which is how the route came to answer a wrong address with
    // `400 QUERY_ERROR`. The sentence is unchanged; only the class, and with it the status.
    const error = await thrownAsync(() => new SparkplugProvider(connection()).connect());
    expect(error instanceof ConnectionError).toBe(true);
    expect(error instanceof QueryError).toBe(false);
  });
});

describe("a payload refusal is a QueryError AND an instance of itself", () => {
  /** A payload that declares a two-gigabyte field in sixteen bytes. */
  const hostile = new Uint8Array([0x12, 0xff, 0xff, 0xff, 0xff, 0x07, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  test("it reaches the shipped conversion, which only takes QueryError and TimeoutError", () => {
    const error = thrown(() => decodePayload(hostile));
    expect(error instanceof QueryError).toBe(true);
    expect(isQueryError(error)).toBe(true);
  });

  test("it is an instance of ITSELF, which the prototype line is what makes true", () => {
    /*
     * THE GUARD THIS FILE EXISTS FOR. Nine classes in `src/lib/db/errors.ts` end their constructor
     * with `Object.setPrototypeOf(this, <ThatClass>.prototype)`, which points the object being
     * constructed at the BASE's prototype. A subclass that does not put its own back is not an
     * instance of itself, and `constructor.name` then reads as the base class's name, so a log
     * line does not show it either. Removing the prototype line from `PayloadRefused` turns this
     * assertion red, which is the only thing that keeps it in place.
     */
    const error = thrown(() => decodePayload(hostile));
    expect(error instanceof PayloadRefused).toBe(true);
    expect((error as Error).constructor.name).toBe("PayloadRefused");
    expect((error as Error).name).toBe("PayloadRefused");
  });

  test("the bound it hit is a field, not a message a caller has to parse", () => {
    const error = thrown(() => decodePayload(hostile)) as PayloadRefused;
    expect(error.reason).toBe("field-too-large");
  });

  test("a caller can tell a payload refusal from any other query error", () => {
    const refusal = thrown(() => decodePayload(hostile));
    const other = new QueryError("something else");
    expect(refusal instanceof PayloadRefused).toBe(true);
    expect(other instanceof PayloadRefused).toBe(false);
  });
});

describe("every surface reaches the boundary as a QueryError, and the boundary stays selective", () => {
  /*
   * THE MEASURE THAT MATTERS IS NOT "is there a plain Error in the source". A sibling session
   * measured a provider whose own named error class derived from Error and was never converted at
   * the boundary: there was no `throw new Error(` to grep for, and the sentences still reached
   * nobody. So the question is asked surface by surface, by running each one.
   */
  const refusingReader = async () => {
    throw new PayloadRefused("depth-cap", "nesting deeper than 32 messages");
  };

  test("a payload refusal from the reader survives connect as a QueryError", async () => {
    // This is the path a decode refusal will take once the shared transport lands.
    const error = await thrownAsync(() => new SparkplugProvider(connection(), {}, {}, refusingReader).connect());
    expect(error instanceof QueryError).toBe(true);
    expect(error instanceof PayloadRefused).toBe(true);
    expect((error as Error).message).toContain("nesting deeper than 32 messages");
  });

  test("a payload refusal from the reader survives a console read as a QueryError", async () => {
    const provider = new SparkplugProvider(connection(), {}, {}, refusingReader);
    // The connect read is the one that fails here, which is itself the first case.
    const error = await thrownAsync(() => provider.connect());
    expect(isQueryError(error)).toBe(true);
  });

  test.each([
    ["listContainers", (p: SparkplugProvider) => p.listContainers()],
    ["countObjects", (p: SparkplugProvider) => p.countObjects(["G1", "E1"])],
    ["listObjects", (p: SparkplugProvider) => p.listObjects(["G1", "E1"], "node")],
    ["describeObject", (p: SparkplugProvider) => p.describeObject(["G1", "E1"], "node")],
    ["describeObjects", (p: SparkplugProvider) => p.describeObjects(["G1", "E1"], "node")],
    ["readObjectSource", (p: SparkplugProvider) => p.readObjectSource(["G1", "E1"], "node")],
    ["query", (p: SparkplugProvider) => p.query("{}")],
    ["getOverview", (p: SparkplugProvider) => p.getOverview()],
    ["runMaintenance", (p: SparkplugProvider) => p.runMaintenance()],
  ])("%s on a closed connection reaches the boundary as a QueryError", async (_name, call) => {
    const error = await thrownAsync(() => call(new SparkplugProvider(connection(), {}, {}, reader)));
    expect(isQueryError(error)).toBe(true);
  });

  test("getHealth does NOT throw on a closed connection, which is deliberate", async () => {
    // Health is the one surface a panel asks before anything works, so it answers "unknown"
    // rather than refusing. A refusal here would blank the panel that is supposed to explain why.
    const health = await new SparkplugProvider(connection(), {}, {}, reader).getHealth();
    expect(health.databaseSize).toBe("unknown");
    expect(health.cacheHitRatio).toBe("unknown");
  });

  test("THE BOUNDARY IS SELECTIVE: an unrelated error passes through unchanged", async () => {
    /*
     * The second case the rule asks for. Converting everything into a QueryError would be as wrong
     * as converting nothing: a TypeError from a programming mistake is not a query that failed, and
     * dressing it as one sends a developer looking at the broker.
     */
    const broken = async () => {
      throw new TypeError("this is a programming mistake, not a refusal");
    };
    const error = await thrownAsync(() => new SparkplugProvider(connection(), {}, {}, broken).connect());
    expect(error instanceof TypeError).toBe(true);
    expect(error instanceof QueryError).toBe(false);
    expect(isQueryError(error)).toBe(false);
  });
});

describe("THE FOURTH SCOPE: our own defect has none, and is not dressed as a failure", () => {
  /*
   * The three scopes above are a failed read, a connection that cannot work, and an unrelated
   * error. The fourth is narrower and more specific: a value OUR OWN CODE could not legitimately
   * produce, reaching our own function. A variable byte integer outside 0 to 268,435,455, a string
   * past 65,535 bytes, or a subscribe with no filters are not things a broker did and not things a
   * user asked for. They are this provider building a packet wrongly.
   *
   * Dressing one as a query failure would tell the user their read was refused and send them to
   * look at the device, which is the one place the answer is not. So these keep their own clothes.
   */
  test.each([
    ["a variable byte integer below zero", () => varint(-1)],
    ["a variable byte integer past the maximum", () => varint(268_435_456)],
    ["a variable byte integer that is not whole", () => varint(1.5)],
    ["a string past 65,535 bytes", () => mqttString("a".repeat(65_536))],
    ["a subscribe with no filters", () => encodeSubscribe(1, [])],
  ])("%s is a RangeError and is NOT converted", (_name, call) => {
    const error = thrown(call);
    expect(error instanceof RangeError).toBe(true);
    expect(error instanceof QueryError).toBe(false);
    expect(isQueryError(error)).toBe(false);
  });

  test("and the contrast: a bound the WIRE tripped IS a query failure", () => {
    // The pair that makes the distinction visible. A payload that is too large came from somewhere
    // else and spoiled one read; a packet this provider built wrongly came from here.
    const hostile = new Uint8Array([0x12, 0xff, 0xff, 0xff, 0xff, 0x07, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(isQueryError(thrown(() => decodePayload(hostile)))).toBe(true);
    expect(isQueryError(thrown(() => varint(-1)))).toBe(false);
  });
});
