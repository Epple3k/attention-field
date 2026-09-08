import { connectStream } from "./eventStream.js";
import { ArticleStore, RANGE_STEPS, MODE_STEPS, FILTER_STEPS } from "./articleStore.js";
import { Renderer } from "./renderer.js";

const canvas = document.getElementById("field");
const fieldWrap = document.querySelector(".field-wrap");
const renderer = new Renderer(canvas);
const store = new ArticleStore();

const dom = {
  clock: document.getElementById("clock-readout"),
  date: document.getElementById("date-readout"),
  liveDot: document.getElementById("live-dot"),
  liveLabel: document.getElementById("live-label"),
  gainValue: document.getElementById("gain-value"),
  gainFill: document.getElementById("gain-fill"),
  rangeCtrl: document.getElementById("range-ctrl"),
  rangeValue: document.getElementById("range-value"),
  rangeFill: document.getElementById("range-fill"),
  modeCtrl: document.getElementById("mode-ctrl"),
  modeValue: document.getElementById("mode-value"),
  modeFill: document.getElementById("mode-fill"),
  filterCtrl: document.getElementById("filter-ctrl"),
  filterValue: document.getElementById("filter-value"),
  filterFill: document.getElementById("filter-fill"),
  nodeCount: document.getElementById("node-count"),
  nodeFill: document.getElementById("node-fill"),
  clustersCount: document.getElementById("clusters-count"),
  clustersFill: document.getElementById("clusters-fill"),
  linksCount: document.getElementById("links-count"),
  linksFill: document.getElementById("links-fill"),
  epsValue: document.getElementById("eps-value"),
  epsFill: document.getElementById("eps-fill"),
  elapsedValue: document.getElementById("elapsed-value"),
  focusValue: document.getElementById("focus-value"),
};

function flash(el) {
  el.classList.remove("is-changed");
  void el.offsetWidth; // force reflow so the animation restarts on repeat triggers
  el.classList.add("is-changed");
}

// ---------------------------------------------------------------------
// GAIN — continuous, scroll-over-the-field. Governs how strongly each
// incoming edit affects the field.
// ---------------------------------------------------------------------
let gain = 50; // 0–100, 50 = unity

function setGain(next) {
  gain = Math.max(0, Math.min(100, next));
  dom.gainValue.textContent = String(Math.round(gain)).padStart(3, "0");
  dom.gainFill.style.width = `${gain}%`;
}
setGain(gain);

fieldWrap.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -2 : 2;
    setGain(gain + delta);
  },
  { passive: false }
);

// ---------------------------------------------------------------------
// RANGE / MODE / FILTER — discrete instrument controls. Each responds to
// both a click (step forward, like a selector button) and a scroll while
// hovered (step forward/back), so the interaction language stays
// consistent with GAIN without competing for the same gesture.
// ---------------------------------------------------------------------
function setRange(index) {
  store.setRangeIndex(index);
  const step = RANGE_STEPS[store.rangeIndex];
  dom.rangeValue.textContent = step.label;
  dom.rangeFill.style.width = `${((store.rangeIndex + 1) / RANGE_STEPS.length) * 100}%`;
  flash(dom.rangeValue);
}
setRange(store.rangeIndex);

function cycleMode(dir) {
  const i = MODE_STEPS.indexOf(store.mode);
  const next = MODE_STEPS[(i + dir + MODE_STEPS.length) % MODE_STEPS.length];
  store.setMode(next);
  dom.modeValue.textContent = next;
  dom.modeFill.style.width = `${((MODE_STEPS.indexOf(next) + 1) / MODE_STEPS.length) * 100}%`;
  flash(dom.modeValue);
}

function cycleFilter(dir) {
  const i = FILTER_STEPS.indexOf(store.filter);
  const next = FILTER_STEPS[(i + dir + FILTER_STEPS.length) % FILTER_STEPS.length];
  store.setFilter(next);
  dom.filterValue.textContent = next;
  dom.filterFill.style.width = `${((FILTER_STEPS.indexOf(next) + 1) / FILTER_STEPS.length) * 100}%`;
  flash(dom.filterValue);
}

