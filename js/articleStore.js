// Data Processor + Article State Store.
// Owns the live set of active article nodes, the transient pulse rings
// spawned when edits arrive, and the association links formed between
// articles touched by the same editor in close succession. Knows nothing
// about rendering.

import { stepPhysics, displaceNeighbors, applyLinkForces } from "./physics.js";

const MAX_NODES = 60;
const TAU_HEAT = 5.5; // seconds — burst decay (drives pulse glow, mode-independent)
const REMOVE_THRESHOLD = 0.012;
const BASE_RADIUS = 3;
const MAX_RADIUS = 26;
const RING_LIFETIME = 0.9; // seconds

const MAJOR_DELTA = 500; // characters — threshold for a "substantial" edit
const LINK_WINDOW_MS = 90 * 1000; // same editor touching 2 articles within this window = a link
const LINK_LIFETIME = 6; // seconds a link stays visible once formed
const MAX_LINKS = 60;
const MAX_RECENT_PER_USER = 5;
const VOLUME_REFERENCE = 14; // edits-in-range that count as a "full" node in VOLUME mode

export const RANGE_STEPS = [
  { label: "1M", seconds: 60 },
  { label: "5M", seconds: 300 },
  { label: "15M", seconds: 900 },
  { label: "1H", seconds: 3600 },
];

export const MODE_STEPS = ["ACTIVITY", "VOLUME"];
export const FILTER_STEPS = ["ALL", "NEW", "MAJOR", "MINOR"];

