/**
 * `scopeServer` (tests/helpers/weaviate-agent.ts): two data-scope captures of one principal may share a request line
 * and differ only by body, as the scoped count of the granted tenant acme and of the refused tenant globex both are
 * `POST /v1/aggregate/Tenanted`. Each is answered by its own body, never by whichever file the directory lists last:
 * macOS lists the directory sorted and Linux in hash order, so a line-only map answered the two runners differently.
 */
import { describe, expect, test } from "bun:test";
import type { NodeRequest } from "@/lib/db/http/node-transport";
import { scopeServer } from "../../../helpers/weaviate-agent";

const LINE = "POST /v1/aggregate/Tenanted";

const request = (body?: string): NodeRequest => ({
  method: "POST",
  url: "http://127.0.0.1:8080/v1/aggregate/Tenanted",
  body,
  signal: new AbortController().signal,
  maxResponseBytes: 65_536,
});

describe("scopeServer, a request line two captures share", () => {
  test("each tenant's count is answered by the capture that sent its body", async () => {
    const answer = scopeServer("scoped");
    expect((await answer(request('{"tenant":"acme"}'), LINE)).status).toBe(200);
    expect((await answer(request('{"tenant":"globex"}'), LINE)).status).toBe(403);
  });

  test("the body is compared as JSON, not as text", async () => {
    const answer = scopeServer("scoped");
    expect((await answer(request('{ "tenant": "globex" }'), LINE)).status).toBe(403);
  });

  test("a body no capture of the line sent throws by name", () => {
    const answer = scopeServer("scoped");
    expect(() => answer(request('{"tenant":"initech"}'), LINE)).toThrow(
      `no scoped data-scope capture answers ${LINE} with that body`,
    );
    expect(() => answer(request(), LINE)).toThrow(`no scoped data-scope capture answers ${LINE} with that body`);
  });

  test("an override still answers the line whatever its body", async () => {
    const answer = scopeServer("scoped", {
      [LINE]: { status: 404, contentType: "application/json", retryAfter: null, text: "{}" },
    });
    expect((await answer(request('{"tenant":"acme"}'), LINE)).status).toBe(404);
  });
});
