/**
 * Values, and the two conditions that make bytes text (SN-S7).
 *
 * Every input below was measured, on 13 October 2026, either on the wire against Net-SNMP
 * snmpd 5.9.4 or in the runtime under Node 24.14.0 and Bun 1.4.2. Three of them are here
 * because a mutation run showed the check they belong to was not bound by anything: the C1
 * case used to carry a NUL, so the C0 check caught it first; the byte order mark case used to
 * be `feff41`, which is not valid UTF-8 at all, so the decoder refused it before the mark check
 * was reached; and the leading mark turned out to be stripped by the decoder itself.
 */
import { describe, expect, test } from "bun:test";
import { isShowableText, readUnsigned, renderValue } from "@/lib/db/providers/network/snmp/values";

const bytes = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));

describe("a 64 bit counter survives as a decimal string", () => {
  test("2^53+1 is exact, where a Number is not", () => {
    const rendered = renderValue({ kind: "counter64" }, bytes("20000000000001"));
    expect(rendered.display).toBe("9007199254740993");
    expect(rendered.as).toBe("decimalString");
    expect(String(Number("9007199254740993"))).toBe("9007199254740992");
  });
  test("2^64-1 is exact, leading zero octet and all", () => {
    expect(renderValue({ kind: "counter64" }, bytes("00ffffffffffffffff")).display).toBe("18446744073709551615");
  });
  test("what reaches a result can be serialised", () => {
    const rendered = renderValue({ kind: "counter64" }, bytes("20000000000001"));
    expect(() => JSON.stringify({ value: rendered.display })).not.toThrow();
    expect(typeof rendered.display).toBe("string");
  });
  test("readUnsigned is exact at eight octets", () => {
    expect(readUnsigned(bytes("ffffffffffffffff")).toString()).toBe("18446744073709551615");
  });
});

describe("32 bit values are exact at their limits", () => {
  test("an unsigned maximum is not read as minus one", () => {
    expect(renderValue({ kind: "counter32" }, bytes("ffffffff")).display).toBe("4294967295");
    expect(renderValue({ kind: "gauge32" }, bytes("ffffffff")).display).toBe("4294967295");
  });
  test("a signed minimum keeps its sign", () => {
    expect(renderValue({ kind: "integer" }, bytes("80000000")).display).toBe("-2147483648");
    expect(renderValue({ kind: "integer" }, bytes("0000007b")).display).toBe("123");
  });
});

describe("text needs the MIB to say so AND the bytes to be showable", () => {
  test("a MAC address decodes cleanly and is still not text", () => {
    expect(isShowableText(bytes("001a2b3c4d5e"))).toBe(false);
    const rendered = renderValue({ kind: "macAddress" }, bytes("001a2b3c4d5e"));
    expect(rendered.display).toBe("00:1a:2b:3c:4d:5e");
    expect(rendered.as).toBe("hex");
  });
  test("an ANSI escape sequence passes the decode and fails the reading", () => {
    const escape = bytes("1b5b33316d5245441b5b306d");
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(escape)).not.toThrow();
    expect(isShowableText(escape)).toBe(false);
    expect(renderValue({ kind: "text" }, escape).as).toBe("hex");
  });
  test("plain text where the MIB says text", () => {
    expect(renderValue({ kind: "text" }, bytes("6c6f")).display).toBe("lo");
  });
  test("the same bytes are not text where the MIB does not say so", () => {
    expect(renderValue({ kind: "octets" }, bytes("6c6f")).as).toBe("hex");
  });
  test("a control byte is refused", () => {
    expect(isShowableText(bytes("004100"))).toBe(false);
  });
  test("a C1 control is refused by its own check", () => {
    expect(isShowableText(bytes("c28541"))).toBe(false);
  });
  test("a byte order mark that is not leading is refused by its own check", () => {
    expect(isShowableText(bytes("41efbbbf"))).toBe(false);
  });
  test("the decoder strips a LEADING mark, so the round trip is what refuses that one", () => {
    const leading = bytes("efbbbf41");
    expect(new TextDecoder("utf-8", { fatal: true }).decode(leading)).toBe("A");
    expect(isShowableText(leading)).toBe(false);
  });
});

describe("DateAndTime follows its display hint and the errata", () => {
  test("an offset reading", () => {
    expect(renderValue({ kind: "dateAndTime" }, bytes("07ea0a0c16051e002b0e00")).display).toBe(
      "2026-10-12 22:05:30.0 +14:00",
    );
  });
  test("an all zero reading is legal, not a defect", () => {
    expect(renderValue({ kind: "dateAndTime" }, bytes("0000000000000000")).display).toBe("0000-00-00 00:00:00.0");
  });
  test("a length the hint does not allow falls back to hex", () => {
    expect(renderValue({ kind: "dateAndTime" }, bytes("07ea0a")).as).toBe("hex");
  });
});

describe("the raw bytes are kept whatever the rendering", () => {
  for (const kind of ["counter64", "text", "octets", "macAddress", "dateAndTime", "integer"] as const) {
    test(kind, () => {
      expect(renderValue({ kind }, bytes("001a2b3c4d5e")).raw.length).toBe(6);
    });
  }
  test("an IPv4 address reads as dotted quad", () => {
    expect(renderValue({ kind: "ipAddress" }, bytes("c0000201")).display).toBe("192.0.2.1");
  });
});

describe("bytes that are not text at all", () => {
  test("a sequence no UTF-8 decoder accepts is not showable", () => {
    // The first half of the rule: the decoder is strict, so a lone continuation byte ends the
    // question before the round trip or the control scan is reached. Without a case here the
    // only measured path was the one where decoding succeeds.
    expect(isShowableText(Uint8Array.of(0x80))).toBe(false);
    expect(isShowableText(Uint8Array.of(0xc3, 0x28))).toBe(false);
  });
});
