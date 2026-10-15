/**
 * Running one parsed request against a device, with no device.
 *
 * `runRead` takes an `Exchanger` rather than a socket, which is what makes every rule in `read.ts`
 * measurable here: the walk's three bounds, the two warnings that keep a half-read list, the
 * refusal sentences, and the two shapes a range answer comes in. Nothing in this file opens a
 * port.
 *
 * WHY THE ANSWERS GO THROUGH THE REAL FRAME READER. A hand-built `InboundFrame` would let this
 * file agree with `read.ts` about where a body starts while both disagree with the wire, and that
 * is exactly the fault these cases were written to catch: the identification walk sliced one byte
 * off the body, so a device's objects parsed as an empty list and the screen showed nothing. The
 * bytes below are assembled as MB 6.21 and MB TCP 4.1 describe them and pushed through
 * `FrameReader`, so the frame a case reads is the frame a device sends.
 *
 * THE SLICE HAD TWO SYMPTOMS AND BOTH ARE HELD HERE, because a fix measured against one of them
 * leaves the other free to come back. A device whose More Follows byte is 0x00 answered into an
 * empty object list, so the walk returned no rows AND no warning, which is the quiet half; a
 * device sending 0xFF put that byte where the conformity level is read and threw
 * `ModbusIdentificationError` from the parser, which is the loud half. The first case below holds
 * the quiet one, and the three that walk a second round hold the loud one.
 */
import { describe, expect, test } from "bun:test";
import { MAX_IDENTIFICATION_ROUNDS } from "@/lib/db/providers/industrial/modbus/constants";
import { FrameReader, type Exchange } from "@/lib/db/providers/industrial/modbus/framing";
import type { ParsedMap } from "@/lib/db/providers/industrial/modbus/register-map";
import { runRead, type Exchanger } from "@/lib/db/providers/industrial/modbus/read";
import { QueryError } from "@/lib/db/errors";

const EMPTY_MAP: ParsedMap = { points: [], isEmpty: true, warnings: [] };

/** One answer, built as a device builds it: MBAP header, unit id, then the PDU. */
function answer(pdu: Buffer, unitId = 1): Exchange {
  const header = Buffer.alloc(7);
  header.writeUInt16BE(1, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(pdu.length + 1, 4);
  header[6] = unitId;
  const frames = new FrameReader().push(Buffer.concat([header, pdu]));
  const frame = frames[0];
  if (frame === undefined) throw new Error("the test built a frame the reader could not read");
  return { kind: "answer", frame };
}

/** A 43/14 response PDU: function code, MEI type, and the six-byte head MB 6.21 defines. */
function identification(options: {
  objects: ReadonlyArray<{ id: number; value: string }>;
  moreFollows?: boolean;
  nextObjectId?: number;
}): Exchange {
  const tail = options.objects.map((object) =>
    Buffer.concat([Buffer.from([object.id, Buffer.byteLength(object.value)]), Buffer.from(object.value, "utf8")]),
  );
  return answer(
    Buffer.concat([
      Buffer.from([
        0x2b,
        0x0e,
        0x01,
        0x01,
        options.moreFollows === true ? 0xff : 0x00,
        options.nextObjectId ?? 0x00,
        options.objects.length,
      ]),
      ...tail,
    ]),
  );
}

/** A read answer: function code, the byte count the device declares, then that many bytes. */
const readAnswer = (functionCode: number, bytes: Buffer, declared = bytes.length): Exchange =>
  answer(Buffer.concat([Buffer.from([functionCode, declared]), bytes]));

const words = (...values: number[]): Buffer => {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, at) => out.writeUInt16BE(value, at * 2));
  return out;
};

/**
 * An exchanger that answers from a script and records what it was asked.
 *
 * The last answer repeats, because a bound is measured by asking more times than the bound allows
 * and a script that ran out would end the walk for the wrong reason.
 */
