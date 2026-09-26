"use client";

import React, { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { appFetch } from "@/lib/config/base-path";
import { mcpClientConfigs } from "@/lib/mcp/client-config";

/**
 * The MCP settings screen (#246), in its simplest form; its visual design is later work.
 *
 * It shows whether MCP is ready on this server and, when it is not, what an operator sets; how
 * many opted-in connections the user's role reaches, with the empty-list explanation at zero; a
 * token minted on request and shown once; and each client's configuration for the deployment's
 * URL. The token lives in component state only: never in browser storage and never in a URL.
 */

interface McpStatus {
  readonly state: "off" | "misconfigured" | "ready";
  readonly problems: readonly string[];
  readonly url: string | null;
  readonly tokenTtlDays: number | null;
  readonly visibleConnections: number | null;
}

interface MintedToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly url: string;
}

interface MintRefusal {
  readonly error: string;
  readonly problems: readonly string[];
}

type Status =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "loaded"; readonly status: McpStatus };

function connectionsSentence(count: number | null): string {
  if (count === null)
    return "The connections your role can reach are unknown, because the seed file could not be read.";
  if (count === 0) {
    return "No connection is opted in for your role: an operator adds mcp: true to a seed connection, and until then list_connections answers an empty list.";
  }
  return count === 1
    ? "Your role can reach 1 opted-in connection."
    : `Your role can reach ${count} opted-in connections.`;
}

export function McpSettings() {
  const [loaded, setLoaded] = useState<Status>({ kind: "loading" });
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [refusal, setRefusal] = useState<MintRefusal | null>(null);
  const [minting, setMinting] = useState(false);

  useEffect(() => {
    let current = true;
    appFetch("/api/mcp/token")
      .then(async (response) => {
        if (!response.ok) throw new Error(`status ${response.status}`);
        return (await response.json()) as McpStatus;
      })
      .then((status) => current && setLoaded({ kind: "loaded", status }))
      .catch(() => current && setLoaded({ kind: "failed" }));
    return () => {
      current = false;
    };
  }, []);

  async function mint() {
    setMinting(true);
    setRefusal(null);
    try {
      const response = await appFetch("/api/mcp/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = (await response.json()) as MintedToken & Partial<MintRefusal>;
      if (response.ok) setMinted(body);
      else setRefusal({ error: body.error ?? "The token could not be created.", problems: body.problems ?? [] });
    } catch {
      setRefusal({ error: "The token could not be created. Try again.", problems: [] });
    } finally {
      setMinting(false);
    }
  }

  if (loaded.kind === "loading")
    return <main className="p-6 text-sm text-fg-secondary">Reading the MCP status...</main>;
  if (loaded.kind === "failed") {
    return (
      <main className="p-6 text-sm text-fg-secondary">
        The MCP status could not be read. Reload the page to try again.
      </main>
    );
  }
  const { status } = loaded;

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 text-sm text-fg-secondary">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-fg-bright">MCP</h1>
        <p>
          An AI client of your own reads the opted-in connections of this server and runs read-only SQL with a token
          minted for you.
        </p>
      </header>

      <section aria-labelledby="mcp-status" className="space-y-2">
        <h2 id="mcp-status" className="font-medium text-fg-bright">
          Status
        </h2>
        {status.state === "off" && (
          <p>
            MCP is off on this server. An operator enables it by setting LIBREDB_MCP_ENABLED to true, with
            LIBREDB_MCP_URL and LIBREDB_MCP_TOKEN_LABEL.
          </p>
        )}
        {status.state === "misconfigured" && (
          <p>MCP is not ready on this server. An operator has to fix every problem below.</p>
        )}
        {status.state === "ready" && (
          <p>
            MCP is ready at <code>{status.url}</code>
          </p>
        )}
        {status.problems.length > 0 && (
          <ul className="list-disc pl-5">
            {status.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        <p>{connectionsSentence(status.visibleConnections)}</p>
      </section>

      {status.state === "ready" && (
        <section aria-labelledby="mcp-token" className="space-y-2">
          <h2 id="mcp-token" className="font-medium text-fg-bright">
            Your token
          </h2>
          {minted === null ? (
            <>
              <p>
                A token is valid for {status.tokenTtlDays} days and carries your current role. It is shown once, when
                you create it.
              </p>
              <Button type="button" onClick={() => void mint()} disabled={minting}>
                Create token
              </Button>
              {refusal !== null && (
                <div role="alert" className="space-y-1 text-danger">
                  <p>{refusal.error}</p>
                  {refusal.problems.map((problem) => (
                    <p key={problem}>{problem}</p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <p>Copy this token now: it is not shown again, and nothing about it is stored.</p>
              <pre data-testid="mcp-token-value" className="overflow-x-auto rounded bg-raised p-2 font-mono">
                {minted.token}
              </pre>
              <CopyButton text={minted.token} testId="mcp-token-copy" label="Copy token" />
              <p>
                It expires on {minted.expiresAt.slice(0, 10)}. Rotating LIBREDB_MCP_TOKEN_LABEL revokes every MCP token
                at once.
              </p>
            </>
          )}
        </section>
      )}

      {status.url !== null && (
        <section aria-labelledby="mcp-clients" className="space-y-4">
          <h2 id="mcp-clients" className="font-medium text-fg-bright">
            Client configuration
          </h2>
          <p>Where a snippet reads LIBREDB_MCP_TOKEN, set that variable to your token. Never commit a token.</p>
          {mcpClientConfigs(status.url).map((config) => (
            <article key={config.id} className="space-y-1">
              <h3 className="text-fg-bright">{config.client}</h3>
              <p>In {config.file}:</p>
              <pre data-testid={`mcp-snippet-${config.id}`} className="overflow-x-auto rounded bg-raised p-2 font-mono">
                {config.snippet}
              </pre>
              <CopyButton text={config.snippet} testId={`mcp-snippet-copy-${config.id}`} />
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
