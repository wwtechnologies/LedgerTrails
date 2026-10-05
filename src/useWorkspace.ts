import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as chooseSave } from "@tauri-apps/plugin-dialog";
import type { Snapshot } from "./model";
import { emptyWorkspace, type Workspace } from "./workspace";
export function useWorkspace(
  books: Snapshot,
  desktop: boolean,
  onSaved: (b: Snapshot) => void,
) {
  const [value, setValue] = useState<Workspace>(emptyWorkspace),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    if (!desktop || !books.company) {
      setValue(emptyWorkspace());
      setLoading(false);
      return;
    }
    invoke<Workspace>("read_workspace", { revision: books.revision })
      .then((v) => {
        if (active) setValue(v);
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [books.path, books.revision, desktop]);
  async function persist(next: Workspace) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke<Snapshot>("save_workspace", {
        revision: books.revision,
        value: next,
      });
      setValue(next);
      onSaved(result);
      setNotice("Saved in the company file. An automatic backup was created.");
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { value, loading, saving, error, notice, persist };
}
export async function exportFile(
  books: Snapshot,
  desktop: boolean,
  name: string,
  extension: "csv" | "html",
  content: string,
) {
  if (desktop) {
    const path = await chooseSave({
      defaultPath: `${name}.${extension}`,
      filters: [
        {
          name: extension === "csv" ? "CSV report" : "Printable HTML report",
          extensions: [extension],
        },
      ],
    });
    if (!path) return false;
    await invoke("export_document", {
      path: path.toLowerCase().endsWith("." + extension)
        ? path
        : path + "." + extension,
      content,
      revision: books.revision,
    });
  } else {
    const blob = new Blob([content], {
      type:
        extension === "csv"
          ? "text/csv;charset=utf-8"
          : "text/html;charset=utf-8",
    });
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `${name}.${extension}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return true;
}
