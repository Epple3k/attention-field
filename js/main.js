import { connectStream } from "./eventStream.js";
import { ArticleStore } from "./articleStore.js";
import { Renderer } from "./renderer.js";
import { tieKey } from "./geometry.js";
import { GROUPS } from "./groups.js";
import { generateClusterInsight } from "./insights.js";
import { fetchPagePreview } from "./previewService.js";
import { refreshCurrentEvents, findEventForTitles } from "./currentEventsService.js";

const canvas = document.getElementById("field");
const renderer = new Renderer(canvas);
const store = new ArticleStore();

// GAIN/RANGE/MODE/FILTER no longer have a UI (the control ribbon was
// removed) — the store just runs on its built-in defaults (RANGE 15M,
// MODE ACTIVITY, FILTER ALL) and every edit affects the field at unity
// gain, same as the old GAIN=50 default did.
const GAIN = 50;

// ---------------------------------------------------------------------
// Intro overlay — shown automatically on a visitor's first load (per
// browser, via localStorage), reachable afterward any time via the
// header's ABOUT button. Live data starts flowing immediately underneath
// it regardless of whether it's showing, so nothing is lost by reading it.
// ---------------------------------------------------------------------
const SEEN_INTRO_KEY = "attentionField.seenIntro";
const introEl = document.getElementById("intro");
const introEnterBtn = document.getElementById("intro-enter");
const aboutBtn = document.getElementById("about-btn");

function hasSeenIntro() {
  try {
    return localStorage.getItem(SEEN_INTRO_KEY) === "1";
  } catch {
    return false; // private/blocked storage — just show it every visit
  }
}

function markIntroSeen() {
  try {
    localStorage.setItem(SEEN_INTRO_KEY, "1");
  } catch {
    // ignore — nothing to persist, intro just reappears next visit
  }
}

function showIntro() {
  introEl.classList.remove("is-hidden");
}

function hideIntro() {
  introEl.classList.add("is-hidden");
  markIntroSeen();
}

if (hasSeenIntro()) hideIntro();
introEnterBtn.addEventListener("click", hideIntro);
aboutBtn.addEventListener("click", showIntro);

// group color key — built once from the same GROUPS the renderer colors
// nodes from, so the legend can never drift out of sync with the field
const legendEl = document.getElementById("group-legend");
for (const key of Object.keys(GROUPS)) {
  if (key === "OTHER") continue; // neutral fallback earns no legend slot
  const { label, color } = GROUPS[key];
  const item = document.createElement("span");
  item.className = "field__legend-item";
  item.innerHTML = `<span class="field__legend-dot" style="background: rgb(${color})"></span>${label.toUpperCase()}`;
  legendEl.appendChild(item);
}

const dom = {
  clock: document.getElementById("clock-readout"),
  date: document.getElementById("date-readout"),
  liveDot: document.getElementById("live-dot"),
  liveLabel: document.getElementById("live-label"),
  focusValue: document.getElementById("focus-value"),
};

// ---------------------------------------------------------------------
// Toast — a brief, self-dismissing message. Used for exactly one thing
// right now: telling someone why scrolling to Index didn't do anything.
// ---------------------------------------------------------------------
const toastEl = document.getElementById("toast");
let toastTimeout = null;

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.remove("is-visible"), 2200);
}

// ---------------------------------------------------------------------
// Views — FIELD (the network) and INDEX (the same live data as a text
// hierarchy). There's no control ribbon or tab bar anymore — the scroll
// wheel does the switching, with a small pair of position dots (bottom
// center) as the only persistent, always-clickable fallback.
//
// Over FIELD, any deliberate scroll moves to INDEX (nothing else on that
// view consumes scroll). Inside INDEX, scrolling behaves like a normal
// list — it only falls through to a view-switch when you're already
// scrolled to the very top and scroll up again, the same "overscroll"
// pattern many two-section sites use, so reading a long list is never
// interrupted by an accidental flip back to FIELD.
//
// INDEX is locked until there's enough live data for its "top events"
// summary to say something real — see indexReady, set from the frame
// loop — so nobody scrolls into an empty, uninteresting page.
// ---------------------------------------------------------------------
const viewsEl = document.getElementById("views");
const viewEls = { field: document.getElementById("view-field"), index: document.getElementById("view-index") };
const dotEls = { field: document.getElementById("dot-field"), index: document.getElementById("dot-index") };
let currentView = "field";
let indexReady = false; // one-way latch — see computeIndexReady() in the frame loop

