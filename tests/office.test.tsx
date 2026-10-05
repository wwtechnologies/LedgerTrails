import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OfficeNetwork from "../src/OfficeNetwork";
import { invoke as appInvoke, connectOffice } from "../src/backend";
import sample from "../src/sample.json";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: () => true,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
  save: vi.fn(),
}));
const status = {
  enabled: false,
  running: false,
  address: "192.168.1.20",
  port: 47831,
  company: "",
  error: null,
  users: [],
  savedConnection: null,
};
const remote = {
  ...sample,
  path: "office://192.168.1.20:47831/company",
  office: { address: "192.168.1.20:47831", name: "Alice", role: "editor" },
};
beforeEach(async () => {
  vi.resetAllMocks();
  await appInvoke("open_company", { path: "/local.bky" });
  mocks.invoke.mockReset();
});
test("hosting is opt-in and setup configures the chosen company before starting", async () => {
  mocks.invoke.mockImplementation(async (command) =>
    command === "office_start"
      ? { ...status, running: true, company: "/books/company.bky" }
      : status,
  );
  mocks.open.mockResolvedValue("/books/company.bky");
  render(
    <OfficeNetwork books={null} onClose={vi.fn()} onConnected={vi.fn()} />,
  );
  await screen.findByText("Hosting is off");
  expect(mocks.invoke).not.toHaveBeenCalledWith("office_start");
  fireEvent.click(
    screen.getByRole("button", { name: "Choose company to share" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Company to share")).toHaveValue(
      "/books/company.bky",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Enable hosting" }));
  await screen.findByText("Hosting is on");
  expect(mocks.invoke).toHaveBeenCalledWith("office_configure", {
    path: "/books/company.bky",
    address: "192.168.1.20",
    port: 47831,
  });
  expect(
    mocks.invoke.mock.calls.findIndex(([c]) => c === "office_configure"),
  ).toBeLessThan(
    mocks.invoke.mock.calls.findIndex(([c]) => c === "office_start"),
  );
});
test("coworker codes have explicit roles and can be revoked", async () => {
  let users: { id: string; name: string; role: string }[] = [];
  mocks.invoke.mockImplementation(async (command) => {
    if (command === "office_invite") {
      users = [{ id: "user1", name: "Viewer", role: "reader" }];
      return "LT1-example-secret";
    }
    if (command === "office_revoke") users = [];
    return { ...status, running: true, company: "/books/shared.bky", users };
  });
  render(
    <OfficeNetwork books={null} onClose={vi.fn()} onConnected={vi.fn()} />,
  );
  await screen.findByRole("heading", { name: "Coworker access" });
  fireEvent.change(screen.getByLabelText("Coworker name"), {
    target: { value: "Viewer" },
  });
  fireEvent.change(screen.getByLabelText("Access", { exact: true }), {
    target: { value: "reader" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create access code" }));
  await screen.findByDisplayValue("LT1-example-secret");
  expect(mocks.invoke).toHaveBeenCalledWith("office_invite", {
    name: "Viewer",
    role: "reader",
  });
  fireEvent.click(screen.getByRole("button", { name: "Revoke Viewer" }));
  await waitFor(() =>
    expect(
      screen.queryByDisplayValue("LT1-example-secret"),
    ).not.toBeInTheDocument(),
  );
  expect(mocks.invoke).toHaveBeenCalledWith("office_revoke", { id: "user1" });
});
test("successful pairing switches shared operations to the host and local opens switch back", async () => {
  mocks.invoke.mockResolvedValue(remote);
  await connectOffice("LT1-test");
  await appInvoke("add_entry", { revision: "abc", entry: {} });
  expect(mocks.invoke).toHaveBeenLastCalledWith("office_request", {
    command: "add_entry",
    args: { revision: "abc", entry: {} },
  });
  await appInvoke("parse_statement", { path: "/client/bank.csv" });
  expect(mocks.invoke).toHaveBeenLastCalledWith("parse_statement", {
    path: "/client/bank.csv",
  });
  await appInvoke("open_company", { path: "/local.bky" });
  await appInvoke("refresh_journal");
  expect(mocks.invoke).toHaveBeenLastCalledWith("refresh_journal", undefined);
});
test("failed pairing leaves local routing intact and does not replace the active book", async () => {
  mocks.invoke.mockImplementation(async (command) => {
    if (command === "office_status") return status;
    throw new Error("Host offline");
  });
  const onConnected = vi.fn();
  render(
    <OfficeNetwork books={null} onClose={vi.fn()} onConnected={onConnected} />,
  );
  await screen.findByText("Hosting is off");
  fireEvent.change(screen.getByLabelText("Access code"), {
    target: { value: "LT1-offline" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Host offline");
  expect(onConnected).not.toHaveBeenCalled();
  mocks.invoke.mockResolvedValue(sample);
  await appInvoke("refresh_journal");
  expect(mocks.invoke).toHaveBeenLastCalledWith("refresh_journal", undefined);
});
test("remote Save As selects the downloaded local company before subsequent edits", async () => {
  mocks.invoke.mockResolvedValue(remote);
  await connectOffice("LT1-test");
  mocks.invoke.mockResolvedValue({ ...sample, path: "/copies/local.bky" });
  await appInvoke("copy_company", {
    path: "/copies/local.bky",
    revision: "abc",
    switch: true,
  });
  expect(mocks.invoke).toHaveBeenLastCalledWith("open_company", {
    path: "/copies/local.bky",
  });
  await appInvoke("add_entry", { revision: "local", entry: {} });
  expect(mocks.invoke).toHaveBeenLastCalledWith("add_entry", {
    revision: "local",
    entry: {},
  });
});
test("host startup failures are shown without claiming hosting is on", async () => {
  mocks.invoke.mockImplementation(async (command) => {
    if (command === "office_start") throw new Error("Port already in use");
    return { ...status, company: "/books/shared.bky" };
  });
  render(
    <OfficeNetwork books={null} onClose={vi.fn()} onConnected={vi.fn()} />,
  );
  await screen.findByText("Hosting is off");
  fireEvent.click(screen.getByRole("button", { name: "Enable hosting" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Port already in use",
  );
  expect(screen.queryByText("Hosting is on")).not.toBeInTheDocument();
});

test("saved hosting can be disabled even when startup failed", async () => {
  let stopped = false;
  mocks.invoke.mockImplementation(async (command) => {
    if (command === "office_stop") stopped = true;
    return {
      ...status,
      enabled: !stopped,
      error: stopped ? null : "Address unavailable",
    };
  });
  render(
    <OfficeNetwork books={null} onClose={vi.fn()} onConnected={vi.fn()} />,
  );
  await screen.findByRole("button", { name: "Turn off hosting" });
  fireEvent.click(screen.getByRole("button", { name: "Turn off hosting" }));
  await screen.findByRole("button", { name: "Enable hosting" });
  expect(mocks.invoke).toHaveBeenCalledWith("office_stop");
});

test("canceling a connection switch preserves unsaved work", async () => {
  mocks.invoke.mockResolvedValue({
    ...status,
    savedConnection: "192.168.1.20:47831",
  });
  const onConnected = vi.fn();
  render(
    <OfficeNetwork
      books={null}
      beforeConnect={() => false}
      onClose={vi.fn()}
      onConnected={onConnected}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Reconnect to 192.168.1.20:47831",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Reconnect to 192.168.1.20:47831" }),
    ).toBeEnabled(),
  );
  expect(onConnected).not.toHaveBeenCalled();
  expect(
    mocks.invoke.mock.calls.some(([command]) => command === "office_connect"),
  ).toBe(false);
});
