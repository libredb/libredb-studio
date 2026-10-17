/**
 * The recorded answer carries the LIVE request's id, whatever width that id needs.
 *
 * WHY THIS FILE EXISTS. A request id is an ASN.1 INTEGER, so its width follows its value:
 * `randomInt(1, 0x7fffffff)` needs four octets 99.61% of the time and three 0.39%, while all
 * eight recordings carry four. The replay used to write the id over the recorded one only when
 * the widths matched and otherwise returned the recording AS IT WAS - answering a live request
 * with a stranger's id, which the provider drops and then waits its whole deadline for an answer
 * that never comes. The integration file's cases die at the runner's 5000 ms budget when that
 * happens, which is what CI reported on 16 October 2026 and what nothing here was holding.
 *
 * The two cases below are the two halves of the repair: the id arrives whatever its width, and
 * nothing else in the datagram moves.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BerField, readChildren, readField } from "@/lib/db/providers/network/snmp/ber";
import { withRequestId } from "../../../helpers/snmp-capture";

const CAPTURES = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../fixtures/snmp/captures/agent.json"), "utf8"),
) as { readonly exchanges: ReadonlyArray<{ readonly key: string; readonly answer: string }> };

const answerOf = (key: string): Uint8Array => {
  const found = CAPTURES.exchanges.find((entry) => entry.key.includes(key));
  if (found === undefined) throw new Error(`no recording for ${key}`);
  return Uint8Array.from(Buffer.from(found.answer, "base64"));
};

/** The id field of a datagram, as bytes. */
function idOf(datagram: Uint8Array): readonly number[] {
  const [, , pdu] = readChildren(datagram, readField(datagram, 0));
  const fields = readChildren(datagram, pdu);
  return [...datagram.slice(fields[0].start, fields[0].end)];
}

describe("a recorded answer is replayed under the live request's id", () => {
  test("an id narrower than the recorded one arrives whole", () => {
    // Three octets is the width 0.39% of ids need, and the one the recordings never carry.
    const narrow = [0x12, 0x34, 0x56];

    const replayed = withRequestId(answerOf("oids=1.3.6.1.2.1.1.5.0"), Uint8Array.from(narrow));

    expect(idOf(replayed)).toEqual(narrow);
  });

  test("the sixteen-varbind answer survives the rewrite, long-form length and all", () => {
    // The case the first repair got wrong. This answer's varbind list is longer than 127 octets,
    // so its length is written in the long form, and a header width guessed from the octet before
    // the content reads one of the length's own octets. The walk cases failed and the
    // single-value ones passed, which is how the mistake was found.
    const recorded = answerOf("pdu=165 max=50 oids=1.3.6.1.4.1.8072.9999.9999");
    const before = readChildren(recorded, readChildren(recorded, readField(recorded, 0))[2]);

    const replayed = withRequestId(recorded, Uint8Array.from([0x01, 0x02]));
    const after = readChildren(replayed, readChildren(replayed, readField(replayed, 0))[2]);

    // A varbind list this long needs its own limit: `readChildren` refuses more than eight
    // fields by default, which is the bound the provider wants on a PDU, not on a list of values.
    const varbinds = (datagram: Uint8Array, list: BerField): number => readChildren(datagram, list, 64).length;

    expect(idOf(replayed)).toEqual([0x01, 0x02]);
    expect(varbinds(replayed, after[3])).toBe(varbinds(recorded, before[3]));
    expect(varbinds(replayed, after[3])).toBeGreaterThan(8);
  });

  test("an id of the recorded width leaves the datagram byte for byte", () => {
    // The control: the rewrite re-encodes every field, so this says the re-encoding reproduces
    // what the agent sent rather than a form of its own.
    const recorded = answerOf("oids=1.3.6.1.2.1.1.5.0");
    const same = Uint8Array.from(idOf(recorded));

    expect([...withRequestId(recorded, same)]).toEqual([...recorded]);
  });
});
