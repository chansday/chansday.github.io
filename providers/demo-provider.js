import { emptyRow } from "./provider-adapter.js";

const DEMO_ROW = emptyRow({
  rank: 1,
  symbol: "DEMO-01",
  name: "예시 종목 (UI 전용)",
  status: "demo",
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function demoResult(message) {
  return { status: "demo", message, rows: [clone(DEMO_ROW)], source: null, asOfDate: null };
}

/**
 * Safe demo adapter. It renders the table shape without pretending that any
 * number is a market observation or a prediction result.
 */
export function createDemoProvider() {
  return {
    id: "demo",
    label: "DEMO MODE · UI / SCHEMA ONLY",
    status: "demo",
    getSourceMetadata() {
      return null;
    },
    async getSnapshot() {
      return {
        schemaVersion: "1.0.0",
        status: "demo",
        mode: "demo",
        asOfDate: null,
        publishedAt: null,
        market: { name: "KOSPI", currency: "KRW", timezone: "Asia/Seoul" },
        provider: { id: "demo", status: "demo", label: "DEMO MODE · UI / SCHEMA ONLY", source: null },
        pipeline: {
          previousResult: { status: "demo", attemptedAt: null, provider_id: "demo", message: "UI demo only" },
          analysis: { status: "demo", attemptedAt: null, provider_id: "demo", message: "UI demo only" },
          forecast: { status: "demo", attemptedAt: null, provider_id: "demo", message: "UI demo only" },
          closeSettlement: { status: "demo", attemptedAt: null, provider_id: "demo", message: "UI demo only" },
        },
        rows: [clone(DEMO_ROW)],
        meta: {
          generatedBy: "providers/demo-provider.js",
          lastAttemptAt: null,
          lastAttemptMode: "demo",
          blockedReason: "Demo data is not a financial measurement or prediction performance result.",
          isDemo: true,
          source: null,
        },
      };
    },
    async fetchPreviousDay() {
      return demoResult("DEMO MODE: 전일 실제 결과를 표시하지 않습니다.");
    },
    async runAnalysis() {
      return demoResult("DEMO MODE: 당일 분석 결과를 표시하지 않습니다.");
    },
    async generateForecast() {
      return demoResult("DEMO MODE: 사전예측 결과를 표시하지 않습니다.");
    },
    async settleClose() {
      return demoResult("DEMO MODE: 장마감 실제 결과를 표시하지 않습니다.");
    },
  };
}
