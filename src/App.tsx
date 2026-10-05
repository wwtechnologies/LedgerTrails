import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  FilePlus2,
  FolderOpen,
  LayoutDashboard,
  BarChart3,
  Receipt,
  List,
  Plus,
  RefreshCw,
  Save,
  Download,
  Upload,
  Search,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import {
  Amount,
  Entry,
  Snapshot,
  CompanyDetails,
  formatAmount,
  today,
  totals,
} from "./model";
import "./App.css";
import sample from "./sample.json";
import ReportsPage from "./ReportsPage";
import TaxPage from "./TaxPage";
import "./Finance.css";
import ReviewPage from "./ReviewPage";
import ImportDialog, { ImportOutcome } from "./ImportDialog";
import {
  RecentBook,
  readRecentBooks,
  rememberBook,
  writeRecentBooks,
} from "./recentBooks";
const companyFilters = [
  { name: "LedgerTrails company file", extensions: ["bky"] },
];
const backupFilters = [{ name: "LedgerTrails backup", extensions: ["bkybk"] }];
const withExtension = (path: string, extension: string) =>
  path.toLowerCase().endsWith(`.${extension}`) ? path : `${path}.${extension}`;
const filters = [
  { name: "hledger journal", extensions: ["journal", "ledger", "hledger"] },
];
function Money({ amounts }: { amounts: Amount[] }) {
  return (
    <>
      {amounts.length ? (
        amounts.map((a, i) => (
          <span className="money" key={i}>
            {formatAmount(a)}
          </span>
        ))
      ) : (
        <span className="money">—</span>
      )}
    </>
  );
}