function setView(view) {
  if (view === currentView) return;
  currentView = view;
  for (const key of Object.keys(viewEls)) {
    viewEls[key].classList.toggle("is-active", key === view);
    dotEls[key].classList.toggle("is-active", key === view);
  }
  if (view === "index") renderIndex(); // jump straight to fresh content, not last frame's
}

function attemptSwitchToIndex() {
  if (!indexReady) {
    showToast("GATHERING DATA — NOT ENOUGH SIGNAL YET");
    return;
  }
  setView("index");
}

dotEls.field.addEventListener("click", () => setView("field"));
dotEls.index.addEventListener("click", attemptSwitchToIndex);

let viewSwitchAccum = 0; // debounce: one switch per gesture, not one per wheel event
viewsEl.addEventListener(
  "wheel",
  (e) => {
    const now = performance.now();
    if (now - viewSwitchAccum < 450) return;

    if (currentView === "field") {
      const magnitude = Math.max(Math.abs(e.deltaX), Math.abs(e.deltaY));
      if (magnitude < 4) return;
      if (e.deltaX > 0 || e.deltaY > 0) {
        viewSwitchAccum = now;
        attemptSwitchToIndex();
      }
      // scrolling "up/back" while already on FIELD has nowhere to go
      return;
    }

    // on INDEX: a horizontal swipe is always a fast path back to FIELD;
    // a vertical scroll only falls through once already at the top of
    // the list, so normal list-scrolling is never interrupted
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 4) {
      viewSwitchAccum = now;
      setView("field");
      return;
    }
    if (e.deltaY < 0 && indexWrapEl.scrollTop <= 0) {
      viewSwitchAccum = now;
      setView("field");
    }
  },
  { passive: true }
);

// ---------------------------------------------------------------------
// Index view — the same live nodes/clusters as a text hierarchy: a "top
// events" digest first (the most significant active clusters, each with
// its Pattern Engine explanation), then the full group -> topic cluster
// -> articles breakdown. Rebuilt periodically (not every frame — this is
// DOM, not canvas) from main.js's frame loop, and only while visible.
// ---------------------------------------------------------------------
const indexTopEl = document.getElementById("index-top");
const indexListEl = document.getElementById("index-list");
const indexWrapEl = document.getElementById("index-wrap");
const GROUP_ORDER = ["SCI_TECH", "GEO_NATURE", "ARTS_CULTURE", "PUBLIC_LIFE", "OTHER"];

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// A cluster's explanation prefers a real outside source over a heuristic
// guess: if any of its members is currently named in Wikipedia's own "In
// the news" feed (see currentEventsService.js — an actual online lookup,
// refreshed periodically below), that genuine story is used verbatim
// instead of the Pattern Engine's edit-summary-based reading. Falls back to
// the heuristic whenever no live news match exists, which is most of the
// time — this is a real citation when one's available, not a replacement
// for the heuristic layer.
function getClusterInsight(cluster) {
  const newsMatch = findEventForTitles(cluster.members.map((m) => m.title));
  if (newsMatch) {
    return { text: newsMatch, confidence: "CONFIRMED — LIVE NEWS MATCH", byline: "WIKIPEDIA — IN THE NEWS" };
  }
  return generateClusterInsight(cluster);
}

// Ranks currently-active named clusters and returns the ones confident
// enough to explain — used both to render the top-of-page digest and to
// decide whether INDEX is even worth showing yet (see computeIndexReady).
// A confirmed live-news match is always ranked ahead of a heuristic-only
// read, regardless of member count — an actual sourced explanation is more
// worth surfacing than a bigger cluster with only a guess behind it.
function topConfidentClusters(limit) {
  const named = store.getClusters().filter((c) => c.members.length >= 3);
  return named
    .map((cluster) => ({ cluster, insight: getClusterInsight(cluster) }))
    .filter(({ insight }) => insight.confidence !== "PATTERN: INSUFFICIENT SIGNAL")
    .sort((a, b) => {
      const confirmedA = a.insight.confidence.startsWith("CONFIRMED") ? 1 : 0;
      const confirmedB = b.insight.confidence.startsWith("CONFIRMED") ? 1 : 0;
      if (confirmedA !== confirmedB) return confirmedB - confirmedA;
      return b.cluster.members.length - a.cluster.members.length;
    })
    .slice(0, limit);
}

