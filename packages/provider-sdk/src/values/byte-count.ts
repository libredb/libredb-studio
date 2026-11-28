/**
 * A byte count as display text: `1536` is `1.5 KB`.
 *
 * A negative or non-finite input is not a magnitude, so it is refused as "N/A"
 * rather than drawn as a figure. All five of -1, -1536, NaN, Infinity and
 * -Infinity measured as the literal "NaN undefined" before this guard, by two
 * different routes: `Math.log` is NaN for a negative and for NaN, so the unit
 * index is NaN, while `Math.log(Infinity)` is Infinity, so the index is Infinity
 * - either way it lands outside the array and the division reduces to NaN. "N/A"
 * is the string a panel shows for a size it does not have. A real 0 stays "0 B"
 * because zero bytes IS a measurement, and `-0` reaches that arm first
 * (`-0 === 0` is true), so it never sees the refusal below.
 *
 * The ladder gains PB and EB, and the index is CLAMPED to its end. Two rungs is
 * a judgement, the clamp is the guarantee: a byte count stops being an exact
 * integer in a double at 2^53, which is 8 PB, so rungs past EB would spell
 * magnitudes the input can no longer carry - and a double stays finite up to
 * 1024^102 (measured), so no ladder length can outrun the input range. Without
 * the clamp a petabyte read as "1 undefined" - a number wearing a missing unit,
 * which scans as a figure rather than as garbage - and so did every larger
 * input. A size summed over every part of a large database reaches PB scale.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (!Number.isFinite(bytes) || bytes < 0) return "N/A";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
