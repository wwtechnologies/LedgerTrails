import Decimal from "decimal.js";
import type { Snapshot } from "./model.ts";
import {
  balances,
  sum,
  under,
  isReview,
  amount,
  findings,
  generateReport,
  type Report,
  type Period,
} from "./reports.ts";
import {
  checkItems,
  entityLabels,
  formLinks,
  type TaxYear,
  type Workspace,
} from "./workspace.ts";
export function taxAccounts(books: Snapshot, p: Period) {
  return [
    ...balances(
      books.transactions.filter((t) => t.date >= p.start && t.date <= p.end),
      p.currency,
    ),
  ]
    .filter(
      ([a, v]) => (under(a, "income") || under(a, "expenses")) && !v.isZero(),
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account, value]) => ({
      account,
      amount: amount(under(account, "income") ? value.negated() : value),
    }));
}
export function taxPacket(
  books: Snapshot,
  p: Period,
  tax: TaxYear,
  workspace: Workspace,
): Report[] {
  const entries = books.transactions.filter(
      (t) => t.date >= p.start && t.date <= p.end,
    ),
    b = balances(entries, p.currency);
  const inc = sum(b, (a) => under(a, "income")).negated(),
    exp = sum(b, (a) => under(a, "expenses")),
    profit = inc.minus(exp);
  const relevant = tax.adjustments.filter((a) => a.currency === p.currency),
    increase = relevant
      .filter((a) => a.direction === "increase")
      .reduce((n, a) => n.plus(a.amount), new Decimal(0)),
    decrease = relevant
      .filter((a) => a.direction === "decrease")
      .reduce((n, a) => n.plus(a.amount), new Decimal(0));
  const accounts = taxAccounts(books, p),
    unmapped = accounts.filter(
      (a) => !tax.mappings[a.account] || tax.mappings[a.account] === "Unmapped",
    ).length;
  const pending = entries.filter((t) =>
    t.postings.some((p) => isReview(p.account)),
  ).length;
  const title = "Tax preparation summary";
  const summary: Report = {
    title,
    subtitle: `Calendar year ${p.start.slice(0, 4)} · ${p.currency} · Draft for preparer review`,
    columns: ["Item", "Value"],
    rows: [
      ["Entity classification", entityLabels[tax.entity]],
      ["Federal return starting point", formLinks[tax.entity].name],
      ["Reported accounting method", tax.basis],
      ["State / local jurisdictions", tax.jurisdiction || "Not provided"],
      ["Recorded income", amount(inc)],
      ["Recorded expenses", amount(exp)],
      ["Net book profit / loss", amount(profit)],
      ["Manual income increases", amount(increase)],
      ["Manual income decreases", amount(decrease)],
      [
        "Adjusted book income worksheet",
        amount(profit.plus(increase).minus(decrease)),
      ],
      ["Transactions needing classification in year", String(pending)],
      ["Unmapped income / expense accounts", String(unmapped)],
      [
        "Checklist completed",
        `${checkItems.filter(([key]) => tax.checks[key]).length} of ${checkItems.length}`,
      ],
    ],
    notes: [
      ...findings(books, p),
      "Adjusted book income is a working figure, not taxable income or tax due. Deductions, limitations, elections, credits, personal taxes, and state/local returns require preparer review.",
      "Account mappings organize records only. They do not change the ledger or automatically apply tax deductions. Record reviewed book-to-tax differences as separate adjustments.",
      "Only the selected currency is included. Reconcile other currencies and any required conversion separately.",
      `Federal form reference: ${formLinks[tax.entity].url}`,
    ],
  };
  const mappings: Report = {
    title: "Tax category worksheet",
    subtitle: summary.subtitle,
    columns: ["Book account", "Preparer category", "Recorded amount"],
    rows: accounts.map((a) => [
      a.account,
      tax.mappings[a.account] || "Unmapped",
      a.amount,
    ]),
    notes: [
      "These are book amounts, not approved deductions. Meals, vehicle costs, assets, owner items, and other limited expenses need supporting records and tax adjustments.",
    ],
  };
  const adjustments: Report = {
    title: "Book-to-tax adjustments",
    subtitle: summary.subtitle,
    columns: ["Description", "Direction", "Amount"],
    rows: relevant.map((a) => [a.description, a.direction, amount(a.amount)]),
    notes: [
      "Manual preparation worksheet only. Adjustments do not post to the ledger; amounts are not calculated by LedgerTrails.",
    ],
  };
  const checklist: Report = {
    title: "Preparation checklist & notes",
    subtitle: summary.subtitle,
    columns: ["Task", "Status"],
    rows: [
      ...checkItems.map(([key, label]) => [
        label,
        tax.checks[key] ? "Confirmed by user" : "Outstanding",
      ]),
      ["Preparer notes", tax.notes || "None"],
    ],
    notes: [
      "Checklist status records user confirmation, not verification of a filed return.",
      "Records guide: https://www.irs.gov/businesses/small-businesses-self-employed/what-kind-of-records-should-i-keep",
      "Accounting methods: https://www.irs.gov/publications/p538",
      "Information return instructions: https://www.irs.gov/instructions/i1099mec",
    ],
  };
  return [
    summary,
    mappings,
    adjustments,
    checklist,
    ...(
      [
        "profit-loss",
        "balance-sheet",
        "trial-balance",
        "general-ledger",
        "review",
        "debts",
        "payroll",
        "sales-tax",
        "equity",
        "asset-register",
        "inventory",
        "contractors",
      ] as const
    ).map((id) => generateReport(id, books, p, workspace)),
  ];
}
