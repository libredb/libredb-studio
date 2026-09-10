// A path-preserving reverse proxy: root-relative mistakes must fail with 404.
import { createServer, request as upstreamRequest } from "node:http";

const prefix = process.env.E2E_BASE_PATH || "/~/libredb";
const upstreamPort = Number(process.env.E2E_BASE_PATH_APP_PORT || 3020);
const port = Number(process.env.E2E_BASE_PATH_PROXY_PORT || 3021);
createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    response.writeHead(404).end("Outside Studio's path prefix");
    return;
  }
  const upstream = upstreamRequest(
    {
      hostname: "127.0.0.1",
      port: upstreamPort,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, "x-forwarded-host": request.headers.host, "x-forwarded-proto": "http" },
    },
    (result) => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    },
  );
  upstream.on("error", () => response.writeHead(502).end("Upstream unavailable"));
  request.pipe(upstream);
}).listen(port, "127.0.0.1");