function scripted(answers: readonly Exchange[]): Exchanger & { readonly asked: Buffer[] } {
  const asked: Buffer[] = [];
  return {
    asked,
    exchange(build: (transactionId: number) => Buffer): Promise<Exchange> {
      const frame = build(asked.length + 1);
      asked.push(frame);
      return Promise.resolve(answers[Math.min(asked.length - 1, answers.length - 1)] as Exchange);
    },
  };
}

const identify = (session: Exchanger, level: "basic" | "regular" | "extended" = "basic") =>
  runRead({ kind: "identify", level }, EMPTY_MAP, session, 1);

describe("the identification walk", () => {
  test("shows the objects the device sent, named and decoded", async () => {
    const session = scripted([
      identification({
        objects: [
          { id: 0x00, value: "Acme" },
          { id: 0x01, value: "AC-1" },
          { id: 0x02, value: "1.4" },
        ],
      }),
    ]);

    const rows = await identify(session);

    expect(rows.fields).toEqual(["object_id", "name", "value"]);
    expect(rows.rows).toEqual([
      { object_id: "0x00", name: "VendorName", value: "Acme" },
      { object_id: "0x01", name: "ProductCode", value: "AC-1" },
      { object_id: "0x02", name: "MajorMinorRevision", value: "1.4" },
    ]);
    expect(rows.warnings).toEqual([]);
  });

  test("asks the device for the level it was given", async () => {
    const session = scripted([identification({ objects: [] })]);

    await identify(session, "extended");

    // The request PDU sits after the seven MBAP bytes: function code, MEI type, level, object id.
    expect([...(session.asked[0] as Buffer).subarray(7)]).toEqual([0x2b, 0x0e, 0x03, 0x00]);
  });

  test("follows More Follows to the next object id, and asks from there", async () => {
    const session = scripted([
      identification({ objects: [{ id: 0x00, value: "Acme" }], moreFollows: true, nextObjectId: 0x02 }),
      identification({ objects: [{ id: 0x02, value: "1.4" }] }),
    ]);

    const rows = await identify(session);

    expect(rows.rows.map((row) => row.object_id)).toEqual(["0x00", "0x02"]);
    expect([...(session.asked[1] as Buffer).subarray(7)]).toEqual([0x2b, 0x0e, 0x01, 0x02]);
    expect(rows.warnings).toEqual([]);
  });

  test("stops, and says so, when the device asks the walk to continue where it already is", async () => {
    const session = scripted([
      identification({ objects: [{ id: 0x00, value: "Acme" }], moreFollows: true, nextObjectId: 0x00 }),
    ]);

    const rows = await identify(session);

    expect(rows.rows).toHaveLength(1);
    expect(rows.warnings).toEqual([expect.stringContaining("does not come after 0x0")]);
    expect(session.asked).toHaveLength(1);
  });

  test("stops at the round bound, keeps what it has, and says the list is what it had", async () => {
    // Each answer names a HIGHER next object id than the one before, so the walk never trips the
    // non-increasing guard and the round bound is the only thing left that can end it. An answer
    // that repeated its own next object id would stop the walk for the other reason and this case
    // would pass while measuring nothing.
    const session = scripted(
      Array.from({ length: MAX_IDENTIFICATION_ROUNDS + 1 }, (_unused, round) =>
        identification({
          objects: [{ id: round, value: `object ${round}` }],
          moreFollows: true,
          nextObjectId: round + 1,
        }),
      ),
    );

    const rows = await identify(session);

    expect(session.asked).toHaveLength(MAX_IDENTIFICATION_ROUNDS);
    expect(rows.warnings).toEqual([expect.stringContaining(`after ${MAX_IDENTIFICATION_ROUNDS} requests`)]);
    expect(rows.rows).toHaveLength(MAX_IDENTIFICATION_ROUNDS);
  });

  test("keeps the objects it already has when the device stops answering with 01", async () => {
    const session = scripted([
      identification({ objects: [{ id: 0x00, value: "Acme" }], moreFollows: true, nextObjectId: 0x01 }),
      { kind: "exception", code: 0x01 },
    ]);

    const rows = await identify(session);

    expect(rows.rows).toEqual([{ object_id: "0x00", name: "VendorName", value: "Acme" }]);
    expect(rows.warnings).toEqual(["The device stopped answering identification requests partway through."]);
  });

  test("refuses, in the protocol's own words, when 01 arrives before any object", async () => {
    const session = scripted([{ kind: "exception", code: 0x01 }]);

    await expect(identify(session)).rejects.toThrow(/refused the function/);
  });

  test("reports an exception code the protocol does not define as the number it is", async () => {
    const session = scripted([{ kind: "exception", code: 0x7a }]);

    await expect(identify(session)).rejects.toThrow(
      "The device refused the read with exception code 122, and this provider has no sentence for that code.",
    );
  });
});

