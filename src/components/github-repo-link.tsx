"use client";

import { Github } from "lucide-react";
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
      <Github strokeWidth={1.5} className="w-3.5 h-3.5" />
    </a>
  );
}
