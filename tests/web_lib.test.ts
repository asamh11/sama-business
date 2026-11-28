import { test } from "node:test";
import assert from "node:assert/strict";
import { trialBalance, statements, deriveAlerts, toCSV } from "../web/src/lib/reports.ts";
import { DICTS, translate, dirOf } from "../web/src/lib/i18n.ts";
import { NAV, navFor, roleAllows, CAN } from "../web/src/lib/nav.ts";

const accounts = [
  { id: "cash", code: "1010", name: "Cash", type: "asset" },
  { id: "cap", code: "3010", name: "Capital", type: "equity" },
  { id: "sales", code: "4010", name: "Sales", type: "revenue" },
  { id: "rent", code: "5010", name: "Rent", type: "expense" },
  { id: "loan", code: "2010", name: "Loan", type: "liability" },
];
const L = (account_id: string, debit: number | string | bigint, credit: number | string | bigint, currency = "USD") =>
  ({ account_id, currency, debit, credit });

const lines = [
  L("cash", 100000, 0), L("cap", 0, 100000), // رأس المال
  L("cash", 50000, 0), L("sales", 0, 50000), // مبيعات
  L("rent", 12000, 0), L("cash", 0, 12000), // إيجار
  L("cash", 20000, 0), L("loan", 0, 20000), // قرض
  L("cash", 9000000, 0, "SYP"), L("sales", 0, 9000000, "SYP"),
];

test("trial balance sums per account and never mixes currencies", () => {
  const tb = trialBalance(accounts, lines);
  const cashUsd = tb.rows.find((r) => r.accountId === "cash" && r.currency === "USD")!;
  assert.equal(cashUsd.debit, 170000n);
  assert.equal(cashUsd.credit, 12000n);
  assert.equal(cashUsd.balance, 158000n);
  assert.ok(tb.rows.some((r) => r.accountId === "cash" && r.currency === "SYP"));
  assert.equal(tb.totals.USD.debit, tb.totals.USD.credit);
  assert.equal(tb.totals.SYP.debit, tb.totals.SYP.credit);
  assert.ok(tb.totals.USD.balanced && tb.totals.SYP.balanced);
  assert.equal(tb.orphanAccounts.length, 0);
});

test("income statement and balance sheet reconcile (assets = liabilities + equity + net income)", () => {
  const st = statements(trialBalance(accounts, lines).rows);
  assert.equal(st.USD.revenue, 50000n);
  assert.equal(st.USD.expense, 12000n);
  assert.equal(st.USD.netIncome, 38000n);
  assert.equal(st.USD.assets, 158000n);
  assert.equal(st.USD.liabilities, 20000n);
  assert.equal(st.USD.equity, 100000n);
  assert.equal(st.USD.imbalance, 0n);
  assert.equal(st.SYP.netIncome, 9000000n);
  assert.equal(st.SYP.imbalance, 0n);
});

test("amounts above 2^53 stay exact (bigint)", () => {
  const huge = "9007199254740993"; // 2^53 + 1
  const tb = trialBalance(accounts, [L("cash", huge, 0), L("cap", 0, huge)]);
  const cash = tb.rows.find((r) => r.accountId === "cash")!;
  assert.equal(cash.debit, 9007199254740993n);
  assert.ok(tb.totals.USD.balanced);
});

test("unbalanced data and unknown accounts raise high alerts", () => {
  const bad = [L("cash", 100, 0), L("cap", 0, 90), L("ghost", 5, 5)];
  const tb = trialBalance(accounts, bad);
  assert.equal(tb.totals.USD.balanced, false);
  assert.deepEqual(tb.orphanAccounts, ["ghost"]);
  const alerts = deriveAlerts({ branches: 1, accounts: 5, cashboxes: 1, entries: 3, totals: tb.totals, orphanAccounts: tb.orphanAccounts, truncated: false });
  assert.ok(alerts.some((a) => a.key === "unbalancedCurrency" && a.level === "high"));
  assert.ok(alerts.some((a) => a.key === "unknownAccount" && a.level === "high"));
});

test("truncated loads raise a high alert; healthy data raises none", () => {
  const tb = trialBalance(accounts, lines);
  const base = { branches: 1, accounts: 5, cashboxes: 1, entries: 5, totals: tb.totals, orphanAccounts: tb.orphanAccounts };
  assert.equal(deriveAlerts({ ...base, truncated: false }).length, 0);
  assert.ok(deriveAlerts({ ...base, truncated: true }).some((a) => a.key === "dataTruncated"));
});

test("CSV quotes properly, blocks formula injection, keeps negative numbers", () => {
  const csv = toCSV([["name", "amount"], ['=HYPERLINK("x")', "-12.50"], ["a,b", 'say "hi"'], ["@cmd", "+5"]]);
  assert.ok(csv.startsWith("\uFEFF"));
  const body = csv.slice(1).split("\r\n");
  assert.equal(body[1], "\"'=HYPERLINK(\"\"x\"\")\",-12.50");
  assert.equal(body[2], '"a,b","say ""hi"""');
  assert.equal(body[3], "'@cmd,'+5");
});

test("every nav item has labels in Arabic and English; both dictionaries have identical keys", () => {
  assert.deepEqual(Object.keys(DICTS.ar).sort(), Object.keys(DICTS.en).sort());
  for (const n of NAV) {
    assert.ok(DICTS.ar[`nav.${n.id}`] && DICTS.en[`nav.${n.id}`], n.id);
    if (n.status === "soon") assert.ok(DICTS.ar[`soon.${n.id}`] && DICTS.en[`soon.${n.id}`], `soon.${n.id}`);
  }
});

test("translate falls back, interpolates, and direction follows language", () => {
  assert.equal(translate("en", "alert.unbalancedCurrency", { currency: "USD" }).includes("USD"), true);
  assert.equal(translate("ar", "no.such.key"), "no.such.key");
  assert.equal(dirOf("ar"), "rtl");
  assert.equal(dirOf("en"), "ltr");
});

test("menu follows account type; branches always reachable; enterprise sees all 12", () => {
  assert.equal(NAV.length, 12);
  assert.equal(navFor("enterprise").length, 12);
  assert.ok(!navFor("personal").some((n) => n.id === "sales"));
  assert.ok(!navFor("retail").some((n) => n.id === "hr"));
  for (const m of ["personal", "retail", "enterprise"] as const) {
    assert.ok(navFor(m).some((n) => n.id === "branches"));
    assert.ok(navFor(m).some((n) => n.id === "accounting"));
  }
});

test("UI role gates mirror the database rules", () => {
  assert.equal(roleAllows("cashier", CAN.post), true);
  assert.equal(roleAllows("cashier", CAN.reverse), false);
  assert.equal(roleAllows("accountant", CAN.closeBooks), false);
  assert.equal(roleAllows("admin", CAN.closeBooks), true);
  assert.equal(roleAllows("viewer", CAN.post), false);
  assert.equal(roleAllows(null, CAN.post), false);
});
