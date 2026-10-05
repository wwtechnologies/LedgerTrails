import { useState, type FormEvent } from "react";
import Decimal from "decimal.js";
import type { Snapshot } from "./model";
import { formatAmount, today } from "./model";
import type { TaxYear } from "./workspace";
import {
  estimateDefaults,
  estimateTax,
  estimateReports,
  filingLabels,
  taxSources,
  dueDate,
  type EstimateSettings,
  type Jurisdiction,
  type PaymentPlan,
} from "./estimates";
import { reportHtml } from "./reports";
import { exportFile } from "./useWorkspace";
const money = (value: Decimal) =>
  formatAmount({ quantity: value.toFixed(2), commodity: "USD" });
export default function TaxDashboard({
  books,
  year,
  tax,
  update,
  disabled,
  dirty,
  desktop,
}: {
  books: Snapshot;
  year: string;
  tax: TaxYear;
  update: (t: TaxYear) => void;
  disabled: boolean;
  dirty: boolean;
  desktop: boolean;
}) {
  const s = tax.estimate || estimateDefaults(year),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [exporting, setExporting] = useState(false);
  const change = (patch: Partial<EstimateSettings>) =>
    update({ ...tax, estimate: { ...s, ...patch } });
  let estimate: ReturnType<typeof estimateTax> | null = null,
    setup = "";
  try {
    if (tax.entity !== "sole")
      throw Error(
        "Automatic estimates currently support sole proprietors / single-member LLCs. Confirm this classification in Readiness.",
      );
    estimate = estimateTax(books, year, s);
  } catch (e) {
    setup = e instanceof Error ? e.message : String(e);
  }
  const field = (key: keyof EstimateSettings, label: string, hint?: string) => (
    <label key={key}>
      {label}
      <input
        aria-label={label}
        inputMode="decimal"
        value={String(s[key])}
        onChange={(e) => change({ [key]: e.target.value })}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
  async function download() {
    setError("");
    setNotice("");
    setExporting(true);
    try {
      if (
        await exportFile(
          books,
          desktop,
          `Booky-tax-estimate-${year}`,
          "html",
          reportHtml(
            books.company?.name || "Company",
            estimateReports(books, year, s),
          ),
        )
      )
        setNotice("Estimate and quarterly plan exported.");
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }
  function addPayment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    const amount = String(data.get("amount")),
      date = String(data.get("date"));
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || new Decimal(amount).lte(0)) {
      setError("Enter a positive payment amount with at most two decimals.");
      return;
    }
    if (date > today() || date < year + "-01-01") {
      setError(
        "Use the actual date of a payment for this tax year, not a future date.",
      );
      return;
    }
    setError("");
    change({
      payments: [
        ...s.payments,
        {
          id: crypto.randomUUID(),
          jurisdiction: data.get("jurisdiction") as Jurisdiction,
          date,
          amount,
          note: String(data.get("note")),
        },
      ],
    });
    form.reset();
  }
  const plan = (p: PaymentPlan, j: Jurisdiction) => {
    const next = p.quarters.find((q) => !q.past),
      name = j === "federal" ? "Federal" : "Oklahoma";
    return (
      <section className="quarter-plan" key={j}>
        <div className="quarter-heading">
          <div>
            <h3>{name} quarterly plan</h3>
            <p>
              {s.payment_goal === "minimum"
                ? p.method
                : "Full projected annual tax"}{" "}
              · annual installments {money(p.target)}
            </p>
          </div>
          <div>
            <small>
              {next
                ? `Target gap by ${next.due}`
                : "All installment dates have passed"}
            </small>
            <strong>
              {next
                ? money(next.gap)
                : money(Decimal.max(0, p.target.minus(p.paid)))}
            </strong>
          </div>
        </div>
        <p className="muted">
          {next
            ? "Target gap includes unpaid earlier installments."
            : "Shown amount is the remaining annual installment-plan gap."}{" "}
          It is not a penalty determination.
        </p>
        <div className="report-scroll">
          <table>
            <thead>
              <tr>
                <th>Quarter / due date</th>
                <th>Installment target</th>
                <th>Cumulative target</th>
                <th>Paid by cutoff</th>
                <th>Target gap</th>
              </tr>
            </thead>
            <tbody>
              {p.quarters.map((q) => (
                <tr key={q.quarter}>
                  <td>
                    Q{q.quarter}
                    <small>
                      {q.due}
                      {q.past ? " · past date" : ""}
                    </small>
                  </td>
                  <td>{money(q.target)}</td>
                  <td>{money(q.cumulative)}</td>
                  <td>{money(q.paid)}</td>
                  <td>{money(q.gap)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="quarter-reserve">
          Additional tax beyond the annual installment plan:{" "}
          <b>
            {money(Decimal.max(0, p.tax.minus(p.withholding).minus(p.target)))}
          </b>
        </p>
      </section>
    );
  };
  return (
    <div className="tax-dashboard">
      <div className="estimate-heading">
        <div>
          <span className="eyebrow">AT A GLANCE</span>
          <h2>Your tax outlook</h2>
          <p>{year} · USD · Draft estimate based on entered assumptions</p>
        </div>
        <button
          className="secondary"
          disabled={disabled || !estimate || dirty || exporting}
          onClick={download}
        >
          Export estimate & payment plan
        </button>
      </div>
      {setup && (
        <p className="estimate-setup" role="status">
          {setup}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="estimate-cards">
        {[
          [
            "Projected federal tax",
            estimate?.federal.tax,
            "Income tax, self-employment, other entered taxes, less credits",
          ],
          [
            "Projected Oklahoma tax",
            estimate?.oklahoma?.tax,
            s.state === "OK"
              ? "Full-year resident estimate"
              : "Select Oklahoma to include state tax",
          ],
          [
            "Federal balance at filing",
            estimate?.federal.balance,
            "After entered annual withholding and payments recorded by snapshot date",
          ],
          [
            "Oklahoma balance at filing",
            estimate?.oklahoma?.balance,
            "After entered annual withholding and payments recorded by snapshot date",
          ],
        ].map(([label, value, help]) => (
          <section className="estimate-card" key={String(label)}>
            <span>{String(label)}</span>
            <strong>{value instanceof Decimal ? money(value) : "—"}</strong>
            <small>{String(help)}</small>
          </section>
        ))}
      </div>
      {estimate && (
        <>
          <p className="estimate-caveat">
            Positive balances are projected amounts still to cover; negative
            balances are projected overpayments. Future quarterly payments are
            not yet subtracted.
          </p>
          <div className="estimate-breakdown">
            <span>
              Schedule C forecast <b>{money(estimate.profit)}</b>
            </span>
            <span>
              Self-employment tax <b>{money(estimate.se)}</b>
            </span>
            <span>
              Federal taxable income <b>{money(estimate.taxable)}</b>
            </span>
            <span>
              Payments recorded{" "}
              <b>
                {money(
                  estimate.federal.paid.plus(estimate.oklahoma?.paid || 0),
                )}
              </b>
            </span>
          </div>
          {estimate.pending > 0 && (
            <div className="estimate-setup">
              <strong>Incomplete books</strong>
              <p>
                {estimate.pending} transactions still need classification.
                Resolve these before relying on the projected amounts.
              </p>
            </div>
          )}
        </>
      )}
      <fieldset disabled={disabled}>
        <legend>Forecast and payment strategy</legend>
        <div className="field-grid">
          <label>
            Personal filing status
            <select
              value={s.filing_status}
              onChange={(e) =>
                change({
                  filing_status: e.target
                    .value as EstimateSettings["filing_status"],
                })
              }
            >
              {Object.entries(filingLabels).map(([v, label]) => (
                <option value={v} key={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            State estimate
            <select
              value={s.state}
              onChange={(e) =>
                change({ state: e.target.value as EstimateSettings["state"] })
              }
            >
              <option value="none">Federal only</option>
              <option value="OK">Oklahoma</option>
            </select>
          </label>
          <label>
            Profit forecast method
            <select
              value={s.profit_source}
              onChange={(e) =>
                change({
                  profit_source: e.target
                    .value as EstimateSettings["profit_source"],
                })
              }
            >
              <option value="ledger">
                Recorded profit, no growth forecast
              </option>
              <option value="annualized">
                Straight-line forecast from year to date
              </option>
              <option value="manual">Enter annual Schedule C profit</option>
            </select>
          </label>
          {s.profit_source === "manual" ? (
            field(
              "annual_profit",
              "Projected annual Schedule C profit",
              "Enter the full annual profit, not additional profit.",
            )
          ) : (
            <label>
              Records through
              <input
                type="date"
                min={year + "-01-01"}
                max={year + "-12-31"}
                value={s.through}
                onChange={(e) => change({ through: e.target.value })}
              />
            </label>
          )}
          <label>
            Quarterly payment goal
            <select
              value={s.payment_goal}
              onChange={(e) =>
                change({
                  payment_goal: e.target
                    .value as EstimateSettings["payment_goal"],
                })
              }
            >
              <option value="minimum">
                Estimated minimum installment target
              </option>
              <option value="full">Cover full projected annual tax</option>
            </select>
          </label>
          <label>
            Payment snapshot date
            <input
              type="date"
              value={s.as_of}
              onChange={(e) => change({ as_of: e.target.value })}
            />
            <small>Payments after this date are excluded from balances.</small>
          </label>
        </div>
        <p>
          Profit forecasts use this company’s USD income and expense accounts.
          Tax adjustment worksheets are not automatically added; enter a
          reviewed Schedule C forecast when needed.
        </p>
      </fieldset>
      {estimate && (
        <div>
          {plan(estimate.federal, "federal")}
          {estimate.oklahoma && plan(estimate.oklahoma, "oklahoma")}
        </div>
      )}
      <details className="estimate-inputs" open>
        <summary>Personal income, deductions, credits & withholding</summary>
        <fieldset disabled={disabled}>
          <p>
            Use annual amounts for the whole return. Zero is an assumption, not
            a value Booky verified. For joint returns, include both spouses’
            taxable wages and Medicare wages, but only the business owner’s
            Social Security wages.
          </p>
          <div className="field-grid">
            {field(
              "wages",
              "Annual taxable W-2 wages",
              "Form W-2 box 1; household total on a joint return.",
            )}
            {field(
              "ss_wages",
              "Owner wages subject to Social Security",
              "Owner’s W-2 box 3; used to avoid taxing earnings over the annual cap twice.",
            )}
            {field(
              "medicare_wages",
              "Annual Medicare wages",
              "W-2 box 5; combined on a joint return.",
            )}
            {field(
              "other_income",
              "Other ordinary income",
              "Excludes capital gains and qualified dividends, which need a separate calculation.",
            )}
            {field(
              "agi_deductions",
              "Other adjustments to income",
              "Reviewed Schedule 1 deductions, excluding the automatically calculated half of SE tax.",
            )}
            <label>
              Federal deduction method
              <select
                value={s.deduction_mode}
                onChange={(e) =>
                  change({
                    deduction_mode: e.target
                      .value as EstimateSettings["deduction_mode"],
                  })
                }
              >
                <option value="standard">Basic standard deduction</option>
                <option value="custom">Reviewed deduction override</option>
              </select>
              <small>
                Use an override for itemizing, dependent limits, or
                age/blindness additions.
              </small>
            </label>
            {s.deduction_mode === "custom" &&
              field("federal_deduction", "Reviewed federal deduction total")}
            {field(
              "qbi_deduction",
              "Reviewed QBI deduction",
              "Not calculated automatically; enter 0 until reviewed.",
            )}
            {field(
              "other_deduction",
              "Other deductions after AGI",
              "Reviewed Schedule 1-A or other allowed deductions; do not duplicate amounts above.",
            )}
            {field("federal_credits", "Federal nonrefundable credits")}
            {field("refundable_credits", "Federal refundable credits")}
            {field(
              "federal_other_tax",
              "Other federal taxes",
              "Reviewed AMT, NIIT, or other taxes not automatically calculated.",
            )}
            {field(
              "federal_withholding",
              "Expected annual federal withholding",
              "Include income tax and Additional Medicare withholding; exclude regular FICA and estimated payments.",
            )}
          </div>
        </fieldset>
      </details>
      <details className="estimate-inputs">
        <summary>Prior-year tax for payment targets</summary>
        <fieldset disabled={disabled}>
          <p>
            Use the prior return’s tax as defined in Form 1040-ES, not its
            balance due, payments, or last year’s Booky profit.
          </p>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={s.prior_federal_eligible}
              onChange={(e) =>
                change({ prior_federal_eligible: e.target.checked })
              }
            />
            Prior-year federal return covered 12 months and qualifies for the
            prior-year method (including residency requirements where
            applicable).
          </label>
          <div className="field-grid">
            {field(
              "prior_federal_tax",
              "Prior-year federal tax",
              "Blank means unknown; enter 0 only for a confirmed qualifying zero-tax year.",
            )}
            {field(
              "prior_agi",
              "Prior-year federal AGI",
              "Used for the 100% / 110% rule.",
            )}
          </div>
          {s.state === "OK" && (
            <>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={s.prior_ok_eligible}
                  onChange={(e) =>
                    change({ prior_ok_eligible: e.target.checked })
                  }
                />
                Prior Oklahoma return covered 12 months and qualifies for the
                prior-year method.
              </label>
              <div className="field-grid">
                {field("prior_ok_tax", "Prior-year Oklahoma tax")}
              </div>
            </>
          )}
        </fieldset>
      </details>
      {s.state === "OK" && (
        <details className="estimate-inputs">
          <summary>Oklahoma assumptions</summary>
          <fieldset disabled={disabled}>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={s.ok_resident}
                onChange={(e) => change({ ok_resident: e.target.checked })}
              />
              Estimate as a full-year Oklahoma resident, with all income taxable
              in Oklahoma before entered adjustments.
            </label>
            <div className="field-grid">
              {field(
                "ok_adjustment",
                "Oklahoma income adjustment",
                "Net additions minus subtractions to federal AGI; negative amounts subtract.",
              )}
              {field(
                "ok_deduction",
                "Reviewed Oklahoma deduction override",
                "Blank uses Oklahoma’s standard deduction. Required if overriding federal deductions.",
              )}
              {field(
                "ok_exemptions",
                "Oklahoma exemptions",
                "Number of eligible $1,000 exemptions; confirm dependents and filing status.",
              )}
              {field("ok_credits", "Oklahoma nonrefundable credits")}
              {field("ok_withholding", "Expected annual Oklahoma withholding")}
            </div>
          </fieldset>
        </details>
      )}
      <details className="estimate-inputs">
        <summary>Due-date overrides / disaster relief</summary>
        <fieldset disabled={disabled}>
          <p>
            Standard calendar-year dates are shown unless overridden. Confirm
            relief eligibility before changing dates.{" "}
            {year === "2025" && s.state === "OK" && (
              <a
                href="https://oklahoma.gov/tax/newsroom/2025/09-30-2025.html"
                target="_blank"
                rel="noreferrer"
              >
                Review Oklahoma’s 2025 disaster-relief notice.
              </a>
            )}
          </p>
          <div className="field-grid">
            {(
              [
                "federal",
                ...(s.state === "OK" ? ["oklahoma"] : []),
              ] as Jurisdiction[]
            ).flatMap((j) =>
              Array.from({ length: 4 }, (_, q) => (
                <label key={j + q}>
                  {j === "federal" ? "Federal" : "Oklahoma"} Q{q + 1} due
                  <input
                    type="date"
                    value={dueDate(s, year, j, q)}
                    onChange={(e) => {
                      const next = { ...s.due_dates };
                      if (e.target.value)
                        next[`${j}_${q + 1}`] = e.target.value;
                      else delete next[`${j}_${q + 1}`];
                      change({ due_dates: next });
                    }}
                  />
                </label>
              )),
            )}
          </div>
          <button
            type="button"
            className="secondary"
            onClick={() => change({ due_dates: {} })}
          >
            Reset standard due dates
          </button>
        </fieldset>
      </details>
      <section className="payment-tracker">
        <h3>Record an estimated tax payment</h3>
        <p>
          Record payments already made or prior-year refunds applied to this tax
          year, using their effective credit date. This tracker does not send
          money or add accounting entries. Save the tax workspace to keep
          changes.
        </p>
        <form onSubmit={addPayment}>
          <fieldset disabled={disabled}>
            <div className="field-grid">
              <label>
                Payment authority
                <select name="jurisdiction">
                  <option value="federal">IRS / federal</option>
                  <option value="oklahoma">Oklahoma</option>
                </select>
              </label>
              <label>
                Payment date
                <input
                  name="date"
                  type="date"
                  min={year + "-01-01"}
                  max={today()}
                  defaultValue={today()}
                  required
                />
              </label>
              <label>
                Amount paid (USD)
                <input name="amount" required inputMode="decimal" />
              </label>
              <label>
                Reference / note
                <input
                  name="note"
                  placeholder="Confirmation or credit reference (no SSN)"
                />
              </label>
            </div>
            <button className="secondary">Record payment</button>
          </fieldset>
        </form>
        <div className="report-scroll">
          <table>
            <thead>
              <tr>
                <th>Authority</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Reference</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {s.payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.jurisdiction}</td>
                  <td>{p.date}</td>
                  <td>{money(new Decimal(p.amount))}</td>
                  <td>{p.note}</td>
                  <td>
                    <button
                      type="button"
                      className="text-button"
                      disabled={disabled}
                      onClick={() =>
                        change({
                          payments: s.payments.filter((x) => x.id !== p.id),
                        })
                      }
                    >
                      Remove payment
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!s.payments.length && (
            <p>
              No payments recorded for {year}. This does not mean no payments
              were made.
            </p>
          )}
        </div>
      </section>
      {estimate && (
        <details className="estimate-inputs">
          <summary>Calculation assumptions and limits</summary>
          <ul>
            {estimate.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p>
            Calculated self-employment deduction: {money(estimate.halfSE)}.
            Additional Medicare tax: {money(estimate.additionalMedicare)}.
          </p>
        </details>
      )}
      <details className="estimate-inputs">
        <summary>Official sources · 2025 / 2026 rules</summary>
        <p>Rates and payment rules verified October 4, 2026.</p>
        <ul>
          {taxSources.map(([label, url]) => (
            <li key={url}>
              <a href={url} target="_blank" rel="noreferrer">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
