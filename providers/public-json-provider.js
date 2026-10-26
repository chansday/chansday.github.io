import {
  createSourceMetadata,
  isProviderResult,
  validateRankingRows,
} from "./provider-adapter.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OVERALL_DEADLINE_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_AGE_HOURS = 72;
const CONFIRMED_LICENSE = "confirmed";
const USER_AGENT = "chansday-kospi-signal-board/1.0 (+https://chansday.github.io/)";

function readConfig(env) {
  const rawUrl = (env.KOSPI_PUBLIC_SOURCE_URL || "").trim();
  const name = (env.KOSPI_PUBLIC_SOURCE_NAME || "").trim();
  const licenseStatus = (env.KOSPI_PUBLIC_SOURCE_LICENSE_STATUS || "unconfirmed").trim().toLowerCase();
  const licenseUrl = (env.KOSPI_PUBLIC_SOURCE_LICENSE_URL || "").trim();
  const allowedHosts = (env.KOSPI_PUBLIC_SOURCE_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  if (!rawUrl || !name || !licenseUrl || licenseStatus !== CONFIRMED_LICENSE || allowedHosts.length === 0) {
    return {
      enabled: false,
      reason: "Public source requires an explicit URL, name, license URL, confirmed license status, and host allowlist.",
      source: null,
    };
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { enabled: false, reason: "Public source URL is invalid.", source: null };
  }
  if (url.protocol !== "https:") {
    return { enabled: false, reason: "Public source URL must use HTTPS.", source: null };
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    return { enabled: false, reason: "Public source host is not in the explicit allowlist.", source: null };
  }
  let parsedLicenseUrl;
  try {
    parsedLicenseUrl = new URL(licenseUrl);
  } catch {
    return { enabled: false, reason: "Public source license URL is invalid.", source: null };
  }
  if (parsedLicenseUrl.protocol !== "https:") {
    return { enabled: false, reason: "Public source license URL must use HTTPS.", source: null };
  }

  const requestedTimeout = Number(env.KOSPI_PUBLIC_SOURCE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const requestedDeadline = Number(env.KOSPI_PUBLIC_OVERALL_DEADLINE_MS || DEFAULT_OVERALL_DEADLINE_MS);
  const requestedRetries = Number(env.KOSPI_PUBLIC_MAX_RETRIES || DEFAULT_MAX_RETRIES);
  const requestedRetryBase = Number(env.KOSPI_PUBLIC_RETRY_BASE_MS || DEFAULT_RETRY_BASE_MS);
  const requestedMaxAge = Number(env.KOSPI_PUBLIC_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);

  return {
    enabled: true,
    url: url.toString(),
    timeoutMs: Number.isFinite(requestedTimeout) ? Math.max(1000, requestedTimeout) : DEFAULT_TIMEOUT_MS,
    overallDeadlineMs: Number.isFinite(requestedDeadline) ? Math.max(1000, requestedDeadline) : DEFAULT_OVERALL_DEADLINE_MS,
    maxRetries: Number.isFinite(requestedRetries) ? Math.min(3, Math.max(0, requestedRetries)) : DEFAULT_MAX_RETRIES,
    retryBaseMs: Number.isFinite(requestedRetryBase) ? Math.min(3000, Math.max(0, requestedRetryBase)) : DEFAULT_RETRY_BASE_MS,
    maxAgeHours: Number.isFinite(requestedMaxAge) ? Math.max(1, requestedMaxAge) : DEFAULT_MAX_AGE_HOURS,
    source: createSourceMetadata({
      name,
      url: url.toString(),
      licenseStatus,
      licenseUrl: parsedLicenseUrl.toString(),
    }),
  };
}

function blockedResult(config, message) {
  return {
    status: "degraded",
    message,
    rows: [],
    source: config.source,
    asOfDate: null,
  };
}

function normalizePayload(payload, source, stage, now, maxAgeHours) {
  if (!payload || typeof payload !== "object") {
    return { status: "degraded", message: "Public source returned a non-object JSON payload.", rows: [], source, asOfDate: null };
  }
  const validation = validateRankingRows(payload.rows);
  if (!validation.valid) return { status: "degraded", message: validation.reason, rows: [], source, asOfDate: null };
  const asOfDate = typeof payload.asOfDate === "string" ? payload.asOfDate : null;
  if (validation.rows.length > 0 && !asOfDate) return { status: "degraded", message: "Public JSON payload must include asOfDate; freshness cannot be verified.", rows: [], source, asOfDate: null };
  const observedAt = asOfDate ? new Date(`${asOfDate}T15:30:00+09:00`) : null;
  const stale = observedAt && (now.getTime() - observedAt.getTime()) / 3_600_000 > maxAgeHours;
  const status = stale ? "degraded" : payload.status === "degraded" ? "degraded" : validation.rows.length > 0 ? "ready" : "no_data";
  return {
    status,
    message: stale ? "Public JSON payload is stale; the previous snapshot is not reused." : `${stage} stage received ${validation.rows.length} validated row(s) from the configured public JSON source.`,
    rows: stale ? [] : validation.rows,
    source: { ...source, status: stale ? "stale" : source.status },
    asOfDate,
  };
}

async function fetchWithRetry(url, { config, fetchImpl, deadlineAt, metrics }) {
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return { ok: false, reason: "overall deadline exceeded" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, remaining));
    metrics.requested += 1;
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, redirect: "error", signal: controller.signal });
      if (response.ok) { metrics.completed += 1; return { ok: true, response }; }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= config.maxRetries) return { ok: false, reason: `HTTP ${response.status}` };
      metrics.retries += 1;
      const retryAfter = Number(response.headers?.get("retry-after") || 0);
      const delay = Math.min(3000, retryAfter > 0 ? retryAfter * 1000 : config.retryBaseMs * (2 ** attempt));
      if (Date.now() + delay >= deadlineAt) return { ok: false, reason: "overall deadline exceeded during retry backoff" };
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      if (attempt >= config.maxRetries) return { ok: false, reason: error.name === "AbortError" ? "source timeout or overall deadline exceeded" : `request failed: ${error.message}` };
      metrics.retries += 1;
      const delay = Math.min(3000, config.retryBaseMs * (2 ** attempt));
      if (Date.now() + delay >= deadlineAt) return { ok: false, reason: "overall deadline exceeded during retry backoff" };
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally { clearTimeout(timer); }
  }
  return { ok: false, reason: "retry budget exhausted" };
}

