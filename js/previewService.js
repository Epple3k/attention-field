// Fetches a small live preview of a Wikipedia page — the plain-text
// extract and a thumbnail, if one exists — for the node hover panel.
// Same public, CORS-open Wikimedia REST API that powers Wikipedia's own
// "Page Previews" hovercards, so this is the same kind of preview a
// reader already gets on wikipedia.org itself, not a bespoke summary.

const API = "https://en.wikipedia.org/api/rest_v1/page/summary/";

const cache = new Map(); // title -> {extract, description, thumbnailUrl} | null | Promise
const imageCache = new Map(); // url -> HTMLImageElement

/** Resolves to {extract, description, thumbnailUrl} or null (page not
 * found, or the request failed — never throws). Cached per title for the
 * life of the page, including negative results, so a hover that fails
 * once doesn't retry on every subsequent hover. */
export async function fetchPagePreview(title) {
  if (cache.has(title)) {
    const entry = cache.get(title);
    return entry instanceof Promise ? entry : entry;
  }
  const promise = fetchNow(title);
  cache.set(title, promise);
  const result = await promise;
  cache.set(title, result);
  return result;
}

async function fetchNow(title) {
  try {
    const url = API + encodeURIComponent(title.replace(/ /g, "_"));
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      extract: data.extract || "",
      description: data.description || "",
      thumbnailUrl: data.thumbnail ? data.thumbnail.source : null,
    };
  } catch {
    return null;
  }
}

/** Returns a loaded, ready-to-draw Image for a thumbnail URL, or null if
 * it hasn't finished loading yet (or there is none) — never blocks;
 * the canvas render loop just picks it up automatically once ready,
 * since it redraws every frame anyway. */
export function getCachedImage(url) {
  if (!url) return null;
  let img = imageCache.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    imageCache.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}
