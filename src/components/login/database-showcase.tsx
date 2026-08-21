import { listShowcaseDatabases } from "@/lib/db-showcase";

interface DatabaseShowcaseProps {
  variant: "desktop" | "mobile";
}

/**
 * The login hero's engine list, on both surfaces.
 *
 * Every name, icon and accent colour comes from `DB_UI_CONFIG` through
 * `listShowcaseDatabases()`. Nothing here types an engine name: the defect issue #425
 * closes was two hand-written five-item arrays in `login-form.tsx` that stopped tracking
 * `DatabaseType` three providers ago, so adding a provider must be enough to publish it.
 *
 * The two variants need two different token families and this is one of the two easiest
 * places in the page to ship invisible text (`community-section.tsx` records the other):
 * the desktop block sits inside the hero's left column, which is pinned dark by a nested
 * `dark` class and therefore re-declares fill/hairline/fg for that subtree only, while the
 * mobile block lives in the right panel and follows the viewer's theme through
 * muted/foreground. Swapping either set into the other surface renders the pills the same
 * colour as their background.
 *
 * `pointer-events-none select-none` matches the decorative feature cards above it: this is
 * showcase content on an unauthenticated page, not navigation.
 *
 * The desktop text sits at `fg-tertiary` rather than further down the ramp because the ramp
 * runs out of contrast before it runs out of steps on this ground: `fg-subtle` over
 * `surface` measures 2.6:1 and `fg-muted` over a `fill` pill 3.9:1, both under the 4.5:1
 * WCAG AA floor for 12px type. `fg-tertiary` is 7.7:1 and is already the hero's own body
 * colour, so the block reads as one family rather than as an exception.
 */
export function DatabaseShowcase({ variant }: DatabaseShowcaseProps) {
  if (variant === "desktop") {
    return <DesktopDatabases />;
  }
  return <MobileDatabases />;
}

function DesktopDatabases() {
  return (
    <ul
      aria-label="Supported databases"
      data-testid="database-showcase-desktop"
      className="flex flex-wrap gap-x-5 gap-y-2.5 pointer-events-none select-none"
    >
      {listShowcaseDatabases().map((db) => {
        const Icon = db.icon;
        return (
          <li key={db.type} className="flex items-center gap-1.5 text-xs text-fg-tertiary">
            <Icon className={`h-3.5 w-3.5 ${db.color}`} aria-hidden="true" />
            {/*
              Label and marker share ONE span rather than sitting as two flex children. As
              flex children the gap between them was visual only - the item's text read
              "LibreDB(embedded)" with no separator at all, which is what a screen reader and
              a copy-paste get. Inside one span the space is a real text node.

              No colour class on the marker: it inherits the item's own `fg-tertiary`.
              Stepping it down the ramp is what the eye wants and what the ramp cannot give
              on this ground - the measurements in this file's header put `fg-muted` at 3.9:1
              and `fg-subtle` at 2.6:1, both under the 4.5:1 AA floor for type this small.
              The parentheses carry the demotion instead.
            */}
            <span>
              <span data-engine-label>{db.label}</span>
              {db.embedded && <span> (embedded)</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function MobileDatabases() {
  return (
    <ul
      aria-label="Supported databases"
      data-testid="database-showcase-mobile"
      className="flex flex-wrap justify-center gap-2 pointer-events-none select-none"
    >
      {listShowcaseDatabases().map((db) => (
        <li key={db.type} className="text-[10px] px-2.5 py-1 rounded-full bg-muted text-muted-foreground font-medium">
          <span data-engine-label>{db.label}</span>
          {db.embedded && <span> (embedded)</span>}
        </li>
      ))}
    </ul>
  );
}