function renderIndexTop() {
  const ranked = topConfidentClusters(3);
  if (!ranked.length) {
    indexTopEl.innerHTML = "";
    return;
  }
  let html = `<div class="index-top">
    <div class="index-top__label">TOP EVENTS RIGHT NOW — AND WHY THEY'RE ACTIVE</div>`;
  for (const { cluster, insight } of ranked) {
    html += `<div class="index-top__item">
      <div class="index-top__header">
        <span class="index-top__name">${escapeHtml(cluster.label.toUpperCase())}</span>
        <span class="index-top__count">${cluster.members.length} ARTICLES</span>
      </div>
      <div class="index-top__text">${escapeHtml(insight.text)}<span class="index-top__byline">— ${insight.byline} · ${insight.confidence}</span></div>
    </div>`;
  }
  html += `</div>`;
  indexTopEl.innerHTML = html;
}

function renderIndex() {
  renderIndexTop();

  const nodes = store.getNodes();
  if (!nodes.length) {
    indexListEl.innerHTML = `<div class="index-empty">WAITING FOR LIVE ACTIVITY —</div>`;
    return;
  }

  const clusters = store.getClusters().filter((c) => c.members.length >= 3);
  const clusterOfNode = new Map();
  for (const c of clusters) for (const m of c.members) clusterOfNode.set(m, c);

  const buckets = new Map(GROUP_ORDER.map((k) => [k, { loose: [], clusterMap: new Map() }]));
  for (const node of nodes) {
    const bucket = buckets.get(node.group) || buckets.get("OTHER");
    const cluster = clusterOfNode.get(node);
    if (cluster) {
      if (!bucket.clusterMap.has(cluster)) bucket.clusterMap.set(cluster, []);
      bucket.clusterMap.get(cluster).push(node);
    } else {
      bucket.loose.push(node);
    }
  }

  const scrollTop = indexWrapEl.scrollTop;
  let html = "";

  for (const key of GROUP_ORDER) {
    const bucket = buckets.get(key);
    const total = bucket.loose.length + [...bucket.clusterMap.values()].reduce((s, arr) => s + arr.length, 0);
    if (!total) continue;
    const group = GROUPS[key];

    html += `<div class="index-group">
      <div class="index-group__header">
        <span class="index-group__dot" style="background: rgb(${group.color})"></span>
        <span class="index-group__name">${group.label.toUpperCase()}</span>
        <span class="index-group__count">${total}</span>
      </div>`;

    const clusterEntries = [...bucket.clusterMap.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [cluster, members] of clusterEntries) {
      const insight = getClusterInsight({ ...cluster, members });
      html += `<div class="index-cluster">
        <div class="index-cluster__header">
          <span class="index-cluster__name">${escapeHtml(cluster.label.toUpperCase())}</span>
          <span class="index-cluster__count">${members.length} ARTICLES</span>
        </div>
        <div class="index-insight">${escapeHtml(insight.text)}<span class="index-insight__byline">— ${insight.byline} · ${insight.confidence}</span></div>
        <ul class="index-articles">${articleRows(members)}</ul>
      </div>`;
    }

    if (bucket.loose.length) {
      html += `<div class="index-cluster">
        <div class="index-cluster__header">
          <span class="index-cluster__name">UNGROUPED</span>
          <span class="index-cluster__count">${bucket.loose.length} ARTICLES</span>
        </div>
        <ul class="index-articles">${articleRows(bucket.loose)}</ul>
      </div>`;
    }

    html += `</div>`;
  }

  indexListEl.innerHTML = html || `<div class="index-empty">NOTHING CATEGORIZED YET —</div>`;
  indexWrapEl.scrollTop = scrollTop;
}

function articleRows(members) {
  // trending (heavily-read) members sort by rank ahead of edit-count —
  // #1 most-viewed outranks a handful of edits, the way it should read
  const score = (m) => (m.isTrending ? 100000 - m.trendingRank : m.edits);
  return members
    .slice()
    .sort((a, b) => score(b) - score(a))
    .map((m) => {
      const meta = m.isTrending
        ? `#${m.trendingRank} MOST-VIEWED`
        : `${m.edits} ${m.edits === 1 ? "EDIT" : "EDITS"}`;
      return `<li class="index-article" data-url="${escapeHtml(m.url)}">
          <span class="index-article__title">${escapeHtml(m.title)}</span>
          <span class="index-article__meta">${meta}</span>
        </li>`;
    })
    .join("");
}

indexListEl.addEventListener("click", (e) => {
  const row = e.target.closest(".index-article");
  if (row && row.dataset.url) window.open(row.dataset.url, "_blank", "noopener");
});

let indexRebuildAccum = 0;

