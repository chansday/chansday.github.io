export function robotsAllowsPath(text, path, agent = "chansday-kospi-signal-board") {
  const groups = []; let agents = [], rules = [], seenRule = false;
  const flush = () => { if (agents.length) groups.push({ agents, rules }); agents = []; rules = []; seenRule = false; };
  for (const line of String(text || "").split(/\r?\n/)) {
    const clean = line.split("#", 1)[0].trim(); if (!clean) continue;
    const colon = clean.indexOf(":"); if (colon < 0) continue;
    const key = clean.slice(0, colon).trim().toLowerCase(), value = clean.slice(colon + 1).trim();
    if (key === "user-agent") { if (seenRule) flush(); if (value) agents.push(value.toLowerCase()); }
    else if ((key === "allow" || key === "disallow") && agents.length) { seenRule = true; if (value) rules.push({ key, value }); }
  }
  flush();
  const matchLength = (group) => Math.max(0, ...group.agents.filter((a) => a !== "*" && agent.toLowerCase().includes(a)).map((a) => a.length));
  const longestAgent = Math.max(0, ...groups.map(matchLength));
  const selected = longestAgent ? groups.filter((g) => matchLength(g) === longestAgent) : groups.filter((g) => g.agents.includes("*"));
  if (!selected.length) return false;
  const matches = selected.flatMap((g) => g.rules).filter(({ value }) => {
    const end = value.endsWith("$"); const prefix = end ? value.slice(0, -1) : value;
    const pattern = prefix.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${pattern}${end ? "$" : ""}`).test(path);
  }).sort((a,b) => b.value.replaceAll("*", "").length - a.value.replaceAll("*", "").length || (a.key === "allow" ? -1 : 1));
  return matches.length === 0 || matches[0].key === "allow";
}

// The policy is fetched once per origin for this collection, but every exact
// path and query is checked before its data request. Unavailable is fail-closed.
// With allowMissing, only HTTP 404/410 for robots.txt itself is treated as "no
// robots.txt" (RFC 9309 2.3.1.3). Redirects, 401/403/429, 5xx, network errors,
// timeouts and HTML 200 responses remain fail-closed.
// Some hosts answer a strict text/plain Accept with 406 instead of the real
// status; the wildcard lets them report 404 honestly. The User-Agent is unchanged.
const ROBOTS_ACCEPT = "text/plain, */*;q=0.1";
export const MISSING_ROBOTS_STATUSES = Object.freeze([404, 410]);
export async function checkRobotsUrl(context, target, userAgent, { allowMissing = false } = {}) {
  const url = new URL(target); const origin = url.origin;
  if (url.protocol !== "https:") return { ok: false, reason: `robots check requires https: ${origin}`, robotsUrl: `${origin}/robots.txt` };
  context.robotsCache ||= new Map();
  if (!context.robotsCache.has(origin)) {
    context.robotsCache.set(origin, (async () => {
      const robotsUrl = `${origin}/robots.txt`;
      try {
        const r = await context.fetchImpl(robotsUrl, { headers: { Accept: ROBOTS_ACCEPT, "User-Agent": userAgent }, redirect: "error", signal: AbortSignal.timeout(8000) });
        const date = context.now ? context.now() : new Date();
        const checkedAt = date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
        if (MISSING_ROBOTS_STATUSES.includes(r.status)) return { ok: true, missing: true, text: "", status: r.status, robotsUrl, checkedAt };
        if (!r.ok || r.status !== 200) return { ok: false, reason: `robots unavailable: HTTP ${r.status}`, robotsUrl };
        const type = r.headers?.get?.("content-type") || "";
        if (/text\/html/i.test(type)) return { ok: false, reason: "robots returned HTML", robotsUrl };
        const text = await r.text();
        if (!text || text.length > 524288) return { ok: false, reason: "robots empty or oversized", robotsUrl };
        if (!checkedAt) return { ok: false, reason: "robots timestamp unavailable", robotsUrl };
        return { ok: true, text, status: 200, robotsUrl, checkedAt };
      } catch (error) { return { ok: false, reason: `robots unavailable: ${error.name || "error"}`, robotsUrl }; }
    })());
  }
  const policy = await context.robotsCache.get(origin);
  if (!policy.ok) return policy;
  if (policy.missing) {
    if (!allowMissing) return { ok: false, reason: `robots unavailable: HTTP ${policy.status}`, robotsUrl: policy.robotsUrl };
    if (!policy.checkedAt) return { ok: false, reason: "robots timestamp unavailable", robotsUrl: policy.robotsUrl };
    return { ok: true, missing: true, robotsStatus: policy.status, robotsUrl: policy.robotsUrl, checkedAt: policy.checkedAt };
  }
  const product = String(userAgent).split(/\s/, 1)[0].split("/", 1)[0];
  if (!robotsAllowsPath(policy.text, `${url.pathname}${url.search}`, product)) return { ok: false, reason: `robots disallows ${url.pathname}${url.search}`, robotsUrl: policy.robotsUrl };
  return { ok: true, robotsStatus: 200, robotsUrl: policy.robotsUrl, checkedAt: policy.checkedAt };
}
