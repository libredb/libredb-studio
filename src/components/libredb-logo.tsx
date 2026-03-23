import { useId } from 'react';

interface LibreDBLogoProps {
  className?: string;
}

export default function LibreDBLogo({ className }: LibreDBLogoProps) {
  const svgId = useId().replace(/:/g, '');
  const logoGradientId = `logo-gradient-${svgId}`;
  const codeGradientId = `code-gradient-${svgId}`;
  const glowFilterId = `logo-glow-${svgId}`;

  return (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id={logoGradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#9333EA" />
        </linearGradient>
        <linearGradient id={codeGradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#10B981" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
        <filter id={glowFilterId} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.4" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <path
        d="M20 2L36 11.5V29.5L20 39L4 29.5V11.5L20 2Z"
        fill={`url(#${logoGradientId})`}
        fillOpacity="0.05"
        stroke={`url(#${logoGradientId})`}
        strokeWidth="1.8"
        strokeLinejoin="round"
        opacity="0.88"
      />
      <g filter={`url(#${glowFilterId})`}>
        <path
          d="M15 15L10 20.5L15 26"
          stroke={`url(#${codeGradientId})`}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M25 15L30 20.5L25 26"
          stroke={`url(#${codeGradientId})`}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <g opacity="0.7">
        <rect x="16.25" y="16.8" width="7.5" height="2.1" rx="0.6" fill={`url(#${logoGradientId})`} />
        <rect x="16.25" y="20" width="7.5" height="2.1" rx="0.6" fill={`url(#${logoGradientId})`} />
        <rect x="16.25" y="23.2" width="7.5" height="2.1" rx="0.6" fill={`url(#${logoGradientId})`} />
      </g>
    </svg>
  );
}
