import { useEffect, useState, type FormEvent } from "react";
import type { Snapshot } from "./model";
import {
  emptyTaxYear,
  latestYear,
  checkItems,
  entityLabels,
  formLinks,
  taxBuckets,
  turboTaxExpenseBuckets,
  employeeBuckets,
  otherTaxBuckets,
  normalizeTaxYear,
  type TaxYear,
  type Entity,
} from "./workspace";
import { exportFile, useWorkspace } from "./useWorkspace";
import { taxAccounts, taxPacket } from "./tax";
import { reportHtml, reportCsv } from "./reports";
import TaxDashboard from "./TaxDashboard";
import ReportTable from "./ReportTable";
export default function TaxPage({
  books,
  desktop,
  onSaved,
  onDirty,
  onReports,
}: {
  books: Snapshot;
  desktop: boolean;
  onSaved: (b: Snapshot) => void;
  onDirty: (v: boolean) => void;
  onReports: () => void;
}) {
  const [year, setYear] = useState(latestYear(books)),
    [currency, setCurrency] = useState(books.company?.currency || "USD"),
    [tax, setTax] = useState<TaxYear>(emptyTaxYear),
    [dirty, setDirty] = useState(false),
    [tab, setTab] = useState("Estimates"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [exporting, setExporting] = useState(false);
  const workspace = useWorkspace(books, desktop, onSaved);
  useEffect(() => {
    if (!workspace.loading) {
      setTax(
        normalizeTaxYear(workspace.value.tax_years[year] || emptyTaxYear()),
      );
      setDirty(false);
      onDirty(false);
    }
  }, [workspace.value, workspace.loading, year]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const update = (next: TaxYear) => {
    setTax(next);
    setDirty(true);
    onDirty(true);
  };
  const period = { start: year + "-01-01", end: year + "-12-31", currency },
    accounts = taxAccounts(books, period),
    packet = taxPacket(books, period, tax, workspace.value),
    form = formLinks[tax.entity];
  const disabled =
    books.office?.role === "reader" ||
    workspace.loading ||
    workspace.saving ||
    !!workspace.error ||
    !desktop ||
    !books.company;
  async function save() {
    if (
      await workspace.persist({
        ...workspace.value,
        tax_years: { ...workspace.value.tax_years, [year]: tax },
      })
    ) {
      setDirty(false);
      onDirty(false);
    }
  }
  async function download(csv = false) {
    setError("");
    setNotice("");
    setExporting(true);
    try {
      if (
        await exportFile(
          books,
          desktop,
          `LedgerTrails-tax-preparation-${year}`,
          csv ? "csv" : "html",
          csv
            ? reportCsv(packet[2])
            : reportHtml(books.company?.name || "Company", packet),
        )
      )
        setNotice(
          csv
            ? "Tax category CSV saved."
            : "Preparer packet saved. Open the HTML file in a browser to print or save as PDF.",
        );
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }
  function adjust(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form),
      amount = String(data.get("amount"));
    if (!/^\d+(\.\d+)?$/.test(amount)) {
      setError("Use a nonnegative decimal adjustment.");
      return;
    }
    update({
      ...tax,
      adjustments: [
        ...tax.adjustments,
        {
          id: crypto.randomUUID(),
          description: String(data.get("description")),
          direction: data.get("direction") as "increase" | "decrease",
          amount,
          currency,
        },
      ],
    });
    form.reset();
  }
  const years = Array.from(
    new Set([
      "2025",
      "2026",
      String(new Date().getFullYear()),
      latestYear(books),
      ...books.transactions.map((t) => t.date.slice(0, 4)),
      ...Object.keys(workspace.value.tax_years),
    ]),
  )
    .sort()
    .reverse();
  return (
    <section className="finance-area">
      <div className="finance-hero">
        <div>
          <span className="eyebrow">TAX PREPARATION</span>
          <h2>Get your books ready for tax time</h2>
          <p>
            Organize the records, resolve the gaps, and hand your preparer a
            complete picture.
          </p>
        </div>
        <span className="count-pill">Calendar year {year}</span>
      </div>
      <div className="report-controls">
        <label>
          Tax year
          <select
            value={year}
            disabled={workspace.saving}
            onChange={(e) => {
              if (
                dirty &&
                !window.confirm("Discard unsaved tax worksheet changes?")
              )
                return;
              setYear(e.target.value);
            }}
          >
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </label>
        <label>
          Currency
          <select
            value={tab === "Estimates" ? "USD" : currency}
            disabled={tab === "Estimates"}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {Array.from(
              new Set([
                "USD",
                books.company?.currency || "USD",
                ...books.transactions.flatMap((t) =>
                  t.postings.flatMap((p) => p.amounts.map((a) => a.commodity)),
                ),
              ]),
            ).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={disabled || !dirty}
          onClick={save}
        >
          {workspace.saving ? "Saving…" : "Save tax workspace"}
        </button>
        <span className="muted">
          {dirty ? "Unsaved changes" : "Saved workspace"}
        </span>
      </div>
      {(error || workspace.error) && (
        <p role="alert">{error || workspace.error}</p>
      )}
      {(notice || workspace.notice) && (
        <p role="status">{notice || workspace.notice}</p>
      )}
      <div className="tax-callout">
        <strong>Preparation workspace</strong>
        <p>
          LedgerTrails provides planning estimates and organizes your tax
          records. It does not file returns or calculate final liability. Start
          with{" "}
          <a href={form.url} target="_blank" rel="noreferrer">
            {form.name}
          </a>
          ; confirm the correct forms and tax-year rules with your preparer.
        </p>
      </div>
      <div className="finance-tabs">
        {[
          "Estimates",
          "Readiness",
          "Tax categories",
          "Adjustments",
          "Preparer packet",
        ].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {workspace.loading ? (
        <p role="status">Loading tax workspace…</p>
      ) : (
        <>
          {tab === "Estimates" && (
            <TaxDashboard
              books={books}
              year={year}
              tax={tax}
              update={update}
              disabled={disabled}
              dirty={dirty}
              desktop={desktop}
            />
          )}
          {tab === "Readiness" && (
            <>
              <div className="field-grid">
                <label>
                  Federal tax classification
                  <select
                    disabled={disabled}
                    value={tax.entity}
                    onChange={(e) =>
                      update({ ...tax, entity: e.target.value as Entity })
                    }
                  >
                    {Object.entries(entityLabels).map(([v, label]) => (
                      <option value={v} key={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Tax accounting method
                  <select
                    disabled={disabled}
                    value={tax.basis}
                    onChange={(e) => update({ ...tax, basis: e.target.value })}
                  >
                    <option value="unknown">Confirm with preparer</option>
                    <option value="cash">Cash</option>
                    <option value="accrual">Accrual</option>
                    <option value="other">Other / hybrid</option>
                  </select>
                </label>
                <label>
                  State / local jurisdictions
                  <input
                    disabled={disabled}
                    value={tax.jurisdiction}
                    onChange={(e) =>
                      update({ ...tax, jurisdiction: e.target.value })
                    }
                    placeholder="State and other filing jurisdictions"
                  />
                </label>
              </div>
              <ReportTable report={packet[0]} />
              <div className="checklist">
                <h3>Year-end preparation checklist</h3>
                {checkItems.map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={!!tax.checks[key]}
                      onChange={(e) =>
                        update({
                          ...tax,
                          checks: { ...tax.checks, [key]: e.target.checked },
                        })
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <label className="notes-label">
                Notes for your preparer
                <textarea
                  disabled={disabled}
                  value={tax.notes}
                  onChange={(e) => update({ ...tax, notes: e.target.value })}
                  rows={5}
                  placeholder="Missing documents, prior-year carryovers, estimated payments, and questions to resolve"
                />
              </label>
            </>
          )}
          {tab === "Tax categories" && (
            <>
              <h3>Map book accounts to preparation categories</h3>
              <p>
                Choose the matching TurboTax category for each book account.
                Income, inventory, payroll, rent, and other records have
                separate choices. These labels organize amounts only; they do
                not calculate deductible amounts or change transactions.
              </p>
              <p>
                Review vehicle business use, home-office allocation, asset
                treatment, and meal limits before filing. Employee wages and
                work credits are separate calculations; mapping wages does not
                calculate a credit.
              </p>
              <div className="report-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Book account</th>
                      <th>Recorded amount ({currency})</th>
                      <th>Tax preparation category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.account}>
                        <td>{a.account}</td>
                        <td>{a.amount}</td>
                        <td>
                          <select
                            aria-label={`Tax category for ${a.account}`}
                            disabled={disabled}
                            value={tax.mappings[a.account] || "Unmapped"}
                            onChange={(e) =>
                              update({
                                ...tax,
                                mappings: {
                                  ...tax.mappings,
                                  [a.account]: e.target.value,
                                },
                              })
                            }
                          >
                            <option>Unmapped</option>
                            <optgroup label="Employee wages and work credits">
                              {employeeBuckets.map((b) => (
                                <option key={b}>{b}</option>
                              ))}
                            </optgroup>
                            <optgroup label="TurboTax business expenses">
                              {turboTaxExpenseBuckets.map((b) => (
                                <option key={b}>{b}</option>
                              ))}
                            </optgroup>
                            <optgroup label="Other tax sections and review">
                              {otherTaxBuckets.map((b) => (
                                <option key={b}>{b}</option>
                              ))}
                            </optgroup>
                            {tax.mappings[a.account] &&
                              !taxBuckets.includes(
                                tax.mappings[
                                  a.account
                                ] as (typeof taxBuckets)[number],
                              ) && (
                                <optgroup label="Previously saved category — review this mapping">
                                  <option>{tax.mappings[a.account]}</option>
                                </optgroup>
                              )}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!accounts.length && (
                  <p>
                    No income or expense accounts recorded in this year and
                    currency.
                  </p>
                )}
              </div>
              <ReportTable report={packet[2]} />
            </>
          )}
          {tab === "Adjustments" && (
            <>
              <h3>Book-to-tax adjustment worksheet</h3>
              <p>
                Enter reviewed differences such as nondeductible costs or tax
                depreciation. An increase adds to book income; a decrease
                subtracts from it. These entries stay separate from your books.
              </p>
              <form onSubmit={adjust}>
                <fieldset disabled={disabled}>
                  <div className="field-grid">
                    <label>
                      Description
                      <input required name="description" />
                    </label>
                    <label>
                      Effect on book income
                      <select name="direction">
                        <option value="increase">Increase</option>
                        <option value="decrease">Decrease</option>
                      </select>
                    </label>
                    <label>
                      Amount ({currency})
                      <input required name="amount" inputMode="decimal" />
                    </label>
                  </div>
                  <button className="secondary">Add adjustment</button>
                </fieldset>
              </form>
              {tax.adjustments.map((a) => (
                <div className="adjustment" key={a.id}>
                  <span>
                    {a.description} · {a.direction} · {a.amount} {a.currency}
                  </span>
                  <button
                    className="text-button"
                    disabled={disabled}
                    onClick={() =>
                      update({
                        ...tax,
                        adjustments: tax.adjustments.filter(
                          (x) => x.id !== a.id,
                        ),
                      })
                    }
                  >
                    Remove adjustment
                  </button>
                </div>
              ))}
            </>
          )}
          {tab === "Preparer packet" && (
            <>
              <h3>Your annual preparation packet</h3>
              <p>
                Includes the tax summary, mappings, adjustments, checklist,
                notes, financial statements, general ledger, unresolved
                transactions, and supporting schedules.
              </p>
              <div className="report-export">
                <button
                  className="primary"
                  disabled={exporting || dirty || !!workspace.error}
                  onClick={() => download()}
                >
                  Export preparer packet
                </button>
                <button
                  className="secondary"
                  disabled={exporting || dirty || !!workspace.error}
                  onClick={() => download(true)}
                >
                  Export tax categories CSV
                </button>
              </div>
              {dirty && <p>Save your workspace before exporting.</p>}
              <h3>Assets, inventory, and contractor records</h3>
              <p>
                Add these under Reports → Supporting schedules. Record business
                use and depreciation details for assets, and W-9 status and
                payment method for contractors. LedgerTrails does not infer 1099
                eligibility from bank descriptions.
              </p>
              <button className="secondary" onClick={onReports}>
                Open supporting reports
              </button>
              <h3>Source documents to gather</h3>
              <p>
                Prior-year returns, all bank and card statements, receipts,
                sales/processor statements, payroll journals and filings, loan
                statements, asset records, contractor documentation, and
                estimated-tax payment confirmations.
              </p>
              <p>
                Documents remain in your chosen storage; the packet includes
                your notes and schedules, not attached source files.
              </p>
            </>
          )}
          <div className="tax-sources">
            <h3>Official preparation references</h3>
            <a
              target="_blank"
              rel="noreferrer"
              href="https://www.irs.gov/businesses/small-businesses-self-employed/what-kind-of-records-should-i-keep"
            >
              IRS recordkeeping
            </a>
            <a
              target="_blank"
              rel="noreferrer"
              href="https://www.irs.gov/publications/p538"
            >
              Accounting methods
            </a>
            <a
              target="_blank"
              rel="noreferrer"
              href="https://www.irs.gov/instructions/i1040sc"
            >
              Schedule C instructions
            </a>
            <a
              target="_blank"
              rel="noreferrer"
              href="https://www.irs.gov/instructions/i1099mec"
            >
              1099 instructions by tax year
            </a>
          </div>
        </>
      )}
    </section>
  );
}
