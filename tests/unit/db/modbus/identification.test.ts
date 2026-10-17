/**
 * One 43/14 answer, and what an object's bytes mean.
 *
 * Every length the device declares is checked against the bytes that arrived, and each of those
 * checks has its own test here, because they fail differently: a count that overruns the frame, a
 * length that overruns the frame, and a length past what any frame can carry are three separate
 * ways for a reader to end up showing a neighbouring object's bytes as this object's value.
 */
import { describe, expect, test } from "bun:test";
import { MAX_IDENTIFICATION_OBJECT_BYTES, MBAP_LENGTH_MAX } from "@/lib/db/providers/industrial/modbus/constants";
import {
  IDENTIFICATION_OBJECT_NAMES,
  ModbusIdentificationError,
  nameOfObject,
  parseIdentificationResponse,
  valueOfObject,
} from "@/lib/db/providers/industrial/modbus/identification";

/** A 43/14 body: the PDU after the function code. */
function body(
  options: {
    conformity?: number;
    moreFollows?: number;
    nextObjectId?: number;
    declared?: number;
    objects?: ReadonlyArray<{ id: number; bytes: Buffer; declareLength?: number }>;
  } = {},
): Buffer {
  const objects = options.objects ?? [];
  const head = Buffer.from([
    0x0e,
    0x01,
    options.conformity ?? 0x01,
    options.moreFollows ?? 0x00,
    options.nextObjectId ?? 0x00,
    options.declared ?? objects.length,
  ]);
  const tail = objects.map((o) => Buffer.concat([Buffer.from([o.id, o.declareLength ?? o.bytes.length]), o.bytes]));
  return Buffer.concat([head, ...tail]);
}
const text = (s: string) => Buffer.from(s, "utf8");

describe("one answer", () => {
  test("the three objects of a basic read are carried through in order", () => {
    const parsed = parseIdentificationResponse(
      body({
        objects: [
          { id: 0x00, bytes: text("Acme") },
          { id: 0x01, bytes: text("AC-1") },
          { id: 0x02, bytes: text("1.4") },
        ],
      }),
    );
    expect(parsed.objects.map((o) => [o.id, o.bytes.toString("utf8")])).toEqual([
      [0x00, "Acme"],
      [0x01, "AC-1"],
      [0x02, "1.4"],
    ]);
  });

  test("the conformity level is read from the byte that carries it", () => {
    expect(parseIdentificationResponse(body({ conformity: 0x83 })).conformityLevel).toBe(0x83);
  });

  test("an answer that is complete says so, and names no continuation", () => {
    const parsed = parseIdentificationResponse(body({ moreFollows: 0x00, nextObjectId: 0x00 }));
    expect(parsed.moreFollows).toBe(false);
    expect(parsed.nextObjectId).toBe(0x00);
  });

  test("an answer that continues says where", () => {
    const parsed = parseIdentificationResponse(body({ moreFollows: 0xff, nextObjectId: 0x04 }));
    expect(parsed.moreFollows).toBe(true);
    expect(parsed.nextObjectId).toBe(0x04);
  });

  test("an empty object is an object, not an absence", () => {
    const parsed = parseIdentificationResponse(body({ objects: [{ id: 0x03, bytes: Buffer.alloc(0) }] }));
    expect(parsed.objects).toHaveLength(1);
    expect(parsed.objects[0]?.bytes.length).toBe(0);
  });

  test("the bytes are copied, so the frame's buffer can be reused without moving a value", () => {
    const frame = body({ objects: [{ id: 0x00, bytes: text("Acme") }] });
    const parsed = parseIdentificationResponse(frame);
    frame.fill(0, 8);
    expect(parsed.objects[0]?.bytes.toString("utf8")).toBe("Acme");
  });
});

