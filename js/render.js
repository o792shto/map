// Canvas rendering: a crisp, hand-tinted antique-atlas style map. Terrain
// colors are baked once per simulation tick into a 1px-per-cell offscreen
// buffer and drawn without smoothing so terrain stays sharp. National
// territory is drawn separately as filled vector shapes: each nation's true
// cell-ownership boundary is traced into closed loops (a marching-squares-
// style contour extraction) and simplified to drop collinear points, but
// left otherwise unrounded — with states as the unit of ownership, borders
// already read as deliberate province edges, and heavy corner-rounding just
// made them harder to follow. A bold ink stroke keeps them legible at a
// glance. The fill exactly matches true ownership (holes stay real holes,
// no raster artifacts). A paper-grain overlay and screen-space nation name
// labels complete the look. Zoom & pan camera + click-to-select.

const BIOME_SHADE = {
  [BIOME.PLAINS]: 0,
  [BIOME.GRASSLAND]: 0,
  [BIOME.FOREST]: -8,
  [BIOME.MOUNTAIN]: -16,
  [BIOME.DESERT]: 6,
};

const TERRITORY_WASH_ALPHA = 0.5; // how strongly the nation tint covers the terrain beneath it
const CHAIKIN_ITERATIONS = 0; // borders trace the true state shape rather than being rounded away

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}

const BIOME_RGB = {};
for (const k of Object.keys(BIOME_INFO)) BIOME_RGB[k] = hexToRgb(BIOME_INFO[k].color);

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hh = h / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1) { r = c; g = x; } else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; } else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; } else { r = c; b = x; }
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function shadeNationColor(nation, biome) {
  if (!nation._hsl) {
    const m = nation.color.match(/hsl\(([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)/);
    nation._hsl = { h: parseFloat(m[1]), s: parseFloat(m[2]), l: parseFloat(m[3]) };
    nation._shadeRgbCache = {};
  }
  if (nation._shadeRgbCache[biome]) return nation._shadeRgbCache[biome];
  const { h, s, l } = nation._hsl;
  const nl = clamp(l + (BIOME_SHADE[biome] || 0), 10, 85);
  const rgb = hslToRgb(h, s, nl);
  nation._shadeRgbCache[biome] = rgb;
  return rgb;
}

// Rounds a closed polygon loop with Chaikin corner-cutting: replaces each
// vertex with two points 1/4 and 3/4 of the way along its edges, pulling
// the curve away from sharp pixel-step corners. Iterating a few times
// converges to a smooth, rounded outline while keeping the true topology.
function chaikinSmoothClosed(points, iterations) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const n = pts.length;
    if (n < 3) return pts;
    const next = new Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % n];
      next[i * 2] = { x: p0.x * 0.75 + p1.x * 0.25, y: p0.y * 0.75 + p1.y * 0.25 };
      next[i * 2 + 1] = { x: p0.x * 0.25 + p1.x * 0.75, y: p0.y * 0.25 + p1.y * 0.75 };
    }
    pts = next;
  }
  return pts;
}

// Drops vertices where the incoming and outgoing edge run in the same
// direction (a straight run of unit steps), so Chaikin smoothing only acts
// on real corners instead of re-processing hundreds of collinear points.
function simplifyCollinear(loop) {
  const n = loop.length;
  if (n < 3) return loop;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n], cur = loop[i], next = loop[(i + 1) % n];
    const dx1 = cur.x - prev.x, dy1 = cur.y - prev.y;
    const dx2 = next.x - cur.x, dy2 = next.y - cur.y;
    if (dx1 * dy2 - dy1 * dx2 !== 0) out.push(cur);
  }
  return out.length >= 3 ? out : loop;
}

