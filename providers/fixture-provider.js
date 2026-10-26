import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isSnapshot, validateRankingRows } from "./provider-adapter.js";

export const FIXTURE_DATES = Object.freeze(["2026-10-22", "2026-10-23"]);

const STAGE_MESSAGES = Object.freeze({
  previousResult: "합성 전일 결과 예시입니다. 실제 시장 관측값이 아닙니다.",
  analysis: "합성 분석 단계 예시입니다. 실제 입력·모델 결과가 아닙니다.",
  forecast: "합성 expected_* UI 값만 표시합니다. 08:30 KST 실제 입력 스냅샷이 없어 역사적 예측을 재구성하지 않았습니다.",
  closeSettlement: "합성 expected_*와 actual_*를 병합하는 정산 흐름 예시입니다. 실제 장마감 값이 아닙니다.",
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validDate(value) {
  return FIXTURE_DATES.includes(value);
}

function emptyStage(message) {
  return { status: "blocked", message, rows: [], source: null, asOfDate: null };
}

function stageRows(rows, stage) {
  return rows.map((row) => {
    const base = clone(row);
    base.status = "demo";
    if (stage === "previousResult") {
      base.expected_open = null;
      base.expected_close = null;
      base.expected_return = null;
      base.error = null;
      base.quality = "fixture_previous_result";
    } else if (stage === "analysis") {
      base.expected_open = null;
      base.expected_close = null;
      base.expected_return = null;
      base.actual_open = null;
      base.actual_close = null;
      base.actual_return = null;
      base.error = null;
      base.quality = "fixture_analysis";
    } else if (stage === "forecast") {
      base.actual_open = null;
      base.actual_close = null;
      base.actual_return = null;
      base.error = null;
      base.quality = "fixture_expected_only";
    } else {
      base.quality = "fixture_settled";
    }
    return base;
  });
}

export function createFixtureProvider({
  env = process.env,
  fixtureDate = env.KOSPI_FIXTURE_DATE,
  fixtureDir = resolve(process.cwd(), "data", "fixtures"),
} = {}) {
  const selectedDate = String(fixtureDate || "").trim();
  const label = `FIXTURE / SYNTHETIC ONLY / ${selectedDate || "date required"}`;

  async function loadFixture() {
    if (!validDate(selectedDate)) {
      throw new Error(`Fixture date must be one of: ${FIXTURE_DATES.join(", ")}.`);
    }
    const path = resolve(fixtureDir, `${selectedDate}.json`);
    const fixture = JSON.parse(await readFile(path, "utf8"));
    if (!isSnapshot(fixture) || fixture.mode !== "fixture" || fixture.meta?.isDemo !== true) {
      throw new Error(`Fixture ${selectedDate} does not satisfy the fixture snapshot contract.`);
    }
    if (!validateRankingRows(fixture.rows).valid) {
      throw new Error(`Fixture ${selectedDate} contains invalid ranking rows.`);
    }
    return fixture;
  }

  async function stage(stage) {
    try {
      const fixture = await loadFixture();
      return {
        status: "demo",
        message: STAGE_MESSAGES[stage],
        rows: stageRows(fixture.rows, stage),
        source: null,
        asOfDate: fixture.asOfDate,
      };
    } catch (error) {
      return emptyStage(error.message);
    }
  }

  return {
    id: "fixture",
    label,
    status: "demo",
    isDemo: true,
    fixtureDate: selectedDate || null,
    getSourceMetadata() {
      return null;
    },
    async getSnapshot() {
      try {
        return await loadFixture();
      } catch (error) {
        return { status: "blocked", mode: "fixture", message: error.message, rows: [] };
      }
    },
    async fetchPreviousDay() {
      return stage("previousResult");
    },
    async runAnalysis() {
      return stage("analysis");
    },
    async generateForecast() {
      return stage("forecast");
    },
    async settleClose() {
      return stage("closeSettlement");
    },
  };
}
