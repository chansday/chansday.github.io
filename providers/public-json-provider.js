import {
  createSourceMetadata,
  isProviderResult,
  validateRankingRows,
} from "./provider-adapter.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const CONFIRMED_LICENSE = "confirmed";

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

  return {
    enabled: true,
    url: url.toString(),
    timeoutMs: Number.isFinite(requestedTimeout) ? Math.max(1000, requestedTimeout) : DEFAULT_TIMEOUT_MS,
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

function normalizePayload(payload, source, stage) {
  if (!payload || typeof payload !== "object") {
    return { status: "degraded", message: "Public source returned a non-object JSON payload.", rows: [], source, asOfDate: null };
  }
  const validation = validateRankingRows(payload.rows);
  if (!validation.valid) return { status: "degraded", message: validation.reason, rows: [], source, asOfDate: null };
  const status = payload.status === "degraded" ? "degraded" : validation.rows.length > 0 ? "ready" : "no_data";
  return {
    status,
    message: `${stage} stage received ${validation.rows.length} validated row(s) from the configured public JSON source.`,
    rows: validation.rows,
    source,
    asOfDate: typeof payload.asOfDate === "string" ? payload.asOfDate : null,
  };
}

export function createPublicJsonProvider({ env = globalThis.process?.env || {} } = {}) {
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
    async settleClose() {
      return fetchStage(provider, "close-settlement");
    },
  };

  async function fetchStage(currentProvider, stage) {
    if (!config.enabled) return blockedResult(config, config.reason);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const retrievedAt = new Date().toISOString();
    try {
      const response = await fetch(config.url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) return blockedResult(config, `Public source returned HTTP ${response.status}.`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return blockedResult(config, "Public source response is not application/json; HTML scraping is not allowed.");
      }
      const payload = await response.json();
      const source = createSourceMetadata({
        ...config.source,
        licenseStatus: config.source.license_status,
        licenseUrl: config.source.license_url,
        retrievedAt,
      });
      const result = normalizePayload(payload, source, stage);
      if (!isProviderResult(result)) return blockedResult(config, "Public source result failed provider-result validation.");
      return result;
    } catch (error) {
      const reason = error.name === "AbortError" ? "Public source request timed out." : `Public source request failed: ${error.message}`;
      return blockedResult(config, reason);
    } finally {
      clearTimeout(timer);
    }
  }

  return provider;
}
