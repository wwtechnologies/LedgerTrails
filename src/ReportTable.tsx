import type { Report } from "./reports";
export default function ReportTable({ report }: { report: Report }) {
  return (
    <article className="report-paper">
      <div className="report-title">
        <span className="eyebrow">LEDGERTRAILS REPORT</span>
        <h2>{report.title}</h2>
        <p>{report.subtitle}</p>
      </div>
      <div className="report-scroll">
        <table>
          <thead>
            <tr>
              {report.columns.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!report.rows.length && (
          <p className="empty">
            No matching records. Check your dates, account names, or supporting
            schedules.
          </p>
        )}
      </div>
      <details className="report-notes" open>
        <summary>Report notes & data coverage</summary>
        <ul>
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </details>
    </article>
  );
}
