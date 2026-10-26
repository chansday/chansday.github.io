import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isProviderAdapter,
  isProviderResult,
  validateRankingRows,
} from "../providers/provider-adapter.js";
import { createDemoProvider } from "../providers/demo-provider.js";
import { createPublicJsonProvider } from "../providers/public-json-provider.js";

export const MODES = {
  "update-results": { key: "previousResult", method: "fetchPreviousDay" },
  analysis: { key: "analysis", method: "runAnalysis" },
  forecast: { key: "forecast", method: "generateForecast" },
  "close-settlement": { key: "closeSettlement", method: "settleClose" },
};

function parseArgs(argv) {
  const options = { mode: null, dataFile: "data/latest-snapshot.json", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--mode") { options.mode = argv[index + 1]; index += 1; }
    else if (arg === "--data-file") { options.dataFile = argv[index + 1]; index += 1; }
    else if (arg === "--help") {
      console.log("Usage: node scripts/update-results.mjs --mode <update-results|analysis|forecast|close-settlement> [--data-file path] [--dry-run]");
      return null;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.mode || !MODES[options.mode]) {
    throw new Error("--mode must be one of: update-results, analysis, forecast, close-settlement");
  }
  return options;
}

function resolveProvider(env = process.env) {
  const providerId = (env.KOSPI_PROVIDER || "").trim().toLowerCase();
  if (!providerId || providerId === "none") return { provider: null, providerId: null };
  if (providerId === "demo") return { provider: createDemoProvider(), providerId };
  if (providerId === "public-json") return { provider: createPublicJsonProvider({ env }), providerId };
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

function mergeRows(existingRows, incomingRows, mode) {
  if (mode !== "close-settlement") return incomingRows;
  const bySymbol = new Map(existingRows.filter((row) => row.symbol).map((row) => [row.symbol, row]));
  return incomingRows.map((incoming) => {
    const existing = incoming.symbol ? bySymbol.get(incoming.symbol) : null;
    if (!existing) return incoming;
    const expectedFields = ["expected_open", "expected_close", "expected_return"];
    return {
      ...existing,
      ...incoming,
      ...Object.fromEntries(expectedFields.map((field) => [field, incoming[field] ?? existing[field] ?? null])),
    };
  });
}

function applyProviderResult(snapshot, result, mode, provider, providerId, attemptedAt) {
  if (!isProviderResult(result)) {
    const reason = "Provider result failed status/source/ranking schema validation.";
    return {
      ...snapshot,
      status: "degraded",
      mode: "provider",
      provider: providerInfo(provider, providerId, "degraded"),
      rows: [],
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
      rows: [],
      meta: { ...snapshot.meta, blockedReason: reason, isDemo: false, source },
      pipeline: { ...snapshot.pipeline, [MODES[mode].key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  }

  const rows = result.status === "ready" || result.status === "demo"
    ? mergeRows(snapshot.rows, result.rows, mode)
    : [];
  const rowValidation = validateRankingRows(rows);
  if (!rowValidation.valid) {
    const reason = rowValidation.reason;
    return {
      ...snapshot,
      status: "degraded",
      mode: "provider",
      provider: providerInfo(provider, providerId, "degraded"),
      rows: [],
      meta: { ...snapshot.meta, blockedReason: reason, isDemo: false, source },
      pipeline: { ...snapshot.pipeline, [MODES[mode].key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  }

  const isDemo = result.status === "demo";
  return {
    ...snapshot,
    status: result.status,
    mode: isDemo ? "demo" : "provider",
    asOfDate: result.asOfDate || snapshot.asOfDate || null,
    publishedAt: result.status === "ready" || isDemo ? attemptedAt : snapshot.publishedAt || null,
    provider: providerInfo(provider, providerId, result.status),
    rows: rowValidation.rows,
    meta: {
      ...snapshot.meta,
      lastAttemptAt: attemptedAt,
      lastAttemptMode: mode,
      blockedReason: result.status === "ready" ? null : result.message,
      isDemo,
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
  const snapshot = JSON.parse(await readFile(options.dataFile, "utf8"));
  const attemptedAt = new Date().toISOString();
  const { provider, providerId } = resolveProvider();
  let nextSnapshot = {
    ...snapshot,
    meta: { ...snapshot.meta, lastAttemptAt: attemptedAt, lastAttemptMode: options.mode },
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
      rows: [],
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
      rows: [],
      meta: { ...nextSnapshot.meta, isDemo: false, blockedReason: reason, source: provider.getSourceMetadata?.() || null },
      pipeline: { ...nextSnapshot.pipeline, [modeConfig.key]: blockedStep({ attemptedAt, providerId, reason }) },
    };
  } else {
    const result = await provider[modeConfig.method]({ snapshot: nextSnapshot, env: process.env });
    nextSnapshot = applyProviderResult(nextSnapshot, result, options.mode, provider, providerId, attemptedAt);
  }

  const output = `${JSON.stringify(nextSnapshot, null, 2)}\n`;
  if (!options.dryRun) await writeFile(options.dataFile, output, "utf8");
  const summary = { mode: options.mode, provider: providerId, status: nextSnapshot.status, wroteFile: !options.dryRun };
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
