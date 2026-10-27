import { pathToFileURL } from "node:url";

const KST_TIMEZONE = "Asia/Seoul";
const STAGE_BOUNDARIES = Object.freeze({
  open: "09:00:00",
  close: "15:30:00",
});

function kstParts(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
}

export function kstDate(date = new Date()) {
  const parts = kstParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function calculateRunContext(startedAt = null, { requireValue = false } = {}) {
  const rawStartedAt = startedAt ?? (requireValue ? null : process.env.KOSPI_RUN_STARTED_AT || new Date());
  if (!rawStartedAt) throw new Error("KOSPI_RUN_STARTED_AT is required; refusing to substitute the runner clock.");
  const referenceTime = rawStartedAt instanceof Date ? rawStartedAt : new Date(rawStartedAt);
  if (Number.isNaN(referenceTime.getTime())) {
    throw new Error(`Invalid KOSPI_RUN_STARTED_AT value: ${rawStartedAt}`);
  }
  return {
    startedAt: new Date(referenceTime.getTime()),
    runDate: kstDate(referenceTime),
    referenceTime: referenceTime.toISOString(),
    kst: kstParts(referenceTime),
  };
}

export function resolveStage(startedAt = null) {
  const context = calculateRunContext(startedAt, { requireValue: true });
  const time = `${context.kst.hour}:${context.kst.minute}:${context.kst.second}`;
  if (time < STAGE_BOUNDARIES.open) {
    return { ...context, phase: "before-open", stage: "forecast" };
  }
  if (time < STAGE_BOUNDARIES.close) {
    return { ...context, phase: "after-open", stage: "open-settlement" };
  }
  return { ...context, phase: "after-close", stage: "close-settlement" };
}

export function runContextFromEnvironment({ requireValue = false } = {}) {
  return calculateRunContext(process.env.KOSPI_RUN_STARTED_AT || null, { requireValue });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const context = resolveStage(process.env.KOSPI_RUN_STARTED_AT || null);
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_OUTPUT, [
        `run_started_at=${context.referenceTime}`,
        `run_date=${context.runDate}`,
        `phase=${context.phase}`,
        `stage=${context.stage}`,
      ].join("\n") + "\n");
    }
    console.log(JSON.stringify({
      run_started_at: context.referenceTime,
      run_date: context.runDate,
      phase: context.phase,
      stage: context.stage,
    }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
