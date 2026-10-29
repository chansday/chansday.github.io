import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isProviderAdapter,
  isProviderResult,
  noDataSnapshot,
  validateRankingRows,
} from "../providers/provider-adapter.js";
import { createDemoProvider } from "../providers/demo-provider.js";
import { createFixtureProvider } from "../providers/fixture-provider.js";
import { createPublicJsonProvider } from "../providers/public-json-provider.js";
import { createPublicCsvProvider } from "../providers/public-csv-provider.js";
import { createNaverCrawlProvider, savedOpeningIsTimely } from "../providers/naver-crawl-provider.js";
import { compareByExpectedReturn, deriveEvaluationError, deriveExpectedReturn, deriveSessionReturn } from "../providers/evaluation-contract.js";
import { calculateRunContext } from "./run-context.mjs";

export const MODES = {
  "update-results": { key: "previousResult", method: "fetchPreviousDay" },
  analysis: { key: "analysis", method: "runAnalysis" },
  forecast: { key: "forecast", method: "generateForecast" },
  "open-settlement": { key: "openSettlement", method: "settleOpen" },
  "close-settlement": { key: "closeSettlement", method: "settleClose" },
};

const NON_READY_STATUSES = new Set(["no_data", "partial", "degraded", "blocked"]);

const EXPECTED_FIELDS = Object.freeze(["expected_open", "expected_close", "expected_return"]);
// A recorded opening, its source, its basis and the closing estimate derived
// with it are kept or replaced together, never mixed across runs.
const FORECAST_BUNDLE = Object.freeze(["expected_open", "expected_open_source", "expected_open_basis", "expected_close", "expected_close_basis"]);
export function copyForecastBundle(target, from) {
  for (const field of FORECAST_BUNDLE) {
    if (Object.hasOwn(from, field)) target[field] = from[field];
    else if (field === "expected_close") target[field] = null;
    else delete target[field];
  }
  return target;
}
const OPEN_SETTLEMENT_FIELDS = Object.freeze(["actual_open"]);
const CLOSE_SETTLEMENT_FIELDS = Object.freeze(["actual_close", "session_return", "actual_volume"]);

export { calculateRunContext } from "./run-context.mjs";

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function parseAttemptedAt(value, runContext) {
  const attemptedAt = value || runContext.referenceTime;
  if (Number.isNaN(Date.parse(attemptedAt))) throw new Error(`Invalid --attempted-at value: ${attemptedAt}`);
  return new Date(attemptedAt).toISOString();
}

function snapshotBelongsToStage(snapshot, runDate, stage, mode) {
  if (!snapshot || snapshot.meta?.run_date !== runDate || snapshot.meta?.run_stage !== stage) return false;
  if (["open-settlement", "close-settlement"].includes(mode)
    && snapshot.rows?.length > 0
    && snapshot.asOfDate !== runDate) return false;
  return true;
}