describe("what the device declares is checked against what arrived", () => {
  test("a body shorter than the header is refused with both numbers", () => {
    const run = () => parseIdentificationResponse(Buffer.alloc(5));
    expect(run).toThrow(ModbusIdentificationError);
    expect(run).toThrow(/at least 6 bytes/);
    expect(run).toThrow(/carries 5/);
  });

  test("a More Follows byte the protocol does not define is refused", () => {
    expect(() => parseIdentificationResponse(body({ moreFollows: 0x01 }))).toThrow(/0x00 or 0xFF/);
  });

  test("a count larger than the objects that arrived names the object it ran out on", () => {
    expect(() =>
      parseIdentificationResponse(body({ declared: 3, objects: [{ id: 0x00, bytes: text("Acme") }] })),
    ).toThrow(/ends inside object 2/);
  });

  test("an object whose declared length overruns the frame is refused, not padded", () => {
    const run = () =>
      parseIdentificationResponse(body({ objects: [{ id: 0x00, bytes: text("Acme"), declareLength: 40 }] }));
    expect(run).toThrow(/declares 40 bytes/);
    expect(run).toThrow(/only 4 arrived/);
  });

  test("a declared length past what any frame can carry is refused with the bound", () => {
    const run = () =>
      parseIdentificationResponse(body({ objects: [{ id: 0x7f, bytes: Buffer.alloc(0), declareLength: 255 }] }));
    expect(run).toThrow(/only 244 are left for one object/);
  });

  test("the bound is derived from the frame's own limit, not written down beside it", () => {
    // A literal here would stay still while MBAP_LENGTH_MAX moved, and neither would look wrong.
    expect(MAX_IDENTIFICATION_OBJECT_BYTES).toBe(MBAP_LENGTH_MAX - 10);
    expect(MAX_IDENTIFICATION_OBJECT_BYTES).toBe(244);
  });

  test("an object cut off in its own two header bytes is refused", () => {
    const cut = Buffer.concat([body({ declared: 1 }), Buffer.from([0x00])]);
    expect(() => parseIdentificationResponse(cut)).toThrow(/ends inside object 1/);
  });
});

describe("an object's name", () => {
  for (const [id, name] of Object.entries(IDENTIFICATION_OBJECT_NAMES)) {
    test(`object ${id} is ${name}`, () => {
      expect(nameOfObject(Number(id))).toBe(name);
    });
  }

  test("a vendor's own object is named by its number, padded so a list lines up", () => {
    expect(nameOfObject(0x80)).toBe("0x80");
    expect(nameOfObject(0x07)).toBe("0x07");
  });
});

describe("an object's value is data, never markup", () => {
  test("printable text is the text", () => {
    expect(valueOfObject(text("AC-1"))).toBe("AC-1");
  });

  test("text outside ASCII is still text when the bytes really are UTF-8", () => {
    expect(valueOfObject(text("25°C"))).toBe("25°C");
  });

  test("bytes that are not UTF-8 come back as hex, not as a replacement character", () => {
    // 0xFF is not valid UTF-8. Buffer's decoder does not fail on it, it substitutes U+FFFD, so a
    // parser that only called toString would hand a reader a character the device never sent.
    const value = valueOfObject(Buffer.from([0x32, 0x35, 0xff, 0x43]));
    expect(value).toBe("3235ff43");
    expect(value).not.toContain("�");
  });

  test("the same bytes read as Latin-1 would have been wrong, which is why the rule re-encodes", () => {
    // "25°C" as UTF-8 is five bytes; reading them as Latin-1 gives "25Â°C" (MEASURED, §4.9 of the
    // issue). The rule here asks whether re-encoding gives the same bytes back, so it cannot be
    // fooled by a decoder that always succeeds.
    const utf8 = text("25°C");
    expect(utf8).toHaveLength(5);
    expect(valueOfObject(utf8)).toBe("25°C");
    expect(utf8.toString("latin1")).toBe("25Â°C");
  });

  test("control bytes are hex, because a value is shown and a control byte is not shown", () => {
    expect(valueOfObject(Buffer.from([0x41, 0x00, 0x42]))).toBe("410042");
    expect(valueOfObject(Buffer.from([0x1b, 0x5b, 0x31, 0x6d]))).toBe("1b5b316d");
  });

  test("a tab or a newline is text, because those are in the printable set a reader can carry", () => {
    expect(valueOfObject(Buffer.from([0x41, 0x09, 0x42]))).toBe("A\tB");
    expect(valueOfObject(Buffer.from([0x41, 0x0a, 0x42]))).toBe("A\nB");
  });

  test("no bytes is an empty value, not hex of nothing", () => {
    expect(valueOfObject(Buffer.alloc(0))).toBe("");
  });
});
