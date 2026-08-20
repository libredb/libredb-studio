import React from "react";

interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  className?: string;
}

/** PostgreSQL elephant logo (simplified) */
export const PostgreSQLIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <path d="M12 2C7.58 2 4 5.58 4 10c0 2.05.78 3.92 2.05 5.33C5.38 16.46 5 18.15 5 20c0 .55.45 1 1 1h1c.55 0 1-.3 1.2-.75l.8-1.75c.9.32 1.95.5 3 .5s2.1-.18 3-.5l.8 1.75c.2.45.65.75 1.2.75h1c.55 0 1-.45 1-1 0-1.85-.38-3.54-1.05-4.67A7.97 7.97 0 0020 10c0-4.42-3.58-8-8-8z" />
    <circle cx="9.5" cy="9.5" r="1" fill="currentColor" stroke="none" />
    <path d="M14 13c-1 1-3 1-4 0" />
    <path d="M15.5 7.5c.5-1 2-1.5 3-.5" />
    <path d="M8.5 7.5c-.5-1-2-1.5-3-.5" />
  </svg>
);

/** MySQL dolphin logo (simplified) */
export const MySQLIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M9 13h6" />
    <path d="M9 17h3" />
    <circle cx="12" cy="11" r="0" />
    <path
      d="M8 10c1-2 3-3 4.5-2.5S14 10 13.5 12 11 15 9.5 14.5 7 12 8 10z"
      fill="currentColor"
      opacity="0.15"
      stroke="none"
    />
  </svg>
);

/** MongoDB leaf logo */
export const MongoDBIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <path d="M12 2C12 2 7 7 7 13c0 3.31 2.24 6 5 6s5-2.69 5-6c0-6-5-11-5-11z" />
    <path d="M12 22v-3" />
    <path d="M12 2v9" />
  </svg>
);

/** Redis diamond/stack logo */
export const RedisIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <ellipse cx="12" cy="12" rx="9" ry="5" />
    <path d="M12 7v10" />
    <path d="M7.5 9v6" />
    <path d="M16.5 9v6" />
  </svg>
);

/** MSSQL stacked cylinder/database logo (simplified) */
export const MSSQLIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    <path d="M4 8.5c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    <path d="M4 15.5c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </svg>
);

/** Couchbase bucket with its scope/collection dividers (simplified) */
export const CouchbaseIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <path d="M4 7l1.5-3h13L20 7" />
    <path d="M4 7h16l-1.5 12a2 2 0 01-2 1.8H7.5a2 2 0 01-2-1.8L4 7z" />
    <path d="M7.5 11h9" />
    <path d="M7.5 15h9" />
  </svg>
);

/**
 * ClickHouse bar-chart mark: a horizontal rule over five columns, the last one
 * half height. That short column is the distinguishing feature of the brand mark,
 * so it is not simplified away.
 */
export const ClickHouseIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <path d="M4 4h16" />
    <path d="M4 8v12" />
    <path d="M8 8v12" />
    <path d="M12 8v12" />
    <path d="M16 8v12" />
    <path d="M20 8v6" />
  </svg>
);

/**
 * Apache Druid five-pointed angular mark, reduced to its outline. The brand mark's
 * interior is segmented; those segments collapse into mush at the 14px (`w-3.5`)
 * size the sidebar renders a DB icon at, so only the silhouette survives — the
 * five points are what makes it identifiable at that size.
 */
export const DruidIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <path d="M12 3L14.65 8.36L20.56 9.22L16.28 13.39L17.29 19.28L12 16.5L6.71 19.28L7.72 13.39L3.44 9.22L9.35 8.36Z" />
  </svg>
);

/**
 * Trino's rabbit, reduced to a head and two ears.
 *
 * The brand mark is a full rabbit in three-quarter view with a shaded body; at the
 * 14px (`w-3.5`) size the sidebar renders a DB icon at, a body reads as a smudge under
 * the ears, so only the head survives - the two long upright ears are what makes it
 * identifiable, and nothing else in this set has a pair of vertical lobes.
 *
 * Drawn as three closed outlines (two ears, one head) rather than one silhouette, for
 * the reason `DruidIcon` records: a single path joining the ears to the head loses the
 * notch between them at icon size, and the notch is the whole read.
 */