function parseArgs(argv) {
  const options = {
    mode: null,
    dataFile: null,
    dryRun: false,
    provider: null,
    fixtureDate: null,
    runDate: null,
    runStartedAt: process.env.KOSPI_RUN_STARTED_AT || null,
    attemptedAt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--mode") { options.mode = argv[index + 1]; index += 1; }
    else if (arg === "--data-file") { options.dataFile = argv[index + 1]; index += 1; }
    else if (arg === "--provider") { options.provider = argv[index + 1]; index += 1; }
    else if (arg === "--fixture-date") { options.fixtureDate = argv[index + 1]; index += 1; }
    else if (arg === "--run-date" || arg === "--date") { options.runDate = argv[index + 1]; index += 1; }
    else if (arg === "--run-started-at") { options.runStartedAt = argv[index + 1]; index += 1; }
    else if (arg === "--attempted-at") { options.attemptedAt = argv[index + 1]; index += 1; }
    else if (arg === "--help") {
      console.log("Usage: node scripts/update-results.mjs --mode <update-results|analysis|forecast|open-settlement|close-settlement> [--provider id] [--fixture-date YYYY-MM-DD] [--run-date YYYY-MM-DD] [--run-started-at ISO] [--attempted-at ISO] [--data-file path] [--dry-run]");
      return null;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.mode || !MODES[options.mode]) {
    throw new Error("--mode must be one of: update-results, analysis, forecast, open-settlement, close-settlement");
  }
  const explicitRunDate = options.runDate;
  const runContext = calculateRunContext(options.runStartedAt);
  options.runDate = explicitRunDate || runContext?.runDate || process.env.KOSPI_RUN_DATE || null;
  if (!validDate(options.runDate)) throw new Error(`--run-date must be YYYY-MM-DD: ${options.runDate}`);
  options.runStartedAt = runContext.referenceTime;
  options.runContext = runContext;
  options.attemptedAt = parseAttemptedAt(options.attemptedAt, runContext);
  return options;
}

export function resolveProvider(env = process.env, options = {}) {
  const requestedProvider = (options.provider ?? env.KOSPI_PROVIDER ?? "").trim().toLowerCase();
  const providerId = requestedProvider || "naver-crawl";
  const runContext = options.runContext || calculateRunContext(options.runStartedAt);
  const runStartedAt = options.runStartedAt || runContext.referenceTime;
  const attemptedAt = options.attemptedAt || runContext.referenceTime;
  const providerEnv = {
    ...env,
    ...(options.fixtureDate ? { KOSPI_FIXTURE_DATE: options.fixtureDate } : {}),
    KOSPI_RUN_DATE: options.runDate || runContext.runDate,
    KOSPI_RUN_STARTED_AT: runStartedAt,
    KOSPI_RUN_ID: env.KOSPI_RUN_ID || `${options.runDate || runContext.runDate}-${options.mode || "run"}`,
    KOSPI_STABLE_SNAPSHOT: "1",
    GITHUB_RUN_ID: undefined,
  };
  const now = options.now || (() => new Date());
  if (providerId === "none") return { provider: null, providerId };
  if (providerId === "demo") return { provider: createDemoProvider(), providerId };
  if (providerId === "fixture") return { provider: createFixtureProvider({ env: providerEnv }), providerId };
  if (providerId === "public-json") return { provider: createPublicJsonProvider({ env: providerEnv, now }), providerId };
  if (providerId === "public-csv") return { provider: createPublicCsvProvider({ env: providerEnv, now }), providerId };
  if (providerId === "naver-crawl") return {
    provider: createNaverCrawlProvider({ env: providerEnv, fetchImpl: options.fetchImpl, runContext, now, runStartedAt }),
    providerId,
  };
  return { provider: null, providerId };
}

function blockedStep({ attemptedAt, providerId, reason }) {
  return { status: "blocked", attemptedAt, provider_id: providerId || null, message: reason };
}

function providerInfo(provider, providerId, status = "degraded") {
  return {
    id: providerId || provider?.id || null,
    status,
    label: provider?.label || "연결된 데이터 공급자 없음",
    source: provider?.getSourceMetadata?.() || null,
  };
}

async function appendJobSummary(summary) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const message = String(summary.message || "").replaceAll("\n", " ");
  await appendFile(summaryPath, [
    `### KOSPI stage: ${summary.mode}`,
    `- status: \`${summary.status}\``,
    `- provider: \`${summary.provider || "none"}\``,
    `- run date: \`${summary.runDate}\``,
    `- reference time (run start): \`${summary.attemptedAt}\``,
    `- source warning: ${summary.sourceWarning || "none"}`,
    `- snapshot write: \`${summary.wroteFile ? "yes" : "no (dry-run or existing file preserved)"}\``,
    `- message: ${message || "(none)"}`,
    "",
  ].join("\n"), "utf8");
}

function derivedError(row) {
  return deriveEvaluationError(row);
}

function derivedSessionReturn(row) {
  return deriveSessionReturn(row);
}

// The no-trade marker and its evidence belong to the incoming observation;
// a history-based marker is dropped if a recorded opening was kept.
function applyTradingStatus(merged, incoming) {
  if (Object.hasOwn(incoming, "trading_status")) {
    merged.trading_status = incoming.trading_status; merged.no_trade_evidence = incoming.no_trade_evidence;
    if (merged.no_trade_evidence?.source !== "naver_daily_history") { merged.actual_open = null; merged.actual_close = null; merged.actual_volume = null; merged.session_return = null; }
    else if (merged.expected_open > 0) { delete merged.trading_status; delete merged.no_trade_evidence; }
    // A halt seen by a forecast-stage quote leaves no opening estimate.
    if (merged.no_trade_evidence?.source === "naver_polling_quote" && incoming.expected_open === null && merged.expected_open !== null) { merged.expected_open = null; delete merged.expected_open_source; delete merged.expected_open_basis; if (merged.expected_close_basis) { merged.expected_close = null; delete merged.expected_close_basis; } }
  } else { delete merged.trading_status; delete merged.no_trade_evidence; }
  merged.expected_return = deriveExpectedReturn(merged);
  merged.error = deriveEvaluationError(merged);
  return merged;
}

