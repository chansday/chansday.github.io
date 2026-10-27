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
export async function checkRobotsUrl(context, target, userAgent) {
  const url = new URL(target); const origin = url.origin;
  context.robotsCache ||= new Map();
  if (!context.robotsCache.has(origin)) {
    context.robotsCache.set(origin, (async () => {
      const robotsUrl = `${origin}/robots.txt`;
      try {
        const r = await context.fetchImpl(robotsUrl, { headers: { Accept: "text/plain", "User-Agent": userAgent }, redirect: "error", signal: AbortSignal.timeout(8000) });
        if (!r.ok || r.status !== 200) return { ok: false, reason: `robots unavailable: HTTP ${r.status}`, robotsUrl };
        const type = r.headers?.get?.("content-type") || "";
        if (/text\/html/i.test(type)) return { ok: false, reason: "robots returned HTML", robotsUrl };
        const text = await r.text();
        if (!text || text.length > 524288) return { ok: false, reason: "robots empty or oversized", robotsUrl };
        const date = context.now ? context.now() : new Date();
        if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return { ok: false, reason: "robots timestamp unavailable", robotsUrl };
        return { ok: true, text, robotsUrl, checkedAt: date.toISOString() };
      } catch (error) { return { ok: false, reason: `robots unavailable: ${error.name || "error"}`, robotsUrl }; }
    })());
  }
  const policy = await context.robotsCache.get(origin);
  if (!policy.ok) return policy;
  const product = String(userAgent).split(/\s/, 1)[0].split("/", 1)[0];
  if (!robotsAllowsPath(policy.text, `${url.pathname}${url.search}`, product)) return { ok: false, reason: `robots disallows ${url.pathname}${url.search}`, robotsUrl: policy.robotsUrl };
  return { ok: true, robotsUrl: policy.robotsUrl, checkedAt: policy.checkedAt };
}
