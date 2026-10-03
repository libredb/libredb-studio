/**
 * GetVersion to the gates of vector-family spec 5.9. A 2.6 server ignores a parameter it does not know and answers
 * code 0, so a missing feature is refused by Studio, never inferred from an answer (R09 F21); a version Studio cannot
 * read, or a major that is neither 2 nor 3, takes the pre-3.0 answer of every gate.
 */
import { describe, expect, test } from "bun:test";
import {
  MILVUS_TESTED_VERSION,
  MILVUS_VERSION_GATES,
  readMilvusVersion,
  versionGateRefusal,
} from "@/lib/db/providers/vector/milvus/versions";

describe("readMilvusVersion", () => {
  test.each([
    ["3.0.2", 3, 0],
    ["v3.0.2", 3, 0],
    ["3.1.0-rc.1", 3, 1],
    ["2.6.25", 2, 6],
    [" 2.6.25\n", 2, 6],
  ])("reads %j as major %d, minor %d", (text, major, minor) => {
    expect(readMilvusVersion({ version: text })).toEqual({ reported: text.trim(), major, minor });
  });

  test.each([["master"], [""], ["three"], ["3"]])("an unreadable %j keeps no major or minor", (text) => {
    expect(readMilvusVersion({ version: text })).toEqual({
      reported: text.trim() === "" ? undefined : text.trim(),
      major: undefined,
      minor: undefined,
    });
  });

  test("no answer, or an answer with no version, is unread", () => {
    expect(readMilvusVersion(undefined)).toEqual({ reported: undefined, major: undefined, minor: undefined });
    expect(readMilvusVersion({})).toEqual({ reported: undefined, major: undefined, minor: undefined });
  });

  test("the claimed version is 3.0.2", () => {
    expect(MILVUS_TESTED_VERSION).toBe("3.0.2");
  });
});

describe("versionGateRefusal (5.9)", () => {
  test("the one version gate of v1 is orderByFields, since 3.0", () => {
    expect(Object.keys(MILVUS_VERSION_GATES)).toEqual(["orderByFields"]);
    expect(MILVUS_VERSION_GATES.orderByFields.since).toEqual([3, 0]);
  });

  test("3.0.2 and a later 3.x pass", () => {
    expect(versionGateRefusal("orderByFields", readMilvusVersion({ version: "3.0.2" }))).toBeUndefined();
    expect(versionGateRefusal("orderByFields", readMilvusVersion({ version: "3.4.0" }))).toBeUndefined();
  });

  test("2.6.25 is refused naming 3.0 and the version the server reports", () => {
    expect(versionGateRefusal("orderByFields", readMilvusVersion({ version: "2.6.25" }))).toBe(
      "orderByFields needs Milvus 3.0 or later, and this server reports 2.6.25: a server before 3.0 ignores it and returns the rows unsorted, so Studio does not send it.",
    );
  });

  test("an unreadable or foreign version takes the pre-3.0 answer (Review Focus 4)", () => {
    for (const version of [
      undefined,
      { version: "" },
      { version: "master" },
      { version: "v2.6.25" },
      { version: "4.0.0" },
    ]) {
      expect(versionGateRefusal("orderByFields", readMilvusVersion(version))).toMatch(
        /^orderByFields needs Milvus 3\.0 or later, and this server reports /,
      );
    }
    expect(versionGateRefusal("orderByFields", readMilvusVersion({ version: "master" }))).toContain(
      "this server reports a version Studio could not read",
    );
    expect(versionGateRefusal("orderByFields", readMilvusVersion({ version: "4.0.0" }))).toContain(
      "this server reports 4.0.0",
    );
  });
});