export class ArticleStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.nodes = new Map();
    this.rings = [];
    this.links = [];
    this.bounds = { left: 0, top: 0, right: 0, bottom: 0 };
    this._editTimestamps = [];
    this._recentByUser = new Map();
    this._startTime = performance.now();
    this._userPruneAccum = 0;

    this.rangeIndex = 2; // 15M, matches original default
    this.mode = MODE_STEPS[0];
    this.filter = FILTER_STEPS[0];
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }

  setRangeIndex(i) {
    this.rangeIndex = ((i % RANGE_STEPS.length) + RANGE_STEPS.length) % RANGE_STEPS.length;
  }

  setMode(m) {
    this.mode = m;
  }

  setFilter(f) {
    this.filter = f;
  }

  get rangeSeconds() {
    return RANGE_STEPS[this.rangeIndex].seconds;
  }

  getElapsedSeconds() {
    return (performance.now() - this._startTime) / 1000;
  }

  registerEdit(edit, gain) {
    if (!this._passesFilter(edit)) return null;

    const now = performance.now();
    this._editTimestamps.push(now);

    const gainFactor = gain / 50; // 50 == neutral/unity gain
    let node = this.nodes.get(edit.title);

    if (!node) {
      if (this.nodes.size >= MAX_NODES) this._evictWeakest();
      node = this._createNode(edit);
      this.nodes.set(edit.title, node);
    }

    node.edits += 1;
    node.lastActive = now;
    node.lastEditType = edit.type;
    node.url = edit.url;
    node.lastUser = edit.user;
    node.mass = Math.min(1, node.mass + 0.14 * gainFactor);
    node.heat = Math.min(1, node.heat + 0.55 * gainFactor);
    node.history.push(now);

    this.rings.push({
      node,
      age: 0,
      strength: 0.4 + 0.6 * Math.min(1, gainFactor),
    });

    displaceNeighbors(
      [...this.nodes.values()],
      node,
      0.5 + node.heat * gainFactor
    );

    this._linkToRecentByUser(edit.user, node, now);

    return node;
  }

  tick(dt) {
    const now = performance.now();
    const nodes = [...this.nodes.values()];
    const rangeMs = this.rangeSeconds * 1000;
    // decay memory scales with the selected RANGE: a short window makes the
    // field snappy and immediate, a long window makes it linger and settle
    const tauMass = clamp(this.rangeSeconds / 20, 6, 400);

    for (const node of nodes) {
      const idleSeconds = (now - node.lastActive) / 1000;
      node.mass *= Math.exp(-dt / tauMass);
      node.heat *= Math.exp(-dt / TAU_HEAT);

      while (node.history.length && now - node.history[0] > rangeMs) {
        node.history.shift();
      }
      node.rangeCount = node.history.length;

      if (this.mode === "VOLUME") {
        const volumeNorm = Math.min(1, node.rangeCount / VOLUME_REFERENCE);
        node.radius = BASE_RADIUS + (MAX_RADIUS - BASE_RADIUS) * Math.sqrt(volumeNorm);
        node.opacity = clamp(0.16 + volumeNorm * 0.62 + node.heat * 0.28, 0.08, 1);
      } else {
        node.radius = BASE_RADIUS + (MAX_RADIUS - BASE_RADIUS) * Math.sqrt(node.mass);
        node.opacity = clamp(0.08 + node.mass * 0.55 + node.heat * 0.55, 0.06, 1);
      }

      if (
        node.mass < REMOVE_THRESHOLD &&
        node.heat < REMOVE_THRESHOLD &&
        node.rangeCount === 0 &&
        idleSeconds > 8
      ) {
        this.nodes.delete(node.title);
      }
    }

    if (nodes.length) {
      applyLinkForces(this.links, dt);
      stepPhysics(nodes, this.bounds, dt);
    }

    for (const ring of this.rings) ring.age += dt;
    this.rings = this.rings.filter((r) => r.age < RING_LIFETIME);

    for (const link of this.links) link.age += dt;
    this.links = this.links.filter(
      (l) => l.age < LINK_LIFETIME && this.nodes.has(l.a.title) && this.nodes.has(l.b.title)
    );

    const cutoff = now - 1000;
    while (this._editTimestamps.length && this._editTimestamps[0] < cutoff) {
      this._editTimestamps.shift();
    }

    this._userPruneAccum += dt;
    if (this._userPruneAccum > 2) {
      this._userPruneAccum = 0;
      for (const [user, list] of this._recentByUser) {
        const fresh = list.filter((e) => now - e.t < LINK_WINDOW_MS);
        if (fresh.length) this._recentByUser.set(user, fresh);
        else this._recentByUser.delete(user);
      }
    }
  }

  getNodes() {
    return [...this.nodes.values()];
  }

  getRings() {
    return this.rings;
  }

  getLinks() {
    return this.links;
  }

  getEditsPerSecond() {
    return this._editTimestamps.length;
  }

  _passesFilter(edit) {
    switch (this.filter) {
      case "NEW":
        return edit.isNew;
      case "MAJOR":
        return !edit.isNew && Math.abs(edit.lengthDelta) >= MAJOR_DELTA;
      case "MINOR":
        return !edit.isNew && edit.minor === true;
      default:
        return true; // ALL
    }
  }

  // Same editor touching two different articles within LINK_WINDOW_MS is a
  // real, verifiable connection in the data — not an inferred similarity.
  // It surfaces coordinated behavior: a template rollout, a topic sweep,
  // one person following a thread across pages.
  _linkToRecentByUser(user, node, now) {
    if (!user) return;
    const list = this._recentByUser.get(user) || [];
    const fresh = list.filter((e) => now - e.t < LINK_WINDOW_MS);

    for (const prev of fresh) {
      if (prev.node !== node && this.nodes.has(prev.node.title)) {
        this._addLink(prev.node, node);
      }
    }

    fresh.push({ node, t: now });
    while (fresh.length > MAX_RECENT_PER_USER) fresh.shift();
    this._recentByUser.set(user, fresh);
  }

  _addLink(a, b) {
    const exists = this.links.some(
      (l) => (l.a === a && l.b === b) || (l.a === b && l.b === a)
    );
    if (exists) return;
    if (this.links.length >= MAX_LINKS) this.links.shift();
    this.links.push({ a, b, age: 0, life: LINK_LIFETIME });
  }

  _createNode(edit) {
    const b = this.bounds;
    const marginX = (b.right - b.left) * 0.12;
    const marginY = (b.bottom - b.top) * 0.12;
    const homeX = rand(b.left + marginX, b.right - marginX);
    const homeY = rand(b.top + marginY, b.bottom - marginY);
    return {
      title: edit.title,
      x: homeX,
      y: homeY,
      vx: rand(-6, 6),
      vy: rand(-6, 6),
      homeX,
      homeY,
      mass: 0,
      heat: 0,
      radius: BASE_RADIUS,
      opacity: 0.1,
      edits: 0,
      history: [],
      rangeCount: 0,
      lastActive: performance.now(),
      lastEditType: edit.type,
      lastUser: edit.user,
      url: edit.url,
    };
  }

  _evictWeakest() {
    let weakest = null;
    for (const node of this.nodes.values()) {
      const score = node.mass + node.heat + node.rangeCount * 0.05;
      if (!weakest || score < weakest.score) weakest = { node, score };
    }
    if (weakest) this.nodes.delete(weakest.node.title);
  }
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
