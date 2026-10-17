/**
 * The encoder's packets, byte by byte, and the absence that is the point of the module.
 *
 * Two kinds of assertion live here. The first pins each packet's bytes, because a packet that is
 * nearly right is refused by a broker with a reason code and no explanation. The second holds the
 * read-only guarantee from two sides: this module has no function that writes a PUBLISH, and the
 * decoder's import path carries no writer either.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLIENT_ID_PREFIX,
  KEEP_ALIVE_SECONDS,
  MQTT_PROTOCOL_LEVEL,
  MQTT_PROTOCOL_NAME,
  PING_INTERVAL_MS,
} from "@/lib/db/providers/industrial/sparkplug/constants";
import {
  encodeConnect,
  encodeDisconnect,
  encodePingReq,
  encodeSubscribe,
  encodeUnsubscribe,
  mqttString,
  PACKET,
  varint,
} from "@/lib/db/providers/industrial/sparkplug/encoder";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");

describe("the variable byte integer, at the boundaries the specification names", () => {
  test.each([
    [0, "00"],
    [127, "7f"],
    [128, "80 01"],
    [16_383, "ff 7f"],
    [16_384, "80 80 01"],
    [268_435_455, "ff ff ff 7f"],
  ])("%i encodes as %s", (value, expected) => {
    expect(hex(varint(value))).toBe(expected);
  });

  test("the encodings are ASYMMETRIC, so a reversed read cannot pass", () => {
    // 128 is `80 01` and 16,384 is `80 80 01`: reading either backwards gives a different number.
    // A value like 0 or 127 is a single byte and proves nothing about order.
    expect(hex(varint(128))).not.toBe(
      [...varint(128)]
        .reverse()
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" "),
    );
  });

  test.each([[-1], [268_435_456], [1.5]])("%p is refused rather than truncated", (value) => {
    expect(() => varint(value)).toThrow(/variable byte integer/);
  });
});

describe("an MQTT string carries its own length", () => {
  test("a short string", () => {
    expect(hex(mqttString("MQTT"))).toBe("00 04 4d 51 54 54");
  });

  test("a string whose length needs both bytes, which a one-byte length would truncate", () => {
    const long = "a".repeat(300);
    const encoded = mqttString(long);
    expect(encoded[0]).toBe(0x01);
    expect(encoded[1]).toBe(0x2c);
    expect(encoded.length).toBe(302);
  });

  test("a multi-byte character counts BYTES and not characters", () => {
    // Two characters, four bytes. A length in characters would say 2 and the broker would refuse.
    // Written as escapes on purpose: this file stays pure ASCII, and the gate checks that.
    const encoded = mqttString("\u00e7\u00e7");
    expect(encoded[1]).toBe(4);
    expect(encoded.length).toBe(6);
  });

  test("a string past 65,535 bytes is refused", () => {
    expect(() => mqttString("a".repeat(65_536))).toThrow(/65,535/);
  });
});

describe("the CONNECT declares Clean Start, no session to expire, and NO will", () => {
  test("the fixed bytes, field by field", () => {
    const bytes = encodeConnect({ clientId: "libredb-abcdef01", keepAliveSeconds: KEEP_ALIVE_SECONDS });
    expect(bytes[0]).toBe(PACKET.CONNECT);
    // Protocol name, then level.
    expect(hex(bytes.subarray(2, 8))).toBe("00 04 4d 51 54 54");
    // A PASSENGER UNTIL THE LITERAL WENT IN. This read `toBe(MQTT_PROTOCOL_LEVEL)`, which compares
    // the encoded byte to the very constant that produced it: change the constant and the encoder
    // changes with it, so the assertion cannot fail. The protocol level is not a free choice, it is
    // 5 because this is MQTT 5.0, so the literal is the thing worth pinning.
    expect(bytes[8]).toBe(5);
    expect(MQTT_PROTOCOL_LEVEL).toBe(5);
    expect(MQTT_PROTOCOL_NAME).toBe("MQTT");
    // Connect flags: Clean Start only.
    expect(bytes[9]).toBe(0x02);
    // Keep alive, two bytes big-endian.
    expect(bytes[10]).toBe(0x00);
    expect(bytes[11]).toBe(60);
  });

  test("THE WILL FLAG IS CLEAR, and no argument could set it", () => {
    /*
     * Bit 2 of the connect flags is the Will Flag. A will IS a publish: specification 5.4
     * registers an edge node's death certificate as its MQTT will, so a reader that set one would
     * publish a death on a broker the moment its own socket dropped. The absence is structural
     * rather than a default, and this assertion plus the next one say so from both sides.
     */
    for (const options of [
      { clientId: "libredb-1", keepAliveSeconds: 60 },
      { clientId: "libredb-1", keepAliveSeconds: 60, user: "reader" },
      { clientId: "libredb-1", keepAliveSeconds: 60, user: "reader", password: "secret" },
    ]) {
      const bytes = encodeConnect(options);
      expect(bytes[9] & 0x04).toBe(0);
    }
  });

  test("the session expiry property is present and zero", () => {
    const bytes = encodeConnect({ clientId: "libredb-1", keepAliveSeconds: 60 });
    // Property length 5, then identifier 0x11 and four zero bytes.
    expect(bytes[12]).toBe(0x05);
    expect(hex(bytes.subarray(13, 18))).toBe("11 00 00 00 00");
  });

  test("the credential flags follow the credentials, and the three cases differ", () => {
    expect(encodeConnect({ clientId: "c", keepAliveSeconds: 60 })[9]).toBe(0x02);
    expect(encodeConnect({ clientId: "c", keepAliveSeconds: 60, user: "u" })[9]).toBe(0x82);
    expect(encodeConnect({ clientId: "c", keepAliveSeconds: 60, user: "u", password: "p" })[9]).toBe(0xc2);
  });

  test("a client identifier carries the shipped prefix", () => {
    expect(CLIENT_ID_PREFIX).toBe("libredb-");
    expect(PING_INTERVAL_MS).toBe(30_000);
  });
});

