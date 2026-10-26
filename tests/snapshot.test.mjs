import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  emptyRow,
  isProviderAdapter,
  isSnapshot,
  validateRankingRows,
} from "../providers/provider-adapter.js";
import { createDemoProvider } from "../providers/demo-provider.js";
import { createPublicJsonProvider } from "../providers/public-json-provider.js";

test("static snapshot follows the top-level contract", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/latest-snapshot.json", import.meta.url), "utf8"));
  assert.equal(isSnapshot(snapshot), true);
  assert.equal(snapshot.market.name, "KOSPI");
  assert.equal(snapshot.market.timezone, "Asia/Seoul");
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.status, "no_data");
  assert.equal(snapshot.meta.source, null);
  assert.equal(snapshot.pipeline.closeSettlement.status, "pending");
});

test("ranking schema uses snake_case financial fields and rejects legacy names", () => {
  const row = emptyRow({
    rank: 1,
    symbol: "TEST",
    name: "검증용",
    expected_open: 100,
    expected_close: 101,
    expected_return: 1,
  });
  assert.equal(validateRankingRows([row]).valid, true);
  assert.equal(validateRankingRows([{ ...row, expectedOpen: 100 }]).valid, false);
});

test("demo provider implements the adapter without financial numbers", async () => {
  const provider = createDemoProvider();
  assert.equal(isProviderAdapter(provider), true);
  const snapshot = await provider.getSnapshot();
  assert.equal(snapshot.status, "demo");
  assert.equal(snapshot.meta.isDemo, true);
  for (const row of snapshot.rows) {
    assert.equal(row.expected_open, null);
    assert.equal(row.expected_close, null);
    assert.equal(row.actual_open, null);
    assert.equal(row.actual_close, null);
    assert.equal(row.expected_return, null);
    assert.equal(row.actual_return, null);
    assert.equal(row.error, null);
  }
});

test("public JSON provider is disabled without explicit source policy", async () => {
  const provider = createPublicJsonProvider({ env: {} });
  assert.equal(isProviderAdapter(provider), true);
  assert.equal(provider.getSourceMetadata(), null);
  const result = await provider.generateForecast();
  assert.equal(result.status, "degraded");
  assert.equal(result.rows.length, 0);
  assert.match(result.message, /explicit URL|license/i);
});
