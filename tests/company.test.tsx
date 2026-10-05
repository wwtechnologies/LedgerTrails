import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "../src/App";
import sample from "../src/sample.json";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: () => true,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
  save: mocks.save,
}));
const current = { ...sample, path: "/books/example.bky", revision: "original" };
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});
async function openCompany() {
  mocks.open.mockResolvedValueOnce(current.path);
  mocks.invoke.mockResolvedValueOnce(current);
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open company", exact: true }),
  );
  await screen.findByRole("button", { name: "Back up", exact: true });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Back up", exact: true }),
    ).toBeEnabled(),
  );
}
test("opening a local company uses the company backend and shows its name", async () => {
  await openCompany();
  expect(mocks.invoke).toHaveBeenCalledWith("open_company", {
    path: current.path,
  });
  expect(screen.getAllByText("Sample Company").length).toBeGreaterThan(0);
});
test("backup preserves active company and adds the .bkybk extension", async () => {
  await openCompany();
  mocks.save.mockResolvedValueOnce("/backups/safe");
  mocks.invoke.mockResolvedValueOnce({
    ...current,
    path: "/backups/safe.bkybk",
  });
  fireEvent.click(screen.getByRole("button", { name: "Back up", exact: true }));
  await screen.findByText(/Backup created:/);
  expect(mocks.invoke).toHaveBeenLastCalledWith("copy_company", {
    path: "/backups/safe.bkybk",
    revision: "original",
    switch: false,
  });
  expect(screen.getByTitle(current.path)).toBeInTheDocument();
});
test("save as switches to the new company only after success", async () => {
  await openCompany();
  mocks.save.mockResolvedValueOnce("/books/copy.bky");
  mocks.invoke.mockResolvedValueOnce({ ...current, path: "/books/copy.bky" });
  fireEvent.click(screen.getByRole("button", { name: "Save as", exact: true }));
  await screen.findByTitle("/books/copy.bky");
  expect(mocks.invoke).toHaveBeenLastCalledWith("copy_company", {
    path: "/books/copy.bky",
    revision: "original",
    switch: true,
  });
});
test("restore selects a local source and creates a separate company file", async () => {
  mocks.open.mockResolvedValueOnce("/backups/safe.bkybk");
  mocks.save.mockResolvedValueOnce("/books/restored");
  mocks.invoke.mockResolvedValueOnce({
    ...current,
    path: "/books/restored.bky",
  });
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Restore backup or local company copy",
    }),
  );
  await screen.findByText(/Company restored to a new file/);
  expect(mocks.invoke).toHaveBeenCalledWith("restore_company", {
    source: "/backups/safe.bkybk",
    path: "/books/restored.bky",
  });
});
test("cancelled backup and failed restore leave the active file unchanged", async () => {
  await openCompany();
  mocks.save.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole("button", { name: "Back up", exact: true }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Restore", exact: true }),
    ).toBeEnabled(),
  );
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  mocks.open.mockResolvedValueOnce("/backups/bad.bkybk");
  mocks.save.mockResolvedValueOnce("/books/restored.bky");
  mocks.invoke.mockRejectedValueOnce("Invalid company file");
  fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Invalid company file",
  );
  expect(screen.getByTitle(current.path)).toBeInTheDocument();
});
test("new company collects business details and preserves the selected currency for entries", async () => {
  mocks.save.mockResolvedValueOnce("/books/new");
  mocks.invoke.mockResolvedValueOnce({
    ...current,
    company: { name: "My Business", currency: "EUR" },
    path: "/books/new.bky",
  });
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "New company", exact: true }),
  );
  fireEvent.change(screen.getByLabelText("Company name"), {
    target: { value: "My Business" },
  });
  fireEvent.change(screen.getByLabelText(/Default currency/), {
    target: { value: "EUR" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Choose location & create" }),
  );
  await screen.findByText(/Company file created/);
  expect(mocks.invoke).toHaveBeenCalledWith("create_company", {
    path: "/books/new.bky",
    details: { name: "My Business", currency: "EUR" },
    source: null,
    sample: false,
  });
  fireEvent.click(screen.getByRole("button", { name: "Add transaction" }));
  expect(screen.getByLabelText("Currency")).toHaveValue("EUR");
});
test("save flushes the active company revision", async () => {
  await openCompany();
  mocks.invoke.mockResolvedValueOnce(current);
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await screen.findByText(/Company file saved/);
  expect(mocks.invoke).toHaveBeenLastCalledWith("save_company", {
    revision: "original",
  });
});

