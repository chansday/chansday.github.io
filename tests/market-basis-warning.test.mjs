import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("visible warning identifies unverified venue, adjustment and preferred shares", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /거래시장 및 수정주가 기준은 확인되지 않아/);
  assert.match(html, /우선주가 포함될 수 있습니다/);
  assert.match(html, /네이버 종목별 일봉을 사용합니다/);
});
