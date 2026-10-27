import assert from "node:assert/strict";
import test from "node:test";
import { sortRankingRows } from "../providers/ranking-sort.js";

test("default ranking sorts expected_return descending and keeps null values last", () => {
  const rows = [
    { symbol: "C", name: "씨", expectedReturn: null },
    { symbol: "B", name: "비", expectedReturn: 2 },
    { symbol: "A", name: "에이", expectedReturn: 2 },
    { symbol: "D", name: "디", expectedReturn: -1 },
  ];
  assert.deepEqual(sortRankingRows(rows).map((row) => row.symbol), ["A", "B", "D", "C"]);
  assert.deepEqual(sortRankingRows(rows.filter((row) => row.symbol !== "D")).map((row) => row.symbol), ["A", "B", "C"]);
});

test("ranking tie order is deterministic across repeated renders", () => {
  const rows = [
    { symbol: "B", name: "비", expectedReturn: null },
    { symbol: "A", name: "에이", expectedReturn: null },
  ];
  const expected = ["A", "B"];
  assert.deepEqual(sortRankingRows(rows).map((row) => row.symbol), expected);
  assert.deepEqual(sortRankingRows([...rows]).map((row) => row.symbol), expected);
});
