// Force-directed simulation for the node field.
//
// Everything here is velocity + spring/damping based — nothing sets a
// node's position directly except the last-resort boundary safety clamp.
// There is no per-node "home" anchor: any spatial clustering that appears
// is a real consequence of association springs and repulsion, not a
// pre-assigned position pretending to be structure.
//
// Force hierarchy (highest priority / strongest first):
//   1. ASSOCIATION SPRINGS   — linked nodes pull together (real springs:
//                              they push apart too, if closer than rest)
//   1b. SUMMARY GRAVITY      — members pulled toward their cluster's body
//   2. LOCAL REPULSION       — soft personal space, prevents crowding
//   3. COLLISION             — soft, heavily-damped overlap correction —
//                              a squish, not a spring; see collisionDamping
//   4. WEAK GLOBAL CENTERING — keeps the field from drifting offscreen;
//                              deliberately far weaker than #1
//   5. DAMPING               — frame-rate-independent velocity decay
//
// All forces simply accumulate into vx/vy; only the final integrate() step
// damps and moves anything, so call order among 1-4 doesn't matter — only
// their relative magnitudes (set below) do.
//
// Every pairwise force (springs, summary gravity, repulsion, collision)
// splits through a body's effective mass (applyPairForce / massSplit) —
// this is also how hover-stabilization works: a hovered node's mass is
// temporarily raised way up in articleStore.js, so it absorbs almost none
// of any pairwise force while its partner absorbs almost all of it. That
// makes "stabilized" a property of how forces divide between two bodies,
// never a new force pushing on anyone else.

export const PHYSICS = {
  // 1. Association springs (topic ties + event ties). Real Hooke's-law
  // springs: force is proportional to displacement from a rest length, in
  // both directions, so pulling a tied pair apart makes them visibly
  // drift back rather than just stopping being repelled.
  associationStrength: 2.5, // spring constant (px/s^2 per px of displacement)
  associationDistanceMin: 55, // rest length for the strongest tie
  associationDistanceMax: 150, // rest length for the weakest tie

  // 1b. Summary/cluster body gravity — members are pulled toward their
  // cluster's own body position. Mild while expanded (organizes members
  // loosely around it); strong while collapsed (pulling them into the
  // merged shape). Always weaker than a strong direct association tie.
  summaryAttraction: 3,
  summaryCollapseAttraction: 90,
  clusterBodyCohesion: 10, // spring pulling a cluster's body toward its live member centroid
  clusterBodyMassPerMember: 0.55, // extra inertia per member — bigger clusters feel heavier

  // 2. Local repulsion — soft, short-range personal space. A small amount
  // of built-in velocity damping (repulsionDamping) keeps it from ever
  // reading as a spring in its own right.
  repulsionStrength: 12,
  repulsionRange: 70, // px beyond radius-sum where repulsion fades to 0
  repulsionDamping: 0.25, // fraction of closing speed removed per contact

  // 3. Collision — a soft, heavily-damped "squish" rather than a spring:
  // most of what stops two overlapping bodies is removing their closing
  // velocity (collisionDamping), not pushing them apart (collisionStrength
  // is deliberately modest). That combination is what makes contact read
  // as soft-body damping instead of a bounce, while collisionDamping's
  // near-total kill of approach velocity still reliably prevents overlap.
  collisionStrength: 260,
  collisionDamping: 0.88, // fraction of closing speed removed per contact
  collisionPadding: 5,
  maxPairForce: 55, // caps any single pairwise force's per-frame velocity change — forces move nodes gradually rather than in one sudden jolt

  // 4. Weak global centering — substantially weaker than association
  // springs; just enough to keep the whole field from drifting away.
  centeringStrength: 0.05,

  // Soft boundary spring (not a position clamp) plus a last-resort clamp.
  boundaryMargin: 32,
  boundaryStrength: 20,

  // 5. Damping, expressed as a half-life in seconds (frame-rate
  // independent): how long until a node's velocity, absent new force,
  // drops to half. Kept short — nodes should lose velocity quickly once
  // displaced, so the field settles and stays readable rather than
  // carrying momentum around.
  dampingHalfLife: 0.28,
  // Interactions (drag release, cluster expand, tie activation, a new node
  // appearing) briefly extend that half-life so the graph keeps visibly
  // rearranging afterward instead of snapping still; this is how long the
  // boost takes to decay back to baseline.
  energyBoostHalfLife: 1.4,
  energyBoostDampingBonus: 0.6,

  // The hard "how fast can anything ever move" ceiling — low enough that
  // nothing can shoot across the field in one frame's worth of force.
  velocityLimit: 70,

  // Hover stabilization (see articleStore._updateStability). stabilityMass
  // is how much extra effective mass full stability adds (so a stabilized
  // node absorbs roughly 1/(1+stabilityMass) of any pairwise force);
  // stabilityDampingFactor shortens that node's own damping half-life on
  // top of that. inTau/outTau are the ease-in/ease-out times for the
  // stability value itself — fast onset so hovering feels immediate, a
  // slower release so nothing snaps back to normal the instant the
  // pointer moves away.
  stabilityMass: 45,
  stabilityDampingFactor: 7,
  stabilityInTau: 0.12,
  stabilityOutTau: 0.7,
  stabilityNeighborFactor: 0.45, // how much of full stability a tied neighbor gets
};