describe("a SUBSCRIBE carries several filters in one packet, every one at QoS 0", () => {
  test("one filter", () => {
    const bytes = encodeSubscribe(1, ["spBv1.0/#"]);
    expect(bytes[0]).toBe(PACKET.SUBSCRIBE);
    expect(hex(bytes.subarray(2, 4))).toBe("00 01");
    // Property length, then the filter and its options byte.
    expect(bytes[4]).toBe(0x00);
    expect(bytes[bytes.length - 1]).toBe(0x00);
  });

  test("THREE filters in ONE packet, which is what a Sparkplug read needs", () => {
    /*
     * Two cases that differ, because a one-filter test is satisfied by an encoder that ignores
     * everything after the first. The stored certificates need a filter of their own, since
     * MQTT 5.0 4.7.2 keeps a wildcard filter from matching a topic beginning with `$`.
     */
    const one = encodeSubscribe(7, ["spBv1.0/G1/#"]);
    const three = encodeSubscribe(7, ["spBv1.0/G1/#", "$sparkplug/certificates/spBv1.0/G1/#", "spBv1.0/STATE/#"]);
    expect(three.length).toBeGreaterThan(one.length);
    const text = new TextDecoder().decode(three);
    expect(text).toContain("spBv1.0/G1/#");
    expect(text).toContain("$sparkplug/certificates/spBv1.0/G1/#");
    expect(text).toContain("spBv1.0/STATE/#");
  });

  test("EVERY filter's options byte is QoS 0, walked out of the packet rather than guessed", () => {
    /*
     * THE FIRST VERSION OF THIS TEST WAS A PASSENGER. It computed an index as
     * `6 + text.indexOf("a/#") - text.indexOf("a/#")`, which is just 6, asserted that the byte
     * there was defined, and proved nothing at all. The packet is walked properly here: past the
     * fixed header and the packet identifier, then filter by filter, checking the options byte
     * that follows each one.
     */
    const filters = ["a/#", "bb/#", "ccc/#"];
    const bytes = encodeSubscribe(1, filters);
    // Fixed header is one byte plus a one-byte remaining length at this size, then two bytes of
    // packet identifier, then a one-byte property length of zero.
    let at = 1 + 1 + 2 + 1;
    const seen: string[] = [];
    const options: number[] = [];
    while (at < bytes.length) {
      const length = (bytes[at] << 8) | bytes[at + 1];
      seen.push(new TextDecoder().decode(bytes.subarray(at + 2, at + 2 + length)));
      options.push(bytes[at + 2 + length]);
      at += 2 + length + 1;
    }
    expect(seen).toEqual(filters);
    expect(options).toEqual([0, 0, 0]);
    // And the signature takes no QoS argument at all, which is the structural half.
    expect(encodeSubscribe.length).toBe(2);
  });

  test("an empty filter list is refused rather than sent", () => {
    expect(() => encodeSubscribe(1, [])).toThrow(/at least one filter/);
    expect(() => encodeUnsubscribe(1, [])).toThrow(/at least one filter/);
  });
});