// Chains directed unit boundary edges (each already oriented so the owning
// nation's cell sits on a fixed side) into closed loops. A vertex normally
// has exactly one unvisited outgoing edge; the rare diagonal-touch case
// (two blobs meeting at a single corner) just picks the first candidate,
// which is visually irrelevant once smoothed.
function traceLoops(edges) {
  const startIndex = new Map();
  edges.forEach((e, i) => {
    const k = e.x1 + ',' + e.y1;
    let arr = startIndex.get(k);
    if (!arr) { arr = []; startIndex.set(k, arr); }
    arr.push(i);
  });
  const consumed = new Uint8Array(edges.length);
  const loops = [];
  for (let i = 0; i < edges.length; i++) {
    if (consumed[i]) continue;
    const loop = [];
    const startX = edges[i].x1, startY = edges[i].y1;
    let curIdx = i;
    let guard = edges.length + 4;
    while (guard-- > 0) {
      const e = edges[curIdx];
      consumed[curIdx] = 1;
      loop.push({ x: e.x1, y: e.y1 });
      if (e.x2 === startX && e.y2 === startY) break;
      const candidates = startIndex.get(e.x2 + ',' + e.y2);
      let nextIdx = -1;
      if (candidates) {
        for (const ci of candidates) { if (!consumed[ci]) { nextIdx = ci; break; } }
      }
      if (nextIdx === -1) break;
      curIdx = nextIdx;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

class Renderer {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = sim;
    this.cellPx = 6;
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.dragging = false;
    this.lastMouse = null;
    this.showUnrest = true;
    this.showLabels = true;
    this.selectedNationId = null;
    this.pendingDirective = null; // {type: 'war'|'ally'|'peace'|'expand', sourceId} — drives target-candidate markers
    this.battleEffects = []; // {x, y, kind, start} — transient real-time flashes at recent battle/landing sites
    this.onCellClick = null;
    this._bufCanvas = null;
    this._bufCtx = null;
    this._bufDirtyTurn = -1;
    this._nationShapePaths = new Map(); // nationId -> Path2D (smoothed, filled + stroked)
    this._labelPositions = new Map(); // nationId -> {x, y} in cell-space
    this._grainPattern = this.buildGrainPattern();
    this.bindEvents();
    this.fitToScreen();
  }

  setSim(sim) {
    this.sim = sim;
    this.selectedNationId = null;
    this._bufDirtyTurn = -1;
    this._landTotalCache = null;
    this.battleEffects = [];
    this.fitToScreen();
  }

  // Called from outside (wired to Simulation's onBattleEffect) whenever a
  // battle or landing happens at a specific map location, x/y in cell coords.
  addBattleEffect(x, y, kind) {
    this.battleEffects.push({ x, y, kind, start: performance.now() });
  }

  minZoom() {
    const map = this.sim.map;
    const worldW = map.width * this.cellPx, worldH = map.height * this.cellPx;
    return Math.min(this.canvas.width / worldW, this.canvas.height / worldH) * 0.6;
  }

  fitToScreen() {
    const map = this.sim.map;
    const worldW = map.width * this.cellPx, worldH = map.height * this.cellPx;
    const scale = Math.min(this.canvas.width / worldW, this.canvas.height / worldH) * 0.95;
    this.camera.zoom = scale;
    this.camera.x = (this.canvas.width - worldW * scale) / 2;
    this.camera.y = (this.canvas.height - worldH * scale) / 2;
  }

  zoomAt(mx, my, factor) {
    const worldX = (mx - this.camera.x) / this.camera.zoom;
    const worldY = (my - this.camera.y) / this.camera.zoom;
    const newZoom = clamp(this.camera.zoom * factor, this.minZoom(), 14);
    this.camera.zoom = newZoom;
    this.camera.x = mx - worldX * newZoom;
    this.camera.y = my - worldY * newZoom;
  }

  screenToCell(mx, my) {
    const map = this.sim.map;
    const wx = (mx - this.camera.x) / this.camera.zoom;
    const wy = (my - this.camera.y) / this.camera.zoom;
    const cx = Math.floor(wx / this.cellPx), cy = Math.floor(wy / this.cellPx);
    if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return null;
    return map.idx(cx, cy);
  }

  bindEvents() {
    const canvas = this.canvas;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const my = (e.clientY - rect.top) * (canvas.height / rect.height);
      this.zoomAt(mx, my, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    canvas.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this._downPos = { x: e.clientX, y: e.clientY };
      this._moved = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
      const dx = (e.clientX - this.lastMouse.x) * scaleX;
      const dy = (e.clientY - this.lastMouse.y) * scaleY;
      this.camera.x += dx;
      this.camera.y += dy;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      if (this._downPos && Math.hypot(e.clientX - this._downPos.x, e.clientY - this._downPos.y) > 4) this._moved = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (this.dragging && !this._moved && this.onCellClick) {
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
        const my = (e.clientY - rect.top) * (canvas.height / rect.height);
        const cellIdx = this.screenToCell(mx, my);
        this.onCellClick(cellIdx);
      }
      this.dragging = false;
    });

    // touch support
    let lastTouchDist = null;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.dragging = true;
        this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this._downPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this._moved = false;
      } else if (e.touches.length === 2) {
        lastTouchDist = this.touchDist(e.touches);
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && this.dragging) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
        const dx = (e.touches[0].clientX - this.lastMouse.x) * scaleX;
        const dy = (e.touches[0].clientY - this.lastMouse.y) * scaleY;
        this.camera.x += dx;
        this.camera.y += dy;
        this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (this._downPos && Math.hypot(e.touches[0].clientX - this._downPos.x, e.touches[0].clientY - this._downPos.y) > 4) this._moved = true;
      } else if (e.touches.length === 2) {
        const d = this.touchDist(e.touches);
        if (lastTouchDist) {
          const rect = canvas.getBoundingClientRect();
          const mx = ((e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left) * (canvas.width / rect.width);
          const my = ((e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top) * (canvas.height / rect.height);
          this.zoomAt(mx, my, d / lastTouchDist);
        }
        lastTouchDist = d;
      }
    }, { passive: true });
    canvas.addEventListener('touchend', (e) => {
      if (this.dragging && !this._moved && this.onCellClick && this.lastMouse) {
        const rect = canvas.getBoundingClientRect();
        const mx = (this.lastMouse.x - rect.left) * (canvas.width / rect.width);
        const my = (this.lastMouse.y - rect.top) * (canvas.height / rect.height);
        this.onCellClick(this.screenToCell(mx, my));
      }
      this.dragging = false;
      lastTouchDist = null;
    });
  }

  touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  // A small tileable sepia noise pattern, drawn once and reused as a
  // constant-scale paper-grain overlay so the map reads like an aged sheet
  // regardless of zoom level.
  buildGrainPattern() {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const gctx = c.getContext('2d');
    const imgData = gctx.createImageData(size, size);
    const data = imgData.data;
    for (let i = 0; i < size * size; i++) {
      const p = i * 4;
      data[p] = 74; data[p + 1] = 58; data[p + 2] = 36;
      data[p + 3] = Math.floor(Math.random() * 34);
    }
    gctx.putImageData(imgData, 0, 0);
    return this.ctx.createPattern(c, 'repeat');
  }

  // Rebuilds the terrain pixel buffer, the smoothed per-nation territory
  // shapes and label anchor points. Cheap enough (one pass over the grid,
  // plus boundary-length-proportional loop tracing) to redo once per
  // simulation tick.
  buildBuffer() {
    const map = this.sim.map;
    if (!this._bufCanvas || this._bufCanvas.width !== map.width || this._bufCanvas.height !== map.height) {
      this._bufCanvas = document.createElement('canvas');
      this._bufCanvas.width = map.width;
      this._bufCanvas.height = map.height;
      this._bufCtx = this._bufCanvas.getContext('2d');
    }
    const imgData = this._bufCtx.createImageData(map.width, map.height);
    const data = imgData.data;
    const sim = this.sim;
    const centroidSum = new Map(); // nationId -> {sx, sy, n}
    const nationEdges = new Map(); // nationId -> [{x1,y1,x2,y2}, ...]
    const pushEdge = (nationId, x1, y1, x2, y2) => {
      let arr = nationEdges.get(nationId);
      if (!arr) { arr = []; nationEdges.set(nationId, arr); }
      arr.push({ x1, y1, x2, y2 });
    };

    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = map.idx(x, y);
        const owner = map.owner[i];
        const biome = map.biome[i];
        let [r, g, b] = BIOME_RGB[biome];

        if (owner !== -1) {
          let sum = centroidSum.get(owner);
          if (!sum) { sum = { sx: 0, sy: 0, n: 0 }; centroidSum.set(owner, sum); }
          sum.sx += x; sum.sy += y; sum.n++;

          // Emit boundary edges in a fixed per-cell winding order; edges
          // only appear where the neighbor differs, so shared internal
          // edges between same-owner cells cancel out automatically.
          if (y === 0 || map.owner[map.idx(x, y - 1)] !== owner) pushEdge(owner, x, y, x + 1, y);
          if (x === map.width - 1 || map.owner[map.idx(x + 1, y)] !== owner) pushEdge(owner, x + 1, y, x + 1, y + 1);
          if (y === map.height - 1 || map.owner[map.idx(x, y + 1)] !== owner) pushEdge(owner, x + 1, y + 1, x, y + 1);
          if (x === 0 || map.owner[map.idx(x - 1, y)] !== owner) pushEdge(owner, x, y + 1, x, y);
        }

        if (this.showUnrest && owner !== -1) {
          const u = map.unrest[i];
          if (u > 40) {
            const a = clamp((u - 40) / 60, 0, 0.45);
            r = r * (1 - a) + 150 * a;
            g = g * (1 - a) + 32 * a;
            b = b * (1 - a) + 24 * a;
          }
        }
        const p = i * 4;
        data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
      }
    }
    this._bufCtx.putImageData(imgData, 0, 0);
    this._bufDirtyTurn = sim.turn;

    this._labelPositions = new Map();
    for (const [nationId, sum] of centroidSum) {
      this._labelPositions.set(nationId, { x: sum.sx / sum.n, y: sum.sy / sum.n, size: sum.n });
    }

    this.buildNationShapes(nationEdges);
  }

  buildNationShapes(nationEdges) {
    const cellPx = this.cellPx;
    const shapes = new Map();
    for (const [nationId, edges] of nationEdges) {
      const loops = traceLoops(edges);
      const path = new Path2D();
      for (const loop of loops) {
        const simplified = simplifyCollinear(loop);
        if (simplified.length < 3) continue;
        const smoothed = chaikinSmoothClosed(simplified, CHAIKIN_ITERATIONS);
        path.moveTo(smoothed[0].x * cellPx, smoothed[0].y * cellPx);
        for (let i = 1; i < smoothed.length; i++) path.lineTo(smoothed[i].x * cellPx, smoothed[i].y * cellPx);
        path.closePath();
      }
      shapes.set(nationId, path);
    }
    this._nationShapePaths = shapes;
  }

  // Labels are sized with a gentler, tightly-capped curve (so a handful of
  // huge late-game nations don't produce comically oversized text) and
  // placed largest-first with simple bounding-box collision skipping so
  // neighboring names don't pile up on top of each other.
  drawLabels() {
    const { ctx, sim, canvas } = this;
    const landTotal = this._landTotalCache || (this._landTotalCache = (() => {
      let c = 0;
      for (let i = 0; i < sim.map.biome.length; i++) if (BIOME_INFO[sim.map.biome[i]].passable) c++;
      return c;
    })());
    const candidates = [];
    for (const nation of sim.nations) {
      if (!nation.alive) continue;
      const pos = this._labelPositions.get(nation.id);
      if (!pos || pos.size < 3) continue;
      const sx = pos.x * this.cellPx * this.camera.zoom + this.camera.x;
      const sy = pos.y * this.cellPx * this.camera.zoom + this.camera.y;
      if (sx < -80 || sy < -30 || sx > canvas.width + 80 || sy > canvas.height + 30) continue;
      const share = pos.size / landTotal;
      const fontSize = clamp(10 + share * 34, 10, 19);
      candidates.push({ nation, sx, sy, fontSize, size: pos.size });
    }
    candidates.sort((a, b) => b.size - a.size); // larger nations get label placement priority

    const placed = [];
    for (const c of candidates) {
      ctx.font = `600 ${c.fontSize.toFixed(1)}px "Cinzel", "Yu Mincho", serif`;
      const textWidth = ctx.measureText(c.nation.name).width;
      const textHeight = c.fontSize * 1.15;
      const box = {
        x0: c.sx - textWidth / 2, x1: c.sx + textWidth / 2,
        y0: c.sy - textHeight / 2, y1: c.sy + textHeight / 2,
      };
      const overlaps = placed.some(p => !(box.x1 < p.x0 || box.x0 > p.x1 || box.y1 < p.y0 || box.y0 > p.y1));
      if (overlaps) continue;
      placed.push(box);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, c.fontSize * 0.22);
      ctx.strokeStyle = 'rgba(244,232,199,0.85)';
      ctx.strokeText(c.nation.name, c.sx, c.sy);
      ctx.fillStyle = c.nation.id === this.selectedNationId ? '#7a2e1d' : '#3b2a19';
      ctx.fillText(c.nation.name, c.sx, c.sy);
    }
  }

  // A small always-on badge near each intact capital showing relative
  // military strength, so the balance of power reads at a glance instead of
  // requiring a click into the nation list.
  drawMilitaryBadges() {
    const { ctx, sim, canvas } = this;
    if (this.camera.zoom < 0.5) return; // too small/cluttered to read when zoomed far out
    const map = sim.map;
    const placed = [];
    for (const nation of sim.nations) {
      if (!nation.alive || map.owner[nation.capitalIdx] !== nation.id) continue;
      const cx = nation.capitalIdx % map.width, cy = Math.floor(nation.capitalIdx / map.width);
      const sx = (cx + 0.5) * this.cellPx * this.camera.zoom + this.camera.x;
      const sy = (cy + 0.5) * this.cellPx * this.camera.zoom + this.camera.y;
      if (sx < -40 || sy < -30 || sx > canvas.width + 40 || sy > canvas.height + 30) continue;
      const text = `軍${formatNumber(nation.military)}`;
      ctx.font = '600 10.5px "EB Garamond", serif';
      const textWidth = ctx.measureText(text).width;
      const badgeY = sy + this.cellPx * this.camera.zoom * 0.65 + 9;
      const box = { x0: sx - textWidth / 2 - 4, x1: sx + textWidth / 2 + 4, y0: badgeY - 7, y1: badgeY + 7 };
      if (placed.some(p => !(box.x1 < p.x0 || box.x0 > p.x1 || box.y1 < p.y0 || box.y0 > p.y1))) continue;
      placed.push(box);
      ctx.fillStyle = 'rgba(36,26,16,0.72)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, 4);
      else ctx.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      ctx.fill();
      ctx.fillStyle = '#f0d98c';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, sx, badgeY);
    }
  }

  // While the player is choosing a target for a war/alliance/peace directive,
  // mark every eligible target nation's capital with an icon matching the
  // action, so the choice is visible on the map itself instead of only in
  // the bottom-left hint text.
  drawDirectiveMarkers() {
    const { ctx, sim, canvas } = this;
    const pd = this.pendingDirective;
    if (!pd || (pd.type !== 'war' && pd.type !== 'ally' && pd.type !== 'peace')) return;
    const map = sim.map;
    const icon = pd.type === 'war' ? '戦' : pd.type === 'ally' ? '\u{1F91D}' : '和';
    const bg = pd.type === 'war' ? 'rgba(122,46,29,0.92)' : 'rgba(63,107,58,0.92)';
    for (const nation of sim.nations) {
      if (!nation.alive || nation.id === pd.sourceId) continue;
      if (map.owner[nation.capitalIdx] !== nation.id) continue;
      const cx = nation.capitalIdx % map.width, cy = Math.floor(nation.capitalIdx / map.width);
      const sx = (cx + 0.5) * this.cellPx * this.camera.zoom + this.camera.x;
      const sy = (cy + 0.5) * this.cellPx * this.camera.zoom + this.camera.y;
      if (sx < -20 || sy < -20 || sx > canvas.width + 20 || sy > canvas.height + 20) continue;
      const markerY = sy - 22;
      ctx.beginPath();
      ctx.arc(sx, markerY, 11, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(244,232,199,0.9)';
      ctx.stroke();
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f5e9c8';
      ctx.fillText(icon, sx, markerY + 1);
    }
  }

  // A brief expanding ring + flash icon at a recent battle/amphibious-landing
  // site, purely cosmetic and driven by real wall-clock time so it animates
  // smoothly regardless of simulation speed — the point is to make an attack
  // an actual moment to watch rather than a border silently shifting.
  drawBattleEffects() {
    if (this.battleEffects.length === 0) return;
    const { ctx, cellPx, camera } = this;
    const DURATION = 1300;
    const now = performance.now();
    this.battleEffects = this.battleEffects.filter((e) => now - e.start < DURATION);
    for (const e of this.battleEffects) {
      const t = (now - e.start) / DURATION;
      const cx = (e.x + 0.5) * cellPx, cy = (e.y + 0.5) * cellPx;
      const naval = e.kind === 'naval';
      const color = naval ? '90,138,143' : '168,67,44';
      const ringRadius = (cellPx * 0.7) + t * cellPx * 3.5;
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${color},${(1 - t) * 0.85})`;
      ctx.lineWidth = Math.max(1, (2.4 * (1 - t * 0.6)) / camera.zoom);
      ctx.stroke();
      if (t < 0.55) {
        const iconAlpha = 1 - t / 0.55;
        ctx.font = `${Math.max(10, 15 / camera.zoom)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgba(255,236,190,${iconAlpha})`;
        ctx.fillText(naval ? '⚓' : '✦', cx, cy);
      }
    }
  }

  render() {
    const { ctx, canvas, sim } = this;
    const map = sim.map;
    if (this._bufDirtyTurn !== sim.turn || !this._bufCanvas) this.buildBuffer();

    ctx.save();
    ctx.fillStyle = '#2a2014';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(this.camera.x, this.camera.y);
    ctx.scale(this.camera.zoom, this.camera.zoom);

    // Terrain stays crisp: no bilinear smoothing on the raster buffer.
    ctx.imageSmoothingEnabled = false;
    const cellPx = this.cellPx;
    ctx.drawImage(this._bufCanvas, 0, 0, map.width * cellPx, map.height * cellPx);

    // Smoothness in national borders comes from the traced+Chaikin-rounded
    // vector shapes themselves, not from blurring or thick lines.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const nation of sim.nations) {
      if (!nation.alive) continue;
      const path = this._nationShapePaths.get(nation.id);
      if (!path) continue;
      const [wr, wg, wb] = shadeNationColor(nation, BIOME.PLAINS);
      ctx.fillStyle = `rgba(${wr},${wg},${wb},${TERRITORY_WASH_ALPHA})`;
      ctx.fill(path, 'evenodd');
    }
    for (const nation of sim.nations) {
      if (!nation.alive) continue;
      const path = this._nationShapePaths.get(nation.id);
      if (!path) continue;
      ctx.strokeStyle = 'rgba(48,34,20,0.8)';
      ctx.lineWidth = 1.8;
      ctx.stroke(path);
    }

    if (this.selectedNationId != null && this._nationShapePaths.has(this.selectedNationId)) {
      ctx.strokeStyle = '#c9a227';
      ctx.lineWidth = 3.2;
      ctx.stroke(this._nationShapePaths.get(this.selectedNationId));
    }

    for (const nation of sim.nations) {
      if (!nation.alive) continue;
      if (map.owner[nation.capitalIdx] !== nation.id) continue;
      const cx = nation.capitalIdx % map.width, cy = Math.floor(nation.capitalIdx / map.width);
      ctx.beginPath();
      ctx.arc((cx + 0.5) * cellPx, (cy + 0.5) * cellPx, cellPx * 0.65, 0, Math.PI * 2);
      ctx.fillStyle = '#f2dfa0';
      ctx.fill();
      ctx.lineWidth = Math.max(0.5, cellPx * 0.15);
      ctx.strokeStyle = '#3b2a19';
      ctx.stroke();
    }

    this.drawBattleEffects();

    ctx.restore();

    if (this.showLabels) this.drawLabels();
    this.drawMilitaryBadges();
    this.drawDirectiveMarkers();

    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = this._grainPattern;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}
