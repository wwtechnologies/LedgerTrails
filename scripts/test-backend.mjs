import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const env = { ...process.env };
if (process.argv.includes("--bundled")) {
  const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
    /^host: (.+)$/m,
  )?.[1];
  if (!triple) throw new Error("Could not determine the Rust host target");
  env.LEDGERTRAILS_HLEDGER = resolve(
    `src-tauri/binaries/ledgertrails-hledger-${triple}${process.platform === "win32" ? ".exe" : ""}`,
  );
}
execFileSync(
  "cargo",
  ["test", "--manifest-path", "src-tauri/Cargo.toml", "--locked"],
  { env, stdio: "inherit" },
);
