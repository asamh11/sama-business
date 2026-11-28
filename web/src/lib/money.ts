export function parseMinor(input: string, decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new Error("إعداد عدد الخانات العشرية غير صالح");
  }

  const raw = input.trim();
  if (!raw) return 0n;

  // Accept either ungrouped digits (1234.56) or correctly grouped
  // thousands (1,234.56). Never strip arbitrary commas: doing so can
  // silently turn malformed input such as "1,,2" into a different amount.
  const amountPattern = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
  if (!amountPattern.test(raw)) {
    throw new Error("أدخل مبلغاً موجباً بصيغة صحيحة");
  }

  const normalized = raw.replace(/,/g, "");
  const [intPart, fracPart = ""] = normalized.split(".");
  if (fracPart.length > decimals) {
    throw new Error(`الحد الأقصى للخانات العشرية لهذه العملة هو ${decimals}`);
  }

  return BigInt(intPart + fracPart.padEnd(decimals, "0"));
}

export function formatMinor(minor: bigint | number | string, decimals: number): string {
  const val = typeof minor === "bigint" ? minor : BigInt(minor || 0);
  const neg = val < BigInt(0);
  const abs = (neg ? -val : val).toString();
  if (decimals <= 0) {
    return (neg ? "-" : "") + abs.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  const padded = abs.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fracPart = padded.slice(-decimals);
  return `${neg ? "-" : ""}${intPart}.${fracPart}`;
}
