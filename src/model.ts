import Decimal from "decimal.js";
Decimal.set({ precision: 300 });
export interface Amount {
  quantity: string;
  commodity: string;
}
export interface Account {
  name: string;
  amounts: Amount[];
}
export interface Posting {
  account: string;
  amounts: Amount[];
}
export interface Transaction {
  date: string;
  description: string;
  postings: Posting[];
}
export interface CompanyDetails {
  name: string;
  currency: string;
}
export interface Snapshot {
  office?: { address: string; name: string; role: "reader" | "editor" };
  company?: CompanyDetails | null;
  path: string;
  revision: string;
  version: string;
  accounts: Account[];
  transactions: Transaction[];
}
export interface Entry {
  date: string;
  description: string;
  debit: string;
  credit: string;
  amount: string;
  commodity: string;
}
export function formatAmount(a: Amount): string {
  const value = new Decimal(a.quantity);
  const [integer, fraction] = value
    .abs()
    .toFixed(Math.max(2, value.decimalPlaces()))
    .split(".");
  return `${value.isNegative() ? "−" : ""}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? "." + fraction : ""}${a.commodity ? " " + a.commodity : ""}`;
}
export function totals(
  accounts: Account[],
  prefixes: string[],
  invert = false,
): Amount[] {
  const sums = new Map<string, Decimal>();
  accounts
    .filter((a) =>
      prefixes.some((p) => a.name === p || a.name.startsWith(p + ":")),
    )
    .forEach((a) =>
      a.amounts.forEach((v) => {
        sums.set(
          v.commodity,
          (sums.get(v.commodity) ?? new Decimal(0)).plus(v.quantity),
        );
      }),
    );
  return Array.from(sums, ([commodity, value]) => ({
    commodity,
    quantity: (invert ? value.negated() : value).toFixed(),
  }));
}
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
