// Real executable + TLS tests. --native additionally installs a temporary OS service.
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import https from "node:https";
import assert from "node:assert/strict";
const native = process.argv.includes("--native");
const exe = resolve(
  `src-tauri/target/${process.argv.includes("--debug") ? "debug" : "release"}/ledgertrails${process.platform === "win32" ? ".exe" : ""}`,
);
const root = realpathSync(
  mkdtempSync(join(tmpdir(), "LedgerTrails service test ")),
);
const config = join(root, "office settings");
mkdirSync(config);
const company = join(root, "Test company.bky");
writeFileSync(
  company,
  JSON.stringify({
    format: "booky-company",
    version: 1,
    company: { name: "Service test", currency: "USD" },
    journal: "; Service test\n",
  }),
);
const port = await new Promise((resolve, reject) => {
  const s = createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
  /^host: (.+)$/m,
)[1];
const env = {
  ...process.env,
  LEDGERTRAILS_HLEDGER: resolve(
    `src-tauri/binaries/ledgertrails-hledger-${triple}${process.platform === "win32" ? ".exe" : ""}`,
  ),
};
function cli(action, extra = []) {
  return execFileSync(exe, [action, ...extra, "--config-dir", config], {
    env,
    encoding: "utf8",
    timeout: 60000,
  });
}
function admin(action) {
  const args = ["--office-service-admin", action, "--config-dir", config];
  execFileSync(
    process.platform === "win32" ? exe : "sudo",
    process.platform === "win32" ? args : ["-n", exe, ...args],
    { env, stdio: "inherit", timeout: 60000 },
  );
}
function status() {
  return JSON.parse(cli("--office-check"));
}
async function until(predicate, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out: ${label}. ${JSON.stringify(status())}`);
}
let child;
let peer;
function rpc(command = "snapshot", args = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/rpc",
        method: "POST",
        ca: peer.certificate,
        headers: {
          authorization: `Bearer ${peer.token}`,
          "content-type": "application/json",
        },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(body) }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("TLS request timeout")));
    req.end(JSON.stringify({ command, args }));
  });
}
function startProcess() {
  child = spawn(exe, ["--office-server", "--config-dir", config], {
    env,
    stdio: "inherit",
  });
}
async function stopProcess() {
  if (!child) return;
  const p = child;
  child = undefined;
  if (p.exitCode !== null) return;
  const ended = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  await ended;
}
try {
  cli("--office-configure", [
    "--company",
    company,
    "--address",
    "127.0.0.1",
    "--port",
    String(port),
  ]);
  peer = JSON.parse(
    Buffer.from(cli("--office-invite").trim().slice(4), "base64url").toString(),
  );
  assert.equal(status().running, false);
  if (native) {
    cli("--office-service-prepare");
    admin("install");
  } else startProcess();
  await until(() => status().running, "initial host startup");
  if (native) {
    assert.equal(status().service.installed, true);
    assert.equal(status().service.running, true);
  }
  await until(async () => {
    try {
      return (await rpc()).status === 200;
    } catch {
      return false;
    }
  }, "TLS listener readiness");
  const initial = (await rpc()).body.data;
  assert.equal(initial.company.name, "Service test");
  const entry = {
    date: "2026-10-05",
    description: "Service write",
    debit: "assets:bank",
    credit: "income:sales",
    amount: "10.00",
    commodity: "USD",
  };
  const saved = await rpc("add_entry", { revision: initial.revision, entry });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(
    (await rpc("add_entry", { revision: initial.revision, entry })).status,
    409,
  );
  assert.equal((await rpc()).body.data.transactions.length, 1);
  assert.equal(readdirSync(`${company}.backups`).length, 1);
  // Stop and restart the executable/service, without any desktop process alive.
  if (native) admin("stop");
  else await stopProcess();
  await until(() => !status().running, "shutdown releases listener lock");
  if (native) admin("start");
  else startProcess();
  await until(() => status().running, "restart with persisted settings");
  await until(async () => {
    try {
      return (await rpc()).status === 200;
    } catch {
      return false;
    }
  }, "restarted TLS listener");
  if (native) {
    admin("update");
    await until(async () => {
      try {
        return (await rpc()).status === 200;
      } catch {
        return false;
      }
    }, "updated service");
    assert.equal((await rpc()).body.data.transactions.length, 1);
  }
  // A second process changes credentials while the daemon is running.
  const second = cli("--office-invite").trim();
  peer = JSON.parse(Buffer.from(second.slice(4), "base64url").toString());
  assert.equal((await rpc()).status, 200);
  // CLI config edits emulate an app revocation. Server reloads without a restart.
  const file = join(config, "server.json");
  const settings = JSON.parse(readFileSync(file, "utf8"));
  settings.users = [];
  writeFileSync(file, JSON.stringify(settings));
  assert.equal((await rpc()).status, 401);
  settings.enabled = false;
  writeFileSync(file, JSON.stringify(settings));
  await until(() => !status().running, "disable hosting from another process");
  if (native) admin("stop");
  else await stopProcess();
  if (native) admin("start");
  else startProcess();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(
    status().running,
    false,
    "disabled hosting stays disabled across service restarts",
  );
  assert.equal(JSON.parse(readFileSync(company)).company.name, "Service test");
  console.log(
    `Passed headless TLS, restart, live credentials, and persistent disable tests (${native ? "native service" : "process"}, ${process.platform}).`,
  );
} finally {
  if (native) {
    try {
      admin("remove");
      assert.equal(status().service.installed, false);
    } catch (e) {
      console.error(`Service cleanup failed; settings retained at ${config}`);
      throw e;
    }
  } else await stopProcess();
  rmSync(root, { recursive: true, force: true });
}
