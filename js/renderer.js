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

    const nodes = store.getNodes();
    const rings = store.getRings();
    const links = store.getLinks();

    for (const link of links) this._drawLink(link);
    for (const ring of rings) this._drawRing(ring);

    // sort so larger / hotter nodes paint last (on top)
    nodes.sort((a, b) => a.mass + a.heat - (b.mass + b.heat));
    for (const node of nodes) this._drawNode(node);

    return nodes;
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
    // or whichever node is currently hovered
    const showLabel = node.radius > 7 || node.heat > 0.35 || isHover;
    if (showLabel) {
      const fontSize = isHover ? 11 : 9 + Math.min(3, node.mass * 3);
      ctx.font = `500 ${fontSize}px "IBM Plex Mono", monospace`;
      ctx.textBaseline = "middle";
      const labelAlpha = isHover ? 1 : Math.min(1, node.opacity + 0.25);
      ctx.fillStyle = `rgba(${COLOR_DIM}, ${labelAlpha})`;
      if (isHover) ctx.fillStyle = `rgba(243, 237, 224, ${labelAlpha})`;
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
}
