import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { connectOffice, officeAudit } from "./backend";
import type { Snapshot } from "./model";
const actionLabels: Record<string, string> = {
  add_entry: "Added a transaction",
  import_statement: "Imported a statement",
  categorize_review: "Categorized transactions",
  save_workspace: "Saved reports or tax settings",
  "local change": "Changed books on the host",
};
interface Status {
  enabled: boolean;
  running: boolean;
  address: string;
  port: number;
  company: string;
  error: string | null;
  users: { id: string; name: string; role: string }[];
  savedConnection: string | null;
}
export default function OfficeNetwork({
  books,
  onConnected,
  beforeConnect,
  onClose,
}: {
  books: Snapshot | null;
  onConnected: (snapshot: Snapshot) => void;
  onClose: () => void;
  beforeConnect?: () => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const hostingEnabled = !!(status?.enabled || status?.running);
  const [address, setAddress] = useState("");
  const [port, setPort] = useState(47831);
  const [path, setPath] = useState(
    books?.office ? "" : books?.company ? books.path : "",
  );
  const [name, setName] = useState("");
  const [role, setRole] = useState("editor");
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [audit, setAudit] = useState<
    { at: string; actor: string; action: string }[] | null
  >(null);
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    invoke<Status>("office_status")
      .then((s) => {
        if (active) {
          setStatus(s);
          setAddress(s.address);
          setPort(s.port);
          if (s.company) setPath(s.company);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
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
  return (
    <dialog
      className="office-dialog"
      ref={dialog}
      aria-labelledby="office-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2 id="office-title">Office network</h2>
          <p>Share one company from a computer in your office.</p>
        </div>
        <button
          disabled={busy}
          onClick={onClose}
          aria-label="Close office network"
        >
          <X size={20} />
        </button>
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {status?.error && (
        <div className="banner error" role="alert">
          {status.error}
        </div>
      )}
      <section className="office-section">
        <h3>Connect to an office server</h3>
        <p>
          Ask the host for your personal access code. It identifies your access
          and verifies the encrypted connection. Keep it private.
        </p>
        <label>
          Access code
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={3}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <button
          className="primary"
          disabled={busy || (!code.trim() && !status?.savedConnection)}
          onClick={() =>
            task(async () => {
              if (beforeConnect && !beforeConnect()) return;
              const snapshot = await connectOffice(code.trim());
              onConnected(snapshot);
              onClose();
            })
          }
        >
          {code.trim()
            ? "Connect"
            : status?.savedConnection
              ? `Reconnect to ${status.savedConnection}`
              : "Connect"}
        </button>
        {books?.office && (
          <p>
            Connected to {books.office.address} as {books.office.name} ·{" "}
            {books.office.role === "reader" ? "Read-only" : "Editor"}. Open a
            local company to leave this connection.
          </p>
        )}
        {books?.office && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => task(async () => setAudit(await officeAudit()))}
          >
            View recent changes
          </button>
        )}
        {audit && (
          <ul className="office-audit">
            {audit.length ? (
              audit.map((event, i) => (
                <li key={i}>
                  <strong>{event.actor}</strong> ·{" "}
                  {actionLabels[event.action] ?? "Updated company"}
                  <small>{new Date(event.at).toLocaleString()}</small>
                </li>
              ))
            ) : (
              <li>No recorded changes yet.</li>
            )}
          </ul>
        )}
      </section>
      <section className="office-section">
        <h3>Host on this computer</h3>
        <p>
          The company stays on this computer. Keep it awake with LedgerTrails
          running. Once enabled, hosting resumes whenever LedgerTrails opens.
          Closing the app stops access.
        </p>
        {status && (
          <p role="status">
            <strong>
              {status.running ? "Hosting is on" : "Hosting is off"}
            </strong>
            {status.running && ` · ${status.address}:${status.port}`}
          </p>
        )}
        <label>
          Company to share
          <input
            readOnly
            value={path}
            placeholder="Choose a .bky company file"
          />
        </label>
        <button
          className="secondary"
          disabled={busy || !status || status.running}
          onClick={() =>
            task(async () => {
              const chosen = await open({
                multiple: false,
                directory: false,
                filters: [{ name: "Company", extensions: ["bky"] }],
              });
              if (chosen) setPath(chosen);
            })
          }
        >
          Choose company to share
        </button>
        <div className="office-fields">
          <label>
            Host IPv4 address
            <input
              value={address}
              disabled={busy || status?.running}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <label>
            Port
            <input
              type="number"
              min={1024}
              max={65535}
              value={port}
              disabled={busy || status?.running}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </label>
        </div>
        <p>
          Use the host’s private office address (for example, 192.168.1.20).
          Allow the selected TCP port through its firewall on the private office
          network. Keep the address fixed in your router. Do not forward this
          port to the internet.
        </p>
        <p>
          Changing the shared company, address, or port invalidates previous
          access codes.
        </p>
        <button
          className={hostingEnabled ? "secondary" : "primary"}
          disabled={
            busy ||
            !status ||
            (!hostingEnabled &&
              (!path ||
                !address ||
                !Number.isInteger(port) ||
                port < 1024 ||
                port > 65535))
          }
          onClick={() =>
            task(async () => {
              if (hostingEnabled) {
                await invoke("office_stop");
                setStatus(await invoke<Status>("office_status"));
              } else {
                await invoke("office_configure", { path, address, port });
                setInvite("");
                setStatus(await invoke<Status>("office_start"));
              }
            })
          }
        >
          {hostingEnabled ? "Turn off hosting" : "Enable hosting"}
        </button>
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            task(async () => setStatus(await invoke<Status>("office_status")))
          }
        >
          Refresh server status
        </button>
      </section>
      {status?.company && (
        <section className="office-section">
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              task(async () => setAudit(await invoke("office_history")))
            }
          >
            View host company changes
          </button>
          <h3>Coworker access</h3>
          <p>
            Each code grants access to the shared company until revoked. Give
            each coworker their own code; changes are attributed to that name.
          </p>
          <div className="office-fields">
            <label>
              Coworker name
              <input
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Access
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="editor">Editor</option>
                <option value="reader">Read-only</option>
              </select>
            </label>
          </div>
          <button
            className="secondary"
            disabled={busy || !name.trim()}
            onClick={() =>
              task(async () => {
                setInvite(
                  await invoke<string>("office_invite", {
                    name: name.trim(),
                    role,
                  }),
                );
                setStatus(await invoke<Status>("office_status"));
                setName("");
              })
            }
          >
            Create access code
          </button>
          {invite && (
            <label>
              New access code — copy and give to this coworker
              <textarea
                readOnly
                value={invite}
                rows={4}
                onFocus={(e) => e.target.select()}
              />
              <small>
                This code is shown only here. Create a new code if it is lost.
              </small>
            </label>
          )}
          <ul className="office-users">
            {status.users.map((user) => (
              <li key={user.id}>
                <span>
                  {user.name} ·{" "}
                  {user.role === "reader" ? "Read-only" : "Editor"}
                </span>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    task(async () => {
                      setStatus(
                        await invoke<Status>("office_revoke", { id: user.id }),
                      );
                      setInvite("");
                    })
                  }
                >
                  Revoke {user.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </dialog>
  );
}
