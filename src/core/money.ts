// Money is always a bigint count of minor units plus a currency code.
// Never use JS floats for money. Different currencies are never mixed.

export interface Money {
  readonly minor: bigint;
  readonly currency: string;
}

export class MoneyError extends Error {}

/** "12.50" -> 1250n. Rejects floats, exponents and excess decimals. */
export function parseDecimal(input: string, decimals: number): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!m) throw new MoneyError(`invalid amount: "${input}"`);
  const frac = m[3] ?? "";
  if (frac.length > decimals) {
    throw new MoneyError(`too many decimal places (max ${decimals}): "${input}"`);
  }
  const v = BigInt((m[2] ?? "0") + frac.padEnd(decimals, "0"));
  return m[1] ? -v : v;
}

/** 1250n -> "12.50" */
export function formatMinor(minor: bigint, decimals: number): string {
  const neg = minor < 0n;
  const s = (neg ? -minor : minor).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return (neg ? "-" : "") + int + (decimals > 0 ? "." + frac : "");
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  return add(a, { minor: -b.minor, currency: b.currency });
}

/** Split an amount by weights with no lost or invented minor unit. */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((x, y) => x + y, 0n);
  if (weights.length === 0 || sum <= 0n || weights.some((w) => w < 0n)) {
    throw new MoneyError("invalid weights");
  }
  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  const shares = weights.map((w) => (abs * w) / sum);
  let rest = abs - shares.reduce((x, y) => x + y, 0n);
  for (let i = 0; rest > 0n; i = (i + 1) % shares.length) {
    if ((weights[i] ?? 0n) > 0n) {
      shares[i] = (shares[i] ?? 0n) + 1n;
      rest -= 1n;
    }
  }
  return shares.map((s) => s * sign);
}

/**
 * Convert minor units between currencies with a documented rate
 * (rateNum/rateDen = units of target major per 1 source major).
 * Rounds half away from zero. Callers must store rate, date and source.
 */
export function convertMinor(
  minor: bigint,
  fromDecimals: number,
  toDecimals: number,
  rateNum: bigint,
  rateDen: bigint,
): bigint {
  if (rateDen <= 0n || rateNum <= 0n) throw new MoneyError("invalid rate");
  const num = minor * rateNum * 10n ** BigInt(toDecimals);
  const den = rateDen * 10n ** BigInt(fromDecimals);
  const sign = num < 0n ? -1n : 1n;
  const a = num * sign;
  const q = a / den;
  return sign * (((a % den) * 2n >= den) ? q + 1n : q);
}
