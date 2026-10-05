import Decimal from "decimal.js";
import type { Snapshot } from "./model.ts";
import {
  amount,
  balances,
  sum,
  under,
  isReview,
  validDate,
  type Report,
} from "./reports.ts";
Decimal.set({ precision: 300 });
export type FilingStatus = "unknown" | "single" | "joint" | "separate" | "head";
export type Jurisdiction = "federal" | "oklahoma";
export interface TaxPayment {
  id: string;
  jurisdiction: Jurisdiction;
  date: string;
  amount: string;
  note: string;
}
export interface EstimateSettings {
  filing_status: FilingStatus;
  state: "none" | "OK";
  ok_resident: boolean;
  profit_source: "ledger" | "annualized" | "manual";
  through: string;
  annual_profit: string;
  wages: string;
  ss_wages: string;
  medicare_wages: string;
  other_income: string;
  agi_deductions: string;
  deduction_mode: "standard" | "custom";
  federal_deduction: string;
  qbi_deduction: string;
  other_deduction: string;
  federal_credits: string;
  refundable_credits: string;
  federal_other_tax: string;
  federal_withholding: string;
  prior_federal_tax: string;
  prior_agi: string;
  prior_federal_eligible: boolean;
  ok_adjustment: string;
  ok_deduction: string;
  ok_exemptions: string;
  ok_credits: string;
  ok_withholding: string;
  prior_ok_tax: string;
  prior_ok_eligible: boolean;
  payment_goal: "minimum" | "full";
  as_of: string;
  due_dates: Record<string, string>;
  payments: TaxPayment[];
}
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export function estimateDefaults(year: string): EstimateSettings {
  const today = localToday();
  return {
    filing_status: "unknown",
    state: "none",
    ok_resident: true,
    profit_source: "ledger",
    through:
      today < year + "-01-01"
        ? year + "-01-01"
        : today > year + "-12-31"
          ? year + "-12-31"
          : today,
    annual_profit: "",
    wages: "0",
    ss_wages: "0",
    medicare_wages: "0",
    other_income: "0",
    agi_deductions: "0",
    deduction_mode: "standard",
    federal_deduction: "",
    qbi_deduction: "0",
    other_deduction: "0",
    federal_credits: "0",
    refundable_credits: "0",
    federal_other_tax: "0",
    federal_withholding: "0",
    prior_federal_tax: "",
    prior_agi: "",
    prior_federal_eligible: false,
    ok_adjustment: "0",
    ok_deduction: "",
    ok_exemptions: "1",
    ok_credits: "0",
    ok_withholding: "0",
    prior_ok_tax: "",
    prior_ok_eligible: false,
    payment_goal: "minimum",
    as_of: today,
    due_dates: {},
    payments: [],
  };
}
export const filingLabels: Record<FilingStatus, string> = {
  unknown: "Choose filing status",
  single: "Single",
  joint: "Married filing jointly",
  separate: "Married filing separately",
  head: "Head of household",
};
export const taxSources = [
  ["2026 federal estimates", "https://www.irs.gov/pub/irs-pdf/f1040es.pdf"],
  ["2025 federal brackets", "https://www.irs.gov/irb/2024-45_IRB"],
  [
    "Updated 2025–2026 standard deductions",
    "https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill",
  ],
  ["Self-employment tax", "https://www.irs.gov/instructions/i1040sse"],
  ["Additional Medicare tax", "https://www.irs.gov/taxtopics/tc560"],
  [
    "Oklahoma estimated payments",
    "https://oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/OW-8-ES.pdf",
  ],
  [
    "Oklahoma 2025 rates",
    "https://oklahoma.gov/tax/individuals/pay-taxes.html",
  ],
  [
    "Oklahoma 2026 rate changes",
    "https://oklahoma.gov/content/dam/ok/en/tax/documents/resources/publications/legislation/2025LegislativeUpdate.pdf",
  ],
  [
    "Oklahoma deductions and exemptions",
    "https://oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/511-Pkt.pdf",
  ],
  [
    "2025 Oklahoma disaster relief",
    "https://oklahoma.gov/tax/newsroom/2025/09-30-2025.html",
  ],
] as const;
type KnownStatus = Exclude<FilingStatus, "unknown">;
export const federalRules: Record<
  string,
  {
    standard: Record<KnownStatus, number>;
    brackets: Record<KnownStatus, number[]>;
    ssCap: number;
  }
