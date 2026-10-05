import { useMemo, useState } from "react";
import type { Snapshot } from "./model";
import {
  catalog,
  generateReport,
  reportCsv,
  reportHtml,
  validPeriod,
  type ReportId,
} from "./reports";
import { latestYear } from "./workspace";
import { exportFile, useWorkspace } from "./useWorkspace";
import ReportTable from "./ReportTable";
import SupportingSchedules from "./SupportingSchedules";
export default function ReportsPage({
  books,
  desktop,
  onSaved,
}: {
  books: Snapshot;
  desktop: boolean;
  onSaved: (b: Snapshot) => void;
}) {
  const year = latestYear(books),
    [start, setStart] = useState(year + "-01-01"),
    [end, setEnd] = useState(year + "-12-31"),
    [currency, setCurrency] = useState(books.company?.currency || "USD");
  const [id, setId] = useState<ReportId>("profit-loss"),
    [search, setSearch] = useState(""),
    [tab, setTab] = useState<"reports" | "supporting">("reports"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [exporting, setExporting] = useState(false);
  const workspace = useWorkspace(books, desktop, onSaved),
    p = { start, end, currency },
    valid = validPeriod(p);
  const report = useMemo(
    () =>
      valid
        ? generateReport(id, books, { start, end, currency }, workspace.value)
        : null,
    [id, books, start, end, currency, workspace.value, valid],
  );
  const currencies = Array.from(
    new Set([
      books.company?.currency || "USD",
      ...books.transactions.flatMap((t) =>
        t.postings.flatMap((p) => p.amounts.map((a) => a.commodity)),
      ),
    ]),
  );
  async function download(ext: "csv" | "html") {
    if (!report) return;
    setError("");
    setNotice("");
    setExporting(true);
    try {
      if (
        await exportFile(
          books,
          desktop,
          `LedgerTrails-${id}-${end}`,
          ext,
          ext === "csv"
            ? reportCsv(report)
            : reportHtml(books.company?.name || "Company", [report]),
        )
      )
        setNotice(
          ext === "html"
            ? "Printable report saved. Open it in a browser and choose Print / Save as PDF."
            : "CSV report saved.",
        );
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }
  return (
    <section className="finance-area">
      <div className="finance-hero">
        <div>
          <span className="eyebrow">REPORT LIBRARY</span>
          <h2>A clear view of your business</h2>
          <p>
            Financial statements, operating reports, and the detail behind every
            number.
          </p>
        </div>
        <span className="count-pill">{catalog.length} reports</span>
      </div>
      <div className="finance-tabs">
        <button
          className={tab === "reports" ? "active" : ""}
          onClick={() => setTab("reports")}
        >
          Reports
        </button>
        <button
          className={tab === "supporting" ? "active" : ""}
          onClick={() => setTab("supporting")}
        >
          Supporting schedules & budgets
        </button>
      </div>
      <div className="report-controls">
        <label>
          From
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          Through
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label>
          Currency
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <button
          className="secondary"
          onClick={() => {
            setStart(year + "-01-01");
            setEnd(year + "-12-31");
          }}
        >
          Latest recorded year
        </button>
      </div>
      {!valid && <p role="alert">Choose a valid start and end date.</p>}
      {(error || workspace.error) && (
        <p role="alert">{error || workspace.error}</p>
      )}
      {(notice || workspace.notice) && (
        <p role="status">{notice || workspace.notice}</p>
      )}
      {tab === "supporting" ? (
        <SupportingSchedules
          value={workspace.value}
          persist={workspace.persist}
          disabled={
            books.office?.role === "reader" ||
            workspace.loading ||
            workspace.saving ||
            !!workspace.error ||
            !desktop ||
            !books.company
          }
          currency={currency}
          start={start}
          end={end}
        />
      ) : (
        <div className="report-layout">
          <aside className="report-library">
            <label>
              Find a report
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search reports"
              />
            </label>
            {Array.from(new Set(catalog.map((c) => c[2]))).map((group) => (
              <div key={group}>
                <h3>{group}</h3>
                {catalog
                  .filter(
                    (c) =>
                      c[2] === group &&
                      c[1].toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((c) => (
                    <button
                      className={c[0] === id ? "active" : ""}
                      key={c[0]}
                      onClick={() => setId(c[0])}
                    >
                      {c[1]}
                    </button>
                  ))}
              </div>
            ))}
          </aside>
          <div className="report-result">
            <div className="report-export">
              <button
                className="secondary"
                disabled={
                  !report || exporting || workspace.loading || !!workspace.error
                }
                onClick={() => download("csv")}
              >
                Export CSV
              </button>
              <button
                className="primary"
                disabled={
                  !report || exporting || workspace.loading || !!workspace.error
                }
                onClick={() => download("html")}
              >
                Export printable report
              </button>
            </div>
            {workspace.loading ? (
              <p role="status">Loading supporting records…</p>
            ) : (
              report && <ReportTable report={report} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
