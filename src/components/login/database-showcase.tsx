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

/**
 * The gaps are the hero's vertical budget, which has none to spare at 1280x800 and 1366x768
 * (#541, #550, pinned by e2e/login.spec.ts). At a 20px column gap the nineteenth entry (#1088)
 * wrapped the list into a fourth row at both sizes and scrolled the page by 4 and 19px; at 14px
 * 1366x768 kept three rows, and the row gap - 6px then, 4px now - paid for the fourth row 1280x800
 * still takes.
 * The twenty-second entry (#786) took the fourth row at 1366x768 too. The hero column's vertical
 * padding in login-form.tsx pays for that one, because an 8px column gap bought the third row back
 * with 38px left on it, which the next entry would have spent.
 * The twenty-eighth entry (Databend) wrapped the list into a fifth row at 1366x768 and scrolled the
 * page to 781px. A 12px column gap keeps four rows there, with the page needing 759px of the 768;
 * 1280x800 takes five rows at either gap and needs 798px of its 800.
 * The twenty-ninth entry (S3-compatible object storage, the longest label on the page) put
 * 1366x768 back on five rows and scrolled it by 13px at both the 12px and the 10px column gap;
 * at the 6px gap it holds four rows and the page measured 800, 768, 900 and 1080px of 800, 768,
 * 900 and 1080, needing 798, 759, 759 and 701px of them.
 * Two engines landed at once, so the count changed again and the list now carries a thirty-sixth
 * entry. Each of the two paragraphs below measured its own engine as the thirty-fifth, with
 * thirty-five entries on the page, and both landed on the same 4px row gap, which stays until the
 * page is swept at thirty-six.
 * The thirty-fifth entry (Snowflake) wrapped the list into a sixth row at 1280x800 and scrolled the
 * page to 804px; 1366x768 and 1440x900 stayed on five rows needing 765px, 1920x1080 on four needing
 * 707. No column gap down to 4px buys the row back, so the row gap pays: at 4px the four sizes need
 * 794, 757, 757 and 701px of 800, 768, 900 and 1080.
 * The thirty-fifth entry (OPC UA) takes a sixth row at 1280x800 on its own and scrolled that size
 * by 4px, the other three unchanged. THE COLUMN GAP CANNOT PAY FOR THIS ONE, measured in a browser:
 * at 4px and at 2px the label still wraps, and 2px buys the fifth row back only by crowding every
 * label on the page against the next one's icon. The ROW gap pays for it instead, at 4px, which
 * leaves all four row counts as they are and measures 800, 768, 900 and 1080px of 800, 768, 900 and
 * 1080. 1280x800 needs 794 of its 800, measured by sweeping the viewport height at that width, so
 * the 4px gap leaves 6px rather than nothing and the entry after next is what spends the padding.
 * The thirty-seventh entry (Apache Spark) wrapped 1366x768 into a sixth row and scrolled it to
 * 777px at the 4px row gap, while 1280x800 kept its six rows needing 794 and 1440x900 and 1920x1080
 * kept five and four; at the 2px row gap the four sizes need 784, 767, 749 and 695px of 800, 768,
 * 900 and 1080.
 */
function DesktopDatabases() {
  return (
    <ul
      aria-label="Supported databases"
      data-testid="database-showcase-desktop"
      className="flex flex-wrap gap-x-1.5 gap-y-0.5 pointer-events-none select-none"
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