/** Turns a half-life (seconds) into the per-substep decay factor:
 * v(t) = v0 * 0.5^(t/halfLife) = v0 * exp(-ln2 * t/halfLife). */
function decayFactor(halfLifeSeconds, dt) {
  if (halfLifeSeconds <= 0) return 0;
  return Math.exp((-Math.LN2 * dt) / halfLifeSeconds);
}

function clampMagnitude(fx, fy, max) {
  const m = Math.hypot(fx, fy);
  if (m <= max || m === 0) return [fx, fy];
  const s = max / m;
  return [fx * s, fy * s];
}

// ---------------------------------------------------------------------
// 1. Association springs
// ---------------------------------------------------------------------

/** ties: [{a, b, strength}] where strength is 0..1 (already mapped through
 * a restrained scale by the caller — see geometry.mapAssociationStrength).
 * A real two-sided spring: pulls together when farther than rest length,
 * pushes apart when closer, so a torn-apart pair visibly drifts back.
 * Mass-weighted like every other pairwise force, so a stabilized endpoint
 * resists being pulled too. */
export function applyAssociationSprings(ties, dt, config = PHYSICS) {
  for (const tie of ties) {
    const { a, b, strength } = tie;
    if (strength <= 0) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 0.01;
    const restLength =
      config.associationDistanceMax -
      (config.associationDistanceMax - config.associationDistanceMin) * strength;
    const displacement = dist - restLength;
    const force = config.associationStrength * strength * displacement * dt;
    const [fx, fy] = clampMagnitude((dx / dist) * force, (dy / dist) * force, config.maxPairForce);
    // applyPairForce's (fx, fy) is the a→b *separating* direction (that's
    // the convention repulsion/collision pass it in); a spring pulling
    // together needs the opposite sign, so negate here rather than change
    // that shared convention.
    applyPairForce(a, b, -fx, -fy);
  }
}

// ---------------------------------------------------------------------
// 1b. Summary gravity + cluster body cohesion
// ---------------------------------------------------------------------

/** Pulls each cluster's members toward that cluster's body position.
 * bodies: Map<label, {x,y,vx,vy}>. Strength ramps way up while collapsed
 * (pulling members into the merged shape) and stays mild while expanded
 * (loosely organizing them around it, never swallowing them to a point —
 * repulsion/collision supply the standoff distance). Mass-weighted against
 * the body, so a stabilized member barely moves toward it. */
export function applySummaryGravity(clusters, bodies, dt, config = PHYSICS) {
  for (const cluster of clusters) {
    const body = bodies.get(cluster.label);
    if (!body) continue;
    const strength = cluster.collapsed ? config.summaryCollapseAttraction : config.summaryAttraction;
    for (const m of cluster.members) {
      const dx = body.x - m.x;
      const dy = body.y - m.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = Math.min(strength * dt, dist * 8); // avoid overshoot-to-infinity at dist~0
      const [fx, fy] = clampMagnitude((dx / dist) * force, (dy / dist) * force, config.maxPairForce);
      // same sign flip as applyAssociationSprings — this is an attraction,
      // applyPairForce's convention is separating
      applyPairForce(m, body, -fx, -fy);
    }
  }
}