export function createPublicJsonProvider({ env = globalThis.process?.env || {}, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const config = readConfig(env);
  const provider = {
    id: "public-json",
    label: "PUBLIC JSON · OPT-IN ONLY",
    status: config.enabled ? "configured" : "disabled",
    getSourceMetadata() {
      return config.source;
    },
    async fetchPreviousDay() {
      return fetchStage(provider, "previous-result");
    },
    async runAnalysis() {
      return fetchStage(provider, "analysis");
    },
    async generateForecast() {
      return fetchStage(provider, "forecast");
    },
    async settleOpen() {
      return fetchStage(provider, "open-settlement");
    },
    async settleClose() {
      return fetchStage(provider, "close-settlement");
    },
  };

  async function fetchStage(currentProvider, stage) {
    if (!config.enabled) return blockedResult(config, config.reason);
    const startedAt = Date.now();
    const metrics = { requested: 0, completed: 0, failed: 0, retries: 0, deadline_hit: false };
    const retrievedAt = now().toISOString();
    try {
      const fetched = await fetchWithRetry(config.url, { config, fetchImpl, deadlineAt: startedAt + config.overallDeadlineMs, metrics });
      if (!fetched.ok) { metrics.failed += 1; return blockedResult(config, `Public source collection failed: ${fetched.reason}`); }
      const response = fetched.response;
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return blockedResult(config, "Public source response is not application/json; HTML scraping is not allowed.");
      }
      const payload = await response.json();
      const source = createSourceMetadata({
        name: config.source.name,
        url: config.source.url,
        licenseStatus: config.source.license_status,
        licenseUrl: config.source.license_url,
        retrievedAt,
        runId: env.GITHUB_RUN_ID || env.KOSPI_RUN_ID || `local-${startedAt}`,
        status: "ready",
        fetchedAt: retrievedAt,
        metrics: {
          ...metrics,
          elapsed_ms: env.KOSPI_STABLE_SNAPSHOT === "1" ? 0 : Date.now() - startedAt,
          overall_deadline_ms: config.overallDeadlineMs,
          max_concurrency: 1,
        },
      });
      const result = normalizePayload(payload, source, stage, now(), config.maxAgeHours);
      if (!isProviderResult(result)) return blockedResult(config, "Public source result failed provider-result validation.");
      return result;
    } catch (error) {
      const reason = error.name === "AbortError" ? "Public source request timed out." : `Public source request failed: ${error.message}`;
      return blockedResult(config, reason);
    }
  }

  return provider;
}

