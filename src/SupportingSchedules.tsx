import { useState, type FormEvent } from "react";
import type { Budget, Schedule, ScheduleKind, Workspace } from "./workspace";
import { validDate } from "./reports";
export default function SupportingSchedules({
  value,
  persist,
  disabled,
  currency,
  end,
  start,
}: {
  value: Workspace;
  persist: (v: Workspace) => Promise<boolean>;
  disabled: boolean;
  currency: string;
  end: string;
  start: string;
}) {
  const [kind, setKind] = useState<ScheduleKind>("invoice"),
    [error, setError] = useState("");
  async function add(e: FormEvent<HTMLFormElement>, budget = false) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    const get = (key: string) => String(data.get(key) || "").trim();
    setError("");
    try {
      const n = get("amount");
      if (!/^\d+(\.\d+)?$/.test(n))
        throw Error("Use a nonnegative decimal amount.");
      if (budget) {
        const b: Budget = {
          id: crypto.randomUUID(),
          account: get("account"),
          start: get("start"),
          end: get("end"),
          amount: n,
          currency: get("currency"),
        };
        if (!validDate(b.start) || !validDate(b.end) || b.start > b.end)
          throw Error("Choose a valid budget period.");
        if (await persist({ ...value, budgets: [...value.budgets, b] }))
          form.reset();
      } else {
        const row: Schedule = {
          id: crypto.randomUUID(),
          kind,
          name: get("name"),
          reference: get("reference"),
          date: get("date"),
          due: get("due"),
          as_of: get("as_of"),
          amount: n,
          currency: get("currency"),
          notes: get("notes"),
        };
        if (
          !validDate(row.date) ||
          !validDate(row.as_of) ||
          row.date > row.as_of ||
          (row.due && !validDate(row.due))
        )
          throw Error("Check the date and as-of date.");
        if (await persist({ ...value, schedules: [...value.schedules, row] }))
          form.reset();
      }
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="supporting">
      <h2>Supporting schedules</h2>
      <p>
        These records support reports and tax preparation. They do not post
        transactions or change ledger balances. Use the exact report end date
        for outstanding balances, assets, and inventory snapshots.
      </p>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={(e) => add(e)}>
        <fieldset disabled={disabled}>
          <legend>Add a supporting record</legend>
          <div className="field-grid">
            <label>
              Schedule
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as ScheduleKind)}
              >
                <option value="invoice">Open customer invoice</option>
                <option value="bill">Open vendor bill</option>
                <option value="asset">Asset cost register</option>
                <option value="inventory">Inventory carrying value</option>
                <option value="contractor">Contractor payment</option>
              </select>
            </label>
            <label>
              Name / customer / vendor
              <input required name="name" />
            </label>
            <label>
              Reference / document number
              <input name="reference" />
            </label>
            <label>
              {kind === "asset"
                ? "Placed-in-service date"
                : "Document / payment date"}
              <input required type="date" name="date" defaultValue={end} />
            </label>
            {(kind === "invoice" || kind === "bill") && (
              <label>
                Due date
                <input required type="date" name="due" defaultValue={end} />
              </label>
            )}
            <label>
              Balance / record as of
              <input required type="date" name="as_of" defaultValue={end} />
            </label>
            <label>
              {kind === "invoice" || kind === "bill"
                ? "Outstanding amount after payments"
                : kind === "asset"
                  ? "Acquisition cost"
                  : kind === "inventory"
                    ? "Inventory value"
                    : "Payment amount"}
              <input
                required
                name="amount"
                inputMode="decimal"
                placeholder="0.00"
              />
            </label>
            <label>
              Currency
              <input
                required
                name="currency"
                defaultValue={currency}
                pattern="[A-Z]{3}"
              />
            </label>
            <label className="wide">
              Supporting notes
              <input
                name="notes"
                placeholder={
                  kind === "contractor"
                    ? "Payment method, W-9 status, business purpose (keep tax IDs in secure source documents)"
                    : kind === "asset"
                      ? "Business-use percentage, prior depreciation, disposal details, source document"
                      : "Source document, account, and any remaining reconciliation details"
                }
              />
            </label>
          </div>
          <button className="primary">Save supporting record</button>
        </fieldset>
      </form>
      <div className="report-scroll">
        <table>
          <thead>
            <tr>
              <th>Schedule</th>
              <th>Name / reference</th>
              <th>As of</th>
              <th>Amount</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {value.schedules.map((x) => (
              <tr key={x.id}>
                <td>{x.kind}</td>
                <td>
                  {x.name}
                  <small>{x.reference}</small>
                </td>
                <td>{x.as_of}</td>
                <td>
                  {x.amount} {x.currency}
                </td>
                <td>
                  <button
                    className="text-button"
                    disabled={disabled}
                    onClick={() =>
                      persist({
                        ...value,
                        schedules: value.schedules.filter((r) => r.id !== x.id),
                      })
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={(e) => add(e, true)}>
        <fieldset disabled={disabled}>
          <legend>Add an account budget</legend>
          <div className="field-grid">
            <label>
              Exact income / expense account
              <input
                name="account"
                required
                placeholder="expenses:cloud-server"
                pattern="(income|expenses):.+"
              />
            </label>
            <label>
              Start
              <input name="start" type="date" required defaultValue={start} />
            </label>
            <label>
              End
              <input name="end" type="date" required defaultValue={end} />
            </label>
            <label>
              Budget amount
              <input name="amount" required inputMode="decimal" />
            </label>
            <label>
              Currency
              <input
                name="currency"
                required
                defaultValue={currency}
                pattern="[A-Z]{3}"
              />
            </label>
          </div>
          <button className="primary">Save budget</button>
        </fieldset>
      </form>
      {value.budgets.map((b) => (
        <p key={b.id}>
          {b.account} · {b.start} to {b.end} · {b.amount} {b.currency}{" "}
          <button
            disabled={disabled}
            className="text-button"
            onClick={() =>
              persist({
                ...value,
                budgets: value.budgets.filter((x) => x.id !== b.id),
              })
            }
          >
            Remove budget
          </button>
        </p>
      ))}
    </div>
  );
}
