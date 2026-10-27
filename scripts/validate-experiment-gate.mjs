import { pathToFileURL } from "node:url";

const VALID_PHASES = new Set(["before-open", "during-market"]);
const ACCEPTED_EXPERIMENT_STATUSES = new Set(["experimental", "preserved"]);

function parseCandidatePhases(value) {
  if (typeof value !== "string") return null;
  if (value === "") return [];
  const phases = value.split(",");
  if (phases.some((phase) => !VALID_PHASES.has(phase))) return null;
  if (new Set(phases).size !== phases.length) return null;
  return phases;
}

function parseBoolean(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

export function experimentGateDecision({ status, statusSaved, candidate, candidatePhases, reason, notApplicable, postCloseRun }) {
  const phases = Array.isArray(candidatePhases) ? [...candidatePhases] : parseCandidatePhases(candidatePhases);
  const saved = parseBoolean(statusSaved);
  const hasCandidate = parseBoolean(candidate);
  const explicitlyNotApplicable = parseBoolean(notApplicable);
  const postClose = parseBoolean(postCloseRun);
  const reasons = [];

  if (!phases || phases.some((phase) => !VALID_PHASES.has(phase)) || new Set(phases).size !== phases.length) {
    reasons.push("candidate phases are invalid");
  }
  if (saved !== true) reasons.push("experiment status was not saved");
  if (hasCandidate === null || (phases && hasCandidate !== (phases.length > 0))) {
    reasons.push("candidate state does not match candidate phases");
  }

  const emptyNoData = status === "no_data"
    && reason === "data_unavailable"
    && explicitlyNotApplicable === true
    && postClose === true
    && hasCandidate === false
    && phases?.length === 0;
  if (ACCEPTED_EXPERIMENT_STATUSES.has(status) && (hasCandidate !== true || !phases || phases.length === 0)) {
    reasons.push("experimental result must have a non-empty candidate phase state");
  }
  if (!ACCEPTED_EXPERIMENT_STATUSES.has(status) && !emptyNoData) {
    reasons.push(`experiment status is not accepted: ${status || "missing"}`);
  }

  return { allowed: reasons.length === 0, reasons };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const decision = experimentGateDecision({
    status: process.env.EXPERIMENT_STATUS,
    statusSaved: process.env.STATUS_SAVED,
    candidate: process.env.EXPERIMENT_CANDIDATE,
    candidatePhases: process.env.EXPERIMENT_CANDIDATES,
    reason: process.env.EXPERIMENT_REASON,
    notApplicable: process.env.EXPERIMENT_NOT_APPLICABLE,
    postCloseRun: process.env.EXPERIMENT_POST_CLOSE,
  });
  if (!decision.allowed) {
    console.error(`Isolated experiment gate rejected: ${decision.reasons.join("; ")}.`);
    process.exitCode = 1;
  }
}
