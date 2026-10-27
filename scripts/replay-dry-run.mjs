import { readFile } from "node:fs/promises";
import { isSnapshot } from "../providers/provider-adapter.js";

const dates = process.argv.includes("--date")
  ? [process.argv[process.argv.indexOf("--date") + 1]]
  : ["2026-10-22", "2026-10-23"];

for (const date of dates) {
  if (!/^2026-10-(22|23)$/.test(date)) throw new Error(`Unsupported replay date: ${date}`);
  const snapshot = JSON.parse(await readFile(`data/replays/${date}.json`, "utf8"));
  if (!isSnapshot(snapshot) || snapshot.mode !== "replay" || snapshot.meta?.isDemo !== true) {
    throw new Error(`Invalid baseline replay snapshot: ${date}`);
  }
  if (snapshot.provider?.id !== "replay_baseline" || snapshot.baseline?.basis !== "previous_session_close") {
    throw new Error(`Missing previous-session-close baseline contract: ${date}`);
  }
  if (!snapshot.rows.length || snapshot.rows.some((row) => [row.expected_open, row.expected_close, row.expected_return, row.actual_open, row.actual_close, row.session_return, row.error].some((value) => typeof value !== "number"))) {
    throw new Error(`Replay rows are incomplete: ${date}`);
  }
  console.log(JSON.stringify({ date, mode: snapshot.meta.replay_type, rows: snapshot.rows.length, dryRun: true }));
}
