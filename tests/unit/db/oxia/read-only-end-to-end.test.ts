/**
 * A write never reaches Oxia, and the refusal names the read-only mode while it holds (O1, SB2-9.4, SB2-3.3): a
 * `put` through `query` with the mode off, on by the connection and on by an execution profile, each refused with
 * the server's sentence and nothing sent but the connect's snapshot read.
 *
 * The dialog says the same before a connection exists: its read-only hint (`DB_UI_CONFIG.oxia.readOnlyHint`, SB2-9.4).
 */
import { describe, expect, test } from "bun:test";
import { getDBConfig, readOnlyHint } from "@/lib/db-ui-config";
import { QueryError } from "@/lib/db/errors";
import { writeCommandSentence } from "@/lib/db/providers/keyvalue/oxia/commands";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { createFakeOxiaClient } from "../../../helpers/oxia-fake-client";
import { oxiaConnection } from "../../../helpers/oxia-connection";

const READ_ONLY_SENTENCE =
  "put writes, and this connection is read-only. Studio's Oxia support also reads only in this version, so turning the mode off would not run it: write with the oxia CLI.";
const READS_ONLY_SENTENCE =
  "put writes, and Studio's Oxia support reads only in this version: write with the oxia CLI.";

async function refusalOf(readOnly: boolean, executionReadOnly: boolean, text = "put a b") {
  const fake = createFakeOxiaClient({ order: "hierarchical", records: [{ key: "a" }] });
  const provider = new OxiaProvider(oxiaConnection({ readOnly }), {}, { readOnly: executionReadOnly }, () => fake);
  await provider.connect();
  const error = await provider.query(text).catch((caught: unknown) => caught);
  return { error, calls: fake.calls.map((call) => call.rpc) };
}

describe("a write through query", () => {
  test("with the mode off: refused, saying Studio's Oxia support reads only", async () => {
    const { error, calls } = await refusalOf(false, false);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toBe(READS_ONLY_SENTENCE);
    expect(calls).toEqual(["GetShardAssignments"]);
  });

  test("with the connection's mode on: refused, naming the mode", async () => {
    const { error, calls } = await refusalOf(true, false);
    expect((error as QueryError).message).toBe(READ_ONLY_SENTENCE);
    expect(calls).toEqual(["GetShardAssignments"]);
  });

  test("with an execution profile's mode on: refused, naming the mode", async () => {
    const { error } = await refusalOf(false, true);
    expect((error as QueryError).message).toBe(READ_ONLY_SENTENCE);
  });

  test.each(["delete a", "del a", "delete-range a b", "oxia client put a b"])(
    "%s is refused the same way, with nothing sent",
    async (text) => {
      const { error, calls } = await refusalOf(true, false, text);
      const verb = text.replace("oxia client ", "").split(" ")[0];
      expect((error as QueryError).message).toBe(writeCommandSentence(verb, true));
      expect(calls).toEqual(["GetShardAssignments"]);
    },
  );

  test("the two sentences are SB2-3.3's", () => {
    expect(writeCommandSentence("put", true)).toBe(READ_ONLY_SENTENCE);
    expect(writeCommandSentence("put", false)).toBe(READS_ONLY_SENTENCE);
  });
});

describe("the dialog's read-only hint", () => {
  test("says that an Oxia connection is read-only whether or not the box is ticked (SB2-9.4)", () => {
    expect(readOnlyHint(getDBConfig("oxia"))).toBe(
      "Oxia connections are read-only in this version, whether or not this is ticked: Studio sends Oxia no write.",
    );
  });
});