/** The body itself is a real, heavier entity: it's pulled toward the live
 * centroid of its members (so it follows the group) but its effective mass
 * grows with member count, so bigger clusters feel more inert/heavier
 * rather than snapping to every local wiggle. */
export function applyClusterBodyCohesion(clusters, bodies, dt, config = PHYSICS) {
  for (const cluster of clusters) {
    const body = bodies.get(cluster.label);
    if (!body) continue;
    const members = cluster.members;
    let cx = 0;
    let cy = 0;
    for (const m of members) {
      cx += m.x;
      cy += m.y;
    }
    cx /= members.length;
    cy /= members.length;
    const mass = 1 + members.length * config.clusterBodyMassPerMember;
    const dx = cx - body.x;
    const dy = cy - body.y;
    const force = (config.clusterBodyCohesion * dt) / mass;
    body.vx += dx * force;
    body.vy += dy * force;
  }
}

// ---------------------------------------------------------------------
// 2 & 3. Repulsion + collision
// ---------------------------------------------------------------------

/** Soft, short-range personal-space repulsion between any two bodies with
 * an .x/.y/.radius. Pass in regular nodes AND cluster bodies together so
 * summary shapes also claim their own space in the field. A touch of
 * built-in velocity damping keeps repulsion itself from ever springing. */
export function applyRepulsion(bodies, dt, config = PHYSICS) {
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy;
      const range = a.radius + b.radius + config.repulsionRange;
      if (distSq > range * range || distSq < 0.0001) continue;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const ny = dy / dist;
      const falloff = 1 - dist / range;
      const force = config.repulsionStrength * falloff * falloff * dt;
      const [fx, fy] = clampMagnitude(nx * force, ny * force, config.maxPairForce);
      applyPairForce(a, b, fx, fy);
      dampClosingVelocity(a, b, nx, ny, config.repulsionDamping);
    }
  }
}

/** Soft, heavily-damped overlap correction — a squish, not a bounce. Most
 * of the work is done by killing the closing velocity between the two
 * bodies (dampClosingVelocity); the positional push is deliberately mild,
 * so contact reads as viscous rather than springy while still reliably
 * preventing visible overlap once things settle. */
export function applyCollision(bodies, dt, config = PHYSICS) {
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minDist = a.radius + b.radius + config.collisionPadding;
      const distSq = dx * dx + dy * dy;
      if (distSq > minDist * minDist || distSq < 0.0001) continue;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = (minDist - dist) / minDist;
      const force = config.collisionStrength * overlap * dt;
      const [fx, fy] = clampMagnitude(nx * force, ny * force, config.maxPairForce);
      applyPairForce(a, b, fx, fy);
      dampClosingVelocity(a, b, nx, ny, config.collisionDamping);
    }
  }
}

/** Removes `fraction` of the relative velocity two bodies have *toward*
 * each other along the contact normal (n points from a to b) — this is
 * what turns contact into a soft, inelastic squish instead of an elastic
 * bounce. Only acts while they're approaching; never adds speed. Split by
 * the same effective-mass ratio as the positional push, so a stabilized
 * body's own velocity barely changes even as it absorbs a collision. */
function dampClosingVelocity(a, b, nx, ny, fraction) {
  const relVx = b.vx - a.vx;
  const relVy = b.vy - a.vy;
  const closingSpeed = relVx * nx + relVy * ny;
  if (closingSpeed >= 0) return; // already separating — nothing to damp
  const ma = a.bodyMass || 1;
  const mb = b.bodyMass || 1;
  const total = ma + mb;
  const impulse = closingSpeed * fraction;
  a.vx += (impulse * nx * mb) / total;
  a.vy += (impulse * ny * mb) / total;
  b.vx -= (impulse * nx * ma) / total;
  b.vy -= (impulse * ny * ma) / total;
}

function applyPairForce(a, b, fx, fy) {
  const ma = a.bodyMass || 1;
  const mb = b.bodyMass || 1;
  const total = ma + mb;
  a.vx -= (fx * mb) / total;
  a.vy -= (fy * mb) / total;
  b.vx += (fx * ma) / total;
  b.vy += (fy * ma) / total;
}