export function mergeRows(existingRows, incomingRows, mode) {
  const bySymbol = new Map(existingRows.filter((row) => row.symbol).map((row) => [row.symbol, row]));
  const incomingSymbols = new Set(incomingRows.filter((row) => row.symbol).map((row) => row.symbol));
  const mergedRows = incomingRows.map((incoming) => {
    const existing = incoming.symbol ? bySymbol.get(incoming.symbol) : null;
    if (!existing) {
      const normalized = { ...incoming, expected_return: deriveExpectedReturn(incoming) };
      normalized.error = derivedError(normalized);
      return normalized;
    }

    if (mode === "open-settlement") {
      const merged = { ...existing };
      if (!(existing.expected_open > 0 && existing.expected_open_source) && incoming.expected_open_source) copyForecastBundle(merged, incoming);
      for (const field of ["rank", "symbol", "name", "quality", "status", ...OPEN_SETTLEMENT_FIELDS]) {
        if (Object.hasOwn(incoming, field)) merged[field] = incoming[field];
      }
      const expectedReturn = deriveExpectedReturn(merged);
      merged.expected_return = expectedReturn;
      merged.error = derivedError(merged);
      return applyTradingStatus(merged, incoming);
    }

    if (mode === "close-settlement") {
      const merged = { ...existing };
      if (!(existing.expected_open > 0 && existing.expected_open_source) && incoming.expected_open_source) copyForecastBundle(merged, incoming);
      for (const field of ["rank", "symbol", "name", "quality", "status", ...CLOSE_SETTLEMENT_FIELDS]) {
        if (Object.hasOwn(incoming, field)) merged[field] = incoming[field];
      }
      const sessionReturn = derivedSessionReturn(merged);
      if (sessionReturn !== null) merged.session_return = sessionReturn;
      merged.expected_return = deriveExpectedReturn(merged);
      merged.error = derivedError(merged);
      return applyTradingStatus(merged, incoming);
    }

    const merged = { ...existing, ...incoming };
    if (existing.expected_open > 0 && existing.expected_open_source) copyForecastBundle(merged, existing);
    else if (!incoming.expected_open_source) { delete merged.expected_open_source; delete merged.expected_open_basis; if (!incoming.expected_close_basis) delete merged.expected_close_basis; }
    for (const field of EXPECTED_FIELDS) {
      if (incoming[field] === null && existing[field] !== null) merged[field] = existing[field];
    }
    merged.expected_return = deriveExpectedReturn(merged);
    merged.error = derivedError(merged);
    return applyTradingStatus(merged, incoming);
  });
  for (const existing of existingRows) {
    if (existing.symbol && !incomingSymbols.has(existing.symbol)) mergedRows.push(existing);
  }
  // Rank on the merged values: incoming rows may carry a rank computed before
  // recorded expectations were merged in.
  mergedRows.sort(compareByExpectedReturn);
  mergedRows.forEach((row, index) => { row.rank = index + 1; });
  return mergedRows;
}

function carryExpectedRowsForUnavailableSettlement(rows, mode) {
  return rows.map((row) => ({ ...row, expected_return: deriveExpectedReturn(row), error: derivedError(row) }));
}

function unavailableRows(snapshot, mode, providerId = null) {
  if (providerId === "naver-crawl") return [];
  if (["open-settlement", "close-settlement"].includes(mode) && snapshot.rows.length > 0) {
    return carryExpectedRowsForUnavailableSettlement(snapshot.rows, mode);
  }
  return [];
}

