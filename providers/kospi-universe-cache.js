import { readFile } from "node:fs/promises";
import { isKoreanSymbol } from "./korean-symbol.js";
import { displayPath, repoPath } from "./repo-paths.js";

// Committed KOSPI symbol list used when the robots-permitted live list endpoint
// returns no rows (for example before the open). It never supplies prices; it
// only names which symbols to request from the robots-permitted quote host.
// Relative paths resolve against the repository root (see repo-paths.js).
export const KOSPI_UNIVERSE_PATH = "data/kospi-universe.json";
export const DEFAULT_UNIVERSE_MAX_AGE_DAYS = 7;

// A date-only value (CSV basDt) is read as 00:00 KST of that day.
export function parseAsOf(value) {
  if (typeof value !== "string") return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+09:00` : value);
}

export function validateUniverseRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("universe record is not an object");
  if (record.schema_version !== 1 || record.kind !== "kospi_universe" || record.market !== "KOSPI") throw new Error("universe identity mismatch");
  if (record.license_status !== "unconfirmed") throw new Error("universe license_status must remain unconfirmed");
  if (!record.source || typeof record.source !== "object" || typeof record.source.method !== "string" || typeof record.source.url !== "string") throw new Error("universe source metadata missing");
  const collected = Date.parse(record.collected_at);
  if (!Number.isFinite(collected)) throw new Error("universe collected_at invalid");
  const asOf = parseAsOf(record.candidates_as_of);
  if (!Number.isFinite(asOf)) throw new Error("universe candidates_as_of invalid");
  const verified = Date.parse(record.verified_at);
  if (!Number.isFinite(verified)) throw new Error("universe verified_at invalid");
  if (!Array.isArray(record.symbols) || record.symbols.length === 0) throw new Error("universe symbols missing");
  const seen = new Set();
  for (const entry of record.symbols) {
    if (!entry || typeof entry !== "object" || !isKoreanSymbol(entry.symbol) || typeof entry.name !== "string") throw new Error("universe symbol entry invalid");
    if (seen.has(entry.symbol)) throw new Error(`universe duplicate symbol ${entry.symbol}`);
    seen.add(entry.symbol);
  }
  if (record.count !== record.symbols.length) throw new Error("universe count mismatch");
  return { asOf, collected, verified };
}

export function universeAge(record, now = new Date(), maxAgeDays = DEFAULT_UNIVERSE_MAX_AGE_DAYS) {
  const { asOf, collected, verified } = validateUniverseRecord(record);
  const current = now.getTime();
  if (!Number.isFinite(current)) throw new Error("current time invalid");
  if (Math.max(asOf, collected, verified) > current + 60_000) throw new Error("universe candidates_as_of, collected_at or verified_at is in the future");
  // Re-verification never refreshes age: staleness follows the candidate data date.
  const ageDays = (current - asOf) / 86_400_000;
  return { ageDays: Math.round(ageDays * 100) / 100, stale: ageDays > maxAgeDays, maxAgeDays };
}

export async function loadKospiUniverseCache({ path = KOSPI_UNIVERSE_PATH, now = () => new Date(), maxAgeDays = DEFAULT_UNIVERSE_MAX_AGE_DAYS } = {}) {
  try {
    const record = JSON.parse(await readFile(repoPath(path), "utf8"));
    const age = universeAge(record, now(), maxAgeDays);
    return {
      ok: true,
      symbols: record.symbols.map(({ symbol, name }) => ({ symbol, name: name.trim() || symbol })),
      collectedAt: record.collected_at,
      candidatesAsOf: record.candidates_as_of,
      verifiedAt: record.verified_at,
      sourceMethod: record.source.method,
      sourceUrl: record.source.url,
      ageDays: age.ageDays,
      stale: age.stale,
      maxAgeDays: age.maxAgeDays,
      path: displayPath(path),
    };
  } catch (error) {
    return { ok: false, reason: `KOSPI universe cache unavailable: ${error.code === "ENOENT" ? "file not found" : error.message}` };
  }
}
