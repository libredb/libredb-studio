/**
 * A Kubernetes quantity read with Kubernetes' own suffixes (`n`, `u`, `m`, `k`, `M`, `G`, `T`, `P`, `E`, `Ki` to `Ei`,
 * exponents) as an exact fraction, rounded up to a whole milli-unit or unit as `resource.Quantity` rounds, and summed
 * over a least common denominator. Pure and browser-safe, importing nothing. `kubectl top` and the agent's cluster
 * readings in the Kubernetes provider read the cluster's figures with it, and the agent's tool definitions check a
 * quantity a model writes with the same reader.
 */
const BINARY: Readonly<Record<string, number>> = { Ki: 10, Mi: 20, Gi: 30, Ti: 40, Pi: 50, Ei: 60 };
const DECIMAL: Readonly<Record<string, number>> = { n: -9, u: -6, m: -3, "": 0, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18 };

// The build targets ES2017, which has no bigint literals, so the few constants are built once.
const ZERO_N = BigInt(0);
const ONE_N = BigInt(1);
const TWO_N = BigInt(2);
const TEN_N = BigInt(10);
const THOUSAND_N = BigInt(1000);

/** A quantity as an exact fraction: numerator over denominator. */
export interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** The largest exponent a quantity may carry, `1e30` or `1e-30`: no metric a cluster reports comes near it. */
const MAX_EXPONENT = 30;

/**
 * A Kubernetes quantity as an exact fraction, or undefined when the text is not one. The answer comes from the API
 * server, so the digits (at most 40 on each side of the point) and the exponent are bounded before any BigInt work:
 * an unbounded exponent would hold the event loop for seconds, and such a value reads as unreadable.
 */
export function parseQuantity(text: string): Fraction | undefined {
  const match =
    /^([+-]?)([0-9]{1,40}(?:\.[0-9]{0,40})?|\.[0-9]{1,40})(?:([eE][+-]?[0-9]{1,2})|(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE])?)$/.exec(
      text,
    );
  if (match === null) return undefined;
  const [, sign, digits, exponent, suffix = ""] = match;
  if (exponent !== undefined && Math.abs(Number(exponent.slice(1))) > MAX_EXPONENT) return undefined;
  const [whole, fraction = ""] = digits.split(".");
  let numerator = BigInt(`${whole}${fraction}` === "" ? "0" : `${whole}${fraction}`);
  let denominator = TEN_N ** BigInt(fraction.length);
  if (sign === "-") numerator = -numerator;
  const scale = (power: bigint, base: bigint) => {
    if (power >= ZERO_N) numerator *= base ** power;
    else denominator *= base ** -power;
  };
  if (exponent !== undefined) scale(BigInt(exponent.slice(1)), TEN_N);
  else if (suffix in BINARY) scale(BigInt(BINARY[suffix]), TWO_N);
  else scale(BigInt(DECIMAL[suffix]), TEN_N);
  return { numerator, denominator };
}

/** The fraction times `scale`, rounded up, as `Quantity.ScaledValue` rounds. */
function ceilScaled(value: Fraction, scale: bigint): bigint {
  const scaled = value.numerator * scale;
  const quotient = scaled / value.denominator;
  return scaled % value.denominator > ZERO_N ? quotient + ONE_N : quotient;
}

/** `Quantity.MilliValue`. */
export function milliValue(value: Fraction): bigint {
  return ceilScaled(value, THOUSAND_N);
}

/** `Quantity.Value`. */
export function wholeValue(value: Fraction): bigint {
  return ceilScaled(value, ONE_N);
}

const ZERO: Fraction = { numerator: ZERO_N, denominator: ONE_N };

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a, b];
  while (y !== ZERO_N) [x, y] = [y, x % y];
  return x;
}

/**
 * The sum of fractions over their least common denominator, so a pod of many containers keeps its denominator as
 * small as its largest one rather than their product.
 */
export function sumQuantities(values: readonly Fraction[]): Fraction {
  return values.reduce((total, value) => {
    const common = (total.denominator / gcd(total.denominator, value.denominator)) * value.denominator;
    return {
      numerator: total.numerator * (common / total.denominator) + value.numerator * (common / value.denominator),
      denominator: common,
    };
  }, ZERO);
}
