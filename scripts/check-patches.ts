import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Path from "node:path";
import * as Url from "node:url";

const root = Url.fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1) throw new Error("Usage: node scripts/check-patches.ts [sdk-directory]");

const sdk = Path.resolve(args[0] ?? Path.join(root, "../nanocodex"));
const pin: { revision: string } = JSON.parse(
  Fs.readFileSync(Path.join(root, "sdk-revision.json"), "utf8"),
);
if (!/^[a-f0-9]{40}$/.test(pin.revision)) throw new Error("Invalid SDK revision");

function git(options: readonly string[]): string {
  const result = ChildProcess.spawnSync("git", ["-C", sdk, ...options], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "SDK Git inspection failed");
  return result.stdout.trim();
}

function validate(): void {
  if (git(["rev-parse", "HEAD"]) !== pin.revision)
    throw new Error("SDK checkout does not match sdk-revision.json");
  if (git(["status", "--porcelain", "--untracked-files=no"]))
    throw new Error("SDK checkout contains tracked changes");
}

validate();

const result = ChildProcess.spawnSync(
  "python3",
  [Path.join(sdk, "bin/nanocode-sim/patches.py"), "--mutations"],
  {
    cwd: sdk,
    env: {
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      SHIPPY_EXEC: "0",
      SHIPPY_PREFETCH: "0",
      SHIPPY_PRIME: "0",
      SHIPPY_PUSH: "0",
      SHIPPY_REMOTE_BUILD: "0",
    },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(`SDK patch regressions failed: ${result.status ?? result.signal}`);

validate();
console.log(JSON.stringify({ revision: pin.revision, status: "passed" }));
