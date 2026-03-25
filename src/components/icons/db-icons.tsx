import React from 'react';

interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  className?: string;
}

/** PostgreSQL elephant logo (simplified) */
export const PostgreSQLIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
    <path d="M12 2C7.58 2 4 5.58 4 10c0 2.05.78 3.92 2.05 5.33C5.38 16.46 5 18.15 5 20c0 .55.45 1 1 1h1c.55 0 1-.3 1.2-.75l.8-1.75c.9.32 1.95.5 3 .5s2.1-.18 3-.5l.8 1.75c.2.45.65.75 1.2.75h1c.55 0 1-.45 1-1 0-1.85-.38-3.54-1.05-4.67A7.97 7.97 0 0020 10c0-4.42-3.58-8-8-8z" />
    <circle cx="9.5" cy="9.5" r="1" fill="currentColor" stroke="none" />
    <path d="M14 13c-1 1-3 1-4 0" />
    <path d="M15.5 7.5c.5-1 2-1.5 3-.5" />
    <path d="M8.5 7.5c-.5-1-2-1.5-3-.5" />
  </svg>
);

/** MySQL dolphin logo (simplified) */
export const MySQLIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
    <path d="M4.5 16c1-2 3-3 5.5-3s4.5 1 5.5 3" />
    <path d="M19 8c-1-3-4-5-7-5S5.5 5 5 8c-.3 1.5.5 3 2 4s3.5 1.5 5 1.5 3.5-.5 5-1.5 2.3-2.5 2-4z" />
    <path d="M16 6c1.5-.5 3.5 0 4 2s-.5 3.5-1.5 4" />
    <path d="M12 8v3" />
    <circle cx="9.5" cy="9" r="0.75" fill="currentColor" stroke="none" />
    <path d="M8 19l-2 3" />
    <path d="M16 19l2 3" />
    <path d="M12 19v3" />
  </svg>
);

/** SQLite feather/document logo (simplified) */
export const SQLiteIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M9 13h6" />
    <path d="M9 17h3" />
    <circle cx="12" cy="11" r="0" />
    <path d="M8 10c1-2 3-3 4.5-2.5S14 10 13.5 12 11 15 9.5 14.5 7 12 8 10z" fill="currentColor" opacity="0.15" stroke="none" />
  </svg>
);

/** MongoDB leaf logo */
export const MongoDBIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
    <path d="M12 2C12 2 7 7 7 13c0 3.31 2.24 6 5 6s5-2.69 5-6c0-6-5-11-5-11z" />
    <path d="M12 22v-3" />
    <path d="M12 2v9" />
  </svg>
);

/** Redis diamond/stack logo */
export const RedisIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
    <path d="M12 3L2 9l10 6 10-6-10-6z" />
    <path d="M2 15l10 6 10-6" />
    <path d="M2 9v6" />
    <path d="M22 9v6" />
    <path d="M12 15v6" />
    <path d="M2 12l10 6 10-6" />
  </svg>
);

/** Oracle arch/pillar logo (simplified) */
export const OracleIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
    <ellipse cx="12" cy="12" rx="9" ry="5" />
    <path d="M12 7v10" />
    <path d="M7.5 9v6" />
    <path d="M16.5 9v6" />
  </svg>
);

/** MSSQL stacked cylinder/database logo (simplified) */
export const MSSQLIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    <path d="M4 8.5c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    <path d="M4 15.5c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </svg>
);
