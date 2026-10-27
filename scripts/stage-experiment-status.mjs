import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const [date, expectedHash] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^[a-f0-9]{64}$/.test(expectedHash || "")) throw new Error("Invalid status path or digest");
const path = `data/experiments/${date}-status.json`;
const git = (args, options = {}) => {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
};
// Do not replace any staged user change, including a staged deletion.
if (git(["diff", "--cached", "--quiet", "HEAD", "--", path]).status !== 0) throw new Error("Status has staged changes");
const info = await lstat(path);
if (!info.isFile() || info.isSymbolicLink()) throw new Error("Status is not a regular file");
const bytes = await readFile(path);
if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("Status changed after execution");
const ignored = git(["check-ignore", "-q", "--", path]);
if (ignored.status === 0) throw new Error("Status is ignored; refusing to force stage it");
if (ignored.status !== 1) throw new Error("Unable to inspect ignore rules");
const blob = git(["hash-object", "-w", "--stdin"], { input: bytes });
if (blob.status !== 0 || !/^[0-9a-f]{40,64}\s*$/.test(blob.stdout)) throw new Error("Unable to write status blob");
if (git(["update-index", "--add", "--cacheinfo", `100644,${blob.stdout.trim()},${path}`]).status !== 0) throw new Error("Unable to stage status");
