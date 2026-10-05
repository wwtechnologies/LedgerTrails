import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Snapshot } from "./model";
interface Row {
  line: number;
  date: string;
  description: string;
  account: string;
  amount: string;
}
export default function ReviewPage({
  books,
  desktop,
  onSaved,
}: {
  books: Snapshot;
  desktop: boolean;
  onSaved: (books: Snapshot) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]),
    [selected, setSelected] = useState<number[]>([]);
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setSelected([]);
    setError("");
    setLoading(true);
    setRows([]);
    if (!desktop || !books.company) {
      setLoading(false);
      return;
    }
    invoke<Row[]>("list_review", { revision: books.revision })
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [books.revision, books.path, desktop]);
  const visible = rows.filter((r) =>
    `${r.date} ${r.description} ${r.account} ${r.amount}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await invoke("categorize_review", {
        revision: books.revision,
        changes: selected.map((line) => ({ line, category: category.trim() })),
      });
      setSelected([]);
      setNotice("Categories saved. A backup was created.");
      try {
        onSaved(await invoke<Snapshot>("refresh_journal"));
      } catch (e) {
        setRows([]);
        setError(
          `Saved, but refresh failed: ${e}. Refresh the company before continuing.`,
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel review-page">
      <div className="panel-heading">
        <div>
          <h2>Transaction review</h2>
          <p>{rows.length} items awaiting a category</p>
        </div>
      </div>
      <p>
        Review unidentified bank payments and deposits, then choose the account
        they belong to. Vehicle payments may need a principal and interest split
        before categorizing.
      </p>
      {!books.company || !desktop ? (
        <p>Open a company file in the desktop app to review transactions.</p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <label>
            Search transactions
            <input
              aria-label="Search review transactions"
              value={query}
              disabled={busy}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected([]);
              }}
              placeholder="Description, date, amount, or category"
            />
          </label>
          <div className="review-actions">
            <label>
              Category
              <input
                aria-label="Review category"
                list="review-categories"
                value={category}
                disabled={busy}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="expenses:office or equity:owner-draws"
              />
            </label>
            <datalist id="review-categories">
              {Array.from(
                new Set([
                  ...books.accounts.map((a) => a.name),
                  "equity:owner-draws",
                  "expenses:cloud-server",
                  "expenses:office",
                  "expenses:vehicle:interest",
                  "liabilities:vehicle-loan",
                  "income:customer-payments",
                ]),
              )
                .filter((a) => !a.startsWith("equity:needs-review:"))
                .sort()
                .map((a) => (
                  <option key={a} value={a} />
                ))}
            </datalist>
            <button
              className="primary"
              disabled={busy || loading || !selected.length || !category.trim()}
              onClick={save}
            >
              {busy
                ? "Saving…"
                : `Apply category to ${selected.length} selected`}
            </button>
          </div>
          {loading ? (
            <p role="status">Loading transactions…</p>
          ) : (
            <div className="review-table">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select all visible transactions"
                        disabled={busy || !visible.length}
                        checked={
                          !!visible.length &&
                          visible.every((r) => selected.includes(r.line))
                        }
                        onChange={(e) =>
                          setSelected(
                            e.target.checked ? visible.map((r) => r.line) : [],
                          )
                        }
                      />
                    </th>
                    <th>Date</th>
                    <th>Description / current category</th>
                    <th>Category posting amount</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.line}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.description} on ${r.date}`}
                          disabled={busy}
                          checked={selected.includes(r.line)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, r.line]
                                : selected.filter((n) => n !== r.line),
                            )
                          }
                        />
                      </td>
                      <td>{r.date}</td>
                      <td>
                        {r.description}
                        <small>{r.account}</small>
                      </td>
                      <td>{r.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!visible.length && (
                <p>
                  {rows.length
                    ? "No matching transactions."
                    : "No transactions awaiting review."}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