dom.rangeCtrl.addEventListener("click", () => setRange(store.rangeIndex + 1));
dom.rangeCtrl.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    e.stopPropagation();
    setRange(store.rangeIndex + (e.deltaY > 0 ? -1 : 1));
  },
  { passive: false }
);
dom.rangeCtrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") setRange(store.rangeIndex + 1);
});

dom.modeCtrl.addEventListener("click", () => cycleMode(1));
dom.modeCtrl.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    e.stopPropagation();
    cycleMode(e.deltaY > 0 ? -1 : 1);
  },
  { passive: false }
);
dom.modeCtrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") cycleMode(1);
});

dom.filterCtrl.addEventListener("click", () => cycleFilter(1));
dom.filterCtrl.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    e.stopPropagation();
    cycleFilter(e.deltaY > 0 ? -1 : 1);
  },
  { passive: false }
);
dom.filterCtrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") cycleFilter(1);
});

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
// Hover / click — individual nodes open their Wikipedia article; a
// collapsible cluster's merged shape (or its halo, once expanded) toggles
// between "one shape" and "its individual nodes." Node hover always wins
// over cluster hover so members stay reachable inside an expanded cluster.
// ---------------------------------------------------------------------
let pointer = null;
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
});
canvas.addEventListener("mouseleave", () => {
  pointer = null;
  renderer.hoverNode = null;
  renderer.hoverCluster = null;
});
canvas.addEventListener("click", () => {
  if (renderer.hoverNode) {
    window.open(renderer.hoverNode.url, "_blank", "noopener");
  } else if (renderer.hoverCluster) {
    store.toggleClusterExpanded(renderer.hoverCluster.label);
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
    store.registerEdit(edit, gain);
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

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  store.tick(dt);
  const nodes = renderer.draw(store);

  renderer.hoverNode = pointer ? renderer.hitTest(pointer.x, pointer.y, nodes) : null;
  renderer.hoverCluster =
    pointer && !renderer.hoverNode
      ? renderer.hitTestCluster(pointer.x, pointer.y, store.getClusters())
      : null;
  canvas.style.cursor = renderer.hoverNode || renderer.hoverCluster ? "pointer" : "default";

  // the readout counts every article the system is actually tracking,
  // including ones currently merged into a collapsed cluster shape
  const count = store.getNodes().length;
  dom.nodeCount.textContent = String(count).padStart(3, "0");
  dom.nodeFill.style.width = `${Math.min(100, (count / 60) * 100)}%`;

  const linkCount = store.getLinks().length;
  dom.linksCount.textContent = String(linkCount).padStart(3, "0");
  dom.linksFill.style.width = `${Math.min(100, (linkCount / 30) * 100)}%`;

  const namedClusters = store.getClusters().filter((c) => c.members.length >= 3);
  dom.clustersCount.textContent = String(namedClusters.length).padStart(3, "0");
  dom.clustersFill.style.width = `${Math.min(100, (namedClusters.length / 8) * 100)}%`;

  if (namedClusters.length) {
    namedClusters.sort((a, b) => b.members.length - a.members.length);
    dom.focusValue.textContent = namedClusters[0].label.toUpperCase();
    dom.focusValue.classList.remove("is-scanning");
  } else {
    dom.focusValue.textContent = "SCANNING";
    dom.focusValue.classList.add("is-scanning");
  }

  const eps = store.getEditsPerSecond();
  dom.epsValue.textContent = eps.toFixed(1);
  dom.epsFill.style.width = `${Math.min(100, (eps / 15) * 100)}%`;

  const elapsed = Math.floor(store.getElapsedSeconds());
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  dom.elapsedValue.textContent = `${mm}:${ss}`;

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
