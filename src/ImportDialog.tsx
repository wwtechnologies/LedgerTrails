import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FileUp, Search, ShieldCheck, X } from "lucide-react";
import Decimal from "decimal.js";
import { Snapshot, formatAmount } from "./model";
export interface ImportRow {
  index: number;
  line: number;
  date: string;
  source: string;
  description: string;
  category: string;
  check: string;
  amount: string;
  opening: boolean;
  id: string;
  duplicate?: boolean;
}
interface Parsed {
  bank: string;
  file_revision: string;
  sources: string[];
  rows: ImportRow[];
  credits: string;
  debits: string;
  warnings: string[];
}
interface Preview {
  parsed: Parsed;
  rows: ImportRow[];
}
export interface ImportOutcome {
  imported: number;
  skipped: number;
}
export default function ImportDialog({
  books,
  onClose,
  onImported,
}: {
  books: Snapshot;
  onClose: () => void;
  onImported: (outcome: ImportOutcome) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [currency, setCurrency] = useState("USD");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [categories, setCategories] = useState<Record<number, string>>({});
  const [query, setQuery] = useState("");
  const [bulk, setBulk] = useState("equity:unassigned");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function choose() {
    await task(async () => {
      const chosen = await open({
        title: "Choose an Arvest or Bank of America CSV",
        multiple: false,
        directory: false,
        filters: [{ name: "Bank statement CSV", extensions: ["csv"] }],
      });
      if (!chosen) return;
      setParsed(null);
      setPreview(null);
      setPath("");
      setSelected(new Set());
      const result = await invoke<Parsed>("parse_statement", { path: chosen });
      setParsed(result);
      setPath(chosen);
      setQuery("");
      const bank = result.bank === "Arvest" ? "arvest" : "bank-of-america";
      setMappings(
        Object.fromEntries(
          result.sources.map((source, i) => [
            source,
            `assets:bank:${bank}${result.sources.length > 1 ? `:${i + 1}` : ""}`,
          ]),
        ),
      );
    });
  }
  async function review() {
    if (!parsed) return;
    await task(async () => {
      const result = await invoke<Preview>("review_statement", {
        path,
        fileRevision: parsed.file_revision,
        revision: books.revision,
        mappings,
        currency,
      });
      setPreview(result);
      setSelected(
        new Set(
          result.rows
            .filter((r) => !r.duplicate && !r.opening)
            .map((r) => r.index),
        ),
      );
      setCategories(
        Object.fromEntries(
          result.rows.map((r) => [
            r.index,
            r.opening ? "equity:opening-balances" : "equity:unassigned",
          ]),
        ),
      );
    });
  }
  async function commit() {
    if (!parsed || !preview) return;
    await task(async () => {
      const result = await invoke<ImportOutcome>("import_statement", {
        request: {
          path,
          file_revision: parsed.file_revision,
          revision: books.revision,
          mappings,
          currency,
          selections: preview.rows
            .filter((r) => selected.has(r.index) && !r.duplicate)
            .map((r) => ({ index: r.index, category: categories[r.index] })),
        },
      });
      await onImported(result);
    });
  }
  const visible = (preview?.rows ?? []).filter((r) =>
    `${r.description} ${r.source} ${r.category} ${categories[r.index] ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const selectable = visible.filter((r) => !r.duplicate && !r.opening);
  const checked = (preview?.rows ?? []).filter(
    (r) => selected.has(r.index) && !r.duplicate,
  );
  const selectedTotal = checked
    .reduce((sum, r) => sum.plus(r.amount), new Decimal(0))
    .toFixed(2);
  function toggle(index: number, check: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (check) next.add(index);
      else next.delete(index);
      return next;
    });
  }
  return (
    <dialog
      ref={dialog}
      className="import-dialog"
      aria-labelledby="import-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <div className="eyebrow">ARVEST · BANK OF AMERICA</div>
          <h2 id="import-title">Import bank transactions</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close import"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <p className="dialog-intro">
        Review your CSV before adding transactions to {books.company?.name}.
        Your original statement stays unchanged.
      </p>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {!preview ? (
        <>
          <button className="secondary" disabled={busy} onClick={choose}>
            <FileUp size={17} />
            {parsed ? "Choose another CSV" : "Choose statement CSV"}
          </button>
          {parsed && (
            <>
              <div className="import-summary">
                <strong>{parsed.bank}</strong>
                <span>
                  {parsed.rows.filter((r) => !r.opening).length} transactions
                </span>
                <small>{path.split(/[\\/]/).pop()}</small>
              </div>
              <p>
                Map each statement account to its bank account in LedgerTrails. Use the
                same mapping when importing overlapping statements.
              </p>
              <datalist id="bank-import-accounts">
                {books.accounts
                  .filter((a) => a.name.startsWith("assets:"))
                  .map((a) => (
                    <option key={a.name} value={a.name} />
                  ))}
              </datalist>
              {parsed.sources.map((source) => (
                <label className="import-mapping" key={source}>
                  {source}
                  <input
                    disabled={busy}
                    list="bank-import-accounts"
                    aria-label={`LedgerTrails account for ${source}`}
                    value={mappings[source] ?? ""}
                    onChange={(e) =>
                      setMappings((prev) => ({
                        ...prev,
                        [source]: e.target.value,
                      }))
                    }
                  />
                </label>
              ))}
              <label className="import-currency">
                Statement currency
                <input
                  disabled={busy}
                  value={currency}
                  maxLength={12}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              </label>
              <div className="import-summary">
                <span>
                  Money in:{" "}
                  {formatAmount({
                    quantity: parsed.credits,
                    commodity: currency,
                  })}
                </span>
                <span>
                  Money out:{" "}
                  {formatAmount({
                    quantity: parsed.debits,
                    commodity: currency,
                  })}
                </span>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="import-summary">
            <strong>{preview.parsed.bank}</strong>
            <span>
              {checked.length} selected ·{" "}
              {preview.rows.filter((r) => r.duplicate).length} already imported
            </span>
            <span>
              Selected net change:{" "}
              {formatAmount({ quantity: selectedTotal, commodity: currency })}
            </span>
          </div>
          <div className="import-toolbar">
            <label className="search">
              <Search size={16} />
              <input
                placeholder="Filter descriptions or categories"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={busy}
              />
            </label>
            <input
              aria-label="Category for selected visible rows"
              list="import-categories"
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              disabled={busy}
            />
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                setCategories((prev) => ({
                  ...prev,
                  ...Object.fromEntries(
                    visible
                      .filter(
                        (r) =>
                          selected.has(r.index) && !r.duplicate && !r.opening,
                      )
                      .map((r) => [r.index, bulk]),
                  ),
                }))
              }
            >
              Apply to selected visible rows
            </button>
          </div>
          <datalist id="import-categories">
            {Array.from(
              new Set([
                ...books.accounts.map((a) => a.name),
                "equity:unassigned",
                "equity:opening-balances",
                "expenses:bank-fees",
                "expenses:office",
                "income:sales",
              ]),
            ).map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          <div className="import-table-wrap">
            <table className="import-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select visible transactions"
                      disabled={busy || selectable.length === 0}
                      checked={
                        selectable.length > 0 &&
                        selectable.every((r) => selected.has(r.index))
                      }
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          for (const row of selectable) {
                            if (e.target.checked) next.add(row.index);
                            else next.delete(row.index);
                          }
                          return next;
                        })
                      }
                    />
                  </th>
                  <th>Date / account</th>
                  <th>Description</th>
                  <th>Bank change</th>
                  <th>Other account / category</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.index}
                    className={row.duplicate ? "duplicate-row" : ""}
                  >
                    <td>
                      <input
                        aria-label={`Import row ${row.index + 1}`}
                        type="checkbox"
                        disabled={busy || row.duplicate}
                        checked={selected.has(row.index) && !row.duplicate}
                        onChange={(e) => toggle(row.index, e.target.checked)}
                      />
                    </td>
                    <td>
                      {row.date}
                      <small>{mappings[row.source]}</small>
                    </td>
                    <td>
                      <strong>{row.description}</strong>
                      <small>
                        {row.duplicate
                          ? "Already imported"
                          : row.opening
                            ? "Opening balance — optional"
                            : row.category
                              ? `Bank category: ${row.category}`
                              : `CSV line ${row.line}`}
                      </small>
                    </td>
                    <td className="money">
                      {formatAmount({
                        quantity: row.amount,
                        commodity: currency,
                      })}
                    </td>
                    <td>
                      <input
                        aria-label={`Category for row ${row.index + 1}`}
                        list="import-categories"
                        disabled={busy || row.duplicate}
                        value={categories[row.index] ?? ""}
                        onChange={(e) =>
                          setCategories((prev) => ({
                            ...prev,
                            [row.index]: e.target.value,
                          }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 && (
              <div className="empty">No matching transactions.</div>
            )}
          </div>
        </>
      )}
      {parsed && (
        <ul className="import-notes">
          {parsed.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="entry-hint">
        <ShieldCheck size={17} />
        The entire import is validated and saved together, with one automatic
        company backup.
      </div>
      <div className="dialog-actions">
        {preview && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setPreview(null);
              setError("");
            }}
          >
            Back to account mapping
          </button>
        )}
        <button className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        {preview ? (
          <button
            className="primary"
            disabled={busy || checked.length === 0}
            onClick={commit}
          >
            {busy ? "Importing…" : `Import ${checked.length} transactions`}
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || !parsed}
            onClick={review}
          >
            {busy ? "Reading…" : "Review transactions"}
          </button>
        )}
      </div>
    </dialog>
  );
}
