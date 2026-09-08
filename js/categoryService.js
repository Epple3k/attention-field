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
      const set = chunkResult.get(t) || new Set();
      cache.set(t, set);
      results.set(t, set);
    }
  }

  return results;
}

async function fetchChunk(titles) {
  const url = new URL(API);
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "categories");
  url.searchParams.set("clshow", "!hidden");
  url.searchParams.set("cllimit", "50");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  url.searchParams.set("titles", titles.join("|"));

  const out = new Map();
  try {
    const res = await fetch(url.toString());
    if (!res.ok) return out;
    const data = await res.json();
    const pages = (data.query && data.query.pages) || {};
    for (const page of Object.values(pages)) {
      const set = new Set();
      for (const c of page.categories || []) {
        const name = c.title.replace(/^Category:/, "");
        if (!isNoiseCategory(name)) set.add(name);
      }
      out.set(page.title, set);
    }
  } catch {
    // network failure — caller falls back to an empty set per title
  }
  return out;
}
