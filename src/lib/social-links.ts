import type React from "react";
import { Heart } from "lucide-react";
import {
  DockerIcon,
  GitHubIcon,
  InstagramIcon,
  LinkedInIcon,
  RedditIcon,
  XIcon,
  YouTubeIcon,
} from "@/components/icons/social-icons";

/**
 * One destination in the login page's community row.
 *
 * The icon travels with the entry rather than being looked up by id in the component,
 * because a lookup needs a fallback for the miss that cannot happen - and an untaken
 * fallback branch is a line the coverage gate can never cover honestly.
 */
export interface SocialLink {
  /** Stable key for React and for tests; never rendered. */
  id: string;
  /** The link's accessible name. These links are icon-only, so this is their ONLY name. */
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Where LibreDB actually is, in the order the row renders left to right.
 *
 * The handle is `libredb` on every platform; GitHub Sponsors is the one exception,
 * because sponsorship is tied to the maintainer's account rather than to the
 * organisation. All eight were opened and confirmed by the maintainer before shipping -
 * a 404 in the product's front door is worse than an absent link, so a destination that
 * cannot be confirmed does not get a row.
 *
 * Ordered by how much a first-time visitor is likely to want it: the repository first,
 * the professional and short-form channels next, the community forums after, and the
 * distribution and sponsorship links last. The component maps this array; it never
 * writes a destination of its own.
 */
export const SOCIAL_LINKS: readonly SocialLink[] = [
  { id: "github", label: "GitHub", href: "https://github.com/libredb", icon: GitHubIcon },
  { id: "linkedin", label: "LinkedIn", href: "https://www.linkedin.com/company/libredb", icon: LinkedInIcon },
  { id: "x", label: "X", href: "https://x.com/libredb", icon: XIcon },
  { id: "youtube", label: "YouTube", href: "https://www.youtube.com/@libredb", icon: YouTubeIcon },
  { id: "instagram", label: "Instagram", href: "https://www.instagram.com/libredb", icon: InstagramIcon },
  { id: "reddit", label: "Reddit", href: "https://www.reddit.com/r/libredb", icon: RedditIcon },
  { id: "dockerhub", label: "Docker Hub", href: "https://hub.docker.com/u/libredb", icon: DockerIcon },
  // Reuses lucide's Heart: the sponsor card above the row already renders it, so drawing
  // a second heart would put two different hearts on the same page.
  { id: "sponsor", label: "Sponsor", href: "https://github.com/sponsors/cevheri", icon: Heart },
];
