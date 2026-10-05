import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ReportsPage from "../src/ReportsPage";
import TaxPage from "../src/TaxPage";
import sample from "../src/sample.json";
import { emptyWorkspace } from "../src/workspace";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.invoke.mockResolvedValue(emptyWorkspace());
});
test("report library uses latest recorded year and exports selected report", async () => {
  render(<ReportsPage books={sample} desktop onSaved={vi.fn()} />);
  expect(screen.getByLabelText("From")).toHaveValue("2026-01-01");
  fireEvent.click(
    screen.getByRole("button", { name: "Balance sheet", exact: true }),
  );
  await screen.findByRole("heading", { name: "Balance sheet", exact: true });
  mocks.save.mockResolvedValue("/tmp/report.html");
  fireEvent.click(
    screen.getByRole("button", { name: "Export printable report" }),
  );
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "export_document",
      expect.objectContaining({
        revision: sample.revision,
        path: "/tmp/report.html",
        content: expect.stringContaining("Balance sheet"),
      }),
    ),
  );
});
test("tax changes persist per year and unsaved edits disable packet export", async () => {
  const saved = vi.fn();
  render(
    <TaxPage
      books={sample}
      desktop
      onSaved={saved}
      onDirty={vi.fn()}
      onReports={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Readiness", exact: true }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Federal tax classification")).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Federal tax classification"), {
    target: { value: "sole" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Preparer packet", exact: true }),
  );
  expect(
    screen.getByRole("button", { name: "Export preparer packet" }),
  ).toBeDisabled();
  mocks.invoke.mockResolvedValueOnce(sample);
  fireEvent.click(screen.getByRole("button", { name: "Save tax workspace" }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(sample));
  expect(mocks.invoke).toHaveBeenCalledWith(
    "save_workspace",
    expect.objectContaining({
      revision: sample.revision,
      value: expect.objectContaining({
        tax_years: { "2026": expect.objectContaining({ entity: "sole" }) },
      }),
    }),
  );
});
test("workspace load failure disables saving and does not overwrite records", async () => {
  mocks.invoke.mockRejectedValue(new Error("Workspace damaged"));
  render(
    <TaxPage
      books={sample}
      desktop
      onSaved={vi.fn()}
      onDirty={vi.fn()}
      onReports={vi.fn()}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Workspace damaged",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Readiness", exact: true }),
  );
  expect(screen.getByLabelText("Federal tax classification")).toBeDisabled();
});

test("estimates preserve each year's profile and save recorded payments in company workspace", async () => {
  const { estimateDefaults } = await import("../src/estimates");
  const { emptyTaxYear } = await import("../src/workspace");
  const w = emptyWorkspace();
  for (const year of ["2025", "2026"])
    w.tax_years[year] = {
      ...emptyTaxYear(),
      entity: "sole",
      estimate: {
        ...estimateDefaults(year),
        filing_status: "single",
        state: "OK",
        profit_source: "manual",
        annual_profit: year === "2025" ? "50000" : "100000",
      },
    };
  mocks.invoke.mockResolvedValue(w);
  render(
    <TaxPage
      books={sample}
      desktop
      onSaved={vi.fn()}
      onDirty={vi.fn()}
      onReports={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("Projected annual Schedule C profit"),
    ).toHaveValue("100000"),
  );
  fireEvent.change(screen.getByLabelText("Tax year"), {
    target: { value: "2025" },
  });
  await waitFor(() =>
    expect(
      screen.getByLabelText("Projected annual Schedule C profit"),
    ).toHaveValue("50000"),
  );
  expect(screen.getByLabelText("Personal filing status")).toHaveValue("single");
  expect(screen.getByLabelText("State estimate")).toHaveValue("OK");
  fireEvent.change(screen.getByLabelText("Payment date"), {
    target: { value: "2025-04-15" },
  });
  fireEvent.change(screen.getByLabelText("Amount paid (USD)"), {
    target: { value: "1000" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Record payment", exact: true }),
  );
  expect(
    screen.getByRole("button", { name: "Export estimate & payment plan" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove payment" })).toBeEnabled();
  mocks.invoke.mockResolvedValueOnce(sample);
  fireEvent.click(screen.getByRole("button", { name: "Save tax workspace" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "save_workspace",
      expect.objectContaining({
        value: expect.objectContaining({
          tax_years: expect.objectContaining({
            "2025": expect.objectContaining({
              estimate: expect.objectContaining({
                payments: [
                  expect.objectContaining({
                    amount: "1000",
                    date: "2025-04-15",
                    jurisdiction: "federal",
                  }),
                ],
              }),
            }),
            "2026": w.tax_years["2026"],
          }),
        }),
      }),
    ),
  );
});
