import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDaily } from "../scripts/archive-naver-daily.mjs";

test("archive keeps the requested window per month, drops today before 16:00 KST and records revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-archive-")), before = process.env.KOSPI_DATA_ROOT;
  process.env.KOSPI_DATA_ROOT = root;
  try {
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "kospi-universe.json"), JSON.stringify({ symbols: [{ symbol: "005930" }, { symbol: "000660" }] }));
    let close = 110, asked = null;
    const collector = async ({ symbols, targetDate }) => { asked = targetDate; return { status: "ready", requested: symbols.length, rejected: [{ symbol: "000660", date: "2026-10-27", reason: "zero_volume" }],
      observations: [["2026-06-01", "005930"], ["2026-07-15", "005930"], ["2026-10-28", "005930"], ["2026-10-28", "000660"]].map(([date, symbol]) => ({ symbol, date, open: 100, high: 120, low: 90, close, volume: 5 })) }; };
    const r = await archiveDaily({ months: 4, now: () => new Date("2026-10-29T05:00:00Z"), collector, log: () => {} }); // 14:00 KST
    assert.equal(asked, "2026-10-29", "today is excluded before 16:00 KST"); assert.equal(r.lastDate, "2026-10-28"); assert.equal(r.firstDate, "2026-06-28");
    assert.deepEqual(r.written.map((w) => w.month), ["2026-07", "2026-10"], "bars before the window are dropped");
    const oct = JSON.parse(await readFile(join(root, "data", "daily-archive", "2026-10.json"), "utf8"));
    assert.deepEqual(oct.bars["005930"], [["2026-10-28", 100, 120, 90, 110, 5]]); assert.equal(oct.rejected.length, 1);
    close = 111;
    const again = await archiveDaily({ months: 4, now: () => new Date("2026-10-29T08:00:00Z"), collector, log: () => {} }); // 17:00 KST
    assert.equal(asked, "2026-10-30"); assert.equal(again.written.find((w) => w.month === "2026-10").revised, 2);
    const oct2 = JSON.parse(await readFile(join(root, "data", "daily-archive", "2026-10.json"), "utf8"));
    assert.equal(oct2.bars["005930"][0][4], 111); assert.equal(oct2.revised[0].previous[4], 110);
    await assert.rejects(archiveDaily({ months: 4, collector: async () => ({ status: "blocked", requested: 0, reason: "robots" }), log: () => {} }), /incomplete/);
  } finally {
    if (before === undefined) delete process.env.KOSPI_DATA_ROOT; else process.env.KOSPI_DATA_ROOT = before;
    await rm(root, { recursive: true, force: true });
  }
});
