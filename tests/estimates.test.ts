import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateDefaults,
  estimateTax,
  oklahomaTax,
  dueDate,
  type EstimateSettings,
} from "../src/estimates.ts";
import type { Snapshot } from "../src/model.ts";
const books: Snapshot = {
  path: "test",
  revision: "one",
  version: "test",
  accounts: [],
  company: { name: "Test", currency: "USD" },
  transactions: [],
};
const settings = (
  patch: Partial<EstimateSettings> = {},
  year = "2025",
): EstimateSettings => ({
  ...estimateDefaults(year),
  filing_status: "single",
  state: "OK",
  profit_source: "manual",
  annual_profit: "100000",
  as_of: "2025-12-31",
  ...patch,
});
const calc = (patch: Partial<EstimateSettings> = {}, year = "2025") =>
  estimateTax(books, year, settings(patch, year));
test("2025 sole proprietor estimate includes half-SE deduction and separate Oklahoma base", () => {
  const e = calc();
  assert.equal(e.ss.toFixed(2), "11451.40");
  assert.equal(e.medicare.toFixed(2), "2678.15");
  assert.equal(e.halfSE.toFixed(2), "7064.78");
  assert.equal(e.agi.toFixed(2), "92935.22");
  assert.equal(e.taxable.toFixed(2), "77185.22");
  assert.equal(e.incomeTax.toFixed(2), "11894.75");
  assert.equal(e.federal.tax.toFixed(2), "26024.30");
  assert.equal(e.okTaxable?.toFixed(2), "85585.22");
  assert.equal(
    calc({ qbi_deduction: "10000" }).oklahoma?.tax.toFixed(2),
    e.oklahoma?.tax.toFixed(2),
  );
});
test("updated federal standard deductions and bracket boundaries differ by year", () => {
  assert.equal(
    calc({ annual_profit: "0", wages: "27675" }).incomeTax.toFixed(2),
    "1192.50",
  );
  assert.equal(
    calc({ annual_profit: "0", wages: "28500" }, "2026").incomeTax.toFixed(2),
    "1240.00",
  );
  assert.equal(
    calc(
      { annual_profit: "0", wages: "66900", filing_status: "joint" },
      "2026",
    ).deduction.toString(),
    "32200",
  );
});
test("Oklahoma 2026 thresholds replace the 2025 six brackets", () => {
  assert.equal(oklahomaTax(7200, "2025", "single").toFixed(2), "153.50");
  assert.equal(oklahomaTax(3750, "2026", "single").toFixed(2), "0.00");
  assert.equal(oklahomaTax(4900, "2026", "single").toFixed(2), "28.75");
  assert.equal(oklahomaTax(7200, "2026", "single").toFixed(2), "109.25");
  assert.equal(oklahomaTax(14400, "2026", "joint").toFixed(2), "218.50");
});
test("owner W2 wages consume SS cap but not Medicare base", () => {
  const e = calc({ ss_wages: "176000", medicare_wages: "190000" });
  assert.equal(e.ss.toFixed(2), "12.40");
  assert.equal(e.medicare.toFixed(2), "2678.15");
  assert.equal(e.additionalMedicare.toFixed(2), "741.15");
  assert.equal(calc({ ss_wages: "200000" }).ss.toString(), "0");
  assert.equal(calc({ annual_profit: "400" }).se.toString(), "0");
  assert.equal(calc({ annual_profit: "-1000" }).se.toString(), "0");
});
test("unknown prior tax does not become a zero safe harbor and high AGI uses 110%", () => {
  assert.equal(
    calc({ prior_federal_eligible: true }).federal.minimum.toFixed(2),
    "23421.87",
  );
  assert.equal(
    calc({
      prior_federal_eligible: true,
      prior_federal_tax: "10000",
      prior_agi: "150000",
    }).federal.minimum.toString(),
    "10000",
  );
  assert.equal(
    calc({
      prior_federal_eligible: true,
      prior_federal_tax: "10000",
      prior_agi: "150001",
    }).federal.minimum.toString(),
    "11000",
  );
  assert.equal(
    calc({
      prior_federal_eligible: true,
      prior_federal_tax: "0",
      prior_agi: "0",
    }).federal.minimum.toString(),
    "0",
  );
});
test("minimum payment thresholds and full-tax strategy are distinct", () => {
  assert.equal(
    calc({
      annual_profit: "0",
      federal_other_tax: "999.99",
    }).federal.minimum.toString(),
    "0",
  );
  assert.equal(
    calc({
      annual_profit: "0",
      federal_other_tax: "1000",
    }).federal.minimum.toString(),
    "900",
  );
  const e = calc();
  const full = calc({ payment_goal: "full" });
  assert.equal(full.federal.target.toString(), e.federal.tax.toString());
  assert.ok(
    e.oklahoma!.minimum.eq(e.oklahoma!.tax.times(".70").toDecimalPlaces(2)),
  );
  assert.equal(
    calc({
      prior_ok_eligible: true,
      prior_ok_tax: "100",
    }).oklahoma?.minimum.toString(),
    "100",
  );
  assert.equal(
    calc({
      ok_withholding: e.oklahoma!.tax.minus(499).toFixed(2),
    }).oklahoma?.minimum.toString(),
    "0",
  );
});
test("nonrefundable credits cannot erase SE tax; refundable credits can produce an overpayment", () => {
  const e = calc({ federal_credits: "999999" });
  assert.ok(e.federal.tax.eq(e.se));
  assert.equal(
    calc({
      annual_profit: "0",
      refundable_credits: "100",
    }).federal.balance.toString(),
    "-100",
  );
});
test("late catch-up preserves earlier gaps and future payments do not count", () => {
  const e = calc({
    annual_profit: "0",
    federal_other_tax: "10000",
    payment_goal: "full",
    as_of: "2025-06-16",
    payments: [
      {
        id: "1",
        jurisdiction: "federal",
        date: "2025-06-01",
        amount: "5000",
        note: "",
      },
      {
        id: "2",
        jurisdiction: "federal",
        date: "2025-12-01",
        amount: "5000",
        note: "",
      },
    ],
  });
  assert.equal(e.federal.quarters[0].gap.toString(), "2500");
  assert.equal(e.federal.quarters[1].gap.toString(), "0");
  assert.equal(e.federal.paid.toString(), "5000");
  assert.equal(e.federal.balance.toString(), "5000");
  assert.equal(dueDate(settings(), "2025", "federal", 1), "2025-06-16");
  assert.equal(dueDate(settings(), "2026", "federal", 3), "2027-01-15");
  assert.throws(
    () => calc({ due_dates: { federal_1: "2025-10-01" } }),
    /in order/,
  );
});
test("installment rounding sums exactly to annual target", () => {
  const e = calc({
    annual_profit: "0",
    federal_other_tax: "1000.01",
    payment_goal: "full",
  });
  assert.equal(
    e.federal.quarters.reduce((n, q) => n.plus(q.target), e.profit).toFixed(2),
    "1000.01",
  );
});
test("missing records require a forecast and ledger projections exclude other currencies", () => {
  assert.throws(
    () =>
      estimateTax(books, "2026", settings({ profit_source: "ledger" }, "2026")),
    /No USD/,
  );
  const b = {
    ...books,
    transactions: [
      {
        date: "2025-01-01",
        description: "Sales",
        postings: [
          {
            account: "income:sales",
            amounts: [
              { commodity: "USD", quantity: "-100" },
              { commodity: "EUR", quantity: "-500" },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(
    estimateTax(
      b,
      "2025",
      settings({ profit_source: "ledger", through: "2025-01-01" }),
    ).profit.toString(),
    "100",
  );
  assert.equal(
    estimateTax(
      b,
      "2025",
      settings({ profit_source: "annualized", through: "2025-01-01" }),
    ).profit.toString(),
    "36500",
  );
  assert.equal(
    estimateTax(
      b,
      "2025",
      settings({ annual_profit: "900" }),
    ).profit.toString(),
    "900",
  );
});