export const TrinoIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <path d="M8.5 11.5C7.2 9.6 6.5 7.2 6.8 4.8c.1-.8.9-1.2 1.5-.7 1.8 1.5 3 3.6 3.4 5.9" />
    <path d="M15.5 11.5c1.3-1.9 2-4.3 1.7-6.7-.1-.8-.9-1.2-1.5-.7-1.8 1.5-3 3.6-3.4 5.9" />
    <path d="M12 10.5c3 0 5.5 2.4 5.5 5.3S15 21 12 21s-5.5-2.3-5.5-5.2S9 10.5 12 10.5Z" />
    <circle cx="12" cy="16.8" r="1" fill="currentColor" stroke="none" />
  </svg>
);

/**
 * Elastic's banded-disc mark, reduced to its seams.
 *
 * Read off the official logo's own geometry (`Elasticsearch_logo.svg`, the five
 * coloured mark paths): a disc cut into three horizontal bands with a gap between
 * them, whose MIDDLE band ends in a rounded lobe that protrudes past the disc on the
 * right (the `#00a9e5` path, which reaches x=153 where the disc's own right edge is
 * at 166 and whose left neighbour `#353535` is the flat band across the centre).
 * Those three bands and the lobe are the mark; the colours that distinguish them in
 * the brand version cannot survive a `currentColor` icon.
 *
 * Drawn as an outline plus two seam lines rather than three closed segments, for the
 * reason `DruidIcon` records: at the 14px (`w-3.5`) size the sidebar renders a DB
 * icon at, six stacked horizontal strokes collapse into a solid blob, while a disc
 * with two seams and a lobe still reads (rasterized and inspected at 16px and 140px
 * before it was committed).
 */
export const ElasticsearchIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <circle cx="11" cy="12" r="8.5" />
    <path d="M3.1 9.2h16.4" />
    <path d="M3.1 14.8h16.4" />
    <path d="M19.5 9.2a2.8 2.8 0 0 1 0 5.6" />
  </svg>
);

/**
 * The OpenSearch mark: two interlocking hooks forming an S, inside an open arc.
 *
 * Read off the official mark (`opensearch.org/assets/brand/SVG/Mark/opensearch_mark_default.svg`),
 * which is exactly three shapes in a 64-unit box: a quarter-circle arc of radius 36
 * about (25.8, 28.8) sweeping from 3 o'clock to 6 o'clock (`#005EB8`), and two
 * mirrored crescents (`#003B5C` upper, `#005EB8` lower) that interlock into an S.
 * The brand guide describes the mark as built from the negative space of the "O" and
 * the "S", so the S and the open arc are the two things that must survive: this is
 * three strokes at the scaled positions of those three shapes (64 -> 22 units, arc
 * radius 12.4, hook radius 5.5).
 *
 * Deliberately not a magnifying glass. Nothing in the mark is one, and the shape is
 * also what tells this icon apart from `ElasticsearchIcon` at 14px, where the
 * Elastic disc reads as a banded circle and this reads as an S in an arc (both were
 * rasterized and inspected at that size).
 */
export const OpenSearchIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <path d="M7.2 6.2A5.5 5.5 0 1 1 15.8 11.7" />
    <path d="M12.6 13.8A5.5 5.5 0 1 1 4 8.3" />
    <path d="M22.3 9.9A12.4 12.4 0 0 1 9.9 22.3" />
  </svg>
);

/** LibreDB database cylinder with L marker */
export const LibreDBIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <ellipse cx="12" cy="5" rx="7" ry="3" />
    <path d="M5 5v14c0 1.66 3.13 3 7 3s7-1.34 7-3V5" />
    <path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" />
    <path d="M10 18.5h4" />
  </svg>
);

/**
 * Cassandra's eye, reduced to its outline.
 *
 * The project's own mark is an almond-shaped eye with a ringed pupil, and that is
 * what this draws: two arcs meeting at the corners, a circle for the iris and a
 * filled centre. No text, and no attempt at the gradient - a single-stroke mark at
 * weight 1.5 is what every other icon here is, and the eye reads at 14px.
 */
export const CassandraIcon: React.FC<IconProps> = ({ className, ...props }) => (
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
    <path d="M2.5 12c2.6-3.7 5.8-5.5 9.5-5.5s6.9 1.8 9.5 5.5" />
    <path d="M2.5 12c2.6 3.7 5.8 5.5 9.5 5.5s6.9-1.8 9.5-5.5" />
    <circle cx="12" cy="12" r="3.4" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);
