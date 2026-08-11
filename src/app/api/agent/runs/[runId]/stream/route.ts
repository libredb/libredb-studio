import { accessAgentRun } from "@/lib/api/agent-run-access";

/**
 * The run's timeline: everything already recorded, then everything that follows,
 * until the run ends and the ledger closes (#329 T9).
 *
 * Newline-delimited JSON rather than Server-Sent Events. The entries ARE JSON
 * objects — one ledger line each — so NDJSON carries them with no framing to
 * invent, and the reader is a `fetch` the rail already has a session cookie for,
 * where SSE's `EventSource` would buy reconnection this stream does not want
 * (a reconnect must resume at an index, which is what the ledger's own cursor is
 * for).
 */

type RunParams = { params: Promise<{ runId: string }> };

export async function GET(req: Request, { params }: RunParams) {
  const { runId } = await params;
  const access = await accessAgentRun({ route: "GET /api/agent/runs/[runId]/stream", request: req, runId });
  if ("response" in access) return access.response;

  const entries = await access.service.stream(runId);
  const encoder = new TextEncoder();
  const body = entries.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(entry, controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(entry)}\n`));
      },
    }),
  );

  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Reverse proxies that buffer by default would hold the timeline until the
      // run ended, which is exactly when it stops being interesting.
      "x-accel-buffering": "no",
    },
  });
}
