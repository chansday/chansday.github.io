import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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

export const MODES = {
  "update-results": { key: "previousResult", method: "fetchPreviousDay" },
  analysis: { key: "analysis", method: "runAnalysis" },
  forecast: { key: "forecast", method: "generateForecast" },
  "open-settlement": { key: "openSettlement", method: "settleOpen" },
  "close-settlement": { key: "closeSettlement", method: "settleClose" },
};

export const RUN_STAGE_TIMES = Object.freeze({
  "update-results": "07:00:00",
  analysis: "08:00:00",
  forecast: "08:20:00",
  "open-settlement": "09:00:00",
  "close-settlement": "15:30:00",
});

const EXPECTED_FIELDS = Object.freeze(["expected_open", "expected_close", "expected_return"]);
const OPEN_SETTLEMENT_FIELDS = Object.freeze(["actual_open", "actual_return"]);
const CLOSE_SETTLEMENT_FIELDS = Object.freeze(["actual_close", "session_return", "actual_volume"]);

function kstDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function stageAttemptedAt(runDate, mode) {
  return new Date(`${runDate}T${RUN_STAGE_TIMES[mode]}+09:00`).toISOString();
}

function parseAttemptedAt(value, runDate, mode) {
  const attemptedAt = value || stageAttemptedAt(runDate, mode);
  if (Number.isNaN(Date.parse(attemptedAt))) throw new Error(`Invalid --attempted-at value: ${attemptedAt}`);
  return new Date(attemptedAt).toISOString();
}

