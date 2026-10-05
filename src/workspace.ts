import type { EstimateSettings } from "./estimates.ts";
import type { Snapshot } from "./model.ts";
export type Entity = "unknown" | "sole" | "s-corp" | "partnership" | "c-corp";
export interface Adjustment {
  id: string;
  description: string;
  amount: string;
  currency: string;
  direction: "increase" | "decrease";
}
export interface TaxYear {
  estimate?: EstimateSettings;
  entity: Entity;
  basis: string;
  jurisdiction: string;
  checks: Record<string, boolean>;
  mappings: Record<string, string>;
  adjustments: Adjustment[];
  notes: string;
}
export type ScheduleKind =
  "invoice" | "bill" | "asset" | "inventory" | "contractor";
export interface Schedule {
  id: string;
  kind: ScheduleKind;
  name: string;
  reference: string;
  date: string;
  due: string;
  as_of: string;
  amount: string;
  currency: string;
  notes: string;
}
export interface Budget {
  id: string;
  account: string;
  start: string;
  end: string;
  amount: string;
  currency: string;
}
export interface Workspace {
  version: number;
  tax_years: Record<string, TaxYear>;
  schedules: Schedule[];
  budgets: Budget[];
}
export const emptyWorkspace = (): Workspace => ({
  version: 1,
  tax_years: {},
  schedules: [],
  budgets: [],
});
export const emptyTaxYear = (): TaxYear => ({
  entity: "unknown",
  basis: "unknown",
  jurisdiction: "",
  checks: {},
  mappings: {},
  adjustments: [],
  notes: "",
});
export const latestYear = (books: Snapshot) =>
  books.transactions
    .map((t) => t.date.slice(0, 4))
    .sort()
    .slice(-1)[0] ?? String(new Date().getFullYear());
export const checkItems = [
  [
    "identity",
    "Confirm entity classification, tax year, accounting method, and filing jurisdictions",
  ],
  ["banks", "Reconcile every bank account and supply opening balances"],
  ["cards", "Import and reconcile business credit-card purchases and balances"],
  [
    "income",
    "Match receipts to invoices and processor statements, including fees",
  ],
  [
    "payroll",
    "Reconcile payroll journals, gross wages, withholdings, employer taxes, and filings",
  ],
  [
    "assets",
    "Review equipment, inventory, vehicle use, depreciation, and loan principal/interest",
  ],
  [
    "contractors",
    "Review contractor payments, W-9 records, payment methods, and information returns",
  ],
  [
    "sales-tax",
    "Reconcile sales-tax collections, payments, jurisdictions, and filings",
  ],
  [
    "owners",
    "Separate owner contributions, draws, distributions, and personal expenses",
  ],
  [
    "receipts",
    "Gather receipts, prior-year returns, estimated payments, and supporting documents",
  ],
  [
    "review",
    "Have the tax preparer review adjustments and state/local requirements",
  ],
] as const;
export const taxBuckets = [
  "Unmapped",
  "Gross receipts",
  "Other income",
  "Cost of goods sold",
  "Advertising",
  "Vehicle expenses",
  "Commissions and fees",
  "Contract labor",
  "Depreciation review",
  "Insurance",
  "Interest",
  "Legal and professional",
  "Office expenses",
  "Rent and lease",
  "Repairs and maintenance",
  "Supplies",
  "Taxes and licenses",
  "Travel",
  "Meals review",
  "Utilities",
  "Wages",
  "Employee benefits",
  "Other business expenses",
  "Nondeductible / personal",
  "Preparer review",
] as const;
export const entityLabels: Record<Entity, string> = {
  unknown: "Choose tax classification",
  sole: "Sole proprietor / single-member LLC",
  "s-corp": "S corporation",
  partnership: "Partnership",
  "c-corp": "C corporation",
};
export const formLinks: Record<Entity, { name: string; url: string }> = {
  unknown: {
    name: "Confirm federal classification",
    url: "https://www.irs.gov/businesses/small-businesses-self-employed/business-structures",
  },
  sole: {
    name: "Schedule C (Form 1040)",
    url: "https://www.irs.gov/forms-pubs/about-schedule-c-form-1040",
  },
  "s-corp": {
    name: "Form 1120-S",
    url: "https://www.irs.gov/forms-pubs/about-form-1120-s",
  },
  partnership: {
    name: "Form 1065",
    url: "https://www.irs.gov/forms-pubs/about-form-1065",
  },
  "c-corp": {
    name: "Form 1120",
    url: "https://www.irs.gov/forms-pubs/about-form-1120",
  },
};