describe("the two packets that end a read", () => {
  test("PINGREQ is two bytes and carries nothing", () => {
    expect(hex(encodePingReq())).toBe("c0 00");
  });

  test("DISCONNECT is Normal Disconnection with no properties", () => {
    expect(hex(encodeDisconnect())).toBe("e0 01 00");
  });

  test("an UNSUBSCRIBE names the same filters back", () => {
    const bytes = encodeUnsubscribe(9, ["spBv1.0/#", "$sparkplug/#"]);
    expect(bytes[0]).toBe(PACKET.UNSUBSCRIBE);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("spBv1.0/#");
    expect(text).toContain("$sparkplug/#");
  });
});

describe("THE READ-ONLY GUARANTEE, held from both sides", () => {
  test("the packet table has five entries and no PUBLISH", () => {
    expect(Object.keys(PACKET).sort()).toEqual(["CONNECT", "DISCONNECT", "PINGREQ", "SUBSCRIBE", "UNSUBSCRIBE"]);
    // 0x30 is PUBLISH's first byte. No entry carries it.
    expect(Object.values(PACKET)).not.toContain(0x30);
  });

  test("the module's source has no PUBLISH encoder, with comments stripped", () => {
    /*
     * The sweep strips comments first, because this file's own prose names PUBLISH several times
     * and counting prose as code is a mistake three separate scans in this project have made.
     */
    const source = readFileSync(
      path.join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "src",
        "lib",
        "db",
        "providers",
        "industrial",
        "sparkplug",
        "encoder.ts",
      ),
      "utf8",
    )
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/\/\/.*$/gm, "");
    expect(source).not.toContain("PUBLISH");
    expect(source).not.toContain("0x30");
    expect(source).not.toContain("encodePublish");
  });

  test("the DECODER's import path carries no writer, and the package ROOT does", async () => {
    /*
     * The two-sided form, copied from the shipped MQTT provider's own guard because the shape is
     * the proof rather than the habit. The type declaration in `src/types/db-drivers.d.ts` states
     * it outright: THE SPECIFIER IS THE GUARANTEE. The subpath is `module.exports = Parser` and
     * reaches no writer; the root is three lines that re-export `generate` and `writeToStream`, so
     * importing it would put a packet writer one call away from a PUBLISH.
     *
     * Asserting only the subpath would be the one-sided version: it would pass even if the root
     * had no writer either, which would make the whole distinction meaningless.
     */
    const subpath = await import("mqtt-packet/parser.js");
    const member = (holder: unknown, name: string) => {
      const record = holder as Record<string, unknown> | undefined;
      return record?.[name] ?? (record?.default as Record<string, unknown> | undefined)?.[name];
    };
    expect(typeof member(subpath, "parser")).toBe("function");
    expect(member(subpath, "generate")).toBeUndefined();
    expect(member(subpath, "writeToStream")).toBeUndefined();

    const root = await import("mqtt-packet");
    expect(typeof member(root, "generate")).toBe("function");
    expect(typeof member(root, "writeToStream")).toBe("function");
  });

  test("the parser from that subpath decodes a real CONNACK", async () => {
    const subpath = await import("mqtt-packet/parser.js");
    const lifted = subpath as unknown as Record<string, unknown>;
    const factory = (lifted.parser ?? (lifted.default as Record<string, unknown> | undefined)?.parser) as (options: {
      protocolVersion: number;
    }) => { on: (event: string, handler: (value: unknown) => void) => void; parse: (bytes: Buffer) => void };
    const parser = factory({ protocolVersion: MQTT_PROTOCOL_LEVEL });
    let seen: Record<string, unknown> | undefined;
    parser.on("packet", (value) => {
      seen = value as Record<string, unknown>;
    });
    parser.parse(Buffer.from([0x20, 0x02, 0x00, 0x00]));
    expect(seen?.cmd).toBe("connack");
    expect(seen?.reasonCode).toBe(0);
    expect(seen?.sessionPresent).toBe(false);
  });
});
