import { describe, test, expect, spyOn } from "bun:test";
import { createErrorResponse } from "@/lib/api/errors";
import { TimeoutError } from "@/lib/db/errors";

describe("createErrorResponse: a statement's deadline", () => {
  // Chromium sends a POST answered 408 on a reused connection again, so a statement that reached its deadline ran
  // up to six times on the target database for one editor run. 504 is not resent.
  test("a TimeoutError answers 504 with code TIMEOUT_ERROR, never 408", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = createErrorResponse(new TimeoutError("query took too long", "postgres", 30000));
      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body).toEqual({
        error: "Query timed out. Please try a simpler query or increase timeout.",
        code: "TIMEOUT_ERROR",
        statusCode: 504,
        retryable: true,
      });
    } finally {
      warn.mockRestore();
    }
  });
});