// ---------------------------------------------------------------------
// 4. Weak global centering
// ---------------------------------------------------------------------

/** A very weak pull toward the shared field center — deliberately far
 * weaker than association forces, just enough to keep the whole field
 * from drifting off into a corner over time. */
export function applyCentering(bodies, center, dt, config = PHYSICS) {
  for (const b of bodies) {
    b.vx += (center.x - b.x) * config.centeringStrength * dt;
    b.vy += (center.y - b.y) * config.centeringStrength * dt;
  }
}

// ---------------------------------------------------------------------
// 5. Integration: soft boundary, damping, velocity limit, position update
// ---------------------------------------------------------------------

/** energyFactor (0..1): how much of an interaction "boost" is currently
 * active — temporarily extends the damping half-life so the graph keeps
 * visibly resettling after a drag, expand, or tie activation instead of
 * snapping still. Each body may also carry its own `.stability` (0..1,
 * set in articleStore per-frame from hover state), which shortens *that
 * body's* half-life on top of the shared one — hover stabilization is a
 * per-node damping boost, layered on the same integrator everything else
 * uses, not a separate mechanism. */
export function integrate(bodies, bounds, dt, config = PHYSICS, energyFactor = 0) {
  const baseHalfLife = config.dampingHalfLife + energyFactor * config.energyBoostDampingBonus;

  for (const b of bodies) {
    if (b.pinned) continue; // being dragged — position is driven externally

    // soft boundary spring: only engages within `boundaryMargin` of an edge
    const m = config.boundaryMargin + b.radius;
    if (b.x < bounds.left + m) b.vx += (bounds.left + m - b.x) * config.boundaryStrength * dt;
    if (b.x > bounds.right - m) b.vx -= (b.x - (bounds.right - m)) * config.boundaryStrength * dt;
    if (b.y < bounds.top + m) b.vy += (bounds.top + m - b.y) * config.boundaryStrength * dt;
    if (b.y > bounds.bottom - m) b.vy -= (b.y - (bounds.bottom - m)) * config.boundaryStrength * dt;

    const stability = b.stability || 0;
    const halfLife = stability > 0 ? baseHalfLife / (1 + stability * config.stabilityDampingFactor) : baseHalfLife;
    const decay = decayFactor(halfLife, dt);
    b.vx *= decay;
    b.vy *= decay;

    const speed = Math.hypot(b.vx, b.vy);
    if (speed > config.velocityLimit) {
      b.vx = (b.vx / speed) * config.velocityLimit;
      b.vy = (b.vy / speed) * config.velocityLimit;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // last-resort safety clamp — the boundary spring above should make
    // this a no-op in practice; it exists only to guarantee nothing can
    // truly escape the viewport after e.g. a huge dt spike
    const pad = b.radius + 4;
    if (b.x < bounds.left + pad) b.x = bounds.left + pad;
    if (b.x > bounds.right - pad) b.x = bounds.right - pad;
    if (b.y < bounds.top + pad) b.y = bounds.top + pad;
    if (b.y > bounds.bottom - pad) b.y = bounds.bottom - pad;
  }
}

// ---------------------------------------------------------------------
// Impulses — real, physical energy injection for interaction events
// ---------------------------------------------------------------------

/** A direct velocity kick in a given direction (radians) — used for burst
 * events (cluster expand) and tie-activation nudges. */
export function applyImpulse(node, angle, magnitude) {
  node.vx += Math.cos(angle) * magnitude;
  node.vy += Math.sin(angle) * magnitude;
}

/** Pushes nodes near a source point outward — used when a burst of
 * attention (a fresh edit, a cluster bursting open) should visibly
 * displace whatever else is nearby. */
export function displaceNeighbors(nodes, source, strength) {
  for (const n of nodes) {
    if (n === source) continue;
    const dx = n.x - source.x;
    const dy = n.y - source.y;
    const dist = Math.hypot(dx, dy) || 1;
    const radius = 140;
    if (dist > radius) continue;
    const falloff = 1 - dist / radius;
    const force = strength * falloff * 10;
    n.vx += (dx / dist) * force;
    n.vy += (dy / dist) * force;
  }
}
