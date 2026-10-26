import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isProviderAdapter, isSnapshot } from "../providers/provider-adapter.js";
import { createDemoProvider } from "../providers/demo-provider.js";

test("static snapshot follows the top-level contract", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/latest-snapshot.json", import.meta.url), "utf8"));
  assert.equal(isSnapshot(snapshot), true);
  assert.equal(snapshot.market.name, "KOSPI");
  assert.equal(snapshot.market.timezone, "Asia/Seoul");
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.status, "no_data");
});

test("demo provider implements the adapter without financial numbers", async () => {
  const provider = createDemoProvider();
  assert.equal(isProviderAdapter(provider), true);
  const snapshot = await provider.getSnapshot();
  assert.equal(snapshot.status, "demo");
  assert.equal(snapshot.meta.isDemo, true);
  for (const row of snapshot.rows) {
    assert.equal(row.expectedOpen, null);
    assert.equal(row.expectedClose, null);
    assert.equal(row.actualOpen, null);
    assert.equal(row.actualClose, null);
    assert.equal(row.expectedReturn, null);
    assert.equal(row.actualReturn, null);
    assert.equal(row.error, null);
  }
});

