// Download the pinned official release, verify its digest, and prepare a Tauri sidecar.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const release = JSON.parse(
  await readFile(new URL("./hledger-release.json", import.meta.url), "utf8"),
);
const targets = {
  "linux-x64": ["hledger-linux-x64.tar.gz", "x86_64-unknown-linux-gnu"],
  "darwin-x64": ["hledger-mac-x64.tar.gz", "x86_64-apple-darwin"],
  "darwin-arm64": ["hledger-mac-arm64.tar.gz", "aarch64-apple-darwin"],
  "win32-x64": ["hledger-windows-x64.zip", "x86_64-pc-windows-msvc"],
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target)
  throw new Error(
    `No pinned hledger binary for ${process.platform}-${process.arch}`,
  );
const [assetName, triple] = target;
const asset = release.assets[assetName];
const temp = await mkdtemp(join(tmpdir(), "ledgertrails-hledger-"));
try {
  console.log(`Downloading hledger ${release.version} for ${triple}`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== asset.sha256)
    throw new Error("hledger archive checksum mismatch");
  const archivePath = join(temp, assetName);
  await writeFile(archivePath, archive);
  const binary = process.platform === "win32" ? "hledger.exe" : "hledger";
  // bsdtar is supplied by supported Windows versions; tar handles gzip on Unix.
  execFileSync("tar", ["-xf", archivePath, "-C", temp, binary], {
    stdio: "inherit",
  });
  await mkdir("src-tauri/binaries", { recursive: true });
  const destination = `src-tauri/binaries/ledgertrails-hledger-${triple}${process.platform === "win32" ? ".exe" : ""}`;
  await copyFile(join(temp, binary), destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
  await writeFile(
    "src-tauri/tauri.bundle.conf.json",
    JSON.stringify({ bundle: { externalBin: ["binaries/ledgertrails-hledger"] } }, null, 2) +
      "\n",
  );
  console.log(`Prepared ${destination}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
