import { describe, expect, test } from "bun:test";
import { unavailableSavedQueryNotice } from "@/lib/connection-availability";

const SENTENCE = 'No provider for the connection type "acmefoo" is installed in this LibreDB Studio.';

describe("unavailableSavedQueryNotice (FND-1)", () => {
  test("names the saved query and gives the reason", () => {
    expect(unavailableSavedQueryNotice({ name: "Acme report" }, SENTENCE)).toEqual({
      title: "Saved query unavailable",
      description: `Acme report: ${SENTENCE}`,
    });
  });

  test.each([
    ["missing", {}],
    ["empty", { name: "" }],
    ["not text", { name: ["Acme"] }],
  ])('calls a saved query whose name is %s "This saved query"', (_label, query) => {
    expect(unavailableSavedQueryNotice(query, SENTENCE)).toEqual({
      title: "Saved query unavailable",
      description: `This saved query: ${SENTENCE}`,
    });
  });
});
