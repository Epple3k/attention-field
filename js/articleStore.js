// Data Processor + Article State Store.
// Owns the live set of article nodes, the transient pulse rings and event
// ties spawned by edits, the persistent topic clusters computed from real
// Wikipedia category data, and the cluster "bodies" that anchor them in the
// physics simulation. Knows nothing about rendering.

import {
  PHYSICS,
  applyAssociationSprings,
  applySummaryGravity,
  applyClusterBodyCohesion,
  applyRepulsion,
  applyCollision,
  applyCentering,
  integrate,
  applyImpulse,
  displaceNeighbors,
} from "./physics.js";
import { clusterShapeRadius, mapAssociationStrength, clamp01 } from "./geometry.js";
import { fetchCategoriesBatch } from "./categoryService.js";
import { classifyGroup, GROUPS } from "./groups.js";
import { fetchTopTrending } from "./trendingService.js";

const MAX_NODES = 60;
const TAU_HEAT = 5.5; // seconds — burst decay (drives pulse glow, mode-independent)
const REMOVE_THRESHOLD = 0.012;
const BASE_RADIUS = 3;
const MAX_RADIUS = 26;
const RING_LIFETIME = 0.9; // seconds

const MAJOR_DELTA = 500; // characters — threshold for a "substantial" edit
const LINK_WINDOW_MS = 90 * 1000; // same editor touching 2 articles within this window = an event tie
const LINK_LIFETIME = 6; // seconds an event tie stays visible once formed
const MAX_LINKS = 60;
const MAX_RECENT_PER_USER = 5;
const VOLUME_REFERENCE = 14; // edits-in-range that count as a "full" node in VOLUME mode

const CATEGORY_FETCH_INTERVAL = 1.5; // seconds between batched category lookups
const CLUSTER_RECOMPUTE_INTERVAL = 1.2; // seconds between topology recomputes
const FIELD_ENERGY_TAU = 3.5; // seconds — smoothing for the ambient energy readout
export const COLLAPSE_THRESHOLD = 4; // members at which a cluster merges into one shape

// Not every spark of attention turns into something sustained — most real
// activity has a lot of one-off glances that never get a second look. A
// fraction of brand-new nodes get a short, random early-exit timer instead
// of waiting out the normal mass/heat decay curve, so the field's
// population doesn't feel like it's on one uniform clock. A second edit
// before the timer fires cancels it — real, repeated activity always
// overrides the random flicker.
const EARLY_EXIT_CHANCE = 0.3;
const EARLY_EXIT_MIN_MS = 1500;
const EARLY_EXIT_MAX_MS = 5000;