function applyProviderResult(snapshot, result, mode, provider, providerId, attemptedAt) {
  if (!isProviderResult(result)) {
    const reason = "Provider result failed status/source/ranking schema validation.";
    return {
      ...snapshot,
      status: "degraded",
      mode: "provider",
      provider: providerInfo(provider, providerId, "degraded"),
      rows: unavailableRows(snapshot, mode, providerId),
      meta: { ...snapshot.meta, blockedReason: reason, isDemo: false, source: provider?.getSourceMetadata?.() || null },
      pipeline: { ...snapshot.pipeline, [MODES[mode].key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  }

  const source = result.source || provider?.getSourceMetadata?.() || null;
  if (result.status === "ready" && (!source || !source.retrieved_at)) {
    const reason = "Provider returned ready without source metadata and a collection timestamp; operational readiness is blocked.";
    return {
      ...snapshot,
      status: "degraded",
      mode: "provider",
      provider: providerInfo(provider, providerId, "degraded"),
      rows: unavailableRows(snapshot, mode, providerId),
      meta: { ...snapshot.meta, blockedReason: reason, source_warning: null, isDemo: false, source },
      pipeline: { ...snapshot.pipeline, [MODES[mode].key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  }
  if (result.status === "ready" && !["confirmed", "unconfirmed"].includes(source.license_status)) {
    const reason = `Provider returned ready with unsupported license status '${source.license_status}'; operational readiness is blocked.`;
    return {
      ...snapshot,
      status: "degraded",
      mode: "provider",
      provider: providerInfo(provider, providerId, "degraded"),
      rows: unavailableRows(snapshot, mode, providerId),
      meta: { ...snapshot.meta, blockedReason: reason, source_warning: null, isDemo: false, source },
      pipeline: { ...snapshot.pipeline, [MODES[mode].key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  }
  const preserveExpectedRows = result.status === "no_data"
    && ["forecast", "open-settlement", "close-settlement"].includes(mode)
    && snapshot.rows.length > 0;
  const rows = result.status === "ready" || result.status === "demo"
    ? mergeRows(snapshot.rows, result.rows, mode)
    : preserveExpectedRows ? carryExpectedRowsForUnavailableSettlement(snapshot.rows, mode) : [];
  const effectiveStatus = preserveExpectedRows && ["open-settlement", "close-settlement"].includes(mode)
    ? "partial"
    : result.status;
  const rowValidation = validateRankingRows(rows, { koreanSymbols: providerId === "naver-crawl" });
  if (!rowValidation.valid) {
    const reason = rowValidation.reason;
    return {
      ...snapshot,
      status: "degraded",
      mode: "provider",
      provider: providerInfo(provider, providerId, "degraded"),
        rows: unavailableRows(snapshot, mode, providerId),
      meta: { ...snapshot.meta, blockedReason: reason, isDemo: false, source },
      pipeline: { ...snapshot.pipeline, [MODES[mode].key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  }

  const isFixture = providerId === "fixture";
  const isDemo = result.status === "demo" || isFixture;
  const snapshotMode = isFixture ? "fixture" : isDemo ? "demo" : "provider";
  const sourceWarning = source?.license_status === "unconfirmed" && (result.status === "ready" || providerId === "naver-crawl")
    ? "Source license_status is unconfirmed; daily market and adjustment basis and common-share classification are unconfirmed. Preferred shares may be included."
    : null;
  const pipelineMessage = sourceWarning ? `${result.message} Warning: ${sourceWarning}` : result.message;
  return {
    ...snapshot,
    status: effectiveStatus,
    mode: snapshotMode,
    asOfDate: result.asOfDate || snapshot.asOfDate || null,
    publishedAt: result.status === "ready" || isDemo ? attemptedAt : snapshot.publishedAt || null,
    provider: providerInfo(provider, providerId, effectiveStatus),
    rows: rowValidation.rows,
    meta: {
      ...snapshot.meta,
      lastAttemptAt: attemptedAt,
      lastAttemptMode: mode,
      blockedReason: result.status === "ready" ? null : result.message,
      source_warning: sourceWarning,
      isDemo,
      ...(providerId === "fixture" ? { fixture_note: "SYNTHETIC fixture only; not historical 08:30 forecast data." } : {}),
      source,
    },
    pipeline: {
      ...snapshot.pipeline,
      [MODES[mode].key]: { status: result.status, attemptedAt, provider_id: providerId || null, message: pipelineMessage },
    },
  };
}

export async function run(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (!options) return { help: true };
  const modeConfig = MODES[options.mode];
  const stageStartedAt = (dependencies.now || (() => new Date()))();
  if (!(stageStartedAt instanceof Date) || !Number.isFinite(stageStartedAt.getTime())) throw new Error("Invalid stage collection time");
  const currentRunId = process.env.KOSPI_RUN_ID || null;
  const timely = (recordedAt, sourceSnapshot) => savedOpeningIsTimely(recordedAt, options.runContext.referenceTime, stageStartedAt.toISOString(), Boolean(currentRunId && sourceSnapshot?.meta?.run_id === currentRunId));
  const latestPath = resolve(options.dataFile || "data/latest-snapshot.json");
  const runPath = resolve("data", "runs", options.runDate, `${options.mode === "update-results" ? "0700" : options.mode === "analysis" ? "0800" : options.mode === "forecast" ? "0820" : options.mode === "open-settlement" ? "0900" : "1530"}.json`);
  const previousMode = {
    "update-results": null,
    analysis: "update-results",
    forecast: "analysis",
    "open-settlement": "forecast",
    "close-settlement": "open-settlement",
  }[options.mode];
  const previousPath = previousMode
    ? resolve("data", "runs", options.runDate, `${previousMode === "update-results" ? "0700" : previousMode === "analysis" ? "0800" : previousMode === "forecast" ? "0820" : "0900"}.json`)
    : null;
  const explicitDataFile = Boolean(options.dataFile);
  async function readIfPresent(path, expectedStage = null) {
    if (!path) return null;
    try {
      await access(path);
      const candidate = JSON.parse(await readFile(path, "utf8"));
      return expectedStage && !snapshotBelongsToStage(candidate, options.runDate, expectedStage, options.mode) ? null : candidate;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  let snapshot;
  const recoveredSymbols = new Set();
  if (explicitDataFile) {
    snapshot = JSON.parse(await readFile(latestPath, "utf8"));
  } else {
    snapshot = await readIfPresent(runPath, options.mode)
      || await readIfPresent(previousPath, previousMode);
    if (snapshot?.meta?.historical_test || snapshot?.meta?.test_only || snapshot?.mode === "historical_test") snapshot = null;
    snapshot ||= noDataSnapshot();
    // Recover the latest genuine pre-open record even if an intermediate run is missing.
    const recovered = new Map();
    for (const [label, stage] of [["0820", "forecast"], ["0800", "analysis"], ["0700", "update-results"]]) {
      const prior = await readIfPresent(resolve("data", "runs", options.runDate, `${label}.json`), stage);
      if (prior?.asOfDate !== options.runDate || prior?.mode !== "provider" || prior?.provider?.id !== "naver-crawl" || !Array.isArray(prior.rows)) continue;
      for (const row of prior.rows) {
        if (!row.symbol || recovered.has(row.symbol) || !(row.expected_open > 0)) continue;
        const src = row.expected_open_source;
        const t = Date.parse(src?.recorded_at || row.quote_at);
        const kst = new Date(t + 9 * 3600000);
        const before = Number.isFinite(t) && kst.toISOString().slice(0, 10) === options.runDate && kst.getUTCHours() < 9;
        const validSource = src && ["preopen_quote", "preopen_history"].includes(src.kind);
        const legacyQuote = !src && row.market_status === "PREOPEN" && row.quality === "naver_preopen_quote";
        if (!before || !timely(src?.recorded_at || row.quote_at, prior) || (!validSource && !legacyQuote)) continue;
        recoveredSymbols.add(row.symbol);
        recovered.set(row.symbol, { row, expected_open: row.expected_open, expected_open_source: src || { kind: "preopen_quote", recorded_at: row.quote_at, history_dates: [] },
          ...(src && row.expected_open_basis ? { expected_open_basis: row.expected_open_basis } : {}),
          ...(src && row.expected_close_basis ? { expected_close: row.expected_close, expected_close_basis: row.expected_close_basis } : {}) });
      }
    }
    snapshot = { ...snapshot, rows: snapshot.rows.map((row) => {
      const previous = recovered.get(row.symbol);
      if (!previous) return row;
      const merged = { ...row, expected_open: previous.expected_open, expected_open_source: previous.expected_open_source };
      delete merged.expected_open_basis;
      if (previous.expected_open_basis) merged.expected_open_basis = previous.expected_open_basis;
      if (previous.expected_close_basis) { merged.expected_close = previous.expected_close; merged.expected_close_basis = previous.expected_close_basis; }
      else if (merged.expected_close_basis) { merged.expected_close = null; delete merged.expected_close_basis; }
      merged.expected_return = deriveExpectedReturn(merged); merged.error = derivedError(merged);
      return merged;
    }) };
    if (recovered.size && !snapshot.asOfDate) snapshot.asOfDate = options.runDate;
    const present = new Set(snapshot.rows.map((row) => row.symbol));
    for (const [symbol, saved] of recovered) if (!present.has(symbol)) {
      const prior = saved.row;
      snapshot.rows.push({ rank: prior.rank, symbol, name: prior.name, expected_open: saved.expected_open, expected_open_source: saved.expected_open_source,
        ...(saved.expected_open_basis ? { expected_open_basis: saved.expected_open_basis } : {}),
        expected_close: saved.expected_close ?? null, ...(saved.expected_close_basis ? { expected_close_basis: saved.expected_close_basis } : {}), expected_return: deriveExpectedReturn({ expected_open: saved.expected_open, expected_close: saved.expected_close ?? null }), actual_open: null, actual_close: null, actual_return: null, error: null, status: prior.status });
    }
  }
  const attemptedAt = options.attemptedAt;
  const { provider, providerId } = resolveProvider(process.env, { ...options, ...dependencies });
  if (providerId === "naver-crawl") {
    snapshot = { ...snapshot, rows: snapshot.rows.map((row) => {
      if (row.expected_open_source && (recoveredSymbols.has(row.symbol) || timely(row.expected_open_source.recorded_at, snapshot))) return row;
      // Old intraday current-price baselines have no reliable pre-open origin.
      const clean = { ...row, expected_open: null, expected_return: null, error: null };
      delete clean.expected_open_source; delete clean.expected_open_basis;
      // A closing estimate derived from a removed opening goes with it.
      if (clean.expected_close_basis) { clean.expected_close = null; delete clean.expected_close_basis; }
      return clean;
    }) };
  }
  let nextSnapshot = {
    ...snapshot,
    meta: {
      ...snapshot.meta,
      lastAttemptAt: attemptedAt,
      lastAttemptMode: options.mode,
      run_date: options.runDate,
      run_stage: options.mode,
      run_id: process.env.KOSPI_RUN_ID || null,
    },
  };

  if (!provider) {
    const reason = providerId === "none"
      ? "Provider 'none' was explicitly selected. No financial values are generated and this stage is not successful."
      : `Provider '${providerId}' is not registered. Register an adapter before enabling it.`;
    const status = providerId === "none" ? "no_data" : "degraded";
    nextSnapshot = {
      ...nextSnapshot,
      status,
      mode: "provider",
      provider: providerInfo(null, providerId, providerId === "none" ? "disabled" : "unsupported"),
      rows: unavailableRows(nextSnapshot, options.mode, providerId),
      meta: { ...nextSnapshot.meta, isDemo: false, blockedReason: reason, source: null },
      pipeline: { ...nextSnapshot.pipeline, [modeConfig.key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  } else if (!isProviderAdapter(provider)) {
    const reason = `Provider '${provider.id}' does not satisfy the adapter contract.`;
    nextSnapshot = {
      ...nextSnapshot,
      status: "degraded",
      mode: "provider",
      provider: providerInfo(provider, providerId, "degraded"),
      rows: unavailableRows(nextSnapshot, options.mode, providerId),
      meta: { ...nextSnapshot.meta, isDemo: false, blockedReason: reason, source: provider.getSourceMetadata?.() || null },
      pipeline: { ...nextSnapshot.pipeline, [modeConfig.key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  } else {
    const result = await provider[modeConfig.method]({ snapshot: nextSnapshot, env: process.env });
    nextSnapshot = applyProviderResult(nextSnapshot, result, options.mode, provider, providerId, attemptedAt);
  }

  const output = `${JSON.stringify(nextSnapshot, null, 2)}\n`;
  let wroteRunFile = false;
  let wroteLatestFile = false;
  if (!options.dryRun) {
    const preserveExisting = ["blocked", "degraded", "partial"].includes(nextSnapshot.status);
    async function writeSnapshot(path) {
      await mkdir(dirname(path), { recursive: true });
      try { await writeFile(path, output, preserveExisting ? { encoding: "utf8", flag: "wx" } : "utf8"); return true; }
      catch (error) { if (preserveExisting && error.code === "EEXIST") return false; throw error; }
    }
    if (!explicitDataFile) wroteRunFile = await writeSnapshot(runPath);
    wroteLatestFile = await writeSnapshot(latestPath);
  }
  const summary = {
    mode: options.mode,
    runDate: options.runDate,
    attemptedAt,
    referenceTime: attemptedAt,
    provider: providerId,
    status: nextSnapshot.status,
    message: nextSnapshot.pipeline?.[modeConfig.key]?.message || nextSnapshot.meta?.blockedReason || null,
    sourceWarning: nextSnapshot.meta?.source_warning || null,
    source: nextSnapshot.meta?.source || null,
    dryRun: options.dryRun,
    stageFile: explicitDataFile ? null : runPath,
    wroteRunFile,
    wroteLatestFile,
    wroteFile: wroteLatestFile,
  };
  await appendJobSummary(summary);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `status=${summary.status}\n`);
  }
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().then((summary) => {
    if (!summary.help && !summary.dryRun && NON_READY_STATUSES.has(summary.status)) process.exitCode = 2;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
