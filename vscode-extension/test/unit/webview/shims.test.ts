import assert from "node:assert/strict";
import type { WebviewToHost } from "../../../src/results-protocol";
import { settleCopy } from "../../../src/webview/clipboard";
import { connectHost, postToHost } from "../../../src/webview/host-channel";
import { writeToClipboard } from "../../../src/webview/shims/copy-button";
import { toast } from "../../../src/webview/shims/sonner";
import { storage } from "../../../src/webview/shims/storage";

// Types, checked by npm run typecheck (where both specifiers resolve to the real modules), not at run time:
// the shim takes every call the real writeToClipboard takes, and the real toast fits every member the shim names,
// so a shim never offers a surface the real module lacks.
function shimsFitTheRealModules(real: typeof import("sonner").toast): void {
  const _w: typeof import("@/components/copy-button").writeToClipboard = writeToClipboard;
  const _s: Pick<typeof toast, "success" | "error" | "info" | "warning" | "message"> = real;
  void _w;
  void _s;
}
void shimsFitTheRealModules;

describe("the webview's module shims", () => {
  const posted: WebviewToHost[] = [];

  beforeEach(() => {
    posted.length = 0;
    connectHost((message) => posted.push(message));
  });

  afterEach(() => connectHost(undefined));

  it("posts the grid's copy confirmation as an info notice", () => {
    toast.success("Cell copied to clipboard");
    assert.deepEqual(posted, [{ v: 1, type: "notify", level: "info", message: "Cell copied to clipboard" }]);
  });

  it("posts toast, message and info at level info, and warning and error at level error", () => {
    toast("a");
    toast.message("b");
    toast.info("c");
    toast.warning("d");
    toast.error("Could not copy cell");
    assert.deepEqual(
      posted.map((m) => (m.type === "notify" ? [m.level, m.message] : m.type)),
      [
        ["info", "a"],
        ["info", "b"],
        ["info", "c"],
        ["error", "d"],
        ["error", "Could not copy cell"],
      ],
    );
  });

  it("cuts a long notice to the 1,000 characters the host accepts", () => {
    toast.error("x".repeat(1_500));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type === "notify" && posted[0].message, "x".repeat(1_000));
  });

  it("copies through the host and resolves with its answer", async () => {
    const first = writeToClipboard("x");
    assert.equal(posted.length, 1);
    const request = posted[0];
    assert.ok(request.type === "copy");
    assert.deepEqual(request, { v: 1, type: "copy", requestId: request.requestId, text: "x" });
    settleCopy(request.requestId, true);
    assert.equal(await first, true);

    const second = writeToClipboard("y");
    const next = posted[1];
    assert.ok(next.type === "copy");
    assert.notEqual(next.requestId, request.requestId);
    settleCopy(next.requestId, false);
    assert.equal(await second, false);
  });

  it("settles each request once: a second answer for the same id is reported", async () => {
    const copied = writeToClipboard("x");
    const request = posted[0];
    assert.ok(request.type === "copy");
    settleCopy(request.requestId, true);
    await copied;
    settleCopy(request.requestId, true);
    assert.deepEqual(posted[1], {
      v: 1,
      type: "reportError",
      message: `The host settled copy request ${request.requestId}, which this view never made.`,
    });
  });

  it("reports a settlement for a request this view never made, and throws nothing", () => {
    assert.doesNotThrow(() => settleCopy(999, true));
    assert.deepEqual(posted, [
      { v: 1, type: "reportError", message: "The host settled copy request 999, which this view never made." },
    ]);
  });

  it("answers false without posting for a text the host would refuse as too long", async () => {
    assert.equal(await writeToClipboard("x".repeat(16 * 1024 * 1024 + 1)), false);
    assert.deepEqual(posted, []);
  });

  it("refuses every read of browser storage", () => {
    assert.throws(() => (storage as Record<string, unknown>).getItem, {
      message: "The LibreDB Results view keeps no browser storage.",
    });
    assert.throws(() => (storage as Record<string, unknown>).anything, {
      message: "The LibreDB Results view keeps no browser storage.",
    });
  });

  it("throws while no host is connected", () => {
    connectHost(undefined);
    assert.throws(() => postToHost({ v: 1, type: "ready" }), {
      message: "The LibreDB Results view is not connected to its host.",
    });
    assert.throws(() => writeToClipboard("x"), { message: "The LibreDB Results view is not connected to its host." });
  });
});
