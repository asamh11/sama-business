import { test } from "node:test";
import assert from "node:assert/strict";
import { roundDiv, computeLine, computeInvoice, weightedAvgCost, stockAfterIssue } from "../src/lib/invoice.ts";

const B = (n: number) => BigInt(n);

test("roundDiv rounds half away from zero, both signs", () => {
  assert.equal(roundDiv(B(5), B(2)), B(3));
  assert.equal(roundDiv(B(-5), B(2)), B(-3));
  assert.equal(roundDiv(B(4), B(3)), B(1));
  assert.equal(roundDiv(B(-4), B(3)), B(-1));
});

test("line: qty x price, discount, tax are exact in minor units", () => {
  // 1.5 x 10.00 = 15.00 ; خصم 10% = 1.50 ; خاضع 13.50 ; ضريبة 5% = 0.675 -> 0.68
  const r = computeLine({ qtyMilli: B(1500), unitMinor: B(1000), discountBp: 1000, taxBp: 500 });
  assert.deepEqual(r, { net: B(1500), discount: B(150), taxable: B(1350), tax: B(68), total: B(1418) });
});

test("invoice total equals the sum of line totals (no tax recomputed on the sum)", () => {
  const lines = [
    { qtyMilli: B(1000), unitMinor: B(333), taxBp: 500 },
    { qtyMilli: B(1000), unitMinor: B(333), taxBp: 500 },
    { qtyMilli: B(1000), unitMinor: B(333), taxBp: 500 },
  ];
  const inv = computeInvoice(lines);
  assert.equal(inv.total, inv.lines.reduce((s, l) => s + l.total, B(0)));
  assert.equal(inv.total, inv.subtotal - inv.discount + inv.tax);
});

test("invalid input is rejected", () => {
  assert.throws(() => computeLine({ qtyMilli: B(0), unitMinor: B(100) }), /quantity/);
  assert.throws(() => computeLine({ qtyMilli: B(1000), unitMinor: B(-1) }), /price/);
  assert.throws(() => computeLine({ qtyMilli: B(1000), unitMinor: B(100), discountBp: 10001 }), /discount/);
  assert.throws(() => computeLine({ qtyMilli: B(1000), unitMinor: B(100), taxBp: 1.5 }), /tax/);
  assert.throws(() => computeInvoice([]), /at least one/);
});

test("large amounts stay exact beyond 2^53", () => {
  const big = BigInt("9007199254740993");
  const r = computeLine({ qtyMilli: B(1000), unitMinor: big });
  assert.equal(r.total, big);
});

test("weighted average cost and negative-stock guard", () => {
  // 10 وحدات بتكلفة 100، ندخل 10 بتكلفة 200 -> 150
  assert.equal(weightedAvgCost(B(10000), B(100), B(10000), B(200)), B(150));
  assert.equal(stockAfterIssue(B(5000), B(2000)), B(3000));
  assert.throws(() => stockAfterIssue(B(1000), B(1001)), /insufficient/);
  assert.throws(() => stockAfterIssue(B(1000), B(0)), /positive/);
});
