import { readFile, lstat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isDailyExperiment } from "../providers/daily-experiment-contract.js";

const [date, phase] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !["before-open", "during-market"].includes(phase)) throw new Error("Invalid experiment path");
const path = `data/experiments/${date}-${phase}.json`;
function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}
// A tracked phase is replaced only by a validated working file (each run
// updates the day's forecast); an unchanged file stages nothing.
const index = git(["ls-files", "-z", "--", path]);
if (index.status !== 0) throw new Error("Unable to inspect git index");
const head = git(["rev-parse", "--verify", "HEAD"]);
if (head.status !== 0) throw new Error("Unable to inspect checked-out HEAD");
const tracked = git(["ls-tree", "-z", "--name-only", "HEAD", "--", path]);
if (tracked.status !== 0) throw new Error("Unable to inspect tracked files");
const unchanged = (index.stdout || tracked.stdout) && git(["diff", "--quiet", "HEAD", "--", path]).status === 0;
if (unchanged) {
  console.log("Tracked forecast is unchanged.");
} else {
  if (!(index.stdout || tracked.stdout)) {
    const ignored = git(["check-ignore", "-q", "--", path]);
    if (ignored.status === 0) throw new Error("Experiment is ignored; refusing to force stage it");
    if (ignored.status !== 1) throw new Error("Unable to inspect ignore rules");
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Experiment is not a regular file");
  const bytes = await readFile(path);
  let record = null;
  try { record = JSON.parse(bytes.toString("utf8")); } catch { record = null; }
  const valid = record !== null && isDailyExperiment(record, date, phase);
  // A tracked phase whose working file is not a valid forecast (e.g. a local
  // edit) is left untouched; an untracked invalid candidate is an error.
  if (!valid && (index.stdout || tracked.stdout)) { console.log("Tracked forecast differs but is not a valid forecast; left untouched."); process.exit(0); }
  if (!valid) throw new Error("Experiment candidate failed validation");
  // Stage the validated bytes directly; no second filesystem read can substitute content.
  const blob = git(["hash-object", "-w", "--stdin"], { input: bytes });
  if (blob.status !== 0 || !/^[0-9a-f]{40,64}\s*$/.test(blob.stdout)) throw new Error("Unable to write validated experiment blob");
  const staged = git(["update-index", "--add", "--cacheinfo", `100644,${blob.stdout.trim()},${path}`]);
  if (staged.status !== 0) throw new Error("Unable to stage validated experiment blob");
  console.log(index.stdout || tracked.stdout ? "Validated updated forecast staged." : "Validated unpublished forecast staged.");
}