// ---------------------------------------------------------------------
// Canvas sizing
// ---------------------------------------------------------------------
function resize() {
  renderer.resize();
  store.setBounds({ left: 0, top: 0, right: renderer.width, bottom: renderer.height });
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------
// Hover / click / drag.
// - Hovering an individual node highlights it and shows its context
//   summary; clicking (without dragging) opens the article. Node hover
//   always wins over tie/cluster hover so members stay reachable inside
//   an expanded cluster.
// - Dragging a node moves it directly; releasing throws it back into the
//   simulation with real velocity from the drag motion, and briefly
//   loosens damping so the graph visibly resettles.
// - Hovering an association tie emphasizes it and both endpoints, dims
//   everything else, and shows why the two articles are connected.
//   Clicking a tie pins that state open; clicking empty space (or the
//   same tie again) releases it.
// - Clicking a collapsed cluster's merged shape opens it — members burst
//   outward to their own positions.
// - An expanded cluster closes by clicking *outside* its boundary
//   (anywhere in the field that isn't among its own members) — clicking
//   inside that boundary, or on one of its nodes, leaves it open.
// ---------------------------------------------------------------------
let pointer = null;
let lastVisibleNodes = [];
let pinnedTie = null; // { key, kind } — see geometry.tieKey

let dragCandidate = null;
let dragging = false;
let dragStart = null;
let dragHistory = [];
let suppressNextClick = false;

// ---------------------------------------------------------------------
// Wikipedia page preview — a short dwell after a node becomes hovered
// (not instantly, so sweeping the cursor across many nodes doesn't fire
// a request per node), fetch its real Wikipedia summary/thumbnail and
// attach it to the node itself once resolved. The renderer just reads
// node.preview if it's there; nothing here blocks the rest of the hover
// panel from showing immediately.
// ---------------------------------------------------------------------
const PREVIEW_DWELL_MS = 220;
let previewTimer = null;
let previewTimerNode = null;

function schedulePreviewFetch(node) {
  if (node === previewTimerNode) return; // already scheduled/fetched for this exact node
  clearTimeout(previewTimer);
  previewTimerNode = node;
  if (!node || node.preview !== undefined) return; // nothing hovered, or already have a result (even a cached failure)
  previewTimer = setTimeout(() => {
    fetchPagePreview(node.title).then((result) => {
      node.preview = result; // null on failure — still marks "attempted," no retry storm on repeat hovers
    });
  }, PREVIEW_DWELL_MS);
}

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };

  if (dragCandidate) {
    if (!dragging && Math.hypot(pointer.x - dragStart.x, pointer.y - dragStart.y) > 4) {
      dragging = true;
      store.beginDrag(dragCandidate);
      renderer.dragNode = dragCandidate;
    }
    if (dragging) {
      store.dragTo(dragCandidate, pointer.x, pointer.y);
      dragHistory.push({ x: pointer.x, y: pointer.y, t: performance.now() });
      if (dragHistory.length > 5) dragHistory.shift();
    }
  }
});

canvas.addEventListener("mousedown", () => {
  if (!pointer) return;
  const hit = renderer.hitTest(pointer.x, pointer.y, lastVisibleNodes);
  if (!hit) return;
  dragCandidate = hit;
  dragStart = { x: pointer.x, y: pointer.y };
  dragging = false;
  dragHistory = [{ x: pointer.x, y: pointer.y, t: performance.now() }];
});

window.addEventListener("mouseup", () => {
  if (!dragCandidate) return;
  if (dragging) {
    let vx = 0;
    let vy = 0;
    if (dragHistory.length >= 2) {
      const first = dragHistory[0];
      const last = dragHistory[dragHistory.length - 1];
      const dt = Math.max(0.02, (last.t - first.t) / 1000);
      vx = (last.x - first.x) / dt;
      vy = (last.y - first.y) / dt;
    }
    store.endDrag(dragCandidate, vx, vy);
    renderer.dragNode = null;
    suppressNextClick = true;
  }
  dragCandidate = null;
  dragging = false;
  dragHistory = [];
});

canvas.addEventListener("mouseleave", () => {
  pointer = null;
  renderer.hoverNode = null;
  renderer.hoverCluster = null;
  renderer.hoverTie = null;
});

canvas.addEventListener("click", () => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  if (!pointer) return;

  if (renderer.hoverNode) {
    window.open(renderer.hoverNode.url, "_blank", "noopener");
    return;
  }

  if (renderer.hoverTie) {
    const key = tieKey(renderer.hoverTie.tie);
    if (pinnedTie && pinnedTie.key === key) {
      pinnedTie = null;
    } else {
      pinnedTie = { key, kind: renderer.hoverTie.kind };
      store.activateTie(renderer.hoverTie.tie);
    }
    return;
  }

  if (renderer.hoverCluster && renderer.hoverCluster.collapsed) {
    store.expandCluster(renderer.hoverCluster.label);
    return;
  }

  // empty-space click: release any pinned tie and collapse any clusters
  // the click landed outside of
  pinnedTie = null;
  const clusters = store.getClusters();
  if (!renderer.isInsideExpandedCluster(pointer.x, pointer.y, clusters)) {
    for (const c of clusters) {
      if (c.expanded) store.collapseCluster(c.label);
    }
  }
});