function parseArgs(argv) {
  const options = {
    mode: null,
    dataFile: null,
    dryRun: false,
    provider: null,
    fixtureDate: null,
    runDate: process.env.KOSPI_RUN_DATE || kstDate(),
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
    else if (arg === "--attempted-at") { options.attemptedAt = argv[index + 1]; index += 1; }
    else if (arg === "--help") {
      console.log("Usage: node scripts/update-results.mjs --mode <update-results|analysis|forecast|open-settlement|close-settlement> [--provider id] [--fixture-date YYYY-MM-DD] [--run-date YYYY-MM-DD] [--attempted-at ISO] [--data-file path] [--dry-run]");
      return null;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.mode || !MODES[options.mode]) {
    throw new Error("--mode must be one of: update-results, analysis, forecast, open-settlement, close-settlement");
  }
  if (!validDate(options.runDate)) throw new Error(`--run-date must be YYYY-MM-DD: ${options.runDate}`);
  options.attemptedAt = parseAttemptedAt(options.attemptedAt, options.runDate, options.mode);
  return options;
}

function resolveProvider(env = process.env, options = {}) {
  const providerId = (options.provider ?? env.KOSPI_PROVIDER ?? "").trim().toLowerCase();
  const providerEnv = {
    ...env,
    ...(options.fixtureDate ? { KOSPI_FIXTURE_DATE: options.fixtureDate } : {}),
    KOSPI_RUN_DATE: options.runDate,
    KOSPI_RUN_ID: `${options.runDate}-${options.mode}`,
    KOSPI_STABLE_SNAPSHOT: "1",
    GITHUB_RUN_ID: undefined,
  };
  const now = () => new Date(options.attemptedAt);
  if (!providerId || providerId === "none") return { provider: null, providerId: null };
  if (providerId === "demo") return { provider: createDemoProvider(), providerId };
  if (providerId === "fixture") return { provider: createFixtureProvider({ env: providerEnv }), providerId };
  if (providerId === "public-json") return { provider: createPublicJsonProvider({ env: providerEnv, now }), providerId };
  if (providerId === "public-csv") return { provider: createPublicCsvProvider({ env: providerEnv, now }), providerId };
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

function derivedError(row) {
  return typeof row.actual_return === "number" && typeof row.expected_return === "number"
    ? Math.round((row.actual_return - row.expected_return + Number.EPSILON) * 100) / 100
    : null;
}

function derivedActualReturn(row) {
  return typeof row.actual_open === "number" && row.actual_open >= 0 && typeof row.prior_close === "number" && row.prior_close > 0
    ? Math.round(((row.actual_open / row.prior_close - 1) * 100 + Number.EPSILON) * 100) / 100
    : null;
}

function derivedSessionReturn(row) {
  return typeof row.actual_open === "number" && row.actual_open > 0 && typeof row.actual_close === "number"
    ? Math.round(((row.actual_close / row.actual_open - 1) * 100 + Number.EPSILON) * 100) / 100
    : null;
}

export function mergeRows(existingRows, incomingRows, mode) {
  const bySymbol = new Map(existingRows.filter((row) => row.symbol).map((row) => [row.symbol, row]));
  const incomingSymbols = new Set(incomingRows.filter((row) => row.symbol).map((row) => row.symbol));
  const mergedRows = incomingRows.map((incoming) => {
    const existing = incoming.symbol ? bySymbol.get(incoming.symbol) : null;
    if (!existing) return incoming;

    if (mode === "open-settlement") {
      const merged = { ...existing };
      for (const field of ["rank", "symbol", "name", "quality", "status", ...OPEN_SETTLEMENT_FIELDS]) {
        if (Object.hasOwn(incoming, field)) merged[field] = incoming[field];
      }
      const actualReturn = derivedActualReturn(merged);
      if (actualReturn !== null) merged.actual_return = actualReturn;
      merged.error = derivedError(merged);
      return merged;
    }

    if (mode === "close-settlement") {
      const merged = { ...existing };
      for (const field of ["rank", "symbol", "name", "quality", "status", ...CLOSE_SETTLEMENT_FIELDS]) {
        if (Object.hasOwn(incoming, field)) merged[field] = incoming[field];
      }
      const sessionReturn = derivedSessionReturn(merged);
      if (sessionReturn !== null) merged.session_return = sessionReturn;
      merged.error = derivedError(merged);
      return merged;
    }

    const merged = { ...existing, ...incoming };
    for (const field of EXPECTED_FIELDS) {
      if (incoming[field] === null && existing[field] !== null) merged[field] = existing[field];
    }
    return merged;
  });
  for (const existing of existingRows) {
    if (existing.symbol && !incomingSymbols.has(existing.symbol)) mergedRows.push(existing);
  }
  return mergedRows;
}

function carryExpectedRowsForUnavailableSettlement(rows, mode) {
  return rows.map((row) => ({ ...row, error: derivedError(row) }));
}

function unavailableRows(snapshot, mode) {
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
      rows: unavailableRows(snapshot, mode),
      meta: { ...snapshot.meta, blockedReason: reason, isDemo: false, source: provider?.getSourceMetadata?.() || null },
      pipeline: { ...snapshot.pipeline, [MODES[mode].key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  }

  const source = result.source || provider?.getSourceMetadata?.() || null;
  if (result.status === "ready" && (!source || source.license_status !== "confirmed" || !source.retrieved_at)) {
    const reason = "Ready data requires confirmed source licensing and a retrieval timestamp.";
    return {
      ...snapshot,
      status: "degraded",
      mode: "provider",
      provider: providerInfo(provider, providerId, "degraded"),
      rows: unavailableRows(snapshot, mode),
      meta: { ...snapshot.meta, blockedReason: reason, isDemo: false, source },
      pipeline: { ...snapshot.pipeline, [MODES[mode].key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  }

  const preserveExpectedRows = result.status === "no_data" && ["open-settlement", "close-settlement"].includes(mode) && snapshot.rows.length > 0;
  const rows = result.status === "ready" || result.status === "demo"
    ? mergeRows(snapshot.rows, result.rows, mode)
    : preserveExpectedRows ? carryExpectedRowsForUnavailableSettlement(snapshot.rows, mode) : [];
  const effectiveStatus = preserveExpectedRows ? "partial" : result.status;
  const rowValidation = validateRankingRows(rows);
  if (!rowValidation.valid) {
    const reason = rowValidation.reason;
    return {
      ...snapshot,
      status: "degraded",
      mode: "provider",
      provider: providerInfo(provider, providerId, "degraded"),
      rows: unavailableRows(snapshot, mode),
      meta: { ...snapshot.meta, blockedReason: reason, isDemo: false, source },
      pipeline: { ...snapshot.pipeline, [MODES[mode].key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  }

  const isFixture = providerId === "fixture";
  const isDemo = result.status === "demo" || isFixture;
  const snapshotMode = isFixture ? "fixture" : isDemo ? "demo" : "provider";
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
      isDemo,
      ...(providerId === "fixture" ? { fixture_note: "SYNTHETIC fixture only; not historical 08:30 forecast data." } : {}),
      source,
    },
    pipeline: {
      ...snapshot.pipeline,
      [MODES[mode].key]: { status: result.status, attemptedAt, provider_id: providerId || null, message: result.message },
    },
  };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options) return { help: true };
  const modeConfig = MODES[options.mode];
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
  async function readIfPresent(path) {
    if (!path) return null;
    try {
      await access(path);
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  let snapshot;
  if (explicitDataFile) {
    snapshot = JSON.parse(await readFile(latestPath, "utf8"));
  } else {
    snapshot = await readIfPresent(runPath)
      || await readIfPresent(previousPath)
      || await readIfPresent(latestPath);
    if (snapshot?.meta?.historical_test || snapshot?.meta?.test_only || snapshot?.mode === "historical_test") snapshot = null;
    snapshot ||= noDataSnapshot();
  }
  const attemptedAt = options.attemptedAt;
  const { provider, providerId } = resolveProvider(process.env, options);
  let nextSnapshot = {
    ...snapshot,
    meta: {
      ...snapshot.meta,
      lastAttemptAt: attemptedAt,
      lastAttemptMode: options.mode,
      run_date: options.runDate,
      run_stage: options.mode,
    },
  };

  if (!provider) {
    const reason = providerId
      ? `Provider '${providerId}' is not registered. Register an adapter before enabling it.`
      : "No market data provider is configured. No financial values are generated.";
    const status = providerId ? "degraded" : "no_data";
    nextSnapshot = {
      ...nextSnapshot,
      status,
      mode: "provider",
      provider: providerInfo(null, providerId, providerId ? "unsupported" : "not_configured"),
      rows: unavailableRows(nextSnapshot, options.mode),
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
      rows: unavailableRows(nextSnapshot, options.mode),
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
    if (explicitDataFile) {
      await mkdir(dirname(latestPath), { recursive: true });
      await writeFile(latestPath, output, "utf8");
      wroteLatestFile = true;
    } else {
      await mkdir(dirname(runPath), { recursive: true });
      await mkdir(dirname(latestPath), { recursive: true });
      await writeFile(runPath, output, "utf8");
      await writeFile(latestPath, output, "utf8");
      wroteRunFile = true;
      wroteLatestFile = true;
    }
  }
  const summary = {
    mode: options.mode,
    runDate: options.runDate,
    attemptedAt,
    provider: providerId,
    status: nextSnapshot.status,
    stageFile: explicitDataFile ? null : runPath,
    wroteRunFile,
    wroteLatestFile,
    wroteFile: wroteLatestFile,
  };
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