describe("one range of one table", () => {
  test("a bit table gives one row per bit, addressed from the range's own start", async () => {
    const session = scripted([readAnswer(0x01, Buffer.from([0b00000101]))]);

    const rows = await runRead(
      { kind: "range", unitId: 1, table: "coil", address: 10, count: 3 },
      EMPTY_MAP,
      session,
      1,
    );

    expect(rows.fields).toEqual(["unit", "table", "address", "raw", "value"]);
    expect(rows.rows).toEqual([
      { unit: 1, table: "coil", address: 10, raw: true, value: true },
      { unit: 1, table: "coil", address: 11, raw: false, value: false },
      { unit: 1, table: "coil", address: 12, raw: true, value: true },
    ]);
  });

  test("a register range with no type gives one row per register, raw and value alike", async () => {
    const session = scripted([readAnswer(0x03, words(7000, 7011))]);

    const rows = await runRead(
      { kind: "range", unitId: 2, table: "holding_register", address: 0, count: 2 },
      EMPTY_MAP,
      session,
      1,
    );

    expect(rows.rows).toEqual([
      { unit: 2, table: "holding_register", address: 0, raw: [7000], value: 7000 },
      { unit: 2, table: "holding_register", address: 1, raw: [7011], value: 7011 },
    ]);
  });

  test("a typed range reads as many registers per row as the type needs, in the orders given", async () => {
    const session = scripted([readAnswer(0x03, words(0x0001, 0x0000, 0x0000, 0x0002))]);

    const rows = await runRead(
      { kind: "range", unitId: 1, table: "holding_register", address: 0, count: 4, type: "uint32" },
      EMPTY_MAP,
      session,
      1,
    );

    // Two rows, not four: a uint32 spans two registers, and the second row starts at the offset the
    // first one ended on rather than at the next register.
    expect(rows.rows).toEqual([
      { unit: 1, table: "holding_register", address: 0, raw: [0x0001, 0x0000], value: 0x00010000 },
      { unit: 1, table: "holding_register", address: 2, raw: [0x0000, 0x0002], value: 0x00000002 },
    ]);
  });

  test("the word order the request names is the one the decoder reads under", async () => {
    const session = scripted([readAnswer(0x03, words(0x0001, 0x0000))]);

    const rows = await runRead(
      {
        kind: "range",
        unitId: 1,
        table: "holding_register",
        address: 0,
        count: 2,
        type: "uint32",
        wordOrder: "low_first",
      },
      EMPTY_MAP,
      session,
      1,
    );

    expect(rows.rows[0]?.value).toBe(0x00000001);
  });

  test("an answer whose byte count does not match the bytes that arrived is not read", async () => {
    const session = scripted([readAnswer(0x03, words(7000), 6)]);

    await expect(
      runRead({ kind: "range", unitId: 1, table: "holding_register", address: 0, count: 1 }, EMPTY_MAP, session, 1),
    ).rejects.toThrow(new QueryError("The device declared 6 bytes and sent 2, so the answer cannot be read."));
  });
});
