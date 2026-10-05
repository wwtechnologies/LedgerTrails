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