test("recent companies survive reopening the app and bypass the file picker", async () => {
  mocks.open.mockResolvedValueOnce(current.path);
  mocks.invoke.mockResolvedValueOnce(current);
  const first = render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open company", exact: true }),
  );
  await screen.findByRole("button", { name: "Open recent Sample Company" });
  first.unmount();
  mocks.open.mockClear();
  mocks.invoke.mockResolvedValueOnce(current);
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open recent Sample Company" }),
  );
  await screen.findByRole("button", { name: "Back up", exact: true });
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenLastCalledWith("open_company", {
    path: current.path,
  });
});

test("failed recent opens preserve the active book and allow removal of the shortcut", async () => {
  localStorage.setItem(
    "ledgertrails.recent-books.v1",
    JSON.stringify([
      { path: "/missing.bky", name: "Missing Company", kind: "company" },
    ]),
  );
  await openCompany();
  mocks.invoke.mockRejectedValueOnce("File not found");
  fireEvent.click(
    screen.getByRole("button", { name: "Open recent Missing Company" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("File not found");
  expect(screen.getByTitle(current.path)).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Remove Missing Company from recent books",
    }),
  );
  expect(
    screen.queryByRole("button", { name: "Open recent Missing Company" }),
  ).not.toBeInTheDocument();
  expect(localStorage.getItem("ledgertrails.recent-books.v1")).not.toContain(
    "/missing.bky",
  );
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

test("recent journals use the journal backend and can be cleared without file operations", async () => {
  localStorage.setItem(
    "ledgertrails.recent-books.v1",
    JSON.stringify([
      { path: "/books/old.journal", name: "old.journal", kind: "journal" },
    ]),
  );
  mocks.invoke.mockResolvedValueOnce({
    ...current,
    company: null,
    path: "/books/old.journal",
  });
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open recent old.journal" }),
  );
  await screen.findByTitle("/books/old.journal");
  expect(mocks.invoke).toHaveBeenCalledWith("open_journal", {
    path: "/books/old.journal",
  });
  fireEvent.click(screen.getByRole("button", { name: "Clear recent books" }));
  expect(
    JSON.parse(localStorage.getItem("ledgertrails.recent-books.v1")!),
  ).toEqual([]);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

test("corrupt recent-book storage and unavailable storage do not prevent opening a company", async () => {
  localStorage.setItem("ledgertrails.recent-books.v1", "not JSON");
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  try {
    await openCompany();
    expect(screen.getByTitle(current.path)).toBeInTheDocument();
    expect(
      await screen.findByText(/Recent books could not be saved/),
    ).toBeInTheDocument();
  } finally {
    storage.mockRestore();
  }
});

test("recent books are deduplicated, newest first, capped at ten, and exclude backups", async () => {
  localStorage.setItem(
    "ledgertrails.recent-books.v1",
    JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({
        path: `/books/${i}.bky`,
        name: `Company ${i}`,
        kind: "company",
      })),
    ),
  );
  await openCompany();
  let recent = JSON.parse(
    localStorage.getItem("ledgertrails.recent-books.v1")!,
  );
  expect(recent).toHaveLength(10);
  expect(recent[0].path).toBe(current.path);
  expect(recent.some((r: { path: string }) => r.path === "/books/9.bky")).toBe(
    false,
  );
  mocks.invoke.mockResolvedValueOnce(current);
  fireEvent.click(
    screen.getByRole("button", { name: "Open recent Sample Company" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Back up", exact: true }),
    ).toBeEnabled(),
  );
  recent = JSON.parse(localStorage.getItem("ledgertrails.recent-books.v1")!);
  expect(
    recent.filter((r: { path: string }) => r.path === current.path),
  ).toHaveLength(1);
  mocks.save.mockResolvedValueOnce("/backups/safe.bkybk");
  mocks.invoke.mockResolvedValueOnce({
    ...current,
    path: "/backups/safe.bkybk",
  });
  fireEvent.click(screen.getByRole("button", { name: "Back up", exact: true }));
  await screen.findByText(/Backup created:/);
  expect(localStorage.getItem("ledgertrails.recent-books.v1")).not.toContain(
    "safe.bkybk",
  );
});
