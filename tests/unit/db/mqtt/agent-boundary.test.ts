/**
 * The MQTT agent boundary as the pinned brokers answered it (`docs/providers/mqtt.md` section 14), read from the
 * capture `tests/fixtures/mqtt/mosquitto-2.1.2/agent-boundary/boundary.json` that its `run.sh` records. Each claim the
 * provider doc makes about a broker is held to the capture here, so a capture recorded again cannot drift from it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MQTT_COMPLETENESS } from "@/lib/db/providers/keyvalue/mqtt/agent-read";

interface Sent {
  readonly packet: string;
  readonly cleanStart?: boolean;
  readonly will?: boolean;
  readonly sessionExpiryZero?: boolean;
  readonly filters?: readonly string[];
  readonly options?: readonly number[];
}
interface Read {
  readonly rows: readonly Record<string, unknown>[];
  readonly warnings: readonly string[];
  readonly carriesWithheld: boolean;
  readonly carriesCredential: boolean;
  readonly sent: readonly (readonly Sent[])[];
}

const capture = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dir, "../../../fixtures/mqtt/mosquitto-2.1.2/agent-boundary/boundary.json"),
    "utf8",
  ),
) as {
  readonly connect: readonly (readonly Sent[])[];
  readonly reads: Readonly<Record<string, Read>>;
  readonly refusedBeforeSend: readonly { readonly sessionsOpened: number; readonly carriesWithheld: boolean }[];
  readonly rawRefused: {
    readonly wildcardBelowRoot: { readonly namesASeededTopic: boolean };
    readonly sharedSubscription: { readonly messagesTakenIn2s: number };
  };
  readonly rawPublish: Readonly<Record<"asAgent" | "asWriter", { readonly retainedChanged: boolean }>>;
  readonly sys: Readonly<Record<"mosquitto" | "emqx", Readonly<Record<string, number | boolean>>>>;
  readonly state: { readonly retainedUnchanged: boolean };
  readonly emqx: Readonly<Record<string, Read>>;
};

const reads = [...Object.values(capture.reads), ...Object.values(capture.emqx)];

describe("what the agent sent", () => {
  test("connect is a handshake that subscribes to nothing", () => {
    expect(capture.connect).toEqual([
      [{ packet: "CONNECT", cleanStart: true, will: false, sessionExpiryZero: true }, { packet: "DISCONNECT" }],
    ]);
  });

  test("every read is one session of CONNECT, one SUBSCRIBE to # or the requested topic, and DISCONNECT", () => {
    for (const read of reads) {
      expect(read.sent).toHaveLength(1);
      const [connect, subscribe, disconnect, ...rest] = read.sent[0] as Sent[];
      expect(connect).toEqual({ packet: "CONNECT", cleanStart: true, will: false, sessionExpiryZero: true });
      expect(subscribe?.packet).toBe("SUBSCRIBE");
      expect(subscribe?.options).toEqual([4]);
      expect(disconnect).toEqual({ packet: "DISCONNECT" });
      expect(rest).toEqual([]);
    }
    expect(capture.reads.window?.sent[0]?.[1]?.filters).toEqual(["#"]);
    expect(capture.reads.topicNotSeen?.sent[0]?.[1]?.filters).toEqual(["<the requested topic>"]);
  });

  test("every refused request opened no session and quoted nothing withheld", () => {
    expect(capture.refusedBeforeSend.length).toBeGreaterThan(0);
    for (const refused of capture.refusedBeforeSend) {
      expect(refused.sessionsOpened).toBe(0);
      expect(refused.carriesWithheld).toBe(false);
    }
  });
});

describe("what the agent answered", () => {
  test("no answer carried a topic name, a payload or a credential, and every one ends with the completeness sentence", () => {
    for (const read of reads) {
      expect(read.carriesWithheld).toBe(false);
      expect(read.carriesCredential).toBe(false);
      expect(read.warnings.at(-1)).toBe(MQTT_COMPLETENESS);
      expect(read.rows[0]?.scope).not.toBe("complete");
    }
  });

  test("a topic seen and a topic not seen, and a stock EMQX refusing #", () => {
    expect(capture.reads.topicSeenRetained?.rows[0]).toMatchObject({ seen: true, retained: true });
    expect(capture.reads.topicNotSeen?.rows[0]).toMatchObject({ seen: false, retained: null });
    expect(capture.emqx.window?.rows[0]).toMatchObject({
      stop_reason: "subscription-refused",
      broker_reason_code: 135,
      messages: 0,
    });
    expect(capture.emqx.topicSeenRetained?.rows[0]).toMatchObject({ seen: true });
  });
});

describe("what the broker does with what agent mode refuses, sent raw", () => {
  test("a wildcard below the root names a topic, and a shared subscription takes messages", () => {
    expect(capture.rawRefused.wildcardBelowRoot.namesASeededTopic).toBe(true);
    expect(capture.rawRefused.sharedSubscription.messagesTakenIn2s).toBeGreaterThan(0);
  });

  test("the agent's read-only credential publishes nothing, and a writer's publish lands, so the table is the boundary", () => {
    expect(capture.rawPublish.asAgent.retainedChanged).toBe(false);
    expect(capture.rawPublish.asWriter.retainedChanged).toBe(true);
    expect(capture.state.retainedUnchanged).toBe(true);
  });

  test("EMQX's $SYS carries a client's id, user name and address, and Mosquitto's none", () => {
    expect(capture.sys.emqx).toMatchObject({
      topicNamesCarryClientId: true,
      carryUserName: true,
      carryAnAddress: true,
    });
    expect(capture.sys.mosquitto).toMatchObject({
      topicNamesCarryClientId: false,
      payloadsCarryClientId: false,
      carryUserName: false,
      carryAnAddress: false,
    });
  });
});
