import { readFile, writeFile } from "node:fs/promises";
import { isProviderAdapter } from "../providers/provider-adapter.js";
import { createDemoProvider } from "../providers/demo-provider.js";

const MODES = {
  "update-results": { key: "previousResult", method: "fetchPreviousDay" },
  analysis: { key: "analysis", method: "runAnalysis" },
  forecast: { key: "forecast", method: "generateForecast" },
};

function parseArgs(argv) {
  const options = { mode: null, dataFile: "data/latest-snapshot.json", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--mode") { options.mode = argv[index + 1]; index += 1; }
    else if (arg === "--data-file") { options.dataFile = argv[index + 1]; index += 1; }
    else if (arg === "--help") {
      console.log("Usage: node scripts/update-results.mjs --mode <update-results|analysis|forecast> [--data-file path] [--dry-run]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!MODES[options.mode]) throw new Error("--mode must be one of: update-results, analysis, forecast");
  return options;
}

function resolveProvider() {
  const providerId = (process.env.KOSPI_PROVIDER || "").trim().toLowerCase();
  if (!providerId || providerId === "none") return { provider: null, providerId: null };
  if (providerId === "demo") return { provider: createDemoProvider(), providerId };
  return { provider: null, providerId };
}

function blockedStep({ attemptedAt, providerId, reason }) {
  return { status: "blocked", attemptedAt, providerId: providerId || null, message: reason };
}

function mergeProviderResult(snapshot, result, mode) {
  const next = { ...snapshot };
  if (result?.rows && Array.isArray(result.rows)) next.rows = result.rows;
  if (result?.status === "demo") {
    next.status = "demo";
    next.mode = "demo";
    next.provider = { id: "demo", status: "demo", label: "DEMO MODE · UI / SCHEMA ONLY" };
    next.meta = { ...next.meta, isDemo: true, blockedReason: "Demo data is not a financial measurement or prediction performance result." };
  }
  next.pipeline = {
    ...next.pipeline,
    [MODES[mode].key]: { status: result?.status || "blocked", attemptedAt: next.meta.lastAttemptAt, message: result?.message || null },
  };
  return next;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const modeConfig = MODES[options.mode];
  const snapshot = JSON.parse(await readFile(options.dataFile, "utf8"));
  const attemptedAt = new Date().toISOString();
  const { provider, providerId } = resolveProvider();
  let nextSnapshot = { ...snapshot, meta: { ...snapshot.meta, lastAttemptAt: attemptedAt, lastAttemptMode: options.mode } };

  if (!provider) {
    const reason = providerId
      ? `Provider '${providerId}' is not registered. Register an adapter before enabling it.`
      : "No market data provider is configured. No financial values are generated.";
    nextSnapshot.status = "no_data";
    nextSnapshot.mode = "provider";
    nextSnapshot.provider = { id: providerId, status: "not_configured", label: "연결된 데이터 공급자 없음" };
    nextSnapshot.rows = [];
    nextSnapshot.meta = { ...nextSnapshot.meta, isDemo: false, blockedReason: reason };
    nextSnapshot.pipeline = { ...nextSnapshot.pipeline, [modeConfig.key]: blockedStep({ attemptedAt, providerId, reason }) };
  } else if (!isProviderAdapter(provider)) {
    const reason = `Provider '${provider.id}' does not satisfy the adapter contract.`;
    nextSnapshot.status = "blocked";
    nextSnapshot.rows = [];
    nextSnapshot.meta = { ...nextSnapshot.meta, isDemo: false, blockedReason: reason };
    nextSnapshot.pipeline = { ...nextSnapshot.pipeline, [modeConfig.key]: blockedStep({ attemptedAt, providerId, reason }) };
  } else {
    const result = await provider[modeConfig.method]({ snapshot: nextSnapshot, env: process.env });
    nextSnapshot = mergeProviderResult(nextSnapshot, result, options.mode);
  }

  const output = `${JSON.stringify(nextSnapshot, null, 2)}\n`;
  if (!options.dryRun) await writeFile(options.dataFile, output, "utf8");
  console.log(JSON.stringify({ mode: options.mode, provider: providerId, status: nextSnapshot.status, wroteFile: !options.dryRun }));
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

