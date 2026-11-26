export function parseMinor(input: string, decimals: number): bigint {
  const cleaned = input.trim().replace(/,/g, "");
  if (!cleaned) return BigInt(0);
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error("أدخل رقماً موجباً صحيحاً فقط");
  }
  const [intPart, fracPart = ""] = cleaned.split(".");
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