// Heavily-read pages join the field too, alongside heavily-edited ones —
// Wikipedia's own daily top-pageviews list (see trendingService.js), not a
// separate track: they flow through the same category lookup and topic
// clustering as edit-driven nodes, just rendered as a triangle instead of a
// circle (see renderer.js) and exempt from the normal idle/flicker decay
// while they're still actually on that list.
const TRENDING_TOP_N = 10;
const TRENDING_FETCH_INTERVAL = 300; // seconds between refreshing the top-pageviews list
const TRENDING_MIN_MASS = 0.35; // floor so even the #10 slot still reads as a real presence

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
    this.links = []; // transient same-editor event ties
    this.topicLinks = []; // persistent shared-category structural ties
    this.clusters = []; // connected components over topicLinks, size >= 2
    /** @type {Map<string, object>} cluster label -> physics body {x,y,vx,vy,radius,bodyMass} */
    this.clusterBodies = new Map();
    this.bounds = { left: 0, top: 0, right: 0, bottom: 0 };
    this._editTimestamps = [];
    this._recentByUser = new Map();
    this._startTime = performance.now();
    this._userPruneAccum = 0;
    this._categoryQueue = new Set();
    this._categoryFetchAccum = 0;
    this._pendingFetch = false;
    this._clusterRecomputeAccum = 0;
    // staggered rather than firing on the very first tick — that's the same
    // moment the first batch of brand-new nodes' category fetches also
    // fires, and piling every startup request onto Wikipedia at once is
    // exactly when a transient failure does the most damage
    this._trendingFetchAccum = TRENDING_FETCH_INTERVAL - 20;
    this._pendingTrendingFetch = false;
    this._fieldEnergyEMA = 0;
    this._expandedLabels = new Set(); // clusters the viewer has manually opened
    this._energyBoost = 0; // 0..1 — briefly raised by interactions, decays back to 0
    this._hoveredNode = null; // set each frame by main.js from the renderer's hover hit-test

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

  /** Interactions (drag release, cluster expand, tie activation, a fresh
   * node appearing) call this to briefly loosen the simulation's damping
   * so the graph keeps visibly resettling instead of snapping still. */
  boostEnergy(amount) {
    this._energyBoost = Math.min(1, this._energyBoost + amount);
  }

  /** Called once per frame from main.js with whatever node the renderer's
   * hit-test currently says is hovered (or null). Hovering doesn't push
   * on anything — see _updateStability — it only changes how much of the
   * *existing* forces on the hovered node (and its direct ties) take
   * effect, via effective mass and per-node damping. */
  setHoveredNode(node) {
    this._hoveredNode = node;
  }

  // Eases every node's `stability` (0..1) toward its target each tick:
  // 1 for the hovered node itself, a partial value for anything directly
  // tied to it, 0 otherwise. Fast ease-in (hovering should feel immediate)
  // but a slower ease-out, so releasing the pointer doesn't instantly let
  // go — physics.integrate() and the mass set below are what actually act
  // on this value.
  _updateStability(dt) {
    const hovered = this._hoveredNode;
    const neighbors = hovered ? this._getDirectNeighbors(hovered) : null;
    for (const node of this.nodes.values()) {
      let target = 0;
      if (hovered) {
        if (node === hovered) target = 1;
        else if (neighbors.has(node)) target = PHYSICS.stabilityNeighborFactor;
      }
      const tau = target > node.stability ? PHYSICS.stabilityInTau : PHYSICS.stabilityOutTau;
      node.stability += (target - node.stability) * Math.min(1, dt / tau);
      if (node.stability < 0.001) node.stability = 0;
      node.bodyMass = 1 + node.stability * PHYSICS.stabilityMass;
    }
  }

  _getDirectNeighbors(node) {
    const set = new Set();
    for (const l of this.topicLinks) {
      if (l.a === node) set.add(l.b);
      else if (l.b === node) set.add(l.a);
    }
    for (const l of this.links) {
      if (l.a === node) set.add(l.b);
      else if (l.b === node) set.add(l.a);
    }
    return set;
  }

  // -------------------------------------------------------------------
  // Dragging — the node follows the cursor directly (pinned, so the
  // simulation's integrator skips it) while held, then is released back
  // into the simulation with a real velocity derived from the drag motion.
  // -------------------------------------------------------------------
  beginDrag(node) {
    node.pinned = true;
    node.vx = 0;
    node.vy = 0;
  }

  dragTo(node, x, y) {
    node.x = x;
    node.y = y;
  }

  endDrag(node, vx, vy) {
    node.pinned = false;
    node.vx = vx;
    node.vy = vy;
    this.boostEnergy(0.6);
  }

  /** Opens a collapsed cluster into its individual nodes, or re-collapses
   * one the viewer previously opened. Keyed by label since cluster
   * membership objects are rebuilt on every recompute. */
  toggleClusterExpanded(label) {
    if (this._expandedLabels.has(label)) this.collapseCluster(label);
    else this.expandCluster(label);
  }

  expandCluster(label) {
    if (this._expandedLabels.has(label)) return;
    this._expandedLabels.add(label);
    this._burstCluster(label);
    this.boostEnergy(0.8);
  }

  collapseCluster(label) {
    if (!this._expandedLabels.has(label)) return;
    this._expandedLabels.delete(label);
    this._collapseBurst(label);
    this.boostEnergy(0.5);
  }

  getExpandedClusters() {
    return this.clusters.filter((c) => c.expanded);
  }

  /** Hovering/clicking a tie is itself a meaningful interaction — nudge
   * both endpoints and wake the simulation a little. */
  activateTie(tie) {
    const dx = tie.b.x - tie.a.x;
    const dy = tie.b.y - tie.a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    applyImpulse(tie.a, angle + Math.PI, 6);
    applyImpulse(tie.b, angle, 6);
    this.boostEnergy(0.3);
  }

  // A one-time outward kick applied at the instant a cluster opens, plus a
  // shove against whatever else is nearby — this is what makes expanding
  // read as a real physical event (members bursting out, the surrounding
  // field flinching away) rather than members quietly drifting apart.
  _burstCluster(label) {
    const cluster = this.clusters.find((c) => c.label === label);
    if (!cluster) return;
    const members = cluster.members;
    let cx = 0;
    let cy = 0;
    for (const m of members) {
      cx += m.x;
      cy += m.y;
    }
    cx /= members.length;
    cy /= members.length;

    const allNodes = [...this.nodes.values()];
    const burstForce = 90 + members.length * 6;
    members.forEach((m, i) => {
      const dx = m.x - cx;
      const dy = m.y - cy;
      const dist = Math.hypot(dx, dy);
      const angle = dist > 2 ? Math.atan2(dy, dx) : (i / members.length) * Math.PI * 2;
      m.vx += Math.cos(angle) * burstForce;
      m.vy += Math.sin(angle) * burstForce;
      displaceNeighbors(allNodes, m, 0.8);
    });
  }

  // The inverse of _burstCluster — a one-time inward kick the instant a
  // cluster re-collapses, so closing one reads as a decisive "snap"
  // rather than just a passive drift back together (summaryCollapseAttraction
  // still does the rest of the work converging them into the merged shape;
  // this just makes the moment itself a visible event, symmetric with expand).
  _collapseBurst(label) {
    const cluster = this.clusters.find((c) => c.label === label);
    if (!cluster) return;
    const members = cluster.members;
    let cx = 0;
    let cy = 0;
    for (const m of members) {
      cx += m.x;
      cy += m.y;
    }
    cx /= members.length;
    cy /= members.length;

    const pullForce = 70 + members.length * 5;
    for (const m of members) {
      const dx = cx - m.x;
      const dy = cy - m.y;
      const dist = Math.hypot(dx, dy) || 1;
      m.vx += (dx / dist) * pullForce;
      m.vy += (dy / dist) * pullForce;
    }
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
    const isNewNode = !node;

    if (!node) {
      if (this.nodes.size >= MAX_NODES) this._evictWeakest();
      node = this._createNode(edit);
      this.nodes.set(edit.title, node);
      this._categoryQueue.add(edit.title);
    }

    node.edits += 1;
    // a second edit is real, repeated activity — cancel any random
    // early-exit timer, the same way sustained interest always should
    if (!isNewNode) node.earlyExitAt = null;
    node.lastActive = now;
    node.lastEditType = edit.type;
    node.url = edit.url;
    node.lastUser = edit.user;
    node.mass = Math.min(1, node.mass + 0.14 * gainFactor);
    node.heat = Math.min(1, node.heat + 0.55 * gainFactor);
    node.history.push(now);
    if (edit.isNew) node.everNew = true;
    if (edit.comment) {
      node.recentComments.push(edit.comment);
      if (node.recentComments.length > 6) node.recentComments.shift();
    }
    node.recentEditors.add(edit.user || "");
    if (node.recentEditors.size > 12) {
      // keep it bounded without needing insertion order — drop an
      // arbitrary member once well past what any insight needs to count
      node.recentEditors.delete(node.recentEditors.values().next().value);
    }

    this.rings.push({
      node,
      age: 0,
      strength: 0.4 + 0.6 * Math.min(1, gainFactor),
    });

    displaceNeighbors([...this.nodes.values()], node, 0.5 + node.heat * gainFactor);
    if (isNewNode) this.boostEnergy(0.35);

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
      // a trending node's size is driven by its live pageview rank rather
      // than the edit-decay curve, but real edit activity can still push it
      // bigger — trending is a floor, not a ceiling, on top of whatever its
      // own edit-driven mass naturally decays to
      if (node.isTrending) {
        node.mass = Math.max(node.trendingMass, node.mass * Math.exp(-dt / tauMass));
      } else {
        node.mass *= Math.exp(-dt / tauMass);
      }
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

      const earlyExit = node.earlyExitAt !== null && now >= node.earlyExitAt;

      if (
        earlyExit ||
        (!node.isTrending &&
          node.mass < REMOVE_THRESHOLD &&
          node.heat < REMOVE_THRESHOLD &&
          node.rangeCount === 0 &&
          idleSeconds > 8)
      ) {
        this.nodes.delete(node.title);
      }
    }

    for (const ring of this.rings) ring.age += dt;
    this.rings = this.rings.filter((r) => r.age < RING_LIFETIME);

    for (const link of this.links) {
      link.age += dt;
      // event ties fade: strength (physics pull) and freshness both track
      // how recently it formed, mapped through the same restrained scale
      // as topic ties rather than used raw
      link.strength = mapAssociationStrength(clamp01(1 - link.age / link.life));
    }
    this.links = this.links.filter(
      (l) => l.age < LINK_LIFETIME && this.nodes.has(l.a.title) && this.nodes.has(l.b.title)
    );

    this.topicLinks = this.topicLinks.filter(
      (l) => this.nodes.has(l.a.title) && this.nodes.has(l.b.title)
    );
    this.clusters = this._pruneClusters();
    this._syncClusterBodies();
    this._updateStability(dt);

    // ---- physics: see physics.js for the force hierarchy this composes ----
    const liveNodes = [...this.nodes.values()];
    const bodies = [...liveNodes, ...this.clusterBodies.values()];
    if (bodies.length) {
      applyAssociationSprings(this.topicLinks, dt);
      applyAssociationSprings(this.links, dt);
      applySummaryGravity(this.clusters, this.clusterBodies, dt);
      applyClusterBodyCohesion(this.clusters, this.clusterBodies, dt);
      applyRepulsion(bodies, dt);
      applyCollision(bodies, dt);
      const center = {
        x: (this.bounds.left + this.bounds.right) / 2,
        y: (this.bounds.top + this.bounds.bottom) / 2,
      };
      applyCentering(bodies, center, dt);
      integrate(bodies, this.bounds, dt, PHYSICS, this._energyBoost);
    }

    this._energyBoost *= Math.exp((-Math.LN2 * dt) / PHYSICS.energyBoostHalfLife);

    const cutoff = now - 1000;
    while (this._editTimestamps.length && this._editTimestamps[0] < cutoff) {
      this._editTimestamps.shift();
    }

    const rawEnergy = Math.min(1, this.getEditsPerSecond() / 8);
    this._fieldEnergyEMA += (rawEnergy - this._fieldEnergyEMA) * Math.min(1, dt / FIELD_ENERGY_TAU);

    this._userPruneAccum += dt;
    if (this._userPruneAccum > 2) {
      this._userPruneAccum = 0;
      for (const [user, list] of this._recentByUser) {
        const fresh = list.filter((e) => now - e.t < LINK_WINDOW_MS);
        if (fresh.length) this._recentByUser.set(user, fresh);
        else this._recentByUser.delete(user);
      }
    }

    this._categoryFetchAccum += dt;
    if (this._categoryFetchAccum > CATEGORY_FETCH_INTERVAL && this._categoryQueue.size && !this._pendingFetch) {
      this._categoryFetchAccum = 0;
      this._flushCategoryQueue();
    }

    this._clusterRecomputeAccum += dt;
    if (this._clusterRecomputeAccum > CLUSTER_RECOMPUTE_INTERVAL) {
      this._clusterRecomputeAccum = 0;
      this._recomputeClusters();
    }

    this._trendingFetchAccum += dt;
    if (this._trendingFetchAccum > TRENDING_FETCH_INTERVAL && !this._pendingTrendingFetch) {
      this._trendingFetchAccum = 0;
      this._refreshTrending();
    }
  }

  _pruneClusters() {
    return this.clusters
      .map((c) => {
        // re-derive every tick, not just on the slower full recompute,
        // so clicking a cluster open/closed registers immediately
        const expanded = this._expandedLabels.has(c.label);
        return {
          ...c,
          members: c.members.filter((n) => this.nodes.has(n.title)),
          expanded,
          collapsed: c.collapsible && !expanded,
        };
      })
      .filter((c) => c.members.length >= 2);
  }

  // Keeps one physics body per collapsible cluster — a real, persistent
  // entity with its own position/velocity (see applyClusterBodyCohesion),
  // not a value recomputed from scratch each frame. Created at the live
  // member centroid so it doesn't "pop" in somewhere arbitrary; removed
  // once its cluster no longer qualifies.
  _syncClusterBodies() {
    const active = new Set();
    for (const c of this.clusters) {
      if (!c.collapsible) continue;
      active.add(c.label);
      const n = c.members.length;
      let body = this.clusterBodies.get(c.label);
      if (!body) {
        let cx = 0;
        let cy = 0;
        for (const m of c.members) {
          cx += m.x;
          cy += m.y;
        }
        cx /= n;
        cy /= n;
        body = { x: cx, y: cy, vx: 0, vy: 0, radius: 0, bodyMass: 1 };
        this.clusterBodies.set(c.label, body);
      }
      body.radius = clusterShapeRadius(n);
      body.bodyMass = 1 + n * PHYSICS.clusterBodyMassPerMember;
    }
    for (const label of [...this.clusterBodies.keys()]) {
      if (!active.has(label)) this.clusterBodies.delete(label);
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

  getTopicLinks() {
    return this.topicLinks;
  }

  getClusters() {
    return this.clusters;
  }

  getClusterBody(label) {
    return this.clusterBodies.get(label);
  }

  getFieldEnergy() {
    return this._fieldEnergyEMA;
  }

  getEditsPerSecond() {
    return this._editTimestamps.length;
  }

  // -------------------------------------------------------------------
  // Context summaries — short, plain explanations for whatever the
  // viewer is currently pointing at.
  // -------------------------------------------------------------------

  describeNode(node) {
    const groupLabel = node.categoriesLoaded ? GROUPS[node.group].label : null;
    const groupPart = groupLabel && node.group !== "OTHER" ? ` Grouped under ${groupLabel}.` : "";

    if (node.isTrending) {
      const viewsPart = node.trendingViews ? ` (~${formatCount(node.trendingViews)} views today)` : "";
      const editPart =
        node.edits > 0 ? ` Also ${node.edits} live ${node.edits === 1 ? "edit" : "edits"} observed.` : "";
      return `Heavily read right now — #${node.trendingRank} most-viewed on Wikipedia today${viewsPart}.${editPart}${groupPart}`;
    }

    const idleSeconds = Math.max(0, (performance.now() - node.lastActive) / 1000);
    const recency =
      idleSeconds < 5 ? "moments ago" : idleSeconds < 90 ? `${Math.round(idleSeconds)}s ago` : `${Math.round(idleSeconds / 60)}m ago`;
    const editWord = node.edits === 1 ? "edit" : "edits";
    return `Wikipedia article — ${node.edits} ${editWord} observed, last active ${recency}.${groupPart}`;
  }

  describeCluster(cluster) {
    const n = cluster.members.length;
    return `${n} articles connected by the shared Wikipedia category "${cluster.label}."`;
  }

  describeTie(tie, kind) {
    if (kind === "topic") {
      return `"${tie.a.title}" and "${tie.b.title}" are both categorized under "${tie.category}" on Wikipedia.`;
    }
    const user = tie.user || "the same editor";
    return `${user} edited both "${tie.a.title}" and "${tie.b.title}" within the last 90 seconds.`;
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
  // one person following a thread across pages. Distinct from topic
  // clustering below, which is structural rather than behavioral.
  _linkToRecentByUser(user, node, now) {
    if (!user) return;
    const list = this._recentByUser.get(user) || [];
    const fresh = list.filter((e) => now - e.t < LINK_WINDOW_MS);

    for (const prev of fresh) {
      if (prev.node !== node && this.nodes.has(prev.node.title)) {
        this._addLink(prev.node, node, user);
      }
    }

    fresh.push({ node, t: now });
    while (fresh.length > MAX_RECENT_PER_USER) fresh.shift();
    this._recentByUser.set(user, fresh);
  }

  _addLink(a, b, user) {
    const exists = this.links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    if (exists) return;
    if (this.links.length >= MAX_LINKS) this.links.shift();
    this.links.push({ a, b, age: 0, life: LINK_LIFETIME, strength: mapAssociationStrength(1), user });
  }

  async _flushCategoryQueue() {
    const titles = [...this._categoryQueue];
    this._categoryQueue.clear();
    this._pendingFetch = true;
    try {
      const results = await fetchCategoriesBatch(titles);
      for (const title of titles) {
        const node = this.nodes.get(title);
        if (!node) continue; // decayed away before the lookup returned
        if (results.has(title)) {
          node.categories = results.get(title);
          node.categoriesLoaded = true;
          node.group = classifyGroup(node.categories);
        } else {
          // the fetch failed for this one (rate limit, transient network
          // error) — requeue it for the next flush cycle rather than
          // permanently marking it categoryless. No retry cap: a title
          // that keeps failing is either hitting a passing issue (worth
          // retrying indefinitely) or a real outage (giving up wouldn't
          // help either, and would wrongly freeze it out once things
          // recover) — see categoryService.js's fetchCategoriesBatch.
          this._categoryQueue.add(title);
        }
      }
      this._recomputeClusters();
    } catch {
      // the whole request failed outright (e.g. a network error) — requeue
      // every title in this flush the same way, instead of silently
      // dropping them
      for (const title of titles) {
        if (this.nodes.has(title)) this._categoryQueue.add(title);
      }
    } finally {
      this._pendingFetch = false;
    }
  }

  async _refreshTrending() {
    this._pendingTrendingFetch = true;
    try {
      const list = await fetchTopTrending(TRENDING_TOP_N);
      if (list.length) this.syncTrending(list);
    } catch {
      // leave the field as-is — whatever trending nodes already exist just
      // keep aging normally instead of being force-refreshed this cycle
    } finally {
      this._pendingTrendingFetch = false;
    }
  }

  // Adds/updates a node for each currently top-viewed article, and lets any
  // node that fell out of the list stop being treated as trending (it then
  // decays away through the ordinary idle path if nothing else — a real
  // edit — is keeping it alive, exactly like any other node that's gone
  // quiet, rather than vanishing the instant it drops off the list).
  syncTrending(list) {
    const stillTrending = new Set();
    const topN = list.length;
    for (const { title, rank, views } of list) {
      stillTrending.add(title);
      const trendingMass = TRENDING_MIN_MASS + (1 - TRENDING_MIN_MASS) * (1 - (rank - 1) / Math.max(1, topN));
      let node = this.nodes.get(title);
      if (!node) {
        if (this.nodes.size >= MAX_NODES) this._evictWeakest();
        node = this._createTrendingNode(title, rank, views, trendingMass);
        this.nodes.set(title, node);
        this._categoryQueue.add(title);
        continue;
      }
      node.isTrending = true;
      node.trendingRank = rank;
      node.trendingViews = views;
      node.trendingMass = trendingMass;
      // being independently confirmed as heavily-read overrides the random
      // early-exit flicker, the same way a real second edit does
      node.earlyExitAt = null;
    }
    for (const node of this.nodes.values()) {
      if (node.isTrending && !stillTrending.has(node.title)) node.isTrending = false;
    }
  }

  // Builds the field's topic structure from real shared Wikipedia
  // categories: an edge forms between any two active articles that share a
  // category, labeled with the most specific (least common, among currently
  // active nodes) category they have in common. That same rarity also maps
  // (through a restrained scale) into the tie's physics strength, so a very
  // specific shared category pulls harder than a broad, common one.
  // Connected components of size >= 2 become clusters; the renderer only
  // draws a named halo for size >= 3 so a coincidental pair doesn't read as
  // "a topic."
  _recomputeClusters() {
    const all = [...this.nodes.values()];
    for (const n of all) {
      n.topicDegree = 0;
      n.clustered = false;
    }

    const nodes = all.filter((n) => n.categoriesLoaded && n.categories.size);
    if (nodes.length < 2) {
      this.topicLinks = [];
      this.clusters = [];
      return;
    }

    const freq = new Map();
    for (const n of nodes) {
      for (const c of n.categories) freq.set(c, (freq.get(c) || 0) + 1);
    }
    const maxFreq = Math.max(1, ...freq.values());
    // A category held by a big chunk of whatever's currently active isn't a
    // real connection, just coincidence — two articles both being, say,
    // "American films" doesn't read as "these are related" the way a rare,
    // specific category does. Capped at the larger of a flat floor (so a
    // small, early pool isn't over-filtered) and a fraction of the current
    // pool (so the bar rises sensibly as more gets active).
    const tieCommonalityCap = Math.max(4, Math.ceil(nodes.length * 0.35));

    const links = [];
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let best = null;
        let bestScore = Infinity;
        for (const c of a.categories) {
          if (!b.categories.has(c)) continue;
          const score = freq.get(c) || 1;
          if (score > tieCommonalityCap) continue; // too generic to read as a real connection
          if (score < bestScore) {
            bestScore = score;
            best = c;
          }
        }
        if (best) {
          // rarer shared category (lower bestScore) => higher raw strength
          const raw = clamp01(1 - (bestScore - 1) / Math.max(1, maxFreq - 1));
          links.push({ a, b, category: best, strength: mapAssociationStrength(raw) });
          a.topicDegree += 1;
          b.topicDegree += 1;
        }
      }
    }
    this.topicLinks = links;

    const parent = new Map();
    for (const n of nodes) parent.set(n, n);
    const find = (x) => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(x) !== root) {
        const next = parent.get(x);
        parent.set(x, root);
        x = next;
      }
      return root;
    };
    for (const l of links) {
      const ra = find(l.a);
      const rb = find(l.b);
      if (ra !== rb) parent.set(ra, rb);
    }

    const groups = new Map();
    for (const n of nodes) {
      const root = find(n);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(n);
    }

    const clusters = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const counts = new Map();
      for (const l of links) {
        if (members.includes(l.a) && members.includes(l.b)) {
          counts.set(l.category, (counts.get(l.category) || 0) + 1);
        }
      }
      let label = null;
      let labelCount = 0;
      for (const [cat, count] of counts) {
        if (count > labelCount) {
          labelCount = count;
          label = cat;
        }
      }
      if (members.length >= 3) {
        for (const m of members) m.clustered = true;
      }
      const finalLabel = label || "RELATED";
      const collapsible = members.length >= COLLAPSE_THRESHOLD;
      const expanded = this._expandedLabels.has(finalLabel);
      clusters.push({
        members,
        label: finalLabel,
        collapsible,
        expanded,
        collapsed: collapsible && !expanded,
      });
    }
    this.clusters = clusters;
  }

  _createNode(edit) {
    const b = this.bounds;
    const marginX = (b.right - b.left) * 0.16;
    const marginY = (b.bottom - b.top) * 0.16;
    const now = performance.now();
    return {
      title: edit.title,
      x: rand(b.left + marginX, b.right - marginX),
      y: rand(b.top + marginY, b.bottom - marginY),
      vx: rand(-6, 6),
      vy: rand(-6, 6),
      pinned: false,
      stability: 0,
      bodyMass: 1,
      mass: 0,
      heat: 0,
      radius: BASE_RADIUS,
      opacity: 0.1,
      edits: 0,
      everNew: !!edit.isNew,
      recentComments: [],
      recentEditors: new Set(),
      history: [],
      rangeCount: 0,
      categories: null,
      categoriesLoaded: false,
      group: "OTHER",
      topicDegree: 0,
      clustered: false,
      createdAt: now, // drives the node's color desaturating over its lifetime — see renderer.js
      // a random chance this one just flickers out shortly, rather than
      // waiting out the normal decay curve — see EARLY_EXIT_* above
      earlyExitAt: Math.random() < EARLY_EXIT_CHANCE ? now + rand(EARLY_EXIT_MIN_MS, EARLY_EXIT_MAX_MS) : null,
      lastActive: now,
      lastEditType: edit.type,
      lastUser: edit.user,
      url: edit.url,
      preview: undefined, // set by main.js on hover-dwell — see previewService.js
      isTrending: false,
      trendingRank: null,
      trendingViews: null,
      trendingMass: 0,
    };
  }

  // A node for a heavily-read (not necessarily heavily-edited) article —
  // same shape as _createNode's, so it's indistinguishable to every other
  // system (physics, clustering, hover, decay) except the isTrending flag
  // renderer.js reads to draw it as a triangle and the removal exemption
  // above. Starts at its target trendingMass immediately rather than easing
  // in, since it's already a confirmed, current fact about the page, not a
  // fresh pulse of activity to ramp up from zero.
  _createTrendingNode(title, rank, views, trendingMass) {
    const b = this.bounds;
    const marginX = (b.right - b.left) * 0.16;
    const marginY = (b.bottom - b.top) * 0.16;
    const now = performance.now();
    return {
      title,
      x: rand(b.left + marginX, b.right - marginX),
      y: rand(b.top + marginY, b.bottom - marginY),
      vx: rand(-6, 6),
      vy: rand(-6, 6),
      pinned: false,
      stability: 0,
      bodyMass: 1,
      mass: trendingMass,
      heat: 0,
      radius: BASE_RADIUS,
      opacity: 0.1,
      edits: 0,
      everNew: false,
      recentComments: [],
      recentEditors: new Set(),
      history: [],
      rangeCount: 0,
      categories: null,
      categoriesLoaded: false,
      group: "OTHER",
      topicDegree: 0,
      clustered: false,
      createdAt: now,
      earlyExitAt: null, // trending nodes' lifecycle is governed by staying on the top-pageviews list, not the random flicker
      lastActive: now,
      lastEditType: null,
      lastUser: null,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      preview: undefined,
      isTrending: true,
      trendingRank: rank,
      trendingViews: views,
      trendingMass,
    };
  }

  _evictWeakest() {
    let weakest = null;
    for (const node of this.nodes.values()) {
      const score = node.mass + node.heat + node.rangeCount * 0.05 + node.topicDegree * 0.08;
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

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