export default function App() {
  const [books, setBooks] = useState<Snapshot | null>(null);
  const [view, setView] = useState<
    "Overview" | "Transactions" | "Accounts" | "Review" | "Reports" | "Tax"
  >("Overview");
  const [taxDirty, setTaxDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const desktop = isTauri();
  const [recentBooks, setRecentBooks] = useState(() =>
    desktop ? readRecentBooks() : [],
  );
  const [historyWarning, setHistoryWarning] = useState("");
  function updateRecentBooks(recent: RecentBook[]) {
    setRecentBooks(recent);
    setHistoryWarning(
      writeRecentBooks(recent)
        ? ""
        : "Recent books could not be saved on this machine. This list may not persist after closing the app.",
    );
  }
  function activateBooks(snapshot: Snapshot) {
    setBooks(snapshot);
    if (desktop) updateRecentBooks(rememberBook(recentBooks, snapshot));
  }
  async function openRecent(book: RecentBook) {
    await work(async () => {
      try {
        const snapshot = await invoke<Snapshot>(
          book.kind === "company" ? "open_company" : "open_journal",
          { path: book.path },
        );
        activateBooks(snapshot);
        setQuery("");
        setView("Overview");
      } catch (e) {
        throw new Error(
          `Could not open ${book.name}: ${e}. If the file was moved, use Open company to find it, or remove this shortcut from Recent books.`,
        );
      }
    });
  }
  async function work(action: () => Promise<void>) {
    if (taxDirty && !window.confirm("Discard unsaved tax workspace changes?"))
      return;
    setTaxDirty(false);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function imported(outcome: ImportOutcome) {
    setImporting(false);
    setError("");
    setNotice(
      `${outcome.imported} transactions imported. ${outcome.skipped} duplicates skipped. A backup was created if any entries were added.`,
    );
    try {
      setBooks(await invoke<Snapshot>("refresh_journal"));
    } catch (e) {
      setError(
        `Import saved, but refresh failed: ${e}. Refresh before making more changes.`,
      );
    }
  }
  async function choose(mode: "open" | "new" | "sample") {
    if (mode === "new") {
      setError("");
      setCreating(true);
      return;
    }
    await work(async () => {
      if (mode === "open") {
        const path = await open({
          multiple: false,
          directory: false,
          filters: [...companyFilters, ...filters],
        });
        if (path) {
          const command = /\.(journal|ledger|hledger)$/i.test(path)
            ? "open_journal"
            : "open_company";
          activateBooks(await invoke<Snapshot>(command, { path }));
          setQuery("");
        }
      } else {
        const chosen = await save({
          defaultPath: "sample-company.bky",
          filters: companyFilters,
        });
        if (chosen)
          activateBooks(
            await invoke<Snapshot>("create_company", {
              path: withExtension(chosen, "bky"),
              details: { name: "Sample Company", currency: "USD" },
              sample: true,
              source: null,
            }),
          );
      }
    });
  }
  async function createCompany(details: CompanyDetails, source: string | null) {
    await work(async () => {
      const chosen = await save({
        defaultPath: "company.bky",
        filters: companyFilters,
      });
      if (!chosen) return;
      const result = await invoke<Snapshot>("create_company", {
        path: withExtension(chosen, "bky"),
        details,
        source,
        sample: false,
      });
      activateBooks(result);
      setCreating(false);
      setQuery("");
      setNotice(
        "Company file created. Transactions will save automatically to this file.",
      );
    });
  }
  async function restoreCompany() {
    await work(async () => {
      const source = await open({
        title: "Select a backup or company file to restore",
        multiple: false,
        directory: false,
        filters: [...backupFilters, ...companyFilters],
      });
      if (!source) return;
      const chosen = await save({
        title: "Save restored company as a new file",
        defaultPath: "restored-company.bky",
        filters: companyFilters,
      });
      if (!chosen) return;
      activateBooks(
        await invoke<Snapshot>("restore_company", {
          source,
          path: withExtension(chosen, "bky"),
        }),
      );
      setQuery("");
      setNotice(
        "Company restored to a new file. The source backup is unchanged.",
      );
    });
  }
  async function companyAction(action: "save" | "copy" | "backup") {
    if (!books?.company) return;
    await work(async () => {
      if (action === "save") {
        setBooks(
          await invoke<Snapshot>("save_company", { revision: books.revision }),
        );
        setNotice(
          "Company file saved. All recorded transactions are up to date.",
        );
        return;
      }
      const backup = action === "backup";
      const chosen = await save({
        title: backup ? "Create company backup" : "Save company as",
        defaultPath: backup ? `company-${today()}.bkybk` : "company-copy.bky",
        filters: backup ? backupFilters : companyFilters,
      });
      if (!chosen) return;
      const path = withExtension(chosen, backup ? "bkybk" : "bky");
      const result = await invoke<Snapshot>("copy_company", {
        path,
        revision: books.revision,
        switch: !backup,
      });
      if (!backup) activateBooks(result);
      setNotice(
        backup
          ? `Backup created: ${path}. Your current company stays open.`
          : `Saved and opened the company copy: ${path}`,
      );
    });
  }
  const refresh = () =>
    work(async () => setBooks(await invoke<Snapshot>("refresh_journal")));
  async function add(entry: Entry) {
    if (!books) return;
    await work(async () => {
      await invoke("add_entry", { entry, revision: books.revision });
      setAdding(false);
      setNotice(
        "Transaction saved. A backup of the previous journal was created.",
      );
      try {
        setBooks(await invoke<Snapshot>("refresh_journal"));
      } catch (e) {
        setError(
          `Saved successfully, but refresh failed: ${e}. Refresh before adding another entry.`,
        );
      }
    });
  }
  const transactions = (books?.transactions ?? [])
    .filter((t) =>
      `${t.description} ${t.date} ${t.postings.map((p) => p.account).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));
  const accounts = (books?.accounts ?? []).filter((a) =>
    a.name.toLowerCase().includes(query.toLowerCase()),
  );
  const nav = [
    { label: "Overview" as const, icon: LayoutDashboard },
    { label: "Transactions" as const, icon: List },
    { label: "Accounts" as const, icon: Wallet },
    { label: "Review" as const, icon: ShieldCheck },
    { label: "Reports" as const, icon: BarChart3 },
    { label: "Tax" as const, icon: Receipt },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (
              taxDirty &&
              !window.confirm("Discard unsaved tax workspace changes?")
            )
              return;
            setTaxDirty(false);
            setView("Overview");
          }}
        >
          <span className="brand-mark">
            <BookOpen size={22} />
          </span>
          <span>
            <b>LedgerTrails</b>
            <small>YOUR BOOKS, IN BALANCE</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">L</span>
          <span>
            {books?.company?.name ?? "My workspace"}
            <small>{books?.company ? "Company file" : "Local books"}</small>
          </span>
          <ShieldCheck size={16} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={view === label ? "nav-item active" : "nav-item"}
              onClick={() => {
                if (
                  taxDirty &&
                  !window.confirm("Discard unsaved tax workspace changes?")
                )
                  return;
                setTaxDirty(false);
                setView(label);
                setQuery("");
              }}
            >
              <Icon size={18} />
              {label}
              {label === view && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={18} />
            <div>
              Local by design<small>Your company stays on your computer.</small>
            </div>
          </div>
          <span className="engine">
            Powered by hledger <span>↗</span>
          </span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            Workspace <ChevronRight size={14} />
            <strong>{view}</strong>
          </span>
          <span className="local-badge">
            <i /> {desktop ? "On your computer" : "Browser preview"}
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">A CLEARER PICTURE</div>
              <h1>
                {view === "Overview" ? "Your finances, at a glance." : view}
              </h1>
              <p>
                {view === "Overview"
                  ? "A little clarity for every financial decision."
                  : view === "Transactions"
                    ? "Every entry, with the details that keep your books balanced."
                    : "A place for every part of your financial life."}
              </p>
            </div>
            {books && (
              <button
                className="primary"
                disabled={busy || !desktop}
                onClick={() => {
                  setError("");
                  setAdding(true);
                }}
              >
                <Plus size={17} />
                Add transaction
              </button>
            )}
          </div>
          {!desktop && (
            <div className="banner">
              <CircleHelp size={18} />
              This is a browser preview. Launch the desktop app with{" "}
              <code>npm run tauri dev</code> to open your journals. You can
              explore the fictional sample below.
            </div>
          )}
          {error && (
            <div className="banner error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="banner success" role="status">
              <Check size={18} />
              {notice}
            </div>
          )}
          {desktop && (recentBooks.length > 0 || historyWarning) && (
            <details className="recent-books" open={!books}>
              <summary>
                Recent books <span>({recentBooks.length})</span>
              </summary>
              {historyWarning && <p role="status">{historyWarning}</p>}
              <ul>
                {recentBooks.map((book) => (
                  <li key={book.path}>
                    <button
                      className="recent-book-open"
                      disabled={busy}
                      onClick={() => openRecent(book)}
                      aria-label={`Open recent ${book.name}`}
                    >
                      <BookOpen size={18} />
                      <span>
                        <strong>{book.name}</strong>
                        <small>{book.path}</small>
                      </span>
                    </button>
                    <button
                      className="recent-book-remove"
                      disabled={busy}
                      onClick={() =>
                        updateRecentBooks(
                          recentBooks.filter(
                            (entry) => entry.path !== book.path,
                          ),
                        )
                      }
                      aria-label={`Remove ${book.name} from recent books`}
                      title="Remove shortcut; keeps the file"
                    >
                      <X size={16} />
                    </button>
                  </li>
                ))}
              </ul>
              {recentBooks.length > 0 && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => updateRecentBooks([])}
                >
                  Clear recent books
                </button>
              )}
            </details>
          )}
          {!books ? (
            <section className="welcome">
              <div className="welcome-illustration">
                <div className="paper">
                  <span />
                  <span />
                  <span />
                  <div>
                    <Check size={22} />
                  </div>
                </div>
              </div>
              <div className="eyebrow">START WITH YOUR BOOKS</div>
              <h2>A fresh view of your finances.</h2>
              <p>
                Open a company file or create a new company.
                <br />
                Your company details and books travel together in one file.
              </p>
              <div className="welcome-actions">
                <button
                  className="primary"
                  disabled={busy || !desktop}
                  onClick={() => choose("open")}
                >
                  <FolderOpen size={17} />
                  Open company
                </button>
                <button
                  className="secondary"
                  disabled={busy || !desktop}
                  onClick={() => choose("new")}
                >
                  <FilePlus2 size={17} />
                  New company
                </button>
              </div>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => (desktop ? choose("sample") : setBooks(sample))}
              >
                Explore a sample company <ChevronRight size={15} />
              </button>
              <button
                className="text-button"
                disabled={busy || !desktop}
                onClick={restoreCompany}
              >
                <Upload size={15} />
                Restore backup or local company copy
              </button>
              <div className="welcome-footer">
                <ShieldCheck size={15} />
                Private files. Exact amounts. Balanced entries.
              </div>
            </section>
          ) : (
            <>
              <div className="journal-bar">
                <div>
                  <BookOpen size={17} />
                  <span title={books.path}>
                    {books.path.split(/[\\/]/).pop()}
                  </span>
                  <span className="muted">· All time</span>
                </div>
                <div>
                  <button
                    disabled={busy || !desktop}
                    onClick={() => choose("open")}
                  >
                    <FolderOpen size={15} />
                    Open company
                  </button>
                  <button
                    aria-label="Refresh journal"
                    disabled={busy || !desktop}
                    onClick={refresh}
                  >
                    <RefreshCw size={16} className={busy ? "spin" : ""} />
                  </button>
                </div>
              </div>
              <section
                className="company-tools"
                aria-label="Company file actions"
              >
                <div>
                  <strong>{books.company?.name ?? "Standalone journal"}</strong>
                  <small>
                    {books.company
                      ? `Company file · ${books.company.currency} default currency · Transactions saved automatically`
                      : "Create a company to package this journal with your business details."}
                  </small>
                </div>
                <div className="company-buttons">
                  {books.company && (
                    <>
                      <button
                        className="primary"
                        disabled={busy || !desktop}
                        onClick={() => {
                          setError("");
                          setImporting(true);
                        }}
                      >
                        <Upload size={15} />
                        Import CSV
                      </button>
                      <button
                        className="secondary"
                        disabled={busy || !desktop}
                        onClick={() => companyAction("save")}
                      >
                        <Save size={15} />
                        Save
                      </button>
                      <button
                        className="secondary"
                        disabled={busy || !desktop}
                        onClick={() => companyAction("copy")}
                      >
                        Save as
                      </button>
                      <button
                        className="secondary"
                        disabled={busy || !desktop}
                        onClick={() => companyAction("backup")}
                      >
                        <Download size={15} />
                        Back up
                      </button>
                    </>
                  )}
                  <button
                    className="secondary"
                    disabled={busy || !desktop}
                    onClick={restoreCompany}
                  >
                    <Upload size={15} />
                    Restore
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || !desktop}
                    onClick={() => choose("new")}
                  >
                    <FilePlus2 size={15} />
                    New company
                  </button>
                </div>
              </section>
              {view === "Overview" && (
                <div className="stats">
                  {[
                    {
                      title: "Net worth",
                      values: totals(books.accounts, ["assets", "liabilities"]),
                      icon: Wallet,
                      subtitle: "Assets less liabilities",
                      accent: true,
                    },
                    {
                      title: "Income",
                      values: totals(books.accounts, ["income"], true),
                      icon: ArrowDownLeft,
                      subtitle: "All recorded income",
                      accent: false,
                    },
                    {
                      title: "Expenses",
                      values: totals(books.accounts, ["expenses"]),
                      icon: ArrowUpRight,
                      subtitle: "All recorded expenses",
                      accent: false,
                    },
                  ].map(({ title, values, icon: Icon, subtitle, accent }) => (
                    <section
                      key={title}
                      className={`stat ${accent ? "accent" : ""}`}
                    >
                      <div>
                        {title}
                        <Icon size={19} />
                      </div>
                      <h2>
                        <Money amounts={values} />
                      </h2>
                      <small>{subtitle}</small>
                    </section>
                  ))}
                </div>
              )}
              {view === "Reports" && (
                <ReportsPage
                  key={books.path}
                  books={books}
                  desktop={desktop}
                  onSaved={setBooks}
                />
              )}
              {view === "Tax" && (
                <TaxPage
                  key={books.path}
                  books={books}
                  desktop={desktop}
                  onSaved={setBooks}
                  onDirty={setTaxDirty}
                  onReports={() => {
                    if (
                      taxDirty &&
                      !window.confirm("Discard unsaved tax workspace changes?")
                    )
                      return;
                    setTaxDirty(false);
                    setView("Reports");
                  }}
                />
              )}
              {view === "Review" && (
                <ReviewPage
                  key={books.path}
                  books={books}
                  desktop={desktop}
                  onSaved={setBooks}
                />
              )}
              <div className={view === "Overview" ? "overview-grid" : ""}>
                {(view === "Overview" || view === "Transactions") && (
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>
                          {view === "Overview"
                            ? "Recent transactions"
                            : "Transaction register"}
                        </h2>
                        <p>
                          {books.transactions.length} entries in your journal
                        </p>
                      </div>
                      {view === "Overview" ? (
                        <button
                          className="text-button"
                          onClick={() => setView("Transactions")}
                        >
                          View all <ChevronRight size={15} />
                        </button>
                      ) : (
                        <label className="search">
                          <Search size={16} />
                          <input
                            placeholder="Search transactions"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                          />
                        </label>
                      )}
                    </div>
                    <div className="transaction-list">
                      {(view === "Overview"
                        ? transactions.slice(0, 6)
                        : transactions
                      ).map((t, i) => (
                        <details className="transaction" key={`${t.date}-${i}`}>
                          <summary>
                            <span className="transaction-icon">
                              <List size={17} />
                            </span>
                            <span className="transaction-info">
                              <strong>{t.description}</strong>
                              <small>
                                {t.date} <span>·</span> {t.postings.length}{" "}
                                postings
                              </small>
                            </span>
                            <span className="transaction-amount">
                              <Money amounts={t.postings[0]?.amounts ?? []} />
                              <small>{t.postings[0]?.account}</small>
                            </span>
                            <ChevronRight className="disclosure" size={15} />
                          </summary>
                          <div className="postings">
                            {t.postings.map((p, j) => (
                              <div key={j}>
                                <span>{p.account}</span>
                                <Money amounts={p.amounts} />
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                      {transactions.length === 0 && (
                        <div className="empty">
                          {query
                            ? "No matching transactions."
                            : "Your first transaction starts here. Add an entry to bring your books to life."}
                        </div>
                      )}
                    </div>
                    <div className="panel-foot">
                      <ShieldCheck size={14} />
                      Amounts show the first posting. Expand an entry to see
                      every account.
                    </div>
                  </section>
                )}
                {(view === "Overview" || view === "Accounts") && (
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>
                          {view === "Overview"
                            ? "Account balances"
                            : "Chart of accounts"}
                        </h2>
                        <p>{books.accounts.length} accounts · by commodity</p>
                      </div>
                      {view === "Accounts" && (
                        <label className="search">
                          <Search size={16} />
                          <input
                            placeholder="Search accounts"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                          />
                        </label>
                      )}
                    </div>
                    <div className="accounts">
                      {(view === "Overview"
                        ? accounts.filter((a) =>
                            /^(assets|liabilities)(:|$)/.test(a.name),
                          )
                        : accounts
                      ).map((a) => (
                        <div className="account" key={a.name}>
                          <span className="account-symbol">
                            <Wallet size={16} />
                          </span>
                          <div>
                            <strong>
                              {a.name
                                .split(":")
                                .slice(-1)[0]
                                ?.replace(/-/g, " ")}
                            </strong>
                            <small>{a.name}</small>
                          </div>
                          <Money amounts={a.amounts} />
                        </div>
                      ))}
                      {accounts.length === 0 && (
                        <div className="empty">
                          {query
                            ? "No matching accounts."
                            : "Accounts appear as you add transactions."}
                        </div>
                      )}
                    </div>
                    {view === "Overview" && (
                      <button
                        className="account-link"
                        onClick={() => setView("Accounts")}
                      >
                        See all accounts <ChevronRight size={15} />
                      </button>
                    )}
                  </section>
                )}
              </div>
              <footer className="page-footer">
                <span>
                  <i />
                  {books.version}
                </span>
                <span>
                  Amounts stay separate by currency · Account prefixes define
                  overview totals
                </span>
              </footer>
            </>
          )}
        </div>
      </main>
      {importing && books?.company && (
        <ImportDialog
          books={books}
          onClose={() => setImporting(false)}
          onImported={imported}
        />
      )}
      {creating && (
        <CompanyDialog
          busy={busy}
          error={error}
          initialSource={books && !books.company ? books.path : null}
          onClose={() => setCreating(false)}
          onSave={createCompany}
        />
      )}
      {adding && books && (
        <EntryDialog
          accounts={books.accounts.map((a) => a.name)}
          currency={books.company?.currency ?? "USD"}
          busy={busy}
          error={error}
          onClose={() => setAdding(false)}
          onSave={add}
        />
      )}
    </div>
  );
}
function EntryDialog({
  accounts,
  currency,
  busy,
  error,
  onClose,
  onSave,
}: {
  accounts: string[];
  currency: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (e: Entry) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [entry, setEntry] = useState<Entry>({
    date: today(),
    description: "",
    debit: "expenses:",
    credit:
      accounts.find((a) => a.startsWith("assets:")) ?? "assets:bank:checking",
    amount: "",
    commodity: currency,
  });
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const field = (key: keyof Entry, value: string) =>
    setEntry((prev) => ({ ...prev, [key]: value }));
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(entry);
        }}
      >
        <div className="dialog-heading">
          <div>
            <div className="eyebrow">KEEP YOUR BOOKS CURRENT</div>
            <h2>Add a transaction</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close transaction form"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p className="dialog-intro">
          Record a balanced entry between two accounts.
        </p>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <label>
          Description
          <input
            autoFocus
            required
            maxLength={240}
            placeholder="e.g. Office supplies"
            value={entry.description}
            onChange={(e) => field("description", e.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            Date
            <input
              required
              type="date"
              value={entry.date}
              onChange={(e) => field("date", e.target.value)}
            />
          </label>
          <label>
            Amount
            <input
              required
              inputMode="decimal"
              placeholder="0.00"
              value={entry.amount}
              onChange={(e) => field("amount", e.target.value)}
            />
          </label>
          <label>
            Currency
            <input
              required
              maxLength={12}
              value={entry.commodity}
              onChange={(e) => field("commodity", e.target.value.toUpperCase())}
            />
          </label>
        </div>
        <datalist id="accounts">
          {accounts.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        <label>
          Debit account <small>Expense or destination account</small>
          <input
            required
            list="accounts"
            value={entry.debit}
            onChange={(e) => field("debit", e.target.value)}
          />
        </label>
        <label>
          Credit account <small>Payment source or income account</small>
          <input
            required
            list="accounts"
            value={entry.credit}
            onChange={(e) => field("credit", e.target.value)}
          />
        </label>
        <div className="entry-hint">
          <ShieldCheck size={17} />
          hledger validates the journal before saving. A backup is created
          automatically.
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Validating…" : "Save transaction"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function CompanyDialog({
  busy,
  error,
  initialSource,
  onClose,
  onSave,
}: {
  busy: boolean;
  error: string;
  initialSource: string | null;
  onClose: () => void;
  onSave: (details: CompanyDetails, source: string | null) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [source, setSource] = useState<string | null>(initialSource);
  const [pickerError, setPickerError] = useState("");
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function pickJournal() {
    setPicking(true);
    setPickerError("");
    try {
      const chosen = await open({
        title: "Import an existing journal",
        multiple: false,
        directory: false,
        filters,
      });
      if (chosen) setSource(chosen);
    } catch (e) {
      setPickerError(String(e));
    } finally {
      setPicking(false);
    }
  }
  return (
    <dialog
      ref={ref}
      aria-labelledby="company-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy && !picking) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({ name: name.trim(), currency }, source);
        }}
      >
        <div className="dialog-heading">
          <div>
            <div className="eyebrow">YOUR BUSINESS, TOGETHER</div>
            <h2 id="company-title">New company</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close company form"
            disabled={busy || picking}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p className="dialog-intro">
          Save your company details and accounting journal together in a
          portable .bky file.
        </p>
        {(error || pickerError) && (
          <div className="banner error" role="alert">
            {error || pickerError}
          </div>
        )}
        <label>
          Company name
          <input
            autoFocus
            required
            maxLength={120}
            placeholder="e.g. Wright Consulting"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Default currency
          <input
            required
            pattern="[A-Z]{3}"
            maxLength={3}
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
          <small>
            Used for new entries. Existing amounts keep their original
            currencies.
          </small>
        </label>
        <div className="company-import">
          <strong>Starting books</strong>
          <p>{source ?? "Start with an empty journal."}</p>
          <button
            type="button"
            className="text-button"
            disabled={busy || picking}
            onClick={pickJournal}
          >
            <FolderOpen size={15} />
            Import journal
          </button>
          {source && (
            <button
              type="button"
              className="text-button"
              disabled={busy || picking}
              onClick={() => setSource(null)}
            >
              Start empty instead
            </button>
          )}
        </div>
        <div className="entry-hint">
          <ShieldCheck size={17} />
          Choose where to save next. Existing company files and imported
          journals will not be overwritten.
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy || picking}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="primary" disabled={busy || picking}>
            {busy ? "Creating…" : "Choose location & create"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
