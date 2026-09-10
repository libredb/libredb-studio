# Deploy Studio under a subpath

Studio can run at `/libredb`, `/tools/libredb`, or `/~/libredb` behind a reverse proxy.
Set `BASE_PATH` **when building**. Next.js bakes this prefix into routes and browser bundles;
setting it only on a prebuilt image cannot relocate that image. The published images use `/`.

Use a leading slash and no trailing slash. Empty or `/` selects the root. Path segments may
contain letters, digits, `.`, `_`, `~`, and `-`; dot segments, encoded paths, query strings,
fragments, backslashes, and repeated slashes are rejected during the build.

## Build from source

Keep the same value for build and `next start`:

```sh
export BASE_PATH=/tools/libredb
bun install --frozen-lockfile
bun run build
bun start
```

With Docker, build a custom image from the source revision containing subpath support:

```sh
docker build --build-arg BASE_PATH=/tools/libredb -t studio-subpath:local .
docker run --rm -p 3000:3000 --env-file .env.local studio-subpath:local
```

The build uses the prefix from the build arg. Supply your normal runtime authentication,
storage, and LLM settings as usual. `BASE_PATH` is not a replacement for a public origin or
for `ALLOWED_ORIGINS`; that setting still takes origins such as `https://example.com`.

The source `docker-compose.yml` forwards `BASE_PATH` as a build arg:

```sh
BASE_PATH=/tools/libredb docker compose up --build
```

When using `docker-compose.example.yml`, select your custom image and set the same `BASE_PATH`
in Compose's environment so its health check uses the built path.

## Preserve the prefix at the reverse proxy

Forward `/tools/libredb` and everything below it **with the path intact**. Do not use
Traefik `StripPrefix`, an Nginx rewrite, or an HTTPRoute `URLRewrite` to remove the prefix.
For example, an Nginx upstream without a URI suffix preserves the original path:

```nginx
location ~ ^/tools/libredb(?:/|$) {
    proxy_pass http://studio:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

For Traefik, match ``PathPrefix(`/tools/libredb`)`` and forward to Studio without a strip-prefix
middleware. Restrict the rule to your intended hostname as usual. Assets, API calls,
streamed agent responses, and native authentication redirects all use the configured prefix.
Next's router and `Link` apply it automatically. Studio has no WebSocket endpoint to configure.

## Helm and Gateway API

Build and publish your own image with the prefix first. Then use matching chart values:

```yaml
image:
  repository: registry.example.com/studio-subpath
  tag: my-build
config:
  basePath: /tools/libredb

ingress:
  enabled: true
  hosts:
    - host: example.com
      paths:
        - path: /tools/libredb
          pathType: Prefix
```

`config.basePath` prefixes the chart's default startup, readiness, and liveness health paths.
It does not set a runtime app environment variable. Explicit custom probe paths, exec probes,
and TCP probes are preserved. A mismatched image and chart prefix fails readiness.

For a Gateway API deployment, use an HTTPRoute match with the same prefix and your cluster's
actual Gateway reference:

```yaml
route:
  main:
    enabled: true
    parentRefs:
      - name: my-gateway
    hostnames:
      - example.com
    matches:
      - path:
          type: PathPrefix
          value: /tools/libredb
```

Do not add a rewrite filter. If you use external health checks, request
`/tools/libredb/api/db/health`.

## Authentication and editor assets

Register the full OIDC callback URL, for example
`https://example.com/tools/libredb/api/auth/oidc/callback`, and allow the logout return URL
`https://example.com/tools/libredb/login` at your identity provider. Session and OIDC state
cookies use `/tools/libredb` as their path, including when they are removed.

The default Monaco asset URL becomes `/tools/libredb/monaco/vs`. An explicit
`NEXT_PUBLIC_MONACO_VS_PATH` override is used exactly as configured, including an external
asset origin; do not add the prefix a second time.

For the embedded npm library, the host application's routing remains its responsibility.
Standalone builds publish the internal `NEXT_PUBLIC_BASE_PATH` value from `BASE_PATH`; it is
not a separate operator setting.

## Verification

`bun run test:e2e:base-path` builds at `/~/libredb`, starts a local path-preserving proxy that
returns 404 outside that prefix, and tests login, RBAC, cookie deletion, a real SQLite query, origin checks, OIDC error
redirects, and self-hosted editor assets in Chromium. Run it after the ordinary E2E suite;
the two configurations build different versions of `.next`.
