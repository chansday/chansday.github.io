import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INVESTOR_USER_AGENTS } from "../providers/investor-request.js";
import { backfillInvestorFlow, oldestSavedDate, trendPageUrl } from "../scripts/backfill-investor-flow.mjs";

const json = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(body) });
// Weekday sessions strictly before `before`, newest first, back to `listed`.
function sessions(before, n, listed) {
  const out = [], d = new Date(`${before}T00:00:00Z`);
  while (out.length < n) { d.setUTCDate(d.getUTCDate() - 1); const iso = d.toISOString().slice(0, 10); if (iso < listed) break; if (d.getUTCDay() % 6) out.push(iso); }
  return out;
}
const fakeSource = (listed, calls = []) => async (url, init) => {
  calls.push({ url, ua: init.headers["User-Agent"] });
  const u = new URL(url), symbol = u.pathname.split("/")[3], biz = u.searchParams.get("bizdate");
  const before = `${biz.slice(0, 4)}-${biz.slice(4, 6)}-${biz.slice(6, 8)}`;
  return json(sessions(before, Number(u.searchParams.get("pageSize")), listed[symbol]).map((date) => ({ itemCode: symbol, bizdate: date.replaceAll("-", ""), foreignerPureBuyQuant: "+10", organPureBuyQuant: "-3", individualPureBuyQuant: "-7", foreignerHoldRatio: "1.00%" })));
};
const opts = (dir, extra = {}) => ({ directory: dir, now: () => new Date("2026-11-03T05:00:00Z"), sleep: async () => {}, log: () => {}, ...extra });

test("trend page URL uses the collector endpoint with 60-session pages before a date", () => {
  assert.equal(trendPageUrl("005930", "2026-10-26"), "https://m.stock.naver.com/api/stock/005930/trend?pageSize=60&bizdate=20261026");
  assert.throws(() => trendPageUrl("../x", "2026-10-26"));
});

test("backfills date files round by round until the source is exhausted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flow-")), calls = [], rounds = [];
  const summary = await backfillInvestorFlow(["005930", "000660"], opts(dir, { before: "2026-10-26", fetchImpl: fakeSource({ "005930": "2026-03-01", "000660": "2026-06-01" }, calls), afterRound: async (r) => rounds.push(r) }));
  assert.equal(summary.stopped, "source_exhausted");
  assert.ok(calls.every((c) => c.ua === "kospi-signal-personal-investor-collector/1.0" && c.url.startsWith("https://m.stock.naver.com/api/stock/")));
  assert.ok(rounds.length >= 3);
  const files = (await readdir(dir)).sort();
  assert.equal(files[0], "2026-03-02.json");
  assert.equal(files.at(-1), "2026-10-23.json");
  const early = JSON.parse(await readFile(join(dir, "2026-03-02.json"), "utf8"));
  assert.deepEqual(Object.keys(early.stocks), ["005930"]);
  const late = JSON.parse(await readFile(join(dir, "2026-10-23.json"), "utf8"));
  assert.deepEqual(late.stocks["000660"], { foreign_net_shares: 10, individual_net_shares: -7, institution_net_shares: -3 });
  assert.equal(await oldestSavedDate(dir), "2026-03-02");
});

test("a failed request stops without saving the incomplete round and keeps existing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flow-"));
  await writeFile(join(dir, "2026-10-26.json"), JSON.stringify({ date: "2026-10-26", unit: "shares", source: "naver-mobile-trend", stocks: { "005930": { foreign_net_shares: 1 } } }) + "\n");
  let n = 0;
  const ok = fakeSource({ "005930": "2020-01-01", "000660": "2020-01-01" });
  const summary = await backfillInvestorFlow(["005930", "000660"], opts(dir, { before: "2026-10-26", fetchImpl: async (u, i) => (++n >= 4 ? json({}, 403) : ok(u, i)) }));
  assert.equal(summary.stopped.symbol, "000660");
  assert.equal(summary.stopped.reason, "HTTP_403");
  assert.match(summary.stopped.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(summary.rounds.length, 1);
  assert.equal(n, 3 + INVESTOR_USER_AGENTS.length);
  assert.ok((await readdir(dir)).includes("2026-10-26.json"));
});

test("stops before a round that cannot fit the time budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flow-"));
  let t = Date.parse("2026-11-03T05:00:00Z");
  const summary = await backfillInvestorFlow(["005930"], opts(dir, { before: "2026-10-26", budgetMs: 1500, now: () => new Date(t), sleep: async (ms) => { t += ms; }, fetchImpl: fakeSource({ "005930": "2020-01-01" }) }));
  assert.equal(summary.stopped, "time_budget");
  assert.equal(summary.rounds.length, 2);
});

test("rejects sub-second pacing and invalid dates", async () => {
  await assert.rejects(backfillInvestorFlow(["005930"], { before: "2026-10-26", delayMs: 500, log: () => {} }));
  await assert.rejects(backfillInvestorFlow(["005930"], { before: "bad", log: () => {} }));
});
