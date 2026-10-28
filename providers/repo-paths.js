import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Repository root resolved from this module, not from process.cwd(), so the
// daily-history and universe files are found regardless of the working
// directory. KOSPI_DATA_ROOT overrides it (tests use isolated temp roots).
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function dataRoot(env = globalThis.process?.env || {}) {
  const override = typeof env.KOSPI_DATA_ROOT === "string" ? env.KOSPI_DATA_ROOT.trim() : "";
  return override ? resolve(override) : REPO_ROOT;
}

export function repoPath(path, env) {
  return isAbsolute(path) ? path : join(dataRoot(env), path);
}

// Repo-relative POSIX path for metadata, so published snapshots never carry a
// local absolute path; paths outside the root are returned unchanged.
export function displayPath(path, env) {
  const absolute = repoPath(path, env);
  const rel = relative(dataRoot(env), absolute);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : path;
}
