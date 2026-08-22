"use client";

import { useEffect, useState } from "react";
import { ENGINE_URI_SCHEMES } from "@/lib/connection-string-parser";
import { getDBConfig } from "@/lib/db-ui-config";
import { listShowcaseDatabases } from "@/lib/db-showcase";
import type { DatabaseType } from "@/lib/types";

/** How long one scheme holds before the next replaces it. */
const CYCLE_MS = 2600;

/**
 * The URIs the signature cycles through, built from the two sources that already know the
 * answer: `ENGINE_URI_SCHEMES` says which engines have a scheme at all, and each engine's
 * own `defaultPort` from `DB_UI_CONFIG` supplies the port. Nothing here is typed by hand,
 * so an engine that gains a scheme joins the rotation and one whose default port moves
 * follows it.
 *
 * Order follows `listShowcaseDatabases()` rather than the object literal, so the rotation
 * opens on the engine the showcase leads with instead of on whatever key was declared first.
 */
export const SIGNATURE_URIS: readonly { type: DatabaseType; scheme: string; rest: string }[] = listShowcaseDatabases()
  .filter((db) => ENGINE_URI_SCHEMES[db.type] !== undefined)
  .map((db) => ({
    type: db.type,
    scheme: `${ENGINE_URI_SCHEMES[db.type]}://`,
    rest: `user@db.internal:${getDBConfig(db.type).defaultPort}/app`,
  }));

/**
 * The hero's one bold element: a line that reads as a real connection string and changes
 * its scheme on a slow cycle.
 *
 * It is the thesis of the product stated in the product's own vernacular - you point this
 * at a database you already run - and it replaces the wall of engine pills that made the
 * panel unreadable. The engine COUNT is claimed once, in the proof row; this line is the
 * evidence for it, and it can only show schemes `parseConnectionString` actually accepts.
 *
 * Accessibility: the animated line is `aria-hidden` because a string that rewrites itself
 * every 2.6s is hostile to a screen reader. The same information is served statically to
 * assistive technology by the visually hidden list below it, which names every scheme at
 * once. Under `prefers-reduced-motion: reduce` the cycle never starts and the first URI
 * stands, so the page has no motion at all rather than a faster or subtler motion.
 */
export function ConnectionSignature() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    // Read the preference in an effect, not during render: the server has no matchMedia,
    // and branching on it during render would hydrate a different tree than it sent.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % SIGNATURE_URIS.length);
    }, CYCLE_MS);
    return () => clearInterval(timer);
  }, []);

  const current = SIGNATURE_URIS[index];

  return (
    <div className="space-y-2">
      <div
        data-testid="connection-signature"
        aria-hidden="true"
        className="font-mono text-xl xl:text-2xl tracking-tight text-fg-tertiary select-none"
      >
        <span key={current.type} className="text-blue-400 animate-in fade-in duration-500">
          {current.scheme}
        </span>
        {current.rest}
      </div>
      <ul className="sr-only">
        {SIGNATURE_URIS.map((uri) => (
          <li key={uri.type}>{uri.scheme}</li>
        ))}
      </ul>
    </div>
  );
}
