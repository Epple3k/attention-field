// Lightweight, deliberately loose physics for the node field.
// Nodes drift around a soft "home" position, repel when they overlap,
// and receive tiny random impulses so the field never sits perfectly still.

const REPEL_STRENGTH = 420;
const HOME_STRENGTH = 0.35;
const DAMPING = 0.90;
const JITTER = 5.5;
const MAX_SPEED = 60;
const LINK_STRENGTH = 26;
const TOPIC_STRENGTH = 16;
const COLLAPSE_STRENGTH = 150;

export function stepPhysics(nodes, bounds, dt) {
  const n = nodes.length;

  for (let i = 0; i < n; i++) {
    const a = nodes[i];

    // gentle pull back toward home position — keeps the field legible
    // instead of nodes drifting into a corner
    a.vx += (a.homeX - a.x) * HOME_STRENGTH * dt;
    a.vy += (a.homeY - a.y) * HOME_STRENGTH * dt;

    // tiny continuous jitter so dormant nodes still feel alive, scaled
    // down for large nodes so they read as heavier / more settled
    const jitterScale = 1 / (1 + a.mass * 2);
    a.vx += (Math.random() - 0.5) * JITTER * jitterScale * dt;
    a.vy += (Math.random() - 0.5) * JITTER * jitterScale * dt;
  }

  // pairwise soft repulsion — O(n^2) but n stays under ~70, so it's cheap
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distSq = dx * dx + dy * dy;
      const minDist = a.radius + b.radius + 14;
      if (distSq > minDist * minDist || distSq < 0.01) continue;
      const dist = Math.sqrt(distSq) || 0.01;
      const overlap = (minDist - dist) / minDist;
      const force = REPEL_STRENGTH * overlap * dt;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    a.vx *= DAMPING;
    a.vy *= DAMPING;

    const speed = Math.hypot(a.vx, a.vy);
    if (speed > MAX_SPEED) {
      a.vx = (a.vx / speed) * MAX_SPEED;
      a.vy = (a.vy / speed) * MAX_SPEED;
    }

    a.x += a.vx * dt;
    a.y += a.vy * dt;

    const pad = a.radius + 24;
    a.x = clamp(a.x, bounds.left + pad, bounds.right - pad);
    a.y = clamp(a.y, bounds.top + pad, bounds.bottom - pad);
  }
}

/** Nodes touched by a shared recent editor drift gently toward each other
 * while the event link is fresh — a behavioral signal (this happened),
 * not a topical one. Force fades to zero as the link ages out. */
export function applyLinkForces(links, dt) {
  for (const link of links) {
    const t = link.age / link.life;
    if (t >= 1) continue;
    const a = link.a;
    const b = link.b;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const minDist = a.radius + b.radius + 70;
    if (dist <= minDist) continue;
    const force = LINK_STRENGTH * (1 - t) * dt;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }
}

/** Nodes that genuinely share a Wikipedia category pull toward each other
 * continuously, for as long as that structural relationship holds — this
 * is what actually produces topic clusters in the field, rather than a
 * transient nudge. Weaker than the event link so live activity can still
 * displace things locally. */
export function applyTopicForces(links, dt) {
  for (const link of links) {
    const a = link.a;
    const b = link.b;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const minDist = a.radius + b.radius + 50;
    if (dist <= minDist) continue;
    const force = TOPIC_STRENGTH * dt;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }
}

/** A collapsed cluster pulls its members tightly toward their shared
 * centroid — this is what physically turns several separate nodes into
 * one compact body. Removing this force (on expand) lets normal repulsion
 * and topic springs take back over, so members visibly fly back out to
 * their own positions instead of just reappearing. */
export function applyClusterCollapseForce(clusters, dt) {
  for (const cluster of clusters) {
    if (!cluster.collapsed) continue;
    const members = cluster.members;
    let cx = 0;
    let cy = 0;
    for (const m of members) {
      cx += m.x;
      cy += m.y;
    }
    cx /= members.length;
    cy /= members.length;
    for (const m of members) {
      const dx = cx - m.x;
      const dy = cy - m.y;
      const dist = Math.hypot(dx, dy) || 1;
      const force = COLLAPSE_STRENGTH * dt;
      m.vx += (dx / dist) * force;
      m.vy += (dy / dist) * force;
    }
  }
}

/** Impulse applied to nodes near a fresh, energetic pulse — a burst
 * of attention visibly displaces its neighbors. */
export function displaceNeighbors(nodes, source, strength) {
  for (const n of nodes) {
    if (n === source) continue;
    const dx = n.x - source.x;
    const dy = n.y - source.y;
    const dist = Math.hypot(dx, dy) || 1;
    const radius = 140;
    if (dist > radius) continue;
    const falloff = 1 - dist / radius;
    const force = strength * falloff * 26;
    n.vx += (dx / dist) * force;
    n.vy += (dy / dist) * force;
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
