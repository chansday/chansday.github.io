import { mkdir, writeFile, readFile, lstat, realpath, link, rename, rm, appendFile } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { kstDate } from "./market-calendar.mjs";
import { createDailyBaselineExperiment } from "../providers/daily-baseline-experiment.js";
import { isDailyExperiment } from "../providers/daily-experiment-contract.js";

// Existing status bytes are protected unless they are a clean tracked Git file.
async function inspectStatus(path) {
  let bytes = null;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Status path is not a regular file");
    bytes = await readFile(path);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let parent = dirname(resolve(path));
  while (true) {
    try { await lstat(parent); break; } catch (error) { if (error.code !== "ENOENT") throw error; const next = dirname(parent); if (next === parent) throw error; parent = next; }
  }
  const git = spawnSync("git", ["-C", parent, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (git.error) throw git.error;
  if (git.status !== 0) {
    if (bytes !== null) throw new Error("Existing status cannot be verified as clean");
    return bytes;
  }
  const top = await realpath(git.stdout.trim());
  const canonicalPath = resolve(await realpath(parent), relative(parent, resolve(path)));
  const rel = relative(top, canonicalPath).replaceAll("\\", "/");
  if (rel === ".." || rel.startsWith("../")) throw new Error("Status path is outside checkout");
  const state = spawnSync("git", ["-C", top, "status", "--porcelain=v1", "--untracked-files=all", "--", rel], { encoding: "utf8" });
  if (state.error || state.status !== 0) throw new Error("Cannot inspect status file changes");
  if (state.stdout) throw new Error("Status file has existing user changes");
  if (bytes !== null) {
    const tracked = spawnSync("git", ["-C", top, "ls-files", "--stage", "--", rel], { encoding: "utf8" });
    const entry = tracked.stdout?.match(/^100644 ([a-f0-9]{40,64}) 0\t/);
    if (tracked.error || tracked.status !== 0 || !entry) throw new Error("Existing status is not a regular tracked file");
    const head = spawnSync("git", ["-C", top, "rev-parse", `HEAD:${rel}`], { encoding: "utf8" });
    const work = spawnSync("git", ["-C", top, "hash-object", `--path=${rel}`, "--stdin"], { input: bytes, encoding: "utf8" });
    if (head.error || head.status !== 0 || work.error || work.status !== 0 || head.stdout.trim() !== entry[1] || work.stdout.trim() !== entry[1]) throw new Error("Status file has existing user changes");
  }
  return bytes;
}

// Status is a separate latest-attempt record. Phase forecasts remain append-only.
export async function runDailyBaseline({ targetDate, root = "data/experiments", create = createDailyBaselineExperiment, ...options }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate || "") || !Number.isFinite(Date.parse(`${targetDate}T00:00:00Z`)) || new Date(`${targetDate}T00:00:00Z`).toISOString().slice(0, 10) !== targetDate) throw new Error("Invalid experiment target date");
  const statusPath = join(root, `${targetDate}-status.json`);
  const initialStatus = await inspectStatus(statusPath);
  let result;
  try {
    const forecast = await create({ targetDate, ...options });
    if (forecast.status !== "experimental") {
      const status = ["blocked", "no_data"].includes(forecast.status) ? forecast.status : "failed";
      const reason = status === "blocked" && /robots/i.test(forecast.reason || "") ? "robots_blocked" : status === "blocked" ? "source_blocked" : status === "no_data" ? "data_unavailable" : "collection_error";
      result = { status, reason, saved: false };
    } else {
      if (!isDailyExperiment(forecast, targetDate, forecast.phase)) throw new Error("Invalid experimental forecast; nothing saved.");
      await mkdir(root, { recursive: true });
      const path = join(root, `${targetDate}-${forecast.phase}.json`);
      const temporaryForecast = join(root, `.${targetDate}-${forecast.phase}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryForecast, `${JSON.stringify(forecast, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        try {
          // Hard-link creation is atomic and fails if the phase file already exists.
          await link(temporaryForecast, path);
          result = { status: "experimental", reason: "saved", saved: true, candidate: true, path, phase: forecast.phase, stale: forecast.stale };
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("Existing experiment is not a regular file");
          const existing = JSON.parse(await readFile(path, "utf8"));
          if (!isDailyExperiment(existing, targetDate, forecast.phase)) throw new Error("Existing experiment failed validation");
          result = { status: "preserved", reason: "existing_forecast_preserved", saved: false, candidate: true, path, phase: forecast.phase };
        }
      } finally { await rm(temporaryForecast, { force: true }); }
    }
  } catch (error) {
    result = { status: "failed", reason: "collection_error", saved: false };
  }
  // Recover valid orphan phases even when this attempt cannot collect a new forecast.
  const candidatePhases = [];
  for (const phase of ["before-open", "during-market"]) {
    const candidatePath = join(root, `${targetDate}-${phase}.json`);
    try {
      const info = await lstat(candidatePath);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
      if (isDailyExperiment(candidate, targetDate, phase)) candidatePhases.push(phase);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  result.candidatePhases = candidatePhases;
  result.candidate = candidatePhases.length > 0;
  const now = options.now ? options.now() : new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Experiment status time unavailable");
  const statusRecord = { schema_version: 1, target_date: targetDate, status: result.status, reason: result.reason, attempted_at: now.toISOString(), phase: result.phase || null };
  await mkdir(root, { recursive: true });
  const temporary = join(root, `.${targetDate}-status-${randomUUID()}.tmp`);
  try {
    const bytes = Buffer.from(`${JSON.stringify(statusRecord, null, 2)}\n`, "utf8");
    await writeFile(temporary, bytes, { flag: "wx" });
    const current = await inspectStatus(statusPath);
    if ((initialStatus === null) !== (current === null) || (initialStatus && !initialStatus.equals(current))) throw new Error("Status file changed during execution");
    if (initialStatus === null) await link(temporary, statusPath);
    else await rename(temporary, statusPath);
    result.statusHash = createHash("sha256").update(bytes).digest("hex");
  } finally { await rm(temporary, { force: true }); }
  return { ...result, statusSaved: true, statusPath };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const targetDate = process.argv[2] || kstDate();
  runDailyBaseline({ targetDate }).then(async (result) => {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `saved=${result.saved === true}\nphase=${result.phase || ""}\ncandidates=${result.candidatePhases.join(",")}\ncandidate=${result.candidate === true}\nstatus=${result.status}\nstatus_saved=${result.statusSaved === true}\nstatus_hash=${result.statusHash}\n`, "utf8");
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- isolated daily experiment: \`${result.status}\` (${result.reason}); status record saved: ${result.statusSaved === true}\n`, "utf8");
    console.log(JSON.stringify(result));
    if (!["experimental", "preserved"].includes(result.status)) process.exitCode = 1;
  }).catch((error) => { console.error(`Experiment or status persistence failed: ${error.message}`); process.exitCode = 1; });
}
