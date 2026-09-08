// Visual Mapping + Renderer.
// Pure draw layer — takes a store snapshot and paints it. No data logic.

const COLOR_BG = "#0a0a09";
const COLOR_FG_RGB = "243, 237, 224";
const COLOR_ACCENT = "255, 138, 30"; // rgb triplet for accent, used with alpha
const COLOR_DIM = "138, 132, 120";

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.hoverNode = null;
    this.hoverCluster = null;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
  }

  draw(store) {
    const { ctx, width, height } = this;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, width, height);

    this._drawGrid();

    const allNodes = store.getNodes();
    const rings = store.getRings();
    const links = store.getLinks();
    const topicLinks = store.getTopicLinks();
    const clusters = store.getClusters();
    const energy = store.getFieldEnergy();

    // members of a collapsed cluster are no longer individually rendered —
    // the merged shape stands in for all of them
    const hidden = new Set();
    for (const c of clusters) {
      if (c.collapsed) for (const m of c.members) hidden.add(m);
    }
    const nodes = allNodes.filter((n) => !hidden.has(n));

    this._drawAmbientGlow(energy);
    for (const cluster of clusters) {
      if (!cluster.collapsed && cluster.members.length >= 3) this._drawClusterHalo(cluster);
    }
    for (const tl of topicLinks) {
      if (hidden.has(tl.a) || hidden.has(tl.b)) continue;
      this._drawTopicLink(tl);
    }
    for (const link of links) {
      if (hidden.has(link.a) || hidden.has(link.b)) continue;
      this._drawLink(link);
    }
    for (const ring of rings) {
      if (hidden.has(ring.node)) continue;
      this._drawRing(ring);
    }

    // sort so larger / hotter nodes paint last (on top)
    nodes.sort((a, b) => a.mass + a.heat - (b.mass + b.heat));
    for (const node of nodes) this._drawNode(node);

    for (const cluster of clusters) {
      if (cluster.collapsed) this._drawClusterShape(cluster);
      else if (cluster.members.length >= 3) this._drawClusterLabel(cluster);
    }

    return nodes;
  }

  _drawAmbientGlow(energy) {
    if (energy < 0.02) return;
    const { ctx, width, height } = this;
    const cx = width / 2;
    const cy = height / 2;
    const r = Math.max(width, height) * 0.62;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const alpha = Math.min(0.09, energy * 0.11);
    grad.addColorStop(0, `rgba(${COLOR_ACCENT}, ${alpha})`);
    grad.addColorStop(1, `rgba(${COLOR_ACCENT}, 0)`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  _clusterCentroid(cluster) {
    const members = cluster.members;
    let cx = 0;
    let cy = 0;
    for (const m of members) {
      cx += m.x;
      cy += m.y;
    }
    cx /= members.length;
    cy /= members.length;
    let maxR = 40;
    for (const m of members) {
      const d = Math.hypot(m.x - cx, m.y - cy) + m.radius;
      if (d > maxR) maxR = d;
    }
    return { cx, cy, maxR };
  }

  _drawClusterHalo(cluster) {
    if (cluster.members.length < 3) return;
    const { ctx } = this;
    const { cx, cy, maxR } = this._clusterCentroid(cluster);
    const r = maxR + 36;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(${COLOR_FG_RGB}, 0.05)`);
    grad.addColorStop(1, `rgba(${COLOR_FG_RGB}, 0)`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawClusterLabel(cluster) {
    if (cluster.members.length < 3) return;
    const { ctx } = this;
    const { cx, cy, maxR } = this._clusterCentroid(cluster);
    const isHover = this.hoverCluster === cluster;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `500 11px "IBM Plex Mono", monospace`;
    ctx.fillStyle = `rgba(${COLOR_FG_RGB}, ${isHover ? 0.85 : 0.55})`;
    ctx.fillText(cluster.label.toUpperCase(), cx, cy - maxR - 15);
    ctx.font = `400 8px "IBM Plex Mono", monospace`;
    ctx.fillStyle = `rgba(${COLOR_DIM}, 0.65)`;
    const hint = cluster.collapsible ? `${cluster.members.length} ARTICLES — CLICK TO COLLAPSE` : `${cluster.members.length} ARTICLES`;
    ctx.fillText(hint, cx, cy - maxR - 3);
    if (isHover && cluster.collapsible) {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR + 34, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${COLOR_ACCENT}, 0.35)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  // radius formula shared between drawing the collapsed shape and hit-
  // testing it, so the clickable region always matches what's on screen
  _clusterShapeRadius(memberCount) {
    return 22 + Math.min(30, memberCount * 2.2);
  }

  // A collapsed cluster stops being several dots and becomes one object: a
  // regular polygon whose side count equals its member count (literally
  // "made of N things"), rotating slowly, that brightens with the members'
  // aggregate live activity — a real aggregated pulse, not decoration.
  _drawClusterShape(cluster) {
    const { ctx } = this;
    const { cx, cy } = this._clusterCentroid(cluster);
    const n = cluster.members.length;
    const sides = Math.max(3, Math.min(12, n));
    const heat = cluster.members.reduce((s, m) => s + m.heat, 0) / n;
    const r = this._clusterShapeRadius(n);
    const isHover = this.hoverCluster === cluster;
    const rotation = (performance.now() / 1000) * (0.06 + heat * 0.5);

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const angle = rotation + (i / sides) * Math.PI * 2;
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();

    const hotColor = heat > 0.12 || isHover;
    const fillAlpha = 0.05 + heat * 0.1 + (isHover ? 0.03 : 0);
    ctx.fillStyle = `rgba(${hotColor ? COLOR_ACCENT : COLOR_FG_RGB}, ${fillAlpha})`;
    ctx.fill();

    ctx.strokeStyle = `rgba(${hotColor ? COLOR_ACCENT : COLOR_FG_RGB}, ${isHover ? 0.9 : 0.4 + heat * 0.4})`;
    ctx.lineWidth = isHover ? 1.6 : 1.1;
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 12px "IBM Plex Mono", monospace`;
    ctx.fillStyle = `rgba(${COLOR_FG_RGB}, 0.9)`;
    ctx.fillText(cluster.label.toUpperCase(), cx, cy - 5);

    ctx.font = `400 9px "IBM Plex Mono", monospace`;
    ctx.fillStyle = `rgba(${COLOR_DIM}, 0.85)`;
    ctx.fillText(`${n} ARTICLES — CLICK TO EXPAND`, cx, cy + 10);

    if (isHover) {
      const preview = cluster.members
        .slice(0, 3)
        .map((m) => m.title.toLowerCase())
        .join(" · ");
      const more = n > 3 ? ` +${n - 3} more` : "";
      ctx.font = `400 8px "IBM Plex Mono", monospace`;
      ctx.fillStyle = `rgba(${COLOR_DIM}, 0.9)`;
      ctx.fillText(preview + more, cx, cy + r + 15);
    }

    ctx.restore();
  }

  // Structural relationship — a real shared Wikipedia category. Drawn in
  // neutral tone: the single accent color is reserved for live signal
  // (pulses, hot nodes, event links), never for static topology.
  _drawTopicLink(link) {
    const { ctx } = this;
    const { a, b } = link;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = `rgba(${COLOR_FG_RGB}, 0.1)`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  _drawGrid() {
    const { ctx, width, height } = this;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.025)";
    ctx.lineWidth = 1;
    const step = 64;
    for (let x = step; x < width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }
    for (let y = step; y < height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawRing(ring) {
    const { ctx } = this;
    const { node, age, strength } = ring;
    const t = age / 0.9;
    if (t >= 1) return;
    const r = node.radius + 4 + t * 46 * (0.5 + strength);
    const alpha = (1 - t) * 0.55 * strength;
    ctx.save();
    ctx.beginPath();
    ctx.arc(node.x, node.y, Math.max(r, 0), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${COLOR_ACCENT}, ${alpha})`;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }

  _drawLink(link) {
    const { ctx } = this;
    const { a, b, age, life } = link;
    const t = age / life;
    if (t >= 1) return;

    // fades in fast, lingers, fades out — a signal arriving then settling
    const envelope = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
    const alpha = Math.max(0, envelope) * 0.3;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = `rgba(${COLOR_ACCENT}, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // traveling pulse marking the moment of connection
    const travel = Math.min(1, age / 0.7);
    if (travel < 1) {
      const px = a.x + (b.x - a.x) * travel;
      const py = a.y + (b.y - a.y) * travel;
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${COLOR_ACCENT}, ${0.85 * (1 - travel * 0.3)})`;
      ctx.fill();
    }
    ctx.restore();
  }

  _drawNode(node) {
    const { ctx } = this;
    const isHover = this.hoverNode === node;
    const heatGlow = node.heat;

    ctx.save();

    // glow for hot / large nodes
    if (heatGlow > 0.05 || node.radius > 10) {
      const glowR = node.radius * (2.2 + heatGlow * 1.6);
      const grad = ctx.createRadialGradient(
        node.x,
        node.y,
        0,
        node.x,
        node.y,
        glowR
      );
      const glowAlpha = Math.min(0.22, heatGlow * 0.28 + node.mass * 0.06);
      grad.addColorStop(0, `rgba(${COLOR_ACCENT}, ${glowAlpha})`);
      grad.addColorStop(1, `rgba(${COLOR_ACCENT}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

    // core dot
    const coreColor =
      heatGlow > 0.15
        ? `rgba(${COLOR_ACCENT}, ${node.opacity})`
        : `rgba(${COLOR_FG_RGB}, ${node.opacity})`;
    ctx.beginPath();
    ctx.arc(node.x, node.y, Math.max(node.radius, 1.4), 0, Math.PI * 2);
    ctx.fillStyle = coreColor;
    ctx.fill();

    if (isHover) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 5, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${COLOR_ACCENT}, 0.8)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // label — only for nodes with enough presence to earn a caption,
    // nodes anchoring a real cluster, or whichever node is hovered
    const showLabel = node.radius > 7 || node.heat > 0.35 || node.clustered || isHover;
    if (showLabel) {
      // cluster anchors (well-connected within their topic) read slightly
      // larger and brighter — a visual center of gravity, not just a dot
      const degreeBoost = Math.min(2.5, (node.topicDegree || 0) * 0.5);
      const fontSize = isHover ? 11 : 9 + Math.min(3, node.mass * 3) + degreeBoost * 0.4;
      ctx.font = `500 ${fontSize}px "IBM Plex Mono", monospace`;
      ctx.textBaseline = "middle";
      const labelAlpha = isHover
        ? 1
        : Math.min(1, node.opacity + 0.25 + (node.clustered ? 0.15 : 0));
      ctx.fillStyle = `rgba(${COLOR_DIM}, ${labelAlpha})`;
      if (isHover) ctx.fillStyle = `rgba(${COLOR_FG_RGB}, ${labelAlpha})`;
      const label = node.title.length > 34 ? node.title.slice(0, 33) + "…" : node.title;
      ctx.fillText(label.toLowerCase(), node.x + node.radius + 7, node.y);
    }

    ctx.restore();
  }

  hitTest(x, y, nodes) {
    let closest = null;
    let closestDist = Infinity;
    for (const node of nodes) {
      const d = Math.hypot(node.x - x, node.y - y);
      const r = Math.max(node.radius, 6) + 4;
      if (d <= r && d < closestDist) {
        closest = node;
        closestDist = d;
      }
    }
    return closest;
  }

  // Only clusters large enough to be collapsible respond to hover/click —
  // a bare halo on a 3-member cluster is informational only, not a control.
  hitTestCluster(x, y, clusters) {
    let closest = null;
    let closestDist = Infinity;
    for (const cluster of clusters) {
      if (!cluster.collapsible) continue;
      const { cx, cy, maxR } = this._clusterCentroid(cluster);
      const testR = cluster.collapsed
        ? this._clusterShapeRadius(cluster.members.length) + 6
        : maxR + 36;
      const d = Math.hypot(cx - x, cy - y);
      if (d <= testR && d < closestDist) {
        closest = cluster;
        closestDist = d;
      }
    }
    return closest;
  }
}
