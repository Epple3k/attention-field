// Small shared formulas used by physics, the store, and the renderer alike,
// so a cluster's collision radius, its clickable region, and its drawn size
// are always computed the same way instead of drifting out of sync.

/** Visual/physical radius of a collapsed cluster's merged shape. */
export function clusterShapeRadius(memberCount) {
  return 22 + Math.min(30, memberCount * 2.2);
}

/** Halo radius: the shape's own radius plus a small, fixed pad — not a
 * multiplier over the members' scatter, which is what previously made the
 * halo balloon into a "giant circular territory" for a widely-expanded
 * cluster. This keeps it reading as a subtle region around the node. */
export function clusterHaloRadius(memberCount) {
  return clusterShapeRadius(memberCount) + 14;
}

/** Maps a raw 0..1 association score into a restrained strength range
 * instead of letting raw/extreme values drive spring force directly. */
export function mapAssociationStrength(raw, min = 0.28, max = 1) {
  const t = Math.max(0, Math.min(1, raw));
  return min + (max - min) * t;
}

export function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/** Stable, order-independent identity for a tie, keyed by its endpoint
 * titles. Topic ties are rebuilt into new objects on every topology
 * recompute, so a "pinned" tie has to be re-resolved by this key each
 * frame rather than held as a direct object reference. */
export function tieKey(tie) {
  return [tie.a.title, tie.b.title].sort().join("::");
}
