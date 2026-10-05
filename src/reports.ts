import Decimal from "decimal.js";
Decimal.set({ precision: 300 });
import type { Snapshot, Transaction } from "./model.ts";
import type { Workspace } from "./workspace.ts";
export interface Report {
  title: string;
  subtitle: string;
  columns: string[];
  rows: string[][];
  notes: string[];
}
export interface Period {
  start: string;
  end: string;
  currency: string;
}
export const catalog = [
  ["profit-loss", "Profit & loss", "Financial statements"],
  ["balance-sheet", "Balance sheet", "Financial statements"],
  ["cash-flow", "Cash flow", "Financial statements"],
  ["trial-balance", "Trial balance", "Financial statements"],
  ["monthly", "Monthly profit & loss", "Performance"],
  ["comparison", "Period comparison", "Performance"],
  ["income", "Income by account", "Performance"],
  ["expenses", "Expenses by account", "Performance"],
  ["budget", "Budget vs actual", "Performance"],
  ["general-ledger", "General ledger", "Books & banking"],
  ["transactions", "Transaction detail", "Books & banking"],
  ["bank-activity", "Bank activity", "Books & banking"],
  ["review", "Uncategorized transactions", "Books & banking"],
  ["receivables", "Accounts receivable balances", "Customers & vendors"],
  ["ar-aging", "Receivables aging", "Customers & vendors"],
  ["payables", "Accounts payable balances", "Customers & vendors"],
  ["ap-aging", "Payables aging", "Customers & vendors"],
  ["debts", "Loans & credit cards", "Tax & supporting schedules"],
  ["payroll", "Payroll accounts", "Tax & supporting schedules"],
  ["sales-tax", "Sales tax accounts", "Tax & supporting schedules"],
  ["assets", "Fixed asset accounts", "Tax & supporting schedules"],
  ["asset-register", "Asset register", "Tax & supporting schedules"],
  ["inventory", "Inventory valuation schedule", "Tax & supporting schedules"],
  ["contractors", "Contractor payment schedule", "Tax & supporting schedules"],
  ["equity", "Owner & equity activity", "Tax & supporting schedules"],
] as const;
export type ReportId = (typeof catalog)[number][0];
export const under = (a: string, p: string) => a === p || a.startsWith(p + ":");
export const isCash = (a: string) =>
  ["assets:bank", "assets:cash", "assets:checking", "assets:savings"].some(
    (p) => under(a, p),
  );
export const isReview = (a: string) =>
  under(a, "equity:needs-review") ||
  /^(income|expenses):uncategorized(?:$|:)/.test(a);
export const amount = (n: Decimal.Value) =>
  new Decimal(n).toFixed(Math.max(2, new Decimal(n).decimalPlaces()));
export function validPeriod(p: Period) {
  return (
    validDate(p.start) &&
    validDate(p.end) &&
    p.start <= p.end &&
    Number(p.end.slice(0, 4)) - Number(p.start.slice(0, 4)) < 100 &&
    /^[A-Z]{3,12}$/.test(p.currency)
  );
}
export function validDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === s;
}
export const within = (t: Transaction, p: Period) =>
  t.date >= p.start && t.date <= p.end;
