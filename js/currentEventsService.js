// Checks Wikipedia's own "In the news" feed — the curated box on its Main
// Page, exposed as structured JSON via the featured-feed REST API — for a
// real, editorially-sourced sentence explaining why a given article is
// getting attention right now. This is an actual outside lookup, not
// another heuristic: it either finds a genuine current-events story that
// names one of the field's active articles, or it finds nothing, and the
// Index view falls back to the Pattern Engine's edit-summary heuristic
// (see insights.js) when it does.

const FEED_BASE = "https://en.wikipedia.org/api/rest_v1/feed/featured/";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let cachedStories = []; // [{ text, titles: Set<normalized title> }]
let lastFetchAt = 0;
let fetchPromise = null;

function pad(n) {
  return String(n).padStart(2, "0");
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(title) {
  return title.replace(/_/g, " ").trim().toLowerCase();
}

async function fetchDay(date) {
  try {
    const url = `${FEED_BASE}${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const news = data.news || [];
    return news
      .map((item) => ({
        text: stripHtml(item.story || ""),
        titles: new Set((item.links || []).map((l) => normalizeTitle(l.title || ""))),
      }))
      .filter((s) => s.text && s.titles.size);
  } catch {
    return [];
  }
}

/** Refreshes the cached "In the news" stories if stale (or never fetched).
 * Fire-and-forget from main.js's frame loop — findEventForTitles() below
 * just reads whatever's cached, returning null until the first successful
 * fetch resolves, so nothing has to await this. */
export async function refreshCurrentEvents() {
  const now = Date.now();
  if (now - lastFetchAt < REFRESH_INTERVAL_MS && cachedStories.length) return;
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const today = new Date();
      const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
      const [todayStories, yesterdayStories] = await Promise.all([fetchDay(today), fetchDay(yesterday)]);
      // today's edition first (more relevant); de-duped by story text so a
      // story still current across the UTC day boundary isn't offered twice
      const seen = new Set();
      const merged = [];
      for (const s of [...todayStories, ...yesterdayStories]) {
        if (seen.has(s.text)) continue;
        seen.add(s.text);
        merged.push(s);
      }
      if (merged.length) {
        cachedStories = merged;
        lastFetchAt = Date.now();
      }
      // an empty result (both days genuinely had nothing, vs. a fetch
      // failure) still updates the timestamp so a bad day doesn't retry
      // every frame — but a transient network failure throws before here
      // and leaves the previous cache and timestamp untouched.
      else lastFetchAt = Date.now();
    } finally {
      fetchPromise = null;
    }
  })();
  return fetchPromise;
}

/** Synchronous lookup against whatever's currently cached — given a list of
 * article titles (e.g. a cluster's members, or a single node), returns the
 * plain-text "In the news" story that names one of them, or null if none
 * of them are currently in the news. */
export function findEventForTitles(titles) {
  if (!cachedStories.length) return null;
  const normalized = titles.map(normalizeTitle);
  for (const story of cachedStories) {
    if (normalized.some((t) => story.titles.has(t))) return story.text;
  }
  return null;
}
