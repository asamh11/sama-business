// منطق الفواتير والمخزون: دوال نقية، كل المبالغ bigint بالوحدات الصغرى، والكميات بالألف (3 خانات عشرية).
// التقريب: نصف بعيداً عن الصفر. لا نسبة ضريبة افتراضية: تُحدَّد لكل منتج/منشأة (راجع محاسبك).
export type InvoiceLineInput = {
  qtyMilli: bigint;      // 1.5 وحدة = 1500
  unitMinor: bigint;     // سعر الوحدة بالوحدات الصغرى للعملة
  discountBp?: number;   // خصم بالنقاط الأساسية: 1000 = 10%
  taxBp?: number;        // ضريبة بالنقاط الأساسية
};
export type InvoiceLineResult = { net: bigint; discount: bigint; taxable: bigint; tax: bigint; total: bigint };

const ZERO = BigInt(0);

export function roundDiv(n: bigint, d: bigint): bigint {
  if (d === ZERO) throw new Error("division by zero");
  const neg = (n < ZERO) !== (d < ZERO);
  const a = n < ZERO ? -n : n;
  const b = d < ZERO ? -d : d;
  const q = (a * BigInt(2) + b) / (b * BigInt(2)); // نصف لأعلى بالقيمة المطلقة
  return neg ? -q : q;
}

function checkBp(v: number | undefined, name: string): bigint {
  const x = v ?? 0;
  if (!Number.isInteger(x) || x < 0 || x > 10000) throw new Error(`${name} must be an integer between 0 and 10000`);
  return BigInt(x);
}

export function computeLine(l: InvoiceLineInput): InvoiceLineResult {
  if (l.qtyMilli <= ZERO) throw new Error("quantity must be positive");
  if (l.unitMinor < ZERO) throw new Error("unit price must not be negative");
  const net = roundDiv(l.qtyMilli * l.unitMinor, BigInt(1000));
  const discount = roundDiv(net * checkBp(l.discountBp, "discount"), BigInt(10000));
  const taxable = net - discount;
  const tax = roundDiv(taxable * checkBp(l.taxBp, "tax"), BigInt(10000));
  return { net, discount, taxable, tax, total: taxable + tax };
}

// إجمالي الفاتورة = مجموع إجماليات السطور (لا نعيد حساب الضريبة على المجموع، كي يطابق كل سطر ما يُرحَّل).
export function computeInvoice(lines: InvoiceLineInput[]) {
  if (lines.length === 0) throw new Error("invoice needs at least one line");
  const res = lines.map(computeLine);
  const sum = (k: keyof InvoiceLineResult) => res.reduce((s, r) => s + r[k], ZERO);
  return { lines: res, subtotal: sum("net"), discount: sum("discount"), tax: sum("tax"), total: sum("total") };
}

// متوسط التكلفة المرجّح عند إدخال مخزون.
export function weightedAvgCost(onHandMilli: bigint, avgMinor: bigint, inMilli: bigint, inCostMinor: bigint): bigint {
  if (inMilli <= ZERO) throw new Error("incoming quantity must be positive");
  if (onHandMilli < ZERO) throw new Error("on-hand quantity must not be negative");
  const value = onHandMilli * avgMinor + inMilli * inCostMinor;
  return roundDiv(value, onHandMilli + inMilli);
}

// صرف مخزون: يُرفض الرصيد السالب.
export function stockAfterIssue(onHandMilli: bigint, outMilli: bigint): bigint {
  if (outMilli <= ZERO) throw new Error("issued quantity must be positive");
  if (outMilli > onHandMilli) throw new Error("insufficient stock");
  return onHandMilli - outMilli;
}
