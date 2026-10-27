import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ranking status labels remain visible in desktop and mobile layouts", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

  assert.match(css, /\.ranking-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  assert.doesNotMatch(css, /\.ranking-table-wrap\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.ranking-table-wrap\s*table\s*\{[^}]*min-width:\s*1060px/s);
  assert.match(css, /\.ranking-table-wrap th:last-child, \.ranking-table-wrap td:last-child\s*\{[^}]*min-width:\s*9rem/s);
  assert.match(css, /\.ranking-table-wrap td:last-child\s*\{[^}]*white-space:\s*normal/s);
  assert.match(css, /\.row-status\s*\{[^}]*max-width:\s*100%[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.status-pill, \.step-status\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.ranking-card-status\s*\{[^}]*margin-top:\s*12px/s);
  assert.match(html, /<th scope="col">상태<\/th>/);
  assert.match(html, /id="ranking-cards"[^>]*aria-label="모바일 종목 비교 목록"/);
  assert.match(app, /rowStatusLabel\(row\)/);
  assert.match(app, /deriveExpectedReturn\(\{ expected_open: expectedOpen, expected_close: expectedClose \}\)/);
  assert.match(app, /deriveEvaluationError\(\{ expected_open: expectedOpen, expected_close: expectedClose, actual_open: actualOpen, actual_close: actualClose \}\)/);
  assert.match(app, /sortRankingRows\(rows, sortKey\)/);
  assert.match(html, /<option value="expectedReturn" selected>예상 수익률 높은 순<\/option>/);
});
