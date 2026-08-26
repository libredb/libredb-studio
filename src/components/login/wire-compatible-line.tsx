import { Fragment } from "react";
import { WIRE_COMPATIBLE_ENGINES } from "@/lib/db/compatibility";

interface WireCompatibleLineProps {
  variant: "desktop" | "mobile";
}

/**
 * The engines that connect through a driver of their own name's making.
 *
 * The login page named fifteen providers and stopped there, while the product connects to
 * thirty-seven named products: the other twenty-three speak a wire protocol we already ship and
 * were published in README.md and the docs compatibility table, but nowhere a visitor to
 * the front door could see them. This line closes that gap and nothing else - the count and
 * every name come from `WIRE_COMPATIBLE_ENGINES`, so a twentieth probed engine joins the
 * page by being added to the registry.
 *
 * What it deliberately does NOT carry is the per-engine tier. `WireCompatibilityHint` shows
 * it in the connection dialog, where there is room to say that Materialize is query-editor
 * only and that a Citus distributed table reports row counts you should not trust. A hero
 * line has no room for twenty-three qualifications, and the alternative to qualifying them is
 * not to imply parity: the wording claims a measurement, which is the one thing every entry
 * here really has (issue #424's claim discipline - "connects is not supported"), and the
 * docs table is where a reader finds out how much of the product each one gives them.
 *
 * The two variants exist for the same reason `database-showcase.tsx` has two: the desktop
 * block sits in the hero's left column, pinned dark by a nested `dark` class, so it needs
 * that subtree's own `fg-*` tokens, while the mobile block follows the viewer's theme
 * through `muted-foreground`. Swapping either set into the other surface renders the text
 * the same colour as its background.
 *
 * `pointer-events-none select-none` and no anchor: this is decorative showcase content on
 * an unauthenticated page, which is the rule the rest of the hero already follows.
 *
 * `leading-snug` rather than the hero's usual `leading-relaxed`, and the lead sentence is as
 * short as it can be while still claiming a measurement rather than parity. Both are height
 * budget: the hero column measured exactly 800px at a 1280x800 viewport before this line
 * existed, so this is the one block on the page that has to earn its lines.
 */
export function WireCompatibleLine({ variant }: WireCompatibleLineProps) {
  const isDesktop = variant === "desktop";
  return (
    <p
      data-testid={`wire-compatible-${variant}`}
      className={
        isDesktop
          ? "text-xs text-fg-tertiary leading-snug pointer-events-none select-none"
          : "text-[10px] text-center text-muted-foreground leading-snug pointer-events-none select-none"
      }
    >
      Plus {WIRE_COMPATIBLE_ENGINES.length} wire-compatible engines, each measured on a live instance:{" "}
      {WIRE_COMPATIBLE_ENGINES.map((engine, index) => (
        <Fragment key={engine.name}>
          {index > 0 && ", "}
          <span data-relative-name className={isDesktop ? "text-fg-secondary" : "text-foreground"}>
            {engine.name}
          </span>
        </Fragment>
      ))}
      .
    </p>
  );
}