export function balances(transactions: Transaction[], currency: string) {
  const result = new Map<string, Decimal>();
  for (const t of transactions)
    for (const p of t.postings)
      for (const a of p.amounts)
        if (a.commodity === currency)
          result.set(
            p.account,
            (result.get(p.account) ?? new Decimal(0)).plus(a.quantity),
          );
  return result;
}
export function sum(
  m: Map<string, Decimal>,
  filter: (account: string) => boolean,
) {
  let n = new Decimal(0);
  for (const [a, v] of m) if (filter(a)) n = n.plus(v);
  return n;
}
export function findings(books: Snapshot, p: Period) {
  const tx = books.transactions.filter((t) => t.date <= p.end);
  const review = tx.filter((t) =>
    t.postings.some((a) => isReview(a.account)),
  ).length;
  const notes: string[] = [];
  if (review)
    notes.push(
      `${review} transactions through ${p.end} still need classification. Profit and tax worksheets are incomplete until these are resolved.`,
    );
  const banks = Array.from(
    new Set(tx.flatMap((t) => t.postings.map((a) => a.account)).filter(isCash)),
  );
  const absent = banks.filter(
    (bank) =>
      !tx.some(
        (t) =>
          t.postings.some((p) => p.account === bank) &&
          t.postings.some(
            (p) =>
              under(p.account, "equity:opening-balances") ||
              under(p.account, "equity:opening"),
          ),
      ),
  );
  if (absent.length)
    notes.push(
      `Opening balances have not been identified for: ${absent.join(", ")}. Verify whether an opening entry is needed.`,
    );
  const dates = tx
    .filter((t) => within(t, p))
    .map((t) => t.date)
    .sort();
  notes.push(
    dates.length
      ? `Recorded activity in this period: ${dates[0]} to ${dates[dates.length - 1]}. Coverage does not prove all statements were imported.`
      : "No recorded transactions in this period.",
  );
  notes.push(
    "Amounts follow recorded ledger entries. Selecting an accounting method in Tax does not convert cash and accrual records.",
  );
  return notes;
}
export function generateReport(
  id: ReportId,
  books: Snapshot,
  p: Period,
  workspace: Workspace,
): Report {
  if (!validPeriod(p))
    throw new Error("Choose a valid date range and currency.");
  const tx = books.transactions
    .filter((t) => within(t, p))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const all = books.transactions.filter((t) => t.date <= p.end),
    b = balances(tx, p.currency),
    closing = balances(all, p.currency);
  const income = sum(b, (a) => under(a, "income")).negated(),
    expenses = sum(b, (a) => under(a, "expenses"));
  const r: Report = {
    title: catalog.find((c) => c[0] === id)![1],
    subtitle: `${p.start} to ${p.end} · ${p.currency} · As recorded`,
    columns: ["Account", "Amount"],
    rows: [],
    notes: findings(books, p),
  };
  const list = (
    m: Map<string, Decimal>,
    filter: (a: string) => boolean,
    invert = false,
  ) =>
    [...m]
      .filter(([a, v]) => filter(a) && !v.isZero())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([a, v]) => [a, amount(invert ? v.negated() : v)]);
  const detail = (filter: (a: string) => boolean, running = false) => {
    r.columns = [
      "Date",
      "Description",
      "Account",
      "Debit",
      "Credit",
      ...(running ? ["Running balance"] : []),
    ];
    const opening = balances(
      books.transactions.filter((t) => t.date < p.start),
      p.currency,
    );
    if (running)
      for (const [a, v] of [...opening].sort(([a], [b]) => a.localeCompare(b)))
        if (filter(a) && !v.isZero())
          r.rows.push([p.start, "Opening balance", a, "", "", amount(v)]);
    for (const t of tx)
      for (const post of t.postings)
        if (filter(post.account))
          for (const v of post.amounts)
            if (v.commodity === p.currency) {
              const n = new Decimal(v.quantity);
              const next = (opening.get(post.account) ?? new Decimal(0)).plus(
                n,
              );
              opening.set(post.account, next);
              r.rows.push([
                t.date,
                t.description,
                post.account,
                n.gte(0) ? amount(n) : "",
                n.lt(0) ? amount(n.negated()) : "",
                ...(running ? [amount(next)] : []),
              ]);
            }
  };
  switch (id) {
    case "profit-loss":
      r.rows = [
        ...list(b, (a) => under(a, "income"), true),
        ["Total income", amount(income)],
        ...list(b, (a) => under(a, "expenses")),
        ["Total expenses", amount(expenses)],
        ["Net book profit / loss", amount(income.minus(expenses))],
      ];
      break;
    case "income":
      r.rows = [
        ...list(b, (a) => under(a, "income"), true),
        ["Total income", amount(income)],
      ];
      break;
    case "expenses":
      r.rows = [
        ...list(b, (a) => under(a, "expenses")),
        ["Total expenses", amount(expenses)],
      ];
      break;
    case "balance-sheet": {
      const assets = sum(closing, (a) => under(a, "assets")),
        liabilities = sum(closing, (a) => under(a, "liabilities")).negated(),
        equity = sum(closing, (a) => under(a, "equity")).negated(),
        earnings = sum(
          closing,
          (a) => under(a, "income") || under(a, "expenses"),
        ).negated();
      r.subtitle = `As of ${p.end} · ${p.currency} · Includes all recorded prior activity`;
      r.rows = [
        ...list(closing, (a) => under(a, "assets")),
        ["Total assets", amount(assets)],
        ...list(closing, (a) => under(a, "liabilities"), true),
        ["Total liabilities", amount(liabilities)],
        ...list(closing, (a) => under(a, "equity"), true),
        ["Unclosed earnings (all recorded years)", amount(earnings)],
        ["Total equity including earnings", amount(equity.plus(earnings))],
        [
          "Liabilities + equity",
          amount(liabilities.plus(equity).plus(earnings)),
        ],
        [
          "Balance check (expected zero)",
          amount(assets.minus(liabilities).minus(equity).minus(earnings)),
        ],
      ];
      break;
    }
    case "trial-balance":
      r.subtitle = `As of ${p.end} · ${p.currency}`;
      r.columns = ["Account", "Debit balance", "Credit balance"];
      r.rows = [...closing]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([a, v]) => [
          a,
          v.gte(0) ? amount(v) : "",
          v.lt(0) ? amount(v.negated()) : "",
        ]);
      r.rows.push([
        "Total",
        amount(sum(closing, (a) => closing.get(a)!.gt(0))),
        amount(sum(closing, (a) => closing.get(a)!.lt(0)).negated()),
      ]);
      r.notes.push(
        "Debit and credit totals should agree within each currency. Unclassified account roots still appear here.",
      );
      break;
    case "general-ledger":
      detail(() => true, true);
      break;
    case "transactions":
      detail(() => true);
      break;
    case "bank-activity":
      detail(isCash, true);
      break;
    case "review":
      detail(isReview);
      break;
    case "monthly": {
      r.columns = ["Month", "Income", "Expenses", "Net book profit"];
      let month = p.start.slice(0, 7);
      let guard = 0;
      while (month <= p.end.slice(0, 7) && guard++ < 1200) {
        const mb = balances(
          tx.filter((t) => t.date.startsWith(month)),
          p.currency,
        );
        const inc = sum(mb, (a) => under(a, "income")).negated(),
          exp = sum(mb, (a) => under(a, "expenses"));
        r.rows.push([month, amount(inc), amount(exp), amount(inc.minus(exp))]);
        const d = new Date(month + "-01T00:00:00Z");
        d.setUTCMonth(d.getUTCMonth() + 1);
        month = d.toISOString().slice(0, 7);
      }
      r.rows.push([
        "Total",
        amount(income),
        amount(expenses),
        amount(income.minus(expenses)),
      ]);
      break;
    }
    case "comparison": {
      const duration = (Date.parse(p.end) - Date.parse(p.start)) / 86400000 + 1;
      const prevEnd = new Date(Date.parse(p.start) - 86400000)
          .toISOString()
          .slice(0, 10),
        prevStart = new Date(Date.parse(p.start) - duration * 86400000)
          .toISOString()
          .slice(0, 10);
      const prev = balances(
        books.transactions.filter(
          (t) => t.date >= prevStart && t.date <= prevEnd,
        ),
        p.currency,
      );
      r.columns = [
        "Account",
        `${prevStart} to ${prevEnd}`,
        "Selected period",
        "Change",
      ];
      const names = [...new Set([...b.keys(), ...prev.keys()])]
        .filter((a) => under(a, "income") || under(a, "expenses"))
        .sort();
      r.rows = names.map((a) => {
        const sign = under(a, "income") ? -1 : 1,
          old = (prev.get(a) ?? new Decimal(0)).times(sign),
          now = (b.get(a) ?? new Decimal(0)).times(sign);
        return [a, amount(old), amount(now), amount(now.minus(old))];
      });
      r.notes.push(
        "Comparison uses the immediately preceding period of the same number of days. Missing historical entries are not evidence of zero activity.",
      );
      break;
    }
    case "cash-flow": {
      const groups = new Map<string, Decimal>();
      for (const t of tx) {
        const tb = balances([t], p.currency),
          cash = sum(tb, isCash);
        if (cash.isZero()) continue;
        for (const [a, v] of tb) {
          if (isCash(a)) continue;
          const label = isReview(a)
            ? "Unclassified cash movement"
            : under(a, "equity:opening-balances") || under(a, "equity:opening")
              ? "Opening balances recorded in period"
              : under(a, "assets:transfers")
                ? "Transfers in transit"
                : under(a, "equity") ||
                    /^liabilities:(loans?|credit-card|credit-cards|vehicle-loan|mortgage)(:|$)/.test(
                      a,
                    )
                  ? "Financing"
                  : /^assets:(fixed-assets|equipment|vehicles|property|investments)(:|$)/.test(
                        a,
                      )
                    ? "Investing"
                    : /^(income|expenses)(:|$)/.test(a) ||
                        /^assets:(receivables|accounts-receivable|inventory)(:|$)/.test(
                          a,
                        ) ||
                        /^liabilities:(payables|accounts-payable|sales-tax|payroll)(:|$)/.test(
                          a,
                        )
                      ? "Operating"
                      : "Unclassified cash movement";
          groups.set(label, (groups.get(label) ?? new Decimal(0)).minus(v));
        }
        const imbalance = sum(tb, () => true);
        if (!imbalance.isZero())
          groups.set(
            "Currency / valuation difference",
            (
              groups.get("Currency / valuation difference") ?? new Decimal(0)
            ).plus(imbalance),
          );
      }
      const opening = sum(
          balances(
            books.transactions.filter((t) => t.date < p.start),
            p.currency,
          ),
          isCash,
        ),
        change = sum(b, isCash);
      r.rows = [
        ["Opening cash", amount(opening)],
        ...[...groups].map(([a, v]) => [a, amount(v)]),
        ["Net change including opening entries", amount(change)],
        ["Closing cash", amount(opening.plus(change))],
      ];
      r.notes.push(
        "Cash accounts use assets:bank, assets:cash, assets:checking, or assets:savings. Counterpart accounts determine activity groups. Internal cash transfers net to zero; opening entries are shown separately. Review mixed and nonstandard account classifications.",
      );
      break;
    }
    case "budget":
      r.columns = ["Account", "Budget", "Actual", "Actual minus budget"];
      r.rows = workspace.budgets
        .filter(
          (x) =>
            x.start === p.start && x.end === p.end && x.currency === p.currency,
        )
        .map((x) => {
          const actual = (b.get(x.account) ?? new Decimal(0)).times(
            under(x.account, "income") ? -1 : 1,
          );
          return [
            x.account,
            amount(x.amount),
            amount(actual),
            amount(actual.minus(x.amount)),
          ];
        });
      r.notes.push(
        "Budgets apply to exact accounts and exact date ranges. Add a budget in Supporting schedules; amounts are not prorated. Positive expense variance is over budget.",
      );
      break;
    case "ar-aging":
    case "ap-aging": {
      r.subtitle = `As of ${p.end} · ${p.currency} · Manually maintained outstanding items`;
      r.columns = [
        "Customer / vendor",
        "Reference",
        "Due date",
        "Current",
        "1–30 days",
        "31–60 days",
        "61–90 days",
        "Over 90",
        "Total",
      ];
      const rows = workspace.schedules.filter(
        (x) =>
          x.kind === (id === "ar-aging" ? "invoice" : "bill") &&
          x.as_of === p.end &&
          x.currency === p.currency,
      );
      for (const x of rows) {
        const days = Math.floor(
          (Date.parse(p.end) - Date.parse(x.due || x.date)) / 86400000,
        );
        const bucket =
          days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
        const values = Array.from({ length: 5 }, (_, i) =>
          i === bucket ? amount(x.amount) : "0.00",
        );
        r.rows.push([
          x.name,
          x.reference,
          x.due || x.date,
          ...values,
          amount(x.amount),
        ]);
      }
      r.notes.push(
        "Enter outstanding balances as of the exact report end date, including partial payments. Other snapshot dates are excluded. Schedules do not create ledger postings; reconcile totals to the receivables/payables accounts.",
      );
      break;
    }
    case "asset-register":
    case "inventory":
    case "contractors": {
      const kind =
        id === "asset-register"
          ? "asset"
          : id === "inventory"
            ? "inventory"
            : "contractor";
      r.columns = ["Name", "Reference", "Date", "As of", "Amount", "Notes"];
      r.rows = workspace.schedules
        .filter(
          (x) =>
            x.kind === kind &&
            x.currency === p.currency &&
            (kind === "contractor"
              ? x.date >= p.start && x.date <= p.end
              : x.as_of === p.end),
        )
        .map((x) => [
          x.name,
          x.reference,
          x.date,
          x.as_of,
          amount(x.amount),
          x.notes,
        ]);
      r.notes.push(
        kind === "contractor"
          ? "Supporting payments only, not a 1099 eligibility determination. Confirm W-9, recipient type, payment method, and the selected tax year rules."
          : "Supporting schedule uses the exact report end date. Enter asset cost or inventory carrying value; amounts are not automatic tax deductions or depreciation.",
      );
      break;
    }
    default: {
      const tests: Partial<Record<ReportId, RegExp>> = {
        receivables: /^assets:(receivables|accounts-receivable)(:|$)/,
        payables: /^liabilities:(payables|accounts-payable)(:|$)/,
        debts:
          /^liabilities:(loans?|credit-card|credit-cards|vehicle-loan|mortgage)(:|$)/,
        payroll:
          /^(expenses:(payroll|wages|salaries|employee-benefits|payroll-processing-fees)|liabilities:payroll|equity:needs-review:payroll[^:]*)(:|$)/,
        "sales-tax": /^liabilities:(sales-tax|taxes:sales)(:|$)/,
        assets: /^assets:(fixed-assets|equipment|vehicles|property)(:|$)/,
        equity: /^equity(?::|$)/,
      };
      const filter = (a: string) => !!tests[id]?.test(a);
      const asof = ["receivables", "payables", "debts", "assets"].includes(id);
      r.columns = [
        "Account",
        asof ? "Balance (debit positive)" : "Period movement (debit positive)",
      ];
      r.rows = list(asof ? closing : b, filter);
      if (asof) r.subtitle = `As of ${p.end} · ${p.currency}`;
      r.notes.push(
        "Account names determine inclusion. This report is a ledger summary; invoices, payroll filings, tax returns, asset depreciation, and debt amortization need their supporting records.",
      );
      break;
    }
  }
  return r;
}
export const escapeHtml = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function reportCsv(report: Report) {
  const quote = (s: string) =>
    '"' +
    (/^[\s]*[=+@-]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)
      ? "'" + s
      : s
    ).replace(/"/g, '""') +
    '"';
  return [
    [report.title],
    [report.subtitle],
    ...report.notes.map((n) => ["Note", n]),
    [],
    report.columns,
    ...report.rows,
  ]
    .map((row) => row.map(quote).join(","))
    .join("\r\n");
}
export function reportHtml(company: string, reports: Report[]) {
  const e = escapeHtml;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(company)} — Booky reports</title><style>body{font:14px system-ui;color:#203d34;margin:40px}h1{font-size:28px}h2{margin-top:32px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{text-align:left;padding:9px;border-bottom:1px solid #ddd;overflow-wrap:anywhere}th{background:#eef5f1}p,li{line-height:1.5}section{break-before:page}section:first-of-type{break-before:auto}tr{break-inside:avoid}@media print{body{margin:0}button{display:none}thead{display:table-header-group}}</style></head><body><h1>${e(company)}</h1><p>Booky · Prepared ${e(new Date().toISOString().slice(0, 10))} · Draft records for review</p>${reports.map((r) => `<section><h2>${e(r.title)}</h2><p>${e(r.subtitle)}</p><ul>${r.notes.map((n) => `<li>${e(n)}</li>`).join("")}</ul><table><thead><tr>${r.columns.map((c) => `<th>${e(c)}</th>`).join("")}</tr></thead><tbody>${r.rows.length ? r.rows.map((row) => `<tr>${row.map((c) => `<td>${e(c)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${r.columns.length}">No matching records. Check data coverage and supporting schedules.</td></tr>`}</tbody></table></section>`).join("")}</body></html>`;
}
