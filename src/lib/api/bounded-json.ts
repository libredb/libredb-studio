/**
 * Reads a JSON request body and stops at a byte limit.
 *
 * Route handlers have no body limit of their own (the proxy buffers up to 10 MB), and the passkey
 * routes hand what they read to a CBOR parser, so they bound it here. A declared
 * Content-Length over the limit is refused before reading, the rule the MCP SDK's reader applies;
 * otherwise the body is read chunk by chunk and the stream is cancelled as soon as the sum passes
 * the limit, so a body that lies about its length or sends none is still bounded.
 *
 * The auth routes do not import readRequestBody from @modelcontextprotocol/server: an
 * authentication route must not depend on an optional feature's SDK, whose index module would
 * join the auth routes' server bundle and whose releases do not follow the auth layer.
 *
 * A refusal names its reason as well as its status, so a caller that words the two 400s apart
 * (the object edit routes do) can: `empty` is a request with no body bytes at all, `malformed`
 * one whose bytes are not UTF-8 JSON.
 */

export type BoundedJson =
  | { ok: true; body: unknown }
  | { ok: false; status: 413; reason: "too_large" }
  | { ok: false; status: 400; reason: "empty" | "malformed" };

export async function readBoundedJson(request: Request, maxBytes: number): Promise<BoundedJson> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes) return { ok: false, status: 413, reason: "too_large" };
  if (request.body === null) return { ok: false, status: 400, reason: "empty" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream yields its chunks one after another.
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- runs once, on the way out of the loop.
      await reader.cancel();
      return { ok: false, status: 413, reason: "too_large" };
    }
    chunks.push(value);
  }

  if (total === 0) return { ok: false, status: 400, reason: "empty" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    // Undecodable and unparseable bodies are both the client's malformed request.
    return { ok: false, status: 400, reason: "malformed" };
  }
}
