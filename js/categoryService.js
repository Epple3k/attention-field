// Fetches real Wikipedia article categories for topic clustering.
// This is the project's actual semantic-similarity signal — grounded in
// data Wikipedia itself publishes, not an inferred or invented one.

const API = "https://en.wikipedia.org/w/api.php";
const BATCH_SIZE = 20;

// Administrative / maintenance categories that carry no topical meaning.
const NOISE_PATTERNS = [
  /wikipedia/i,
  /articles (with|containing|needing|using|lacking|to be|sourced)/i,
  /pages (using|with|containing)/i,
  /cs1 /i,
  /commons category/i,
  /webarchive/i,
  /wayback/i,
  /short description/i,
  /use (british|american|indian|australian|canadian|new zealand) english/i,
  /use (mdy|dmy) dates/i,
  /living people/i,
  /main topic classifications/i,
  /identifiers/i,
  /all stub articles/i,
  /^\d{3,4}s? (births|deaths|establishments|disestablishments)/i,
  /redirects/i,
  /good articles/i,
  /featured articles/i,
];

export function isNoiseCategory(name) {
  return NOISE_PATTERNS.some((re) => re.test(name));
}

const cache = new Map(); // title -> Set<string> (resolved only)

/** Resolves to a Map<title, Set<category>> for every requested title. */
export async function fetchCategoriesBatch(titles) {
  const results = new Map();
  const toFetch = [];

  for (const title of titles) {
    if (cache.has(title)) {
      results.set(title, cache.get(title));
    } else {
      toFetch.push(title);
    }
  }

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const chunk = toFetch.slice(i, i + BATCH_SIZE);
    const chunkResult = await fetchChunk(chunk);
    for (const t of chunk) {
      if (chunkResult.has(t)) {
        // resolved — even a legitimately empty category set is worth
        // caching, since re-fetching won't change that
        const set = chunkResult.get(t);
        cache.set(t, set);
        results.set(t, set);
      } else {
        // never came back (e.g. the request failed outright) — return an
        // empty set for this call, but don't cache it, so a title isn't
        // permanently treated as categoryless just because of one bad request
        results.set(t, new Set());
      }
    }
  }

  return results;
}

// MediaWiki's cllimit caps categories per RESPONSE, shared across every
// title in the request — not per title. Batch a few category-heavy
// articles together and an early one can exhaust the limit, leaving later
// ones with zero categories despite genuinely having some. `cllimit=max`
// (500 for anonymous requests) makes that rare; the continuation loop
// below handles it correctly whenever it still happens.
const MAX_CONTINUATIONS = 6;

async function fetchChunk(titles) {
  const out = new Map();
  let continueParams = null;
  let iterations = 0;

  try {
    while (iterations < MAX_CONTINUATIONS) {
      iterations += 1;

      const url = new URL(API);
      url.searchParams.set("action", "query");
      url.searchParams.set("prop", "categories");
      url.searchParams.set("clshow", "!hidden");
      url.searchParams.set("cllimit", "max");
      url.searchParams.set("format", "json");
      url.searchParams.set("origin", "*");
      url.searchParams.set("titles", titles.join("|"));
      if (continueParams) {
        for (const [k, v] of Object.entries(continueParams)) url.searchParams.set(k, v);
      }

      const res = await fetch(url.toString());
      if (!res.ok) break;
      const data = await res.json();
      const pages = (data.query && data.query.pages) || {};
      for (const page of Object.values(pages)) {
        if (!out.has(page.title)) out.set(page.title, new Set());
        const set = out.get(page.title);
        for (const c of page.categories || []) {
          const name = c.title.replace(/^Category:/, "");
          if (!isNoiseCategory(name)) set.add(name);
        }
      }

      if (!data.continue) break;
      continueParams = data.continue;
    }
  } catch {
    // network failure — return whatever was accumulated before it happened;
    // caller treats any still-missing title as an empty set
  }
  return out;
}
