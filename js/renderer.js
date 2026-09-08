// Visual Mapping + Renderer.
// Draw layer — takes a store snapshot and paints it, and asks the store
// (read-only) for the short context-summary text to show on hover. No
// simulation or state-mutation logic lives here.

import { clusterShapeRadius, convexHull } from "./geometry.js";
import { GROUPS } from "./groups.js";
import { getCachedImage } from "./previewService.js";

const COLOR_BG = "#f7f6f2";
const COLOR_FG_RGB = "22, 21, 16"; // near-black ink, on the light field background
const COLOR_ACCENT = "184, 84, 6"; // rgb triplet for accent, used with alpha — 4.5:1 on the light field bg
const COLOR_DIM = "96, 94, 87";
// The hover summary panel is deliberately inverted (dark plate, light ink)
// rather than matching the field's own light theme — a common, legible
// callout convention that makes it pop against a busy light field instead
// of blending in.
const COLOR_PANEL_BG = "20, 19, 16";
const COLOR_PANEL_INK = "250, 248, 244";
const COLOR_PANEL_INK_DIM = "198, 195, 188";
// A node's group color desaturates toward gray over this many seconds
// (an exponential decay constant, not a hard cutoff) — see _drawNode.
const AGE_SATURATION_TAU = 40;
const MIN_SATURATION = 0.12; // floor so a very old node still faintly reads its hue

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

    // an expanded cluster's real boundary (not a glow) — drawn first so
    // everything else layers on top of it
    for (const cluster of clusters) {
      if (!cluster.collapsed && cluster.members.length >= 3) this._drawClusterBoundary(cluster, dim);
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

  // The true extent of an expanded cluster's current scatter — unlike
  // clusterHaloRadius (a small fixed size tied to the collapsed shape),
  // this tracks wherever the members actually are, since the boundary
  // drawn below needs to honestly enclose them, however far apart.
  _clusterExtent(cluster) {
    const { cx, cy } = this._clusterCentroid(cluster);
    let maxR = 40;
    for (const m of cluster.members) {
      const d = Math.hypot(m.x - cx, m.y - cy) + m.radius;
      if (d > maxR) maxR = d;
    }
    return { cx, cy, maxR };
  }

  // A clean, non-glowing boundary around an expanded cluster's actual
  // member positions (a convex hull, inflated outward a little past each
  // node), so membership stays legible without a fading halo — the
  // dots don't just get lost in the rest of the field once they've
  // burst apart.
  _drawClusterBoundary(cluster, dim = 1) {
    const members = cluster.members;
    if (members.length < 3) return;
    const { ctx } = this;
    const { cx, cy } = this._clusterCentroid(cluster);
    const hull = convexHull(members.map((m) => ({ x: m.x, y: m.y, r: m.radius })));
    if (hull.length < 3) return;

    ctx.save();
    ctx.beginPath();
    hull.forEach((p, i) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const pad = (p.r || 8) + 14;
      const ox = p.x + (dx / d) * pad;
      const oy = p.y + (dy / d) * pad;
      if (i === 0) ctx.moveTo(ox, oy);
      else ctx.lineTo(ox, oy);
    });
    ctx.closePath();
    ctx.strokeStyle = `rgba(${COLOR_FG_RGB}, ${0.22 * dim})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.restore();
  }

  _drawClusterLabel(cluster, dim = 1) {
    if (cluster.members.length < 3) return;
    const { ctx } = this;
    const { cx, cy, maxR } = this._clusterExtent(cluster);
    const r = maxR + 14;
    const isHover = this.hoverCluster === cluster;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `500 11px "IBM Plex Mono", monospace`;
    ctx.fillStyle = `rgba(${COLOR_FG_RGB}, ${(isHover ? 0.85 : 0.6) * dim})`;
    ctx.fillText(cluster.label.toUpperCase(), cx, cy - r - 15);
    ctx.font = `400 8px "IBM Plex Mono", monospace`;
    ctx.fillStyle = `rgba(${COLOR_DIM}, ${0.7 * dim})`;
    const hint = cluster.collapsible
      ? `${cluster.members.length} ARTICLES — CLICK TO COLLAPSE`
      : `${cluster.members.length} ARTICLES`;
    ctx.fillText(hint, cx, cy - r - 3);
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
    const lines = [
      { text: node.title, kind: "title" },
      { text: store.describeNode(node), kind: "body" },
    ];
    // a small live preview of the actual Wikipedia page — the same
    // extract + thumbnail Wikipedia's own "Page Previews" hovercards use,
    // fetched on hover with a short dwell (see main.js) and cached on the
    // node once resolved; absent until then, never blocking the rest of
    // the panel from showing immediately
    const preview = node.preview;
    let thumbnailImg = null;
    if (preview && preview.extract) {
      const extract =
        preview.extract.length > 210 ? preview.extract.slice(0, 207) + "…" : preview.extract;
      lines.push({ text: extract, kind: "extract" });
      if (preview.thumbnailUrl) thumbnailImg = getCachedImage(preview.thumbnailUrl);
    }
    this._drawSummaryBox(node.x, node.y + node.radius + 22, lines, true, thumbnailImg);
  }

  _drawClusterSummary(store, cluster) {
    const extent = cluster.collapsed
      ? { ...this._clusterCentroid(cluster), maxR: clusterShapeRadius(cluster.members.length) }
      : this._clusterExtent(cluster);
    const { cx, cy, maxR: r } = extent;
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
  // not small text floating loose over whatever's behind it. An optional
  // thumbnail (node hover only, once its preview has loaded) switches the
  // layout to a left-aligned image+text card instead of the plain
  // centered text block cluster/tie summaries use.
  _drawSummaryBox(anchorX, anchorY, lines, anchorBelow, thumbnailImg = null) {
    const { ctx, width, height } = this;
    ctx.save();

    const hasImage = !!thumbnailImg;
    const imageSize = 54;
    const imageGap = 12;
    const padX = 16;
    const padY = 14;
    const maxTextWidth = Math.min(hasImage ? 300 : 360, width - 56 - (hasImage ? imageSize + imageGap : 0));
    const lineHeight = { title: 21, body: 17, meta: 15, extract: 16 };
    const font = {
      title: `600 15px "IBM Plex Mono", monospace`,
      body: `400 13px "IBM Plex Mono", monospace`,
      meta: `400 11px "IBM Plex Mono", monospace`,
      extract: `400 11.5px "IBM Plex Mono", monospace`,
    };
    const color = {
      title: `rgba(${COLOR_PANEL_INK}, 1)`,
      body: `rgba(${COLOR_PANEL_INK}, 0.9)`,
      meta: `rgba(${COLOR_PANEL_INK_DIM}, 0.95)`,
      extract: `rgba(${COLOR_PANEL_INK_DIM}, 1)`,
    };

    ctx.textAlign = hasImage ? "left" : "center";

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

    const textBlockHeight = rows.reduce((s, r) => s + lineHeight[r.kind], 0);
    const contentWidth = hasImage ? imageSize + imageGap + blockWidth : blockWidth;
    const contentHeight = hasImage ? Math.max(imageSize, textBlockHeight) : textBlockHeight;
    const boxWidth = contentWidth + padX * 2;
    const boxHeight = contentHeight + padY * 2;

    const boxCenterX = Math.max(boxWidth / 2 + 10, Math.min(width - boxWidth / 2 - 10, anchorX));
    let boxTop = anchorBelow ? anchorY : anchorY - boxHeight;
    boxTop = Math.max(8, Math.min(height - boxHeight - 8, boxTop));
    const boxLeft = boxCenterX - boxWidth / 2;

    ctx.fillStyle = `rgba(${COLOR_PANEL_BG}, 0.94)`;
    ctx.fillRect(boxLeft, boxTop, boxWidth, boxHeight);
    ctx.strokeStyle = `rgba(${COLOR_PANEL_INK}, 0.14)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(boxLeft + 0.5, boxTop + 0.5, boxWidth - 1, boxHeight - 1);

    let textX = boxCenterX;
    let textStartY = boxTop + padY;
    if (hasImage) {
      const imgX = boxLeft + padX;
      const imgY = boxTop + (boxHeight - imageSize) / 2;
      drawCoverImage(ctx, thumbnailImg, imgX, imgY, imageSize);
      textX = imgX + imageSize + imageGap;
      textStartY = boxTop + (boxHeight - textBlockHeight) / 2;
    }

    ctx.textBaseline = "top";
    let y = textStartY;
    for (const row of rows) {
      ctx.font = font[row.kind];
      ctx.fillStyle = color[row.kind];
      ctx.fillText(row.text, textX, y);
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
    ctx.strokeStyle = "rgba(0,0,0,0.045)";
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

    // identity color (which high-level group the article belongs to),
    // vivid when the node is new and slowly desaturating toward a muted
    // version of the same hue over its lifetime — fresh attention reads as
    // saturated, old attention as faded, independent of whatever's
    // currently happening to it. A live edit still nudges the color
    // slightly toward the accent, but only slightly — a new node's own
    // group color is the identity, not an immediate wash of orange.
    const groupRgb = (GROUPS[node.group] || GROUPS.OTHER).color;
    const ageSeconds = Math.max(0, (performance.now() - (node.createdAt || 0)) / 1000);
    const freshness = Math.exp(-ageSeconds / AGE_SATURATION_TAU);
    const saturation = MIN_SATURATION + (1 - MIN_SATURATION) * freshness;
    const agedRgb = saturation < 1 ? mixToGray(groupRgb, saturation) : groupRgb;
    const heatT = isFocus ? 1 : Math.min(0.4, heatGlow * 0.5);
    const coreRgb = heatT > 0 ? mixRgb(agedRgb, COLOR_ACCENT, heatT) : agedRgb;

    ctx.save();

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
  // a bare boundary on a 3-member cluster is informational only, not a
  // control.
  hitTestCluster(x, y, clusters) {
    let closest = null;
    let closestDist = Infinity;
    for (const cluster of clusters) {
      if (!cluster.collapsible) continue;
      let cx, cy, testR;
      if (cluster.collapsed) {
        ({ cx, cy } = this._clusterCentroid(cluster));
        testR = clusterShapeRadius(cluster.members.length) + 16;
      } else {
        ({ cx, cy, maxR: testR } = this._clusterExtent(cluster));
      }
      const d = Math.hypot(cx - x, cy - y);
      if (d <= testR && d < closestDist) {
        closest = cluster;
        closestDist = d;
      }
    }
    return closest;
  }

  // "Click outside to dismiss": true if the point falls within any
  // currently expanded cluster's boundary — used so a click elsewhere in
  // the field, but not a click among an expanded cluster's own members,
  // is what re-collapses it.
  isInsideExpandedCluster(x, y, clusters) {
    for (const cluster of clusters) {
      if (!cluster.expanded) continue;
      const { cx, cy, maxR } = this._clusterExtent(cluster);
      if (Math.hypot(cx - x, cy - y) <= maxR) return true;
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

// Draws img center-cropped to fill a size x size square at (x, y) —
// "object-fit: cover" for canvas, since a Wikipedia thumbnail's aspect
// ratio is whatever the source image happened to be.
function drawCoverImage(ctx, img, x, y, size) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const scale = Math.max(size / iw, size / ih);
  const sw = size / scale;
  const sh = size / scale;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, size, size);
}

// Blends an "r, g, b" string toward its own perceived-luminance gray by
// (1 - saturation) — true desaturation (fades toward gray, not toward a
// different hue), used for a node's age-based color fade.
function mixToGray(rgb, saturation) {
  const [r, g, b] = rgb.split(",").map(Number);
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  const mix = (c) => Math.round(gray + (c - gray) * saturation);
  return `${mix(r)}, ${mix(g)}, ${mix(b)}`;
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
