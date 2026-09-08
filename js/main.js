import { connectStream } from "./eventStream.js";
import { ArticleStore } from "./articleStore.js";
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
  nodeCount: document.getElementById("node-count"),
  nodeFill: document.getElementById("node-fill"),
  epsValue: document.getElementById("eps-value"),
  epsFill: document.getElementById("eps-fill"),
};

// ---------------------------------------------------------------------
// GAIN — the one scroll-wheel-controlled instrument parameter for v1.
// Governs how strongly each incoming edit affects the field.
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
// Canvas sizing
// ---------------------------------------------------------------------
function resize() {
  renderer.resize();
  store.setBounds({ left: 0, top: 0, right: renderer.width, bottom: renderer.height });
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------
// Hover interaction — highlight only, no modal/inspector in v1.
// ---------------------------------------------------------------------
let pointer = null;
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
});
canvas.addEventListener("mouseleave", () => {
  pointer = null;
  renderer.hoverNode = null;
});
canvas.addEventListener("click", () => {
  if (renderer.hoverNode) window.open(renderer.hoverNode.url, "_blank", "noopener");
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
  canvas.style.cursor = renderer.hoverNode ? "pointer" : "default";

  const count = nodes.length;
  dom.nodeCount.textContent = String(count).padStart(3, "0");
  dom.nodeFill.style.width = `${Math.min(100, (count / 60) * 100)}%`;

  const eps = store.getEditsPerSecond();
  dom.epsValue.textContent = eps.toFixed(1);
  dom.epsFill.style.width = `${Math.min(100, (eps / 15) * 100)}%`;

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
