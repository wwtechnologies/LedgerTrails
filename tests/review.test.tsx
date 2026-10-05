import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ReviewPage from "../src/ReviewPage";
import sample from "../src/sample.json";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const row = {
  line: 5,
  date: "2025-05-12",
  description: "Arvest: Check 1001",
  account: "equity:needs-review:checks",
  amount: "25.00 USD",
};
beforeEach(() => vi.resetAllMocks());
test("selected review entries save with revision and refresh balances", async () => {
  invoke
    .mockResolvedValueOnce([row])
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(sample);
  const saved = vi.fn();
  render(<ReviewPage books={sample} desktop onSaved={saved} />);
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Select Arvest/ }),
  );
  fireEvent.change(screen.getByLabelText("Review category"), {
    target: { value: "expenses:office" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Apply category to 1 selected" }),
  );
  await waitFor(() => expect(saved).toHaveBeenCalledWith(sample));
  expect(invoke).toHaveBeenCalledWith("categorize_review", {
    revision: sample.revision,
    changes: [{ line: 5, category: "expenses:office" }],
  });
});
test("save errors preserve selection and show error", async () => {
  invoke
    .mockResolvedValueOnce([row])
    .mockRejectedValueOnce("Company changed. Refresh before saving.");
  render(<ReviewPage books={sample} desktop onSaved={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Select Arvest/ }),
  );
  fireEvent.change(screen.getByLabelText("Review category"), {
    target: { value: "expenses:office" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Apply category to 1 selected" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Company changed");
  expect(screen.getByRole("checkbox", { name: /Select Arvest/ })).toBeChecked();
});
