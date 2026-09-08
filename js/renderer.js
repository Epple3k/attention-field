// Visual Mapping + Renderer.
// Draw layer — takes a store snapshot and paints it, and asks the store
// (read-only) for the short context-summary text to show on hover. No
// simulation or state-mutation logic lives here.

import { clusterShapeRadius, clusterHaloRadius } from "./geometry.js";
import { GROUPS } from "./groups.js";

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
    this.hoverTie = null; // { tie, kind: "topic" | "event" }
    this.dragNode = null;
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
    this.hiddenNodes = hidden;
    const nodes = allNodes.filter((n) => !hidden.has(n));

    // an active tie (hovered or pinned open) puts the field in a small
    // focus mode: its own line and both endpoints stay full-strength,
    // everything else dims slightly so the relationship reads clearly
    const active = this.hoverTie;
    const dim = active ? 0.32 : 1;
    const isFocusNode = (n) => active && (n === active.tie.a || n === active.tie.b);
    const isFocusLink = (l) => active && l === active.tie;

    this._drawAmbientGlow(energy);
    for (const cluster of clusters) {
      if (!cluster.collapsed && cluster.members.length >= 3) this._drawClusterHalo(cluster, dim);
    }
    for (const tl of topicLinks) {
      if (hidden.has(tl.a) || hidden.has(tl.b)) continue;
      this._drawTopicLink(tl, isFocusLink(tl) ? 1 : dim, isFocusLink(tl));
    }
    for (const link of links) {
      if (hidden.has(link.a) || hidden.has(link.b)) continue;
      this._drawLink(link, isFocusLink(link) ? 1 : dim, isFocusLink(link));
    }
    for (const ring of rings) {
      if (hidden.has(ring.node)) continue;
      this._drawRing(ring, dim);
    }

    // sort so larger / hotter nodes paint last (on top)
    nodes.sort((a, b) => a.mass + a.heat - (b.mass + b.heat));
    for (const node of nodes) {
      this._drawNode(node, isFocusNode(node) ? 1 : dim, isFocusNode(node));
    }

    for (const cluster of clusters) {
      if (cluster.collapsed) this._drawClusterShape(cluster, dim);
      else if (cluster.members.length >= 3) this._drawClusterLabel(cluster, dim);
    }

    if (active) this._drawTieSummary(store, active);
    else if (this.hoverCluster) this._drawClusterSummary(store, this.hoverCluster);
    else if (this.hoverNode && !this.dragNode) this._drawNodeSummary(store, this.hoverNode);

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
    return { cx, cy };
  }

  // Halo radius is the summary shape's own radius plus a small fixed pad —
  // not a multiplier over how far apart the (possibly widely expanded)
  // members happen to be scattered. Keeps it reading as a subtle region
  // around the node rather than a giant circular territory.
  _drawClusterHalo(cluster, dim = 1) {
    if (cluster.members.length < 3) return;
    const { ctx } = this;
    const { cx, cy } = this._clusterCentroid(cluster);
    const r = clusterHaloRadius(cluster.members.length);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(${COLOR_FG_RGB}, ${0.06 * dim})`);
    grad.addColorStop(1, `rgba(${COLOR_FG_RGB}, 0)`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawClusterLabel(cluster, dim = 1) {
    if (cluster.members.length < 3) return;
    const { ctx } = this;
    const { cx, cy } = this._clusterCentroid(cluster);
    const r = clusterHaloRadius(cluster.members.length);
    const isHover = this.hoverCluster === cluster;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `500 11px "IBM Plex Mono", monospace`;
    ctx.fillStyle = `rgba(${COLOR_FG_RGB}, ${(isHover ? 0.85 : 0.55) * dim})`;
    ctx.fillText(cluster.label.toUpperCase(), cx, cy - r - 15);
    ctx.font = `400 8px "IBM Plex Mono", monospace`;
    ctx.fillStyle = `rgba(${COLOR_DIM}, ${0.65 * dim})`;
    const hint = cluster.collapsible
      ? `${cluster.members.length} ARTICLES — CLICK TO COLLAPSE`
      : `${cluster.members.length} ARTICLES`;
    ctx.fillText(hint, cx, cy - r - 3);
    if (isHover && cluster.collapsible) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${COLOR_ACCENT}, 0.35)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  // A collapsed cluster stops being several dots and becomes one object: a
  // regular polygon whose side count equals its member count (literally
  // "made of N things"), rotating slowly, that brightens with the members'
  // aggregate live activity — a real aggregated pulse, not decoration.
  _drawClusterShape(cluster, dim = 1) {
    const { ctx } = this;
    const { cx, cy } = this._clusterCentroid(cluster);
    const n = cluster.members.length;
    const sides = Math.max(3, Math.min(12, n));
    const heat = cluster.members.reduce((s, m) => s + m.heat, 0) / n;
    const isHover = this.hoverCluster === cluster;
    // hover "lifts" the shape slightly larger, on top of its normal size —
    // meant to be an unmistakable response, not a subtle tint shift
    const r = clusterShapeRadius(n) * (isHover ? 1.12 : 1);
    const rotation = (performance.now() / 1000) * (0.06 + heat * 0.5);

    ctx.save();

    if (isHover) {
      ctx.beginPath();
      ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${COLOR_ACCENT}, 0.55)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

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
    const fillAlpha = (0.05 + heat * 0.1 + (isHover ? 0.08 : 0)) * dim;
    ctx.fillStyle = `rgba(${hotColor ? COLOR_ACCENT : COLOR_FG_RGB}, ${fillAlpha})`;
    ctx.fill();

    ctx.strokeStyle = `rgba(${hotColor ? COLOR_ACCENT : COLOR_FG_RGB}, ${(isHover ? 1 : 0.4 + heat * 0.4) * dim})`;
    ctx.lineWidth = isHover ? 1.8 : 1.1;
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${isHover ? 13 : 12}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = `rgba(${COLOR_FG_RGB}, ${(isHover ? 1 : 0.9) * dim})`;
    ctx.fillText(cluster.label.toUpperCase(), cx, cy - 5);

    ctx.font = `400 9px "IBM Plex Mono", monospace`;
    ctx.fillStyle = isHover ? `rgba(${COLOR_ACCENT}, 0.95)` : `rgba(${COLOR_DIM}, ${0.85 * dim})`;
    ctx.fillText(`${n} ARTICLES — CLICK TO EXPAND`, cx, cy + 10);

    ctx.restore();
  }

  _drawNodeSummary(store, node) {
    this._drawSummaryBox(
      node.x,
      node.y + node.radius + 22,
      [
        { text: node.title, kind: "title" },
        { text: store.describeNode(node), kind: "body" },
      ],
      true
    );
  }

  _drawClusterSummary(store, cluster) {
    const { cx, cy } = this._clusterCentroid(cluster);
    const r = cluster.collapsed ? clusterShapeRadius(cluster.members.length) : clusterHaloRadius(cluster.members.length);
    const preview = cluster.members
      .slice(0, 3)
      .map((m) => m.title.toLowerCase())
      .join(" · ");
    const more = cluster.members.length > 3 ? ` +${cluster.members.length - 3} more` : "";
    this._drawSummaryBox(
      cx,
      cy + r + 26,
      [
        { text: store.describeCluster(cluster), kind: "body" },
        { text: preview + more, kind: "meta" },
      ],
      true
    );
  }

  _drawTieSummary(store, active) {
    const { tie, kind } = active;
    const mx = (tie.a.x + tie.b.x) / 2;
    const my = (tie.a.y + tie.b.y) / 2;
    this._drawSummaryBox(
      mx,
      my - 22,
      [
        { text: kind === "topic" ? "TOPIC TIE" : "EVENT TIE", kind: "title" },
        { text: store.describeTie(tie, kind), kind: "body" },
      ],
      false
    );
  }

  // Canvas-drawn context-summary panel — the one place this text renders,
  // so a node's, a cluster's, and a tie's hover panel all look and behave
  // the same way: a real backing plate behind large, high-contrast type,
  // not small text floating loose over whatever's behind it.
  _drawSummaryBox(anchorX, anchorY, lines, anchorBelow) {
    const { ctx, width, height } = this;
    ctx.save();
    ctx.textAlign = "center";

    const maxTextWidth = Math.min(360, width - 56);
    const padX = 16;
    const padY = 12;
    const lineHeight = { title: 21, body: 17, meta: 15 };
    const font = {
      title: `600 15px "IBM Plex Mono", monospace`,
      body: `400 13px "IBM Plex Mono", monospace`,
      meta: `400 11px "IBM Plex Mono", monospace`,
    };
    const color = {
      title: `rgba(${COLOR_FG_RGB}, 1)`,
      body: `rgba(${COLOR_FG_RGB}, 0.88)`,
      meta: `rgba(${COLOR_DIM}, 0.95)`,
    };

    // first pass: wrap and measure every line so the backing panel can be
    // sized to fit before anything is drawn
    const rows = [];
    let blockWidth = 0;
    for (const { text, kind } of lines) {
      if (!text) continue;
      ctx.font = font[kind];
      for (const wrapped of this._wrapText(ctx, text, maxTextWidth)) {
        blockWidth = Math.max(blockWidth, ctx.measureText(wrapped).width);
        rows.push({ text: wrapped, kind });
      }
    }
    if (!rows.length) {
      ctx.restore();
      return;
    }

    const blockHeight = rows.reduce((s, r) => s + lineHeight[r.kind], 0);
    const boxWidth = blockWidth + padX * 2;
    const boxHeight = blockHeight + padY * 2;

    const boxCenterX = Math.max(boxWidth / 2 + 10, Math.min(width - boxWidth / 2 - 10, anchorX));
    let boxTop = anchorBelow ? anchorY : anchorY - boxHeight;
    boxTop = Math.max(8, Math.min(height - boxHeight - 8, boxTop));
    const boxLeft = boxCenterX - boxWidth / 2;

    ctx.fillStyle = "rgba(8, 8, 7, 0.92)";
    ctx.fillRect(boxLeft, boxTop, boxWidth, boxHeight);
    ctx.strokeStyle = `rgba(${COLOR_FG_RGB}, 0.16)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(boxLeft + 0.5, boxTop + 0.5, boxWidth - 1, boxHeight - 1);

    ctx.textBaseline = "top";
    let y = boxTop + padY;
    for (const row of rows) {
      ctx.font = font[row.kind];
      ctx.fillStyle = color[row.kind];
      ctx.fillText(row.text, boxCenterX, y);
      y += lineHeight[row.kind];
    }

    ctx.restore();
  }

  _wrapText(ctx, text, maxWidth) {
    const words = text.split(" ");
    const lines = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(test).width > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // Structural relationship — a real shared Wikipedia category. Drawn in
  // neutral tone: the single accent color is reserved for live signal
  // (pulses, hot nodes, event ties), never for static topology — except
  // when the tie itself is the thing being pointed at.
  _drawTopicLink(link, dim = 1, isActive = false) {
    const { ctx } = this;
    const { a, b } = link;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = isActive ? `rgba(${COLOR_ACCENT}, 0.85)` : `rgba(${COLOR_FG_RGB}, ${0.1 * dim})`;
    ctx.lineWidth = isActive ? 2 : 1;
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

  _drawRing(ring, dim = 1) {
    const { ctx } = this;
    const { node, age, strength } = ring;
    const t = age / 0.9;
    if (t >= 1) return;
    const r = node.radius + 4 + t * 46 * (0.5 + strength);
    const alpha = (1 - t) * 0.55 * strength * dim;
    ctx.save();
    ctx.beginPath();
    ctx.arc(node.x, node.y, Math.max(r, 0), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${COLOR_ACCENT}, ${alpha})`;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }

  _drawLink(link, dim = 1, isActive = false) {
    const { ctx } = this;
    const { a, b, age, life } = link;
    const t = age / life;
    if (t >= 1) return;

    // fades in fast, lingers, fades out — a signal arriving then settling
    const envelope = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
    const alpha = Math.max(0, envelope) * 0.3 * dim;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = isActive ? `rgba(${COLOR_ACCENT}, 0.9)` : `rgba(${COLOR_ACCENT}, ${alpha})`;
    ctx.lineWidth = isActive ? 2 : 1;
    ctx.stroke();

    // traveling pulse marking the moment of connection
    const travel = Math.min(1, age / 0.7);
    if (travel < 1) {
      const px = a.x + (b.x - a.x) * travel;
      const py = a.y + (b.y - a.y) * travel;
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${COLOR_ACCENT}, ${0.85 * (1 - travel * 0.3) * dim})`;
      ctx.fill();
    }
    ctx.restore();
  }

  _drawNode(node, dim = 1, isFocus = false) {
    const { ctx } = this;
    const isHover = this.hoverNode === node;
    const isDrag = this.dragNode === node;
    const heatGlow = node.heat;

    // identity color (which high-level group the article belongs to) at
    // rest, blending toward the accent as the node heats up with live
    // activity — hue says "what kind of topic," the accent shift says
    // "something is happening here right now"
    const groupRgb = (GROUPS[node.group] || GROUPS.OTHER).color;
    const heatT = isFocus ? 1 : Math.min(1, heatGlow / 0.35);
    const coreRgb = heatT > 0 ? mixRgb(groupRgb, COLOR_ACCENT, heatT) : groupRgb;

    ctx.save();

    // glow for hot / large nodes, tinted the same way as the core
    if (heatGlow > 0.05 || node.radius > 10) {
      const glowR = node.radius * (2.2 + heatGlow * 1.6);
      const grad = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowR);
      const glowAlpha = Math.min(0.22, heatGlow * 0.28 + node.mass * 0.06) * dim;
      grad.addColorStop(0, `rgba(${coreRgb}, ${glowAlpha})`);
      grad.addColorStop(1, `rgba(${coreRgb}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

    // core dot
    const opacity = node.opacity * dim;
    ctx.beginPath();
    ctx.arc(node.x, node.y, Math.max(node.radius, 1.4), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${coreRgb}, ${opacity})`;
    ctx.fill();

    if (isDrag) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 7, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${COLOR_ACCENT}, 0.95)`;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    } else if (isHover || isFocus) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 5, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${COLOR_ACCENT}, 0.8)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // label — only for nodes with enough presence to earn a caption,
    // nodes anchoring a real cluster, or whichever node is hovered/focused
    const showLabel = node.radius > 7 || node.heat > 0.35 || node.clustered || isHover || isFocus;
    if (showLabel) {
      // cluster anchors (well-connected within their topic) read slightly
      // larger and brighter — a visual center of gravity, not just a dot
      const degreeBoost = Math.min(2.5, (node.topicDegree || 0) * 0.5);
      const fontSize = isHover ? 11 : 9 + Math.min(3, node.mass * 3) + degreeBoost * 0.4;
      ctx.font = `500 ${fontSize}px "IBM Plex Mono", monospace`;
      ctx.textBaseline = "middle";
      const labelAlpha =
        (isHover ? 1 : Math.min(1, node.opacity + 0.25 + (node.clustered ? 0.15 : 0))) * dim;
      ctx.fillStyle = `rgba(${COLOR_DIM}, ${labelAlpha})`;
      if (isHover || isFocus) ctx.fillStyle = `rgba(${COLOR_FG_RGB}, ${labelAlpha})`;
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

  // Point-to-segment distance hit test for association ties. Checks topic
  // ties first, then event ties; returns { tie, kind } or null. Ties need
  // their own hit target — they are not purely decorative geometry.
  hitTestTie(x, y, topicLinks, eventLinks, hidden) {
    const THRESHOLD = 7;
    let best = null;
    let bestDist = THRESHOLD;

    const scan = (list, kind) => {
      for (const tie of list) {
        if (hidden && (hidden.has(tie.a) || hidden.has(tie.b))) continue;
        const d = distanceToSegment(x, y, tie.a.x, tie.a.y, tie.b.x, tie.b.y);
        if (d < bestDist) {
          bestDist = d;
          best = { tie, kind };
        }
      }
    };
    scan(topicLinks, "topic");
    scan(eventLinks, "event");
    return best;
  }

  // Only clusters large enough to be collapsible respond to hover/click —
  // a bare halo on a 3-member cluster is informational only, not a control.
  hitTestCluster(x, y, clusters) {
    let closest = null;
    let closestDist = Infinity;
    for (const cluster of clusters) {
      if (!cluster.collapsible) continue;
      const { cx, cy } = this._clusterCentroid(cluster);
      const testR = cluster.collapsed
        ? clusterShapeRadius(cluster.members.length) + 16
        : clusterHaloRadius(cluster.members.length);
      const d = Math.hypot(cx - x, cy - y);
      if (d <= testR && d < closestDist) {
        closest = cluster;
        closestDist = d;
      }
    }
    return closest;
  }

  // "Click outside to dismiss": true if the point falls within any
  // currently expanded cluster's boundary (its halo region) — used so a
  // click elsewhere in the field, but not a click among an expanded
  // cluster's own members, is what re-collapses it.
  isInsideExpandedCluster(x, y, clusters) {
    for (const cluster of clusters) {
      if (!cluster.expanded) continue;
      const { cx, cy } = this._clusterCentroid(cluster);
      if (Math.hypot(cx - x, cy - y) <= clusterHaloRadius(cluster.members.length)) return true;
    }
    return false;
  }
}

// Linearly blends two "r, g, b" strings by t (0 = a, 1 = b).
function mixRgb(a, b, t) {
  const pa = a.split(",").map(Number);
  const pb = b.split(",").map(Number);
  const mixed = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return mixed.join(", ");
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
