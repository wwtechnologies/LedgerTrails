import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import type { Snapshot } from "./model";
let remote = false;
const shared = new Set([
  "refresh_journal",
  "save_company",
  "add_entry",
  "review_statement",
  "import_statement",
  "list_review",
  "categorize_review",
  "read_workspace",
  "save_workspace",
  "export_document",
  "copy_company",
]);
export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const wasRemote = remote && shared.has(command);
  const result = await nativeInvoke<T>(
    wasRemote ? "office_request" : command,
    wasRemote ? { command, args: args ?? {} } : args,
  );
  if (
    [
      "open_company",
      "open_journal",
      "create_company",
      "restore_company",
    ].includes(command)
  )
    remote = false;
  if (wasRemote && command === "copy_company" && args?.switch) {
    // Save As creates a local company; select it in the local backend too.
    const snapshot = await nativeInvoke<T>("open_company", { path: args.path });
    remote = false;
    return snapshot;
  }
  return result;
}
export async function connectOffice(code: string): Promise<Snapshot> {
  const snapshot = await nativeInvoke<Snapshot>("office_connect", {
    code: code || null,
  });
  remote = true;
  return snapshot;
}
export async function officeAudit(): Promise<
  { at: string; actor: string; action: string }[]
> {
  return nativeInvoke("office_request", { command: "audit", args: {} });
}
