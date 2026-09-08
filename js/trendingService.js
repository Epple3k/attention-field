// Fetches Wikipedia's own daily "most read" list — the Wikimedia Pageviews
// REST API's per-day top-articles endpoint — so the field can surface pages
// getting heavy reader traffic right now, not just ones being actively
// edited. Same "real, publicly published number" grounding as the rest of
// this app: no engagement-optimized trending algorithm, just Wikipedia's
// own raw daily view counts, filtered down to actual articles.

const BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/";

// Non-article namespaces and utility pages that always dominate raw
// pageviews but aren't "a topic people are reading about."
const EXCLUDED_PREFIXES = [
  "Special:",
  "Wikipedia:",
  "Portal:",
  "Help:",
  "File:",
  "Talk:",
  "Template:",
  "Category:",
  "User:",
];
const EXCLUDED_TITLES = new Set(["Main_Page", "-"]);

function pad(n) {
  return String(n).padStart(2, "0");
}

function dayUrl(date) {
  return `${BASE}${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
}

async function fetchDay(date) {
  try {
    const res = await fetch(dayUrl(date));
    if (!res.ok) return null;
    const data = await res.json();
    return data.items && data.items[0] ? data.items[0].articles : null;
  } catch {
    return null;
  }
}

/** Resolves to the current top `limit` genuinely-an-article pages by daily
 * pageviews, ranked 1..limit — [] if the API has neither today's nor
 * yesterday's data ready (the endpoint lags real time by a few hours right
 * after UTC midnight, and today's list still fills in as the day goes on,
 * which is exactly why this is re-fetched periodically rather than once). */
export async function fetchTopTrending(limit = 10) {
  const today = new Date();
  let articles = await fetchDay(today);
  if (!articles) {
    const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
    articles = await fetchDay(yesterday);
  }
  if (!articles) return [];

  const filtered = articles.filter(
    (a) => !EXCLUDED_TITLES.has(a.article) && !EXCLUDED_PREFIXES.some((p) => a.article.startsWith(p))
  );

  return filtered.slice(0, limit).map((a, i) => ({
    title: a.article.replace(/_/g, " "),
    views: a.views,
    rank: i + 1,
  }));
}
