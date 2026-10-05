import type { Snapshot } from "./model";

export const RECENT_BOOKS_KEY = "ledgertrails.recent-books.v1";
export interface RecentBook {
  path: string;
  name: string;
  kind: "company" | "journal";
}

export function readRecentBooks(): RecentBook[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(RECENT_BOOKS_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    const paths = new Set<string>();
    return value
      .filter((entry): entry is RecentBook => {
        if (
          !entry ||
          typeof entry.path !== "string" ||
          !entry.path.trim() ||
          typeof entry.name !== "string" ||
          !entry.name.trim() ||
          !["company", "journal"].includes(entry.kind) ||
          paths.has(entry.path)
        )
          return false;
        paths.add(entry.path);
        return true;
      })
      .slice(0, 10);
  } catch {
    return [];
  }
}

export function rememberBook(
  recent: RecentBook[],
  books: Snapshot,
): RecentBook[] {
  return [
    {
      path: books.path,
      name:
        books.company?.name || books.path.split(/[\\/]/).pop() || books.path,
      kind: books.company ? ("company" as const) : ("journal" as const),
    },
    ...recent.filter((entry) => entry.path !== books.path),
  ].slice(0, 10);
}

export function writeRecentBooks(recent: RecentBook[]): boolean {
  try {
    localStorage.setItem(RECENT_BOOKS_KEY, JSON.stringify(recent));
    return true;
  } catch {
    return false;
  }
}
