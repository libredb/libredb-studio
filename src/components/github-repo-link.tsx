"use client";

import { REPO_URL } from "@/lib/community/repo";
import { dismissStarPrompt } from "@/lib/community/star-prompt";
import { cn } from "@/lib/utils";

interface GitHubRepoLinkProps {
  /**
   * Spacing, sizing AND colour for the surrounding chrome. The colour is the
   * caller's because this link sits in two very different surfaces: the studio
   * headers are fixed dark chrome (zinc), while the sidebar follows the theme
   * tokens the embedding host supplies. Merging two competing text colours here
   * would depend on tailwind-merge resolving a custom token, which it silently
   * does not.
   */
  className?: string;
}

/**
 * The permanent way to the repository, sitting in the studio chrome beside the
 * version string. A static icon and a static href: nothing here reads a star
 * count or touches the network, so air-gapped installs and the CSP are unaffected.
 *
 * The octocat mark is inlined rather than imported because lucide-react 1.x
 * dropped every brand icon; inlining it (the convention already used by
 * `src/components/icons/db-icons.tsx`) keeps the dependency count unchanged. It
 * is a filled mark, so it paints with `fill="currentColor"` - no stroke - and it
 * carries `aria-hidden` explicitly, which lucide used to add on its behalf.
 *
 * That makes it optically heavier than the 1.5-stroke outline icons it sits
 * beside in the header, and that is accepted rather than corrected: checked at
 * its real 14px in both chrome surfaces, the octocat silhouette still reads, and
 * dimming it back to hairline weight would quietly demote the one permanent link
 * to the repository. The official mark is filled by definition.
 *
 * Following it also marks the one-shot star prompt handled - someone who has
 * already been to the repository should not be asked again by the tenth-query
 * toast. `dismissStarPrompt` is SSR-safe and swallows every storage failure, so
 * this handler cannot throw or block the navigation.
 */
export function GitHubRepoLink({ className }: GitHubRepoLinkProps) {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="LibreDB Studio on GitHub"
      title="LibreDB Studio on GitHub"
      onClick={() => dismissStarPrompt()}
      className={cn("inline-flex items-center justify-center transition-colors", className)}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="w-3.5 h-3.5">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
    </a>
  );
}
