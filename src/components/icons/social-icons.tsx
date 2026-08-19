import React from "react";

/**
 * Monochrome social marks for the login page's community row.
 *
 * Deliberately hand-drawn rather than pulled from an icon package: adding a runtime
 * dependency (or a remote image host) for eight glyphs would put the product's front
 * door behind someone else's release cadence and CDN. They follow the same contract as
 * `db-icons.tsx` - `viewBox="0 0 24 24"`, no width/height attributes so the caller's size
 * classes win, and `currentColor` throughout so one component works both inside the
 * hero's pinned-dark subtree and in the theme-following mobile block.
 *
 * None of them redraw a wordmark. Each doc comment records what was dropped and why the
 * remainder still reads at 16px, which is the size the row actually renders at.
 */
interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  className?: string;
}

/**
 * GitHub's Octocat, kept as a filled silhouette. The mark's interior detail (the face,
 * the individual tentacles) closes up below about 20px, so the outline plus the single
 * tail stroke is what carries recognition here; filled rather than stroked because a
 * 1.5-weight outline of a shape this intricate turns into noise at 16px.
 */
export const GitHubIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" className={className} {...props}>
    <path d="M12 2.5a9.5 9.5 0 00-3 18.5c.47.09.65-.2.65-.45v-1.6c-2.64.58-3.2-1.27-3.2-1.27-.43-1.1-1.06-1.4-1.06-1.4-.86-.59.07-.58.07-.58.95.07 1.45.98 1.45.98.85 1.45 2.23 1.03 2.77.79.09-.62.33-1.03.6-1.27-2.1-.24-4.31-1.05-4.31-4.68 0-1.03.37-1.88.98-2.54-.1-.24-.43-1.2.09-2.51 0 0 .8-.26 2.62 .97a9.1 9.1 0 014.77 0c1.82-1.23 2.62-.97 2.62-.97.52 1.31.19 2.27.1 2.51.61.66.98 1.51.98 2.54 0 3.64-2.22 4.44-4.33 4.67.34.3.64.87.64 1.76v2.6c0 .26.17.55.66.45A9.5 9.5 0 0012 2.5z" />
  </svg>
);

/**
 * LinkedIn: the rounded tile plus the lowercase "in". The letterforms are drawn as
 * strokes rather than set as text so they scale with the icon's own weight; the dot over
 * the "i" stays a filled circle because a 1.5-weight ring collapses to a blob at 16px.
 */
export const LinkedInIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="7.8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <path d="M7.8 10.8v6" />
    <path d="M11.6 16.8v-6" />
    <path d="M11.6 13.6c0-1.55 1.15-2.8 2.6-2.8s2.6 1.25 2.6 2.8v3.2" />
  </svg>
);

/**
 * X: the two crossing strokes of the wordmark's glyph. The real mark tapers its strokes,
 * which is invisible at this size, so a plain even-weight cross is the honest reduction -
 * it is the whole logo, not a simplification of a larger drawing.
 */
export const XIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <path d="M4.5 4.5l15 15" />
    <path d="M19.5 4.5l-15 15" />
  </svg>
);

/**
 * YouTube: the rounded play tile. The triangle is filled because a hollow one reads as a
 * generic "next" chevron at 16px, while the filled play-in-a-rectangle pairing is what
 * makes this specific mark identifiable without any colour.
 */
export const YouTubeIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
    <path d="M10.3 9.2l5 2.8-5 2.8z" fill="currentColor" stroke="none" />
  </svg>
);

/**
 * Instagram: the rounded camera outline, the lens, and the flash dot. The brand's
 * gradient carries most of its recognition, and this row is monochrome by design, so the
 * three concentric shapes have to do that work alone - which they do, provided the flash
 * dot stays filled and off-centre.
 */
export const InstagramIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none" />
  </svg>
);

/**
 * Reddit: Snoo reduced to head, two eyes, a smile and the antenna. The ears and the
 * antenna's stalk are what separate this from a generic smiley, so they survive even
 * though the head's own outline had to lose its ear cut-outs to stay clean at 16px.
 */
export const RedditIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <circle cx="12" cy="14" r="7.5" />
    <circle cx="9.3" cy="13.3" r="1" fill="currentColor" stroke="none" />
    <circle cx="14.7" cy="13.3" r="1" fill="currentColor" stroke="none" />
    <path d="M9.2 16.6c1.7 1.3 3.9 1.3 5.6 0" />
    <path d="M13.6 6.6l1.3-2.9 2.6 1" />
    <circle cx="18.2" cy="5.1" r="1.2" />
  </svg>
);

/**
 * Docker: the whale's hull with the stacked containers on its back and the spout. The
 * brand mark draws each container as a separate box with its own gaps; those gaps fill in
 * below 20px, so this keeps three boxes instead of twelve - enough for the silhouette to
 * still read as "containers on a whale" rather than as a generic cargo icon.
 */
export const DockerIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <path d="M3.5 12.5h13v2.5a3.5 3.5 0 01-3.5 3.5H7a3.5 3.5 0 01-3.5-3.5z" />
    <path d="M6.5 12.5V10h3v2.5" />
    <path d="M11 12.5V10h3v2.5" />
    <path d="M9 10V7.5h3V10" />
    <path d="M16.5 13.2c1.5.9 3.4.5 4.3-.8" />
  </svg>
);