> = {
  "2025": {
    standard: { single: 15750, joint: 31500, separate: 15750, head: 23625 },
    ssCap: 176100,
    brackets: {
      single: [11925, 48475, 103350, 197300, 250525, 626350],
      joint: [23850, 96950, 206700, 394600, 501050, 751600],
      separate: [11925, 48475, 103350, 197300, 250525, 375800],
      head: [17000, 64850, 103350, 197300, 250500, 626350],
    },
  },
  "2026": {
    standard: { single: 16100, joint: 32200, separate: 16100, head: 24150 },
    ssCap: 184500,
    brackets: {
      single: [12400, 50400, 105700, 201775, 256225, 640600],
      joint: [24800, 100800, 211400, 403550, 512450, 768700],
      separate: [12400, 50400, 105700, 201775, 256225, 384350],
      head: [17700, 67450, 105700, 201750, 256200, 640600],
    },
  },
};
const zero = (v: Decimal.Value) => Decimal.max(0, v);
const cents = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export function progressiveTax(
  income: Decimal.Value,
  bounds: number[],
  rates: string[],
) {
  let result = new Decimal(0),
    lower = new Decimal(0),
    n = zero(income);
  for (let i = 0; i < rates.length; i++) {
    const upper = bounds[i] === undefined ? n : new Decimal(bounds[i]);
    result = result.plus(
      zero(Decimal.min(n, upper).minus(lower)).times(rates[i]),
    );
    lower = upper;
    if (n.lte(upper)) break;
  }
  return cents(result);
}
export function oklahomaTax(
  taxable: Decimal.Value,
  year: string,
  status: KnownStatus,
) {
  const factor = status === "joint" || status === "head" ? 2 : 1;
  return progressiveTax(
    taxable,
    (year === "2025" ? [1000, 2500, 3750, 4900, 7200] : [3750, 4900, 7200]).map(
      (x) => x * factor,
    ),
    year === "2025"
      ? [".0025", ".0075", ".0175", ".0275", ".0375", ".0475"]
      : ["0", ".025", ".035", ".045"],
  );
}
const numericFields = [
  "wages",
  "ss_wages",
  "medicare_wages",
  "other_income",
  "agi_deductions",
  "qbi_deduction",
  "other_deduction",
  "federal_credits",
  "refundable_credits",
  "federal_other_tax",
  "federal_withholding",
  "ok_exemptions",
  "ok_credits",
  "ok_withholding",
] as const;
export function validateEstimate(s: EstimateSettings, year: string) {
  if (!federalRules[year])
    throw Error("Automatic estimates are available for 2025 and 2026 only.");
  if (s.filing_status === "unknown")
    throw Error("Choose your personal filing status to calculate estimates.");
  for (const key of numericFields)
    if (!/^\d+(\.\d{1,2})?$/.test(s[key]) || s[key].length > 18)
      throw Error(
        `Enter a nonnegative amount with at most two decimal places for ${key.replace(/_/g, " ")}.`,
      );
  for (const key of [
    "federal_deduction",
    "ok_deduction",
    "prior_federal_tax",
    "prior_agi",
    "prior_ok_tax",
  ] as const)
    if (
      s[key] !== "" &&
      (!/^\d+(\.\d{1,2})?$/.test(s[key]) || s[key].length > 18)
    )
      throw Error(`Check ${key.replace(/_/g, " ")}.`);
  if (!/^-?\d+(\.\d{1,2})?$/.test(s.ok_adjustment))
    throw Error("Check Oklahoma income adjustments.");
  if (!/^\d+$/.test(s.ok_exemptions) || Number(s.ok_exemptions) > 100)
    throw Error("Use a whole number from 0 to 100 for Oklahoma exemptions.");
  if (!validDate(s.as_of)) throw Error("Choose a valid payment snapshot date.");
  if (s.profit_source === "manual") {
    if (
      !/^-?\d+(\.\d{1,2})?$/.test(s.annual_profit) ||
      s.annual_profit.length > 18
    )
      throw Error(
        "Enter projected annual Schedule C profit, including zero if appropriate.",
      );
  } else if (!validDate(s.through) || !s.through.startsWith(year + "-"))
    throw Error("Choose a profit-through date within the selected tax year.");
  if (
    s.deduction_mode === "custom" &&
    (!s.federal_deduction ||
      (s.state === "OK" && s.ok_resident && !s.ok_deduction))
  )
    throw Error(
      "Enter reviewed federal and Oklahoma deductions when overriding the standard deduction.",
    );
  for (const j of ["federal", "oklahoma"] as const) {
    let previous = year + "-01-01";
    for (let q = 0; q < 4; q++) {
      const due = dueDate(s, year, j, q);
      if (!validDate(due) || due < previous)
        throw Error("Quarterly due dates must be valid and in order.");
      previous = due;
    }
  }
  for (const pay of s.payments)
    if (
      !validDate(pay.date) ||
      pay.date < year + "-01-01" ||
      !/^\d+(\.\d{1,2})?$/.test(pay.amount) ||
      new Decimal(pay.amount).lte(0)
    )
      throw Error("Check payment dates and positive payment amounts.");
}
export function dueDate(
  s: EstimateSettings,
  year: string,
  j: Jurisdiction,
  q: number,
) {
  return (
    s.due_dates[`${j}_${q + 1}`] ||
    [
      year + "-04-15",
      year + (year === "2025" ? "-06-16" : "-06-15"),
      year + "-09-15",
      Number(year) + 1 + "-01-15",
    ][q]
  );
}
export function projectedProfit(
  books: Snapshot,
  s: EstimateSettings,
  year: string,
) {
  if (s.profit_source === "manual") return new Decimal(s.annual_profit);
  const tx = books.transactions.filter(
    (t) => t.date >= year + "-01-01" && t.date <= s.through,
  );
  if (
    !tx.some((t) =>
      t.postings.some(
        (p) =>
          (under(p.account, "income") || under(p.account, "expenses")) &&
          p.amounts.some((a) => a.commodity === "USD"),
      ),
    )
  )
    throw Error(
      "No USD income or expense records for this year through that date. Enter a forecast or import current-year records.",
    );
  const b = balances(tx, "USD");
  let profit = sum(
    b,
    (a) => under(a, "income") || under(a, "expenses"),
  ).negated();
  if (s.profit_source === "annualized") {
    const days =
        (Date.parse(s.through) - Date.parse(year + "-01-01")) / 86400000 + 1,
      total =
        (Date.parse(Number(year) + 1 + "-01-01") -
          Date.parse(year + "-01-01")) /
        86400000;
    profit = profit.times(total).div(days);
  }
  return cents(profit);
}
export interface Quarter {
  quarter: number;
  due: string;
  target: Decimal;
  cumulative: Decimal;
  paid: Decimal;
  gap: Decimal;
  past: boolean;
}
export interface PaymentPlan {
  tax: Decimal;
  withholding: Decimal;
  target: Decimal;
  paid: Decimal;
  balance: Decimal;
  minimum: Decimal;
  quarters: Quarter[];
  method: string;
}
function makePlan(
  tax: Decimal,
  withholding: Decimal,
  minimum: Decimal,
  method: string,
  s: EstimateSettings,
  year: string,
  j: Jurisdiction,
): PaymentPlan {
  const target = cents(
    s.payment_goal === "full" ? zero(tax.minus(withholding)) : minimum,
  );
  const payments = s.payments.filter(
      (p) => p.jurisdiction === j && p.date <= s.as_of,
    ),
    paid = cents(payments.reduce((n, p) => n.plus(p.amount), new Decimal(0)));
  const quarters = Array.from({ length: 4 }, (_, q) => {
    const due = dueDate(s, year, j, q),
      cutoff = due < s.as_of ? due : s.as_of;
    const cumulative = cents(target.times(q + 1).div(4));
    const previous = cents(target.times(q).div(4));
    const paid = payments
      .filter((p) => p.date <= cutoff)
      .reduce((n, p) => n.plus(p.amount), new Decimal(0));
    return {
      quarter: q + 1,
      due,
      target: cumulative.minus(previous),
      cumulative,
      paid: cents(paid),
      gap: zero(cumulative.minus(paid)),
      past: due < s.as_of,
    };
  });
  return {
    tax,
    withholding,
    target,
    minimum,
    method,
    paid,
    balance: cents(tax.minus(withholding).minus(paid)),
    quarters,
  };
}
export function estimateTax(
  books: Snapshot,
  year: string,
  s: EstimateSettings,
) {
  validateEstimate(s, year);
  const status = s.filing_status as KnownStatus,
    rules = federalRules[year];
  const profit = projectedProfit(books, s, year),
    netSE = zero(profit).times(".9235"),
    seBase = netSE.lt(400) ? new Decimal(0) : netSE;
  const ss = cents(
      Decimal.min(
        seBase,
        zero(new Decimal(rules.ssCap).minus(s.ss_wages)),
      ).times(".124"),
    ),
    medicare = cents(seBase.times(".029")),
    se = ss.plus(medicare),
    halfSE = cents(se.div(2));
  const additionalMedicare = cents(
    zero(
      new Decimal(s.medicare_wages)
        .plus(seBase)
        .minus(
          status === "joint" ? 250000 : status === "separate" ? 125000 : 200000,
        ),
    ).times(".009"),
  );
  const agi = profit
    .plus(s.wages)
    .plus(s.other_income)
    .minus(halfSE)
    .minus(s.agi_deductions);
  const deduction = new Decimal(
    s.deduction_mode === "custom"
      ? s.federal_deduction
      : rules.standard[status],
  );
  const taxable = zero(
    agi.minus(deduction).minus(s.qbi_deduction).minus(s.other_deduction),
  );
  const incomeTax = progressiveTax(taxable, rules.brackets[status], [
    ".10",
    ".12",
    ".22",
    ".24",
    ".32",
    ".35",
    ".37",
  ]);
  const netFederal = zero(incomeTax.minus(s.federal_credits))
    .plus(se)
    .plus(additionalMedicare)
    .plus(s.federal_other_tax)
    .minus(s.refundable_credits);
  const fedTax = cents(netFederal),
    withholding = new Decimal(s.federal_withholding);
  let fedBase = zero(fedTax).times(".90"),
    fedMethod = "90% of current-year estimate";
  if (
    s.prior_federal_eligible &&
    s.prior_federal_tax !== "" &&
    s.prior_agi !== ""
  ) {
    const rate = new Decimal(s.prior_agi).gt(
      status === "separate" ? 75000 : 150000,
    )
      ? "1.10"
      : "1";
    const prior = new Decimal(s.prior_federal_tax).times(rate);
    if (prior.lte(fedBase)) {
      fedBase = prior;
      fedMethod = `${rate === "1" ? "100%" : "110%"} of entered prior-year tax`;
    }
  }
  const fedMinimum = cents(
    fedTax.minus(withholding).lt(1000)
      ? new Decimal(0)
      : zero(fedBase.minus(withholding)),
  );
  const federal = makePlan(
    fedTax,
    withholding,
    fedMinimum,
    fedMethod,
    s,
    year,
    "federal",
  );
  let oklahoma: PaymentPlan | null = null,
    okTaxable: Decimal | null = null;
  if (s.state === "OK" && s.ok_resident) {
    const deduction = new Decimal(
      s.ok_deduction !== ""
        ? s.ok_deduction
        : status === "joint"
          ? 12700
          : status === "head"
            ? 9350
            : 6350,
    );
    okTaxable = zero(
      agi
        .plus(s.ok_adjustment)
        .minus(deduction)
        .minus(new Decimal(s.ok_exemptions).times(1000)),
    );
    const tax = zero(oklahomaTax(okTaxable, year, status).minus(s.ok_credits)),
      withholding = new Decimal(s.ok_withholding);
    let base = tax.times(".70"),
      method = "70% of current-year estimate";
    if (
      s.prior_ok_eligible &&
      s.prior_ok_tax !== "" &&
      new Decimal(s.prior_ok_tax).lte(base)
    ) {
      base = new Decimal(s.prior_ok_tax);
      method = "100% of entered prior-year Oklahoma tax";
    }
    const minimum = cents(
      tax.minus(withholding).lt(500)
        ? new Decimal(0)
        : zero(base.minus(withholding)),
    );
    oklahoma = makePlan(
      cents(tax),
      withholding,
      minimum,
      method,
      s,
      year,
      "oklahoma",
    );
  }
  const pending = books.transactions.filter(
    (t) =>
      t.date.startsWith(year + "-") &&
      t.postings.some((p) => isReview(p.account)),
  ).length;
  const warnings = [
    "Planning estimate in USD. Amounts use progressive rate schedules; filed-return tax tables and rounding can differ.",
    "Other income, deductions, credits, and withholding are assumed to be the values entered below. Review zero defaults. Business profit alone is not your complete personal return.",
    "QBI and special deductions are included only when you enter reviewed amounts. Capital-gain rates, AMT, NIIT, loss limitations, spouse self-employment, and special tax regimes are not calculated automatically.",
    "Quarterly amounts use equal installments and assume withholding is spread evenly. This is not the IRS annualized-income installment method or a penalty calculation. Later catch-up payments do not erase an earlier shortfall.",
  ];
  if (pending)
    warnings.unshift(
      `${pending} transactions in ${year} still need classification. This estimate is provisional and may change materially.`,
    );
  if (s.profit_source === "annualized")
    warnings.push(
      "Straight-line forecast assumes records are complete from January 1 through the chosen date and the same profit pace continues.",
    );
  if (s.profit_source === "ledger")
    warnings.push(
      "Recorded-profit mode does not forecast additional profit after the chosen date. Tax workspace adjustments are not applied automatically; use a reviewed annual Schedule C profit forecast if needed.",
    );
  if (
    !s.prior_federal_eligible ||
    s.prior_federal_tax === "" ||
    s.prior_agi === ""
  )
    warnings.push(
      "Prior-year federal safe harbor is unavailable until qualifying prior-year tax and AGI are entered. The current-year target depends on forecast accuracy.",
    );
  if (s.state === "OK")
    warnings.push(
      s.ok_resident
        ? "Oklahoma estimate assumes full-year residency and all income taxable in Oklahoma, with entered adjustments. It does not handle other-state credits or part-year allocation."
        : "Oklahoma estimate is unavailable until full-year resident assumptions are confirmed.",
    );
  if (year === "2025" && s.state === "OK")
    warnings.push(
      "Certain Oklahoma counties qualified for postponed 2025 payment deadlines. Confirm eligibility and enter applicable due-date overrides; relief is not assumed automatically.",
    );
  if (new Decimal(s.qbi_deduction).isZero() && profit.gt(0))
    warnings.push(
      "No qualified business income deduction is included. Enter a reviewed QBI deduction if eligible.",
    );
  if (s.profit_source === "manual")
    warnings.push(
      "The annual profit forecast replaces recorded profit; it is not added to it.",
    );
  return {
    profit,
    netSE: seBase,
    ss,
    medicare,
    se,
    halfSE,
    additionalMedicare,
    agi,
    deduction,
    taxable,
    incomeTax,
    okTaxable,
    federal,
    oklahoma,
    pending,
    warnings,
  };
}
export type EstimateResult = ReturnType<typeof estimateTax>;
export function estimateReports(
  books: Snapshot,
  year: string,
  s: EstimateSettings,
): Report[] {
  const e = estimateTax(books, year, s);
  const title = `${year} tax estimate · ${filingLabels[s.filing_status]}`;
  const summary: Report = {
    title,
    subtitle: `USD · Payment snapshot ${s.as_of} · Draft planning estimate`,
    columns: ["Item", "Amount / setting"],
    rows: [
      ["Projected Schedule C profit", amount(e.profit)],
      ["Federal adjusted gross income", amount(e.agi)],
      ["Federal taxable income", amount(e.taxable)],
      ["Federal income tax before credits", amount(e.incomeTax)],
      ["Self-employment tax", amount(e.se)],
      ["Additional Medicare tax", amount(e.additionalMedicare)],
      ["Federal tax after entered credits", amount(e.federal.tax)],
      ["Oklahoma tax", e.oklahoma ? amount(e.oklahoma.tax) : "Not estimated"],
      ["Federal projected balance / (overpayment)", amount(e.federal.balance)],
      [
        "Oklahoma projected balance / (overpayment)",
        e.oklahoma ? amount(e.oklahoma.balance) : "Not estimated",
      ],
      [
        "Payment strategy",
        s.payment_goal === "full"
          ? "Full projected tax"
          : "Estimated minimum installment target",
      ],
    ],
    notes: [
      ...e.warnings,
      ...taxSources.map(([label, url]) => `${label}: ${url}`),
    ],
  };
  const plans: Report[] = (["federal", "oklahoma"] as const).flatMap((j) => {
    const plan = e[j];
    return plan
      ? [
          {
            title: `${j === "federal" ? "Federal" : "Oklahoma"} quarterly plan`,
            subtitle: `${year} · USD · ${plan.method}`,
            columns: [
              "Quarter",
              "Due",
              "Installment target",
              "Cumulative target",
              "Payments through cutoff",
              "Target gap",
            ],
            rows: plan.quarters.map((q) => [
              String(q.quarter),
              q.due,
              amount(q.target),
              amount(q.cumulative),
              amount(q.paid),
              amount(q.gap),
            ]),
            notes: [
              "Payments through cutoff include only dates through the earlier of the due date or payment snapshot date. These are plan comparisons, not penalty determinations.",
            ],
          },
        ]
      : [];
  });
  const payments: Report = {
    title: "Recorded estimated tax payments",
    subtitle: `Tax year ${year} · USD`,
    columns: ["Jurisdiction", "Date", "Amount", "Reference"],
    rows: s.payments.map((p) => [p.jurisdiction, p.date, p.amount, p.note]),
    notes: [
      "Manually recorded payments, not verified with tax authorities. Recording does not send money or post a journal entry. Future-dated records are excluded until the payment snapshot date.",
    ],
  };
  const inputs: Report = {
    title: "Estimate assumptions",
    subtitle: title,
    columns: ["Setting", "Value"],
    rows: Object.entries(s)
      .filter(([key]) => key !== "payments" && key !== "due_dates")
      .map(([key, v]) => [key.replace(/_/g, " "), String(v)]),
    notes: [
      "Rules verified October 4, 2026. Supported tax years: 2025 and 2026.",
    ],
  };
  return [summary, ...plans, payments, inputs];
}