// ---------------------------------------------------------------------
// Live stream connection
// ---------------------------------------------------------------------
connectStream({
  onOpen: () => {
    dom.liveDot.classList.add("is-live");
    dom.liveLabel.textContent = "LIVE";
  },
  onError: () => {
    dom.liveDot.classList.remove("is-live");
    dom.liveLabel.textContent = "RECONNECTING";
  },
  onEdit: (edit) => {
    store.registerEdit(edit, GAIN);
  },
});

// ---------------------------------------------------------------------
// Header clock
// ---------------------------------------------------------------------
function updateClock() {
  const now = new Date();
  dom.clock.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
  dom.date.textContent = now
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase()
    .replace(/,/g, "");
}
updateClock();
setInterval(updateClock, 1000);

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------
let lastTime = performance.now();
let indexReadyCheckAccum = 0;

// Fetches once immediately, then re-checks periodically (refreshCurrentEvents
// itself no-ops if the cache is still fresh) — a live network lookup, not
// something to await from the render path.
refreshCurrentEvents();
let currentEventsCheckAccum = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  store.tick(dt);
  const nodes = renderer.draw(store);
  lastVisibleNodes = nodes;

  renderer.hoverNode = pointer && !dragging ? renderer.hitTest(pointer.x, pointer.y, nodes) : null;
  // read next tick — hovering stabilizes this node (and its direct ties)
  // by raising its effective mass, never by pushing on anything else
  store.setHoveredNode(renderer.hoverNode);
  schedulePreviewFetch(renderer.hoverNode);

  let tieHover = null;
  if (pointer && !renderer.hoverNode && !dragging) {
    tieHover = renderer.hitTestTie(
      pointer.x,
      pointer.y,
      store.getTopicLinks(),
      store.getLinks(),
      renderer.hiddenNodes
    );
  }
  // a pinned tie is re-resolved by key every frame, since topic ties are
  // rebuilt into new objects on each topology recompute
  if (!tieHover && pinnedTie) {
    const list = pinnedTie.kind === "topic" ? store.getTopicLinks() : store.getLinks();
    const resolved = list.find((t) => tieKey(t) === pinnedTie.key);
    if (resolved) tieHover = { tie: resolved, kind: pinnedTie.kind };
    else pinnedTie = null;
  }
  renderer.hoverTie = tieHover;

  renderer.hoverCluster =
    pointer && !renderer.hoverNode && !tieHover && !dragging
      ? renderer.hitTestCluster(pointer.x, pointer.y, store.getClusters())
      : null;

  canvas.style.cursor = dragging
    ? "grabbing"
    : renderer.hoverNode || renderer.hoverTie || renderer.hoverCluster
      ? "pointer"
      : "default";

  const namedClusters = store.getClusters().filter((c) => c.members.length >= 3);
  if (namedClusters.length) {
    namedClusters.sort((a, b) => b.members.length - a.members.length);
    dom.focusValue.textContent = namedClusters[0].label.toUpperCase();
    dom.focusValue.classList.remove("is-scanning");
  } else {
    dom.focusValue.textContent = "SCANNING";
    dom.focusValue.classList.add("is-scanning");
  }

  // INDEX unlocks once at least one active cluster has a confident
  // (not "insufficient signal") Pattern Engine read — a one-way latch,
  // checked on a slow interval rather than every frame since it recomputes
  // insight text. Once unlocked it stays unlocked even if data thins out.
  if (!indexReady) {
    indexReadyCheckAccum += dt;
    if (indexReadyCheckAccum > 1) {
      indexReadyCheckAccum = 0;
      if (topConfidentClusters(1).length > 0) {
        indexReady = true;
        dotEls.index.classList.remove("is-locked");
      }
    }
  }

  currentEventsCheckAccum += dt;
  if (currentEventsCheckAccum > 60) {
    currentEventsCheckAccum = 0;
    refreshCurrentEvents(); // no-ops internally unless the cache is actually stale
  }

  // Index is DOM, not canvas — rebuild it on a slow interval, and only
  // while it's actually the visible view
  indexRebuildAccum += dt;
  if (currentView === "index" && indexRebuildAccum > 1.5) {
    indexRebuildAccum = 0;
    renderIndex();
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
