import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecimal, formatMinor, add, allocate, convertMinor, MoneyError } from "../src/core/money.ts";
import { validateJournal, reverseLines, trialBalance, JournalError } from "../src/core/journal.ts";
import { newDraft, confirmDraft } from "../src/core/draft.ts";

const L = (accountId: string, debit: bigint, credit: bigint, currency = "USD") =>
  ({ accountId, currency, debit, credit });

test("money parses and formats exactly", () => {
  assert.equal(parseDecimal("12.5", 2), 1250n);
  assert.equal(parseDecimal("-0.05", 2), -5n);
  assert.equal(formatMinor(-5n, 2), "-0.05");
  assert.equal(formatMinor(1250n, 2), "12.50");
  assert.equal(formatMinor(7n, 0), "7");
  assert.throws(() => parseDecimal("1.234", 2), MoneyError);
  assert.throws(() => parseDecimal("1e3", 2), MoneyError);
});

test("currencies are never mixed", () => {
  assert.throws(() => add({ minor: 1n, currency: "USD" }, { minor: 1n, currency: "SYP" }), MoneyError);
});

test("allocate loses no minor unit", () => {
  const parts = allocate(100n, [1n, 1n, 1n]);
  assert.deepEqual(parts, [34n, 33n, 33n]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), 100n);
  assert.equal(allocate(-100n, [1n, 1n, 1n]).reduce((a, b) => a + b, 0n), -100n);
});

test("conversion rounds half away from zero", () => {
  assert.equal(convertMinor(1000n, 2, 0, 13000n, 1n), 130000n);
  assert.equal(convertMinor(5n, 2, 2, 1n, 2n), 3n); // 0.05 * 0.5 = 0.025 -> 0.03
  assert.equal(convertMinor(-5n, 2, 2, 1n, 2n), -3n);
});

test("the $100 sale with $70 cost balances and reverses exactly", () => {
  const sale = [L("cash", 10000n, 0n), L("revenue", 0n, 10000n)];
  const cogs = [L("cogs", 7000n, 0n), L("inventory", 0n, 7000n)];
  validateJournal(sale);
  validateJournal(cogs);
  const all = [...sale, ...cogs];
  const tb = trialBalance([...all, ...reverseLines(all)]);
  for (const v of tb.values()) assert.equal(v.debit, v.credit);
});

test("invalid entries are rejected", () => {
  assert.throws(() => validateJournal([L("a", 1n, 0n)]), (e) => e instanceof JournalError && e.code === "TOO_FEW_LINES");
  assert.throws(() => validateJournal([L("a", 1n, 0n), L("b", 0n, 2n)]), (e) => e instanceof JournalError && e.code === "UNBALANCED");
  assert.throws(() => validateJournal([L("a", 1n, 1n), L("b", 0n, 0n)]), (e) => e instanceof JournalError && e.code === "INVALID_LINE");
  assert.throws(() => validateJournal([L("a", 100n, 0n, "USD"), L("b", 0n, 100n, "SYP")]), JournalError);
});

test("AI drafts need human confirmation and cannot be confirmed twice", () => {
  const d = newDraft("d1", "voice", "Cash sale 100 USD", [L("cash", 100n, 0n), L("revenue", 0n, 100n)]);
  assert.equal(d.status, "pending_confirmation");
  assert.throws(() => confirmDraft(d, ""));
  assert.equal(confirmDraft(d, "user-1").idempotencyKey, "draft:d1");
  assert.throws(() => confirmDraft({ ...d, status: "confirmed" }, "user-1"));
});
