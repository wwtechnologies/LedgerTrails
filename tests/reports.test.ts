import test from "node:test";
import assert from "node:assert/strict";
import {
  generateReport,
  reportCsv,
  reportHtml,
  validPeriod,
} from "../src/reports.ts";
import { emptyWorkspace, emptyTaxYear } from "../src/workspace.ts";
import { taxPacket } from "../src/tax.ts";
import type { Snapshot, Transaction } from "../src/model.ts";
const tx = (
  date: string,
  description: string,
  entries: [string, string, string?][],
): Transaction => ({
  date,
  description,
  postings: entries.map(([account, quantity, commodity = "USD"]) => ({
    account,
    amounts: [{ quantity, commodity }],
  })),
});
const books: Snapshot = {
  path: "sample",
  revision: "one",
  version: "test",
  accounts: [],
  company: { name: "Test", currency: "USD" },
  transactions: [
    tx("2024-12-31", "Opening", [
      ["assets:bank:a", "1000"],
      ["equity:opening-balances", "-1000"],
    ]),
    tx("2025-01-01", "Revenue", [
      ["assets:bank:a", "100"],
      ["income:sales", "-100"],
    ]),
    tx("2025-01-02", "Cost", [
      ["expenses:office", "25"],
      ["assets:bank:a", "-25"],
    ]),
    tx("2025-01-03", "Unidentified", [
      ["equity:needs-review:checks", "10"],
      ["assets:bank:a", "-10"],
    ]),
    tx("2025-01-04", "Transfer", [
      ["assets:bank:b", "200"],
      ["assets:bank:a", "-200"],
    ]),
    tx("2025-01-05", "EUR", [
      ["assets:bank:a", "50", "EUR"],
      ["income:sales", "-50", "EUR"],
    ]),
    tx("2026-01-01", "Outside period", [
      ["assets:bank:a", "500"],
      ["income:sales", "-500"],
    ]),
  ],
};
const p = { start: "2025-01-01", end: "2025-12-31", currency: "USD" };
const get = (id: Parameters<typeof generateReport>[0]) =>
  generateReport(id, books, p, emptyWorkspace());
test("profit excludes other currencies, outside dates, transfers, and unresolved items", () => {
  assert.deepEqual(get("profit-loss").rows.at(-1), [
    "Net book profit / loss",
    "75.00",
  ]);
  assert.match(get("profit-loss").notes.join(" "), /1 transactions/);
});
test("balance sheet includes opening equity and unclosed earnings", () => {
  const r = get("balance-sheet");
  assert.deepEqual(
    r.rows.find((r) => r[0] === "Total assets"),
    ["Total assets", "1065.00"],
  );
  assert.deepEqual(r.rows.at(-1), ["Balance check (expected zero)", "0.00"]);
});
test("cash flow nets transfers and includes unresolved cash separately", () => {
  const r = get("cash-flow");
  assert.deepEqual(
    r.rows.find((r) => r[0] === "Operating"),
    ["Operating", "75.00"],
  );
  assert.deepEqual(
    r.rows.find((r) => r[0] === "Unclassified cash movement"),
    ["Unclassified cash movement", "-10.00"],
  );
  assert.deepEqual(r.rows.at(-1), ["Closing cash", "1065.00"]);
});
test("general ledger carries forward opening balances", () => {
  const rows = get("general-ledger").rows;
  assert.deepEqual(
    rows.find((r) => r[1] === "Opening balance" && r[2] === "assets:bank:a"),
    [p.start, "Opening balance", "assets:bank:a", "", "", "1000.00"],
  );
  assert.equal(
    rows.find((r) => r[1] === "Revenue" && r[2] === "assets:bank:a")?.at(-1),
    "1100.00",
  );
});
test("report amounts retain precision beyond JS safe integers", () => {
  const b = {
    ...books,
    transactions: [
      tx("2025-01-01", "Large", [
        ["assets:bank:a", "900719925474099312345.67"],
        ["income:sales", "-900719925474099312345.67"],
      ]),
    ],
  };
  assert.equal(
    generateReport("profit-loss", b, p, emptyWorkspace()).rows.at(-1)?.[1],
    "900719925474099312345.67",
  );
});
test("aging includes exact as-of snapshot and correct overdue bucket", () => {
  const w = emptyWorkspace();
  w.schedules = [
    {
      id: "1",
      kind: "invoice",
      name: "Client",
      reference: "INV1",
      date: "2025-10-01",
      due: "2025-12-01",
      as_of: p.end,
      amount: "99.50",
      currency: "USD",
      notes: "",
    },
    {
      id: "2",
      kind: "invoice",
      name: "Stale",
      reference: "INV2",
      date: "2025-10-01",
      due: "2025-11-01",
      as_of: "2025-11-30",
      amount: "9",
      currency: "USD",
      notes: "",
    },
  ];
  const r = generateReport("ar-aging", books, p, w);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0][4], "99.50");
  assert.equal(r.rows[0][5], "0.00");
});
test("budget requires exact period and account and calculates expense variance", () => {
  const w = emptyWorkspace();
  w.budgets = [
    {
      id: "1",
      account: "expenses:office",
      start: p.start,
      end: p.end,
      amount: "20",
      currency: "USD",
    },
  ];
  assert.deepEqual(generateReport("budget", books, p, w).rows, [
    ["expenses:office", "20.00", "25.00", "5.00"],
  ]);
});
test("tax worksheet excludes suspense and separates reviewed adjustments from book profit", () => {
  const t = emptyTaxYear();
  t.entity = "sole";
  t.adjustments = [
    {
      id: "a",
      description: "Nondeductible",
      direction: "increase",
      amount: "5",
      currency: "USD",
    },
    {
      id: "b",
      description: "Other currency",
      direction: "decrease",
      amount: "90",
      currency: "EUR",
    },
  ];
  const packet = taxPacket(books, p, t, emptyWorkspace());
  assert.deepEqual(
    packet[0].rows.find((r) => r[0] === "Adjusted book income worksheet"),
    ["Adjusted book income worksheet", "80.00"],
  );
  assert.equal(
    packet[1].rows.some((r) => r[0].startsWith("equity:")),
    false,
  );
  assert.match(packet[0].notes.join(" "), /not taxable income/);
});
test("exports escape HTML and neutralize spreadsheet formulas in descriptions", () => {
  const r = get("transactions");
  r.rows.push(['=HYPERLINK("evil")', "<script>alert(1)</script>"]);
  assert.match(reportCsv(r), /'=HYPERLINK/);
  assert.doesNotMatch(reportHtml("<img src=x>", [r]), /<script>|<img/);
  assert.match(reportHtml("Test", [r]), /&lt;script&gt;/);
});
test("invalid dates and inverted periods are rejected", () => {
  assert.equal(validPeriod({ ...p, start: "2025-02-30" }), false);
  assert.throws(() =>
    generateReport(
      "profit-loss",
      books,
      { ...p, start: "2026-01-01" },
      emptyWorkspace(),
    ),
  );
});
