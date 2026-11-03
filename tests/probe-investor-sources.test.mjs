import test from "node:test";
import assert from "node:assert/strict";
import { describePayload, probe, MAX_REQUESTS } from "../scripts/probe-investor-sources.mjs";

const json = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(body) });
const text = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, headers: new Headers({ "content-type": "text/plain" }), text: async () => body });
const rows = (from, n) => Array.from({ length: n }, (_, i) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - i); return { itemCode: "005930", bizdate: d.toISOString().slice(0, 10).replaceAll("-", ""), foreignerPureBuyQuant: "+1", organPureBuyQuant: "-1", individualPureBuyQuant: "0" }; });

test("describePayload finds dated investor tables without values", () => {
  const t = describePayload({ result: { list: rows("2026-11-02", 3) } }).find((x) => x.rows);
  assert.equal(t.path, "result.list");
  assert.equal(t.rows, 3);
  assert.equal(t.date_key, "bizdate");
  assert.equal(t.first_date, "2026-10-31");
  assert.equal(t.last_date, "2026-11-02");
  assert.deepEqual(t.investor_keys, ["foreignerPureBuyQuant", "organPureBuyQuant", "individualPureBuyQuant"]);
});

test("probe never requests data from m.stock.naver.com and honours robots", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/robots.txt") return u.host === "m.stock.naver.com" ? text("User-agent: *\nDisallow: /\n") : u.host === "polling.finance.naver.com" ? text("User-agent: *\nDisallow: /api/\n") : text("", 404);
    if (u.host === "api.stock.naver.com" && u.pathname.endsWith("/trend")) {
      const size = Number(u.searchParams.get("pageSize") || 10), biz = u.searchParams.get("bizdate");
      const start = biz ? new Date(Date.UTC(+biz.slice(0, 4), +biz.slice(4, 6) - 1, +biz.slice(6, 8) - 1)).toISOString().slice(0, 10) : "2026-11-02";
      return start < "2026-01-01" ? json([]) : json(rows(start, Math.min(size, 100)));
    }
    return json({}, 404);
  };
  const report = await probe({ fetchImpl, sleep: async () => {}, log: () => {} });
  assert.ok(calls.filter((u) => u.startsWith("https://m.stock.naver.com/")).every((u) => u.endsWith("/robots.txt")));
  assert.ok(!calls.some((u) => u.startsWith("https://polling.finance.naver.com/api/")));
  assert.equal(report.robots.find((r) => r.origin === "https://m.stock.naver.com").ok, false);
  assert.match(report.best.url, /api\.stock\.naver\.com\/stock\/005930\/trend$/);
  assert.equal(report.depth.page_size, 100);
  assert.ok(report.depth.oldest_date < "2026-06-01");
  assert.ok(report.requests_sent <= MAX_REQUESTS);
});
