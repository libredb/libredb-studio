import { Star, Bug, MessageCircle, Code, Languages, Heart } from 'lucide-react';

const communityUrls = {
  repo: 'https://github.com/libredb/libredb-studio',
  issues: 'https://github.com/libredb/libredb-studio/issues',
  discussions: 'https://github.com/libredb/libredb-studio/discussions',
  contributing: 'https://github.com/libredb/libredb-studio/blob/main/CONTRIBUTING.md',
  translate: 'https://github.com/libredb/libredb-studio/tree/main/src/lib',
  sponsor: 'https://github.com/sponsors/cevheri',
} as const;

const communityActions = [
  { label: 'Star & Fork', icon: Star, url: communityUrls.repo, color: 'bg-blue-500/15 text-blue-400' },
  { label: 'Open an Issue', icon: Bug, url: communityUrls.issues, color: 'bg-red-500/15 text-red-400' },
  { label: 'Discussions', icon: MessageCircle, url: communityUrls.discussions, color: 'bg-cyan-500/15 text-cyan-400' },
  { label: 'Contribute', icon: Code, url: communityUrls.contributing, color: 'bg-violet-500/15 text-violet-400' },
  { label: 'Translate', icon: Languages, url: communityUrls.translate, color: 'bg-emerald-500/15 text-emerald-400' },
  { label: 'Sponsor', icon: Heart, url: communityUrls.sponsor, color: 'bg-pink-500/15 text-pink-400' },
] as const;

interface CommunitySectionProps {
  variant: 'desktop' | 'mobile';
}

export function CommunitySection({ variant }: CommunitySectionProps) {
  if (variant === 'desktop') {
    return <DesktopCommunity />;
  }
  return <MobileCommunity />;
}

function DesktopCommunity() {
  return (
    <div className="space-y-4">
      <div className="h-px bg-white/[0.06]" />

      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-zinc-200">Join the Community</h3>
          <p className="text-xs text-zinc-500">This project is open source. Your contributions make it better!</p>
        </div>
        <span className="shrink-0 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          Open Source
        </span>
      </div>

      <div className="flex flex-wrap gap-2.5">
        {communityActions.map((action) => (
          <a
            key={action.label}
            href={action.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 min-w-[140px] flex-1 px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] hover:border-white/[0.12] transition-all duration-200 group"
          >
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${action.color}`}>
              <action.icon className="h-4 w-4" />
            </div>
            <span className="text-xs font-medium text-zinc-400 group-hover:text-zinc-200 transition-colors duration-200">
              {action.label}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

function MobileCommunity() {
  return (
    <div className="space-y-3">
      <div className="h-px bg-muted" />

      <p className="text-xs font-medium text-center text-muted-foreground">Join the Community</p>

      <div className="flex flex-wrap justify-center gap-2">
        {communityActions.map((action) => (
          <a
            key={action.label}
            href={action.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted text-muted-foreground hover:bg-muted/80 transition-colors text-xs font-medium"
          >
            <action.icon className="h-3 w-3" />
            <span>{action.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
