import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ImportDialog from "../src/ImportDialog";
import sample from "../src/sample.json";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
const base = {
  source: "Bank of America statement",
  category: "",
  check: "",
  line: 1,
};
const parsed = {
  bank: "Bank of America",
  file_revision: "csv-hash",
  sources: [base.source],
  credits: "25.00",
  debits: "10.00",
  warnings: ["Opening balance is optional."],
  rows: [
    {
      ...base,
      index: 0,
      id: "opening",
      date: "2025-01-01",
      description: "Beginning balance",
      amount: "100.00",
      opening: true,
    },
    {
      ...base,
      index: 1,
      id: "fee",
      date: "2025-01-02",
      description: "Bank fee",
      amount: "-10.00",
      opening: false,
    },
    {
      ...base,
      index: 2,
      id: "deposit",
      date: "2025-01-03",
      description: "Deposit",
      amount: "25.00",
      opening: false,
    },
  ],
};
const preview = {
  parsed,
  rows: parsed.rows.map((r) => ({ ...r, duplicate: r.index === 2 })),
};
beforeEach(() => {
  vi.resetAllMocks();
});
async function setup() {
  const onImported = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  mocks.open.mockResolvedValueOnce("/private/bank.csv");
  mocks.invoke.mockResolvedValueOnce(parsed).mockResolvedValueOnce(preview);
  render(
    <ImportDialog
      books={{ ...sample, revision: "company-hash" }}
      onClose={onClose}
      onImported={onImported}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose statement CSV" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Review transactions" }),
    ).toBeEnabled(),
  );
  return { onImported, onClose };
}
async function review() {
  fireEvent.click(screen.getByRole("button", { name: "Review transactions" }));
  await screen.findByRole("button", { name: "Import 1 transactions" });
}
test("preview does not save; excludes opening balances and existing rows by default", async () => {
  await setup();
  await review();
  expect(screen.getByLabelText("Import row 1")).not.toBeChecked();
  expect(screen.getByLabelText("Import row 2")).toBeChecked();
  expect(screen.getByLabelText("Import row 3")).toBeDisabled();
  expect(mocks.invoke.mock.calls.map((c) => c[0])).toEqual([
    "parse_statement",
    "review_statement",
  ]);
});
test("commit sends only selected rows and reviewed categories", async () => {
  const { onImported } = await setup();
  await review();
  fireEvent.change(screen.getByLabelText("Category for row 2"), {
    target: { value: "expenses:bank-fees" },
  });
  mocks.invoke.mockResolvedValueOnce({ imported: 1, skipped: 0 });
  fireEvent.click(
    screen.getByRole("button", { name: "Import 1 transactions" }),
  );
  await waitFor(() =>
    expect(onImported).toHaveBeenCalledWith({ imported: 1, skipped: 0 }),
  );
  expect(mocks.invoke).toHaveBeenLastCalledWith("import_statement", {
    request: {
      path: "/private/bank.csv",
      file_revision: "csv-hash",
      revision: "company-hash",
      mappings: { [base.source]: "assets:bank:bank-of-america" },
      currency: "USD",
      selections: [{ index: 1, category: "expenses:bank-fees" }],
    },
  });
});
test("account mapping is reviewed and opening balance requires explicit selection", async () => {
  await setup();
  fireEvent.change(screen.getByLabelText(`Booky account for ${base.source}`), {
    target: { value: "assets:bank:checking" },
  });
  await review();
  expect(mocks.invoke).toHaveBeenLastCalledWith(
    "review_statement",
    expect.objectContaining({
      mappings: { [base.source]: "assets:bank:checking" },
    }),
  );
  fireEvent.click(screen.getByLabelText("Import row 1"));
  expect(
    screen.getByRole("button", { name: "Import 2 transactions" }),
  ).toBeEnabled();
  expect(screen.getByLabelText("Category for row 1")).toHaveValue(
    "equity:opening-balances",
  );
});
test("bulk categorization affects selected visible transactions only", async () => {
  await setup();
  await review();
  fireEvent.change(
    screen.getByLabelText("Category for selected visible rows"),
    { target: { value: "expenses:bank-fees" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Apply to selected visible rows" }),
  );
  expect(screen.getByLabelText("Category for row 2")).toHaveValue(
    "expenses:bank-fees",
  );
  expect(screen.getByLabelText("Category for row 1")).toHaveValue(
    "equity:opening-balances",
  );
  expect(screen.getByLabelText("Category for row 3")).toHaveValue(
    "equity:unassigned",
  );
});
test("failed import keeps the preview and does not report success", async () => {
  const { onImported } = await setup();
  await review();
  mocks.invoke.mockRejectedValueOnce(
    "Company file changed. Refresh before importing.",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Import 1 transactions" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Company file changed",
  );
  expect(onImported).not.toHaveBeenCalled();
});
test("cancel never commits transactions", async () => {
  const { onClose } = await setup();
  await review();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.some((c) => c[0] === "import_statement")).toBe(
    false,
  );
});
