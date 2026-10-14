/**
 * The version floor: Studio connects to Spark 4.1 and later, the first release that splits large
 * results into chunks Studio can read (SPARK-53525). The text is AnalyzePlan's spark_version answer; a pre-release of
 * exactly 4.1.0 reads as below the floor, because which 4.1.0 previews carry result chunking was not checked.
 * Pure: no I/O, no logger.
 */
import { SPARK_MIN_VERSION } from "./constants";

export interface SparkVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly preRelease: boolean;
}

const LEADING = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?!\d)([\s\S]*)$/;
const PRE_RELEASE = /^-(?:preview\d+|rc\d+|SNAPSHOT)(?![A-Za-z0-9])/;

/** The version AnalyzePlan answered, or undefined when the text does not start with major.minor.patch. */
export function parseSparkVersion(text: string): SparkVersion | undefined {
  const match = LEADING.exec(text);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    preRelease: PRE_RELEASE.test(match[4] as string),
  };
}

/** Whether a server of this version may be connected to. */
export function meetsSparkFloor(version: SparkVersion): boolean {
  if (version.major !== SPARK_MIN_VERSION.major) return version.major > SPARK_MIN_VERSION.major;
  if (version.minor !== SPARK_MIN_VERSION.minor) return version.minor > SPARK_MIN_VERSION.minor;
  if (version.patch !== SPARK_MIN_VERSION.patch) return version.patch > SPARK_MIN_VERSION.patch;
  return !version.preRelease;
}
