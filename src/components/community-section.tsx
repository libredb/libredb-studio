import { SOCIAL_LINKS } from "@/lib/social-links";

/**
 * The one destination this row names in words. Every other way into the project - issues,
 * discussions, contributing, translating, sponsoring - is a path under this repository or a
 * profile already in `SOCIAL_LINKS`, so six separate cards spent six lines of the login hero
 * to say "GitHub" six times. The repository is the door; what is behind it is GitHub's job
 * to show.
 */
const REPO_URL = "https://github.com/libredb/libredb-studio";

interface CommunitySectionProps {
  variant: "desktop" | "mobile";
}

/**
 * The social row's anchor styling, per surface.
 *
 * The two variants need two different token families, and this is the single easiest
 * place in the login page to ship invisible text: the desktop row sits inside the hero's
 * left column, which is pinned dark by a nested `dark` class and therefore re-declares
 * fill/hairline/fg for that subtree only, while the mobile row lives in the right panel
 * and follows the viewer's theme through muted/foreground. Swapping either set into the
 * other surface renders the icons the same colour as their background.
 *
 * `h-8 w-8` is 32px, comfortably over the 24px minimum an icon-only target needs.
 */
const SOCIAL_ANCHOR_CLASSES = {
  desktop:
    "flex h-8 w-8 items-center justify-center rounded-lg bg-fill border border-hairline text-fg-tertiary hover:bg-fill-strong hover:border-hairline-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 transition-all duration-200",
  mobile:
    "flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 transition-colors",
} as const;

/**
 * Icon-only links to where the project lives. Both surfaces map `SOCIAL_LINKS`; neither
 * carries a destination of its own, so the two rows cannot drift apart. Icon-only means
 * `aria-label` is the anchor's entire accessible name - without it a screen reader
 * announces eight identical unnamed links.
 */
function SocialRow({ variant }: CommunitySectionProps) {
  return (
    <div className={variant === "desktop" ? "flex flex-wrap gap-2" : "flex flex-wrap justify-center gap-2"}>
      {SOCIAL_LINKS.map((link) => (
        <a
          key={link.id}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={link.label}
          className={SOCIAL_ANCHOR_CLASSES[variant]}
        >
          <link.icon className="h-4 w-4" />
        </a>
      ))}
    </div>
  );
}

export function CommunitySection({ variant }: CommunitySectionProps) {
  if (variant === "desktop") {
    return <DesktopCommunity />;
  }
  return <MobileCommunity />;
}

function DesktopCommunity() {
  return (
    <div className="space-y-4">
      <div className="h-px bg-fill-strong" />

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-fg-tertiary">
          Open source
          <span aria-hidden="true" className="mx-1.5 text-fg-muted">
            ·
          </span>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 rounded-sm transition-colors duration-200"
          >
            github.com/libredb/libredb-studio
          </a>
        </p>

        <SocialRow variant="desktop" />
      </div>
    </div>
  );
}

function MobileCommunity() {
  return (
    <div className="space-y-3">
      <div className="h-px bg-muted" />

      <p className="text-xs text-center text-muted-foreground">
        Open source
        <span aria-hidden="true" className="mx-1.5">
          ·
        </span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 rounded-sm transition-colors"
        >
          github.com/libredb/libredb-studio
        </a>
      </p>

      <SocialRow variant="mobile" />
    </div>
  );
}
