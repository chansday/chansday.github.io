import test from "node:test";
import assert from "node:assert/strict";
import { closeBasisFor, mergeRows } from "../scripts/update-results.mjs";
import { crossCheckClose } from "../scripts/collection-audit.mjs";
import { validateRankingRows } from "../providers/provider-adapter.js";

const base = { rank: 1, symbol: "005930", name: "삼성전자", expected_open: 100, expected_close: null, expected_return: null, actual_open: 100, actual_close: null, actual_return: null, error: null, status: "valid", quote_at: "2026-10-29T00:20:00.000Z", quote_age_seconds: 1, market_status: "PREOPEN" };
// 15:30:05 KST = 06:30:05Z; 23:17 KST = 14:17Z.
const closeQuote = (close, quoteAt, age) => ({ ...base, actual_close: close, quote_at: quoteAt, quote_age_seconds: age, market_status: "CLOSE" });

test("closeBasisFor classifies by KST observation time", () => {
  assert.equal(closeBasisFor(closeQuote(101, "2026-10-29T06:30:00.000Z", 5)), "krx_regular");
  assert.equal(closeBasisFor(closeQuote(101, "2026-10-29T06:30:00.000Z", 600)), "integrated_nxt");
  assert.equal(closeBasisFor(closeQuote(101, "2026-10-29T14:17:00.000Z", 1)), "integrated_nxt");
  assert.equal(closeBasisFor({ ...base, quote_at: null, quote_age_seconds: null }), "daily_chart");
});

test("close settlement records its own quote stamp and keeps inherited quote_at", () => {
  const [row] = mergeRows([base], [closeQuote(110, "2026-10-29T06:30:00.000Z", 5)], "close-settlement");
  assert.equal(row.actual_close, 110);
  assert.equal(row.close_quote_at, "2026-10-29T06:30:00.000Z");
  assert.equal(row.close_quote_age_seconds, 5);
  assert.equal(row.close_market_status, "CLOSE");
  assert.equal(row.close_basis, "krx_regular");
  assert.equal(validateRankingRows([row]).valid, true, validateRankingRows([row]).reason);
});

test("a later integrated close never replaces a krx_regular close", () => {
  const [krx] = mergeRows([base], [closeQuote(110, "2026-10-29T06:30:00.000Z", 5)], "close-settlement");
  const [late] = mergeRows([krx], [closeQuote(112, "2026-10-29T14:17:00.000Z", 1)], "close-settlement");
  assert.equal(late.actual_close, 110);
  assert.equal(late.close_basis, "krx_regular");
  const [first] = mergeRows([base], [closeQuote(112, "2026-10-29T14:17:00.000Z", 1)], "close-settlement");
  assert.equal(first.actual_close, 112);
  assert.equal(first.close_basis, "integrated_nxt");
});

test("open settlement records open_* quote stamp", () => {
  const [row] = mergeRows([{ ...base, actual_open: null }], [{ ...base, actual_open: 101, quote_at: "2026-10-29T00:00:30.000Z", quote_age_seconds: 2, market_status: "OPEN" }], "open-settlement");
  assert.equal(row.open_quote_at, "2026-10-29T00:00:30.000Z");
  assert.equal(row.open_market_status, "OPEN");
  assert.equal(row.open_quote_age_seconds, 2);
});

test("close_basis is validated and cross-checked against the next prior close", () => {
  assert.equal(validateRankingRows([{ ...base, close_basis: "nxt" }]).valid, false);
  const closes = [{ ...base, actual_close: 110, close_basis: "krx_regular" }, { ...base, symbol: "000660", actual_close: 50, close_basis: "krx_regular" }];
  const next = [{ symbol: "005930", prior_close: 110, prior_close_source: "naver_polling_close_minus_change" }, { symbol: "000660", prior_close: 51, prior_close_source: "naver_polling_close_minus_change" }];
  assert.deepEqual(crossCheckClose(closes, next), { compared: 2, matched: 1, krx_regular_mismatches: ["000660"], prior_close_adjusted: [] });
});

test("KRX close window bounds: 15:30:00 is inside, 15:40:00 is outside", () => {
  assert.equal(closeBasisFor(closeQuote(101, "2026-10-30T06:30:00.000Z", 0)), "krx_regular");
  assert.equal(closeBasisFor(closeQuote(101, "2026-10-30T06:40:00.000Z", 0)), "integrated_nxt");
});

test("next-day prior_close adjustment is an explained exception, not a mismatch", () => {
  const closes = [{ ...base, actual_close: 10000, close_basis: "krx_regular" }, { ...base, symbol: "000660", actual_close: 50, close_basis: "krx_regular" }];
  // Ex-rights: next base price 9000 differs from the real 15:30 close 10000.
  const next = [{ symbol: "005930", prior_close: 9000, prior_close_source: "naver_polling_close_minus_change" }, { symbol: "000660", prior_close: 51, prior_close_source: "naver_polling_close_minus_change" }];
  assert.deepEqual(crossCheckClose(closes, next, ["005930"]), { compared: 2, matched: 0, krx_regular_mismatches: ["000660"], prior_close_adjusted: ["005930"] });
});
