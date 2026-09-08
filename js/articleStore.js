// Data Processor + Article State Store.
// Owns the live set of active article nodes and the transient pulse rings
// spawned when edits arrive. Knows nothing about rendering.

import { stepPhysics, displaceNeighbors } from "./physics.js";

const MAX_NODES = 60;
const TAU_MASS = 42; // seconds — accumulated activity decay (drives size)
const TAU_HEAT = 5.5; // seconds — burst decay (drives pulse/opacity)
const REMOVE_THRESHOLD = 0.012;
const BASE_RADIUS = 3;
const MAX_RADIUS = 26;
const RING_LIFETIME = 0.9; // seconds

export class ArticleStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.nodes = new Map();
    this.rings = [];
    this.bounds = { left: 0, top: 0, right: 0, bottom: 0 };
    this._editTimestamps = [];
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }

  registerEdit(edit, gain) {
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
    node.mass = Math.min(1, node.mass + 0.14 * gainFactor);
    node.heat = Math.min(1, node.heat + 0.55 * gainFactor);

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

    return node;
  }

  tick(dt) {
    const now = performance.now();
    const nodes = [...this.nodes.values()];

    for (const node of nodes) {
      const idleSeconds = (now - node.lastActive) / 1000;
      node.mass *= Math.exp(-dt / TAU_MASS);
      node.heat *= Math.exp(-dt / TAU_HEAT);
      node.radius =
        BASE_RADIUS + (MAX_RADIUS - BASE_RADIUS) * Math.sqrt(node.mass);
      node.opacity = clamp(0.08 + node.mass * 0.55 + node.heat * 0.55, 0.06, 1);

      if (
        node.mass < REMOVE_THRESHOLD &&
        node.heat < REMOVE_THRESHOLD &&
        idleSeconds > 8
      ) {
        this.nodes.delete(node.title);
      }
    }

    if (nodes.length) stepPhysics(nodes, this.bounds, dt);

    for (const ring of this.rings) ring.age += dt;
    this.rings = this.rings.filter((r) => r.age < RING_LIFETIME);

    const cutoff = now - 1000;
    while (
      this._editTimestamps.length &&
      this._editTimestamps[0] < cutoff
    ) {
      this._editTimestamps.shift();
    }
  }

  getNodes() {
    return [...this.nodes.values()];
  }

  getRings() {
    return this.rings;
  }

  getEditsPerSecond() {
    return this._editTimestamps.length;
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
      lastActive: performance.now(),
      lastEditType: edit.type,
      url: edit.url,
    };
  }

  _evictWeakest() {
    let weakest = null;
    for (const node of this.nodes.values()) {
      const score = node.mass + node.heat;
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
