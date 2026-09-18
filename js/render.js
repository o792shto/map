// Canvas rendering: a crisp, hand-tinted antique-atlas style map. Terrain and
// territory colors are baked once per simulation tick into a 1px-per-cell
// offscreen buffer (a monochrome ink terrain tone blended with a translucent
// nation wash), drawn without smoothing so edges stay sharp. Smoothness in
// national borders comes from thick, round-jointed ink stroke lines rather
// than a blurred raster, so the map reads as sharply inked rather than soft-
// focus. A paper-grain overlay and screen-space nation name labels complete
// the look. Zoom & pan camera + click-to-select.

const BIOME_SHADE = {
  [BIOME.PLAINS]: 0,
  [BIOME.GRASSLAND]: 0,
  [BIOME.FOREST]: -8,
  [BIOME.MOUNTAIN]: -16,
  [BIOME.DESERT]: 6,
};

const TERRITORY_WASH_ALPHA = 0.5; // how strongly the nation tint covers the terrain beneath it

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
    this.onCellClick = null;
    this._bufCanvas = null;
    this._bufCtx = null;
    this._bufDirtyTurn = -1;
    this._generalBorderPath = null;
    this._nationBorderPaths = new Map();
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
    this.fitToScreen();
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

  // Rebuilds the terrain+territory pixel buffer, border paths and label
  // anchor points. Cheap enough (one pass over the grid) to redo once per
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

    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = map.idx(x, y);
        const owner = map.owner[i];
        const biome = map.biome[i];
        const [br, bg, bb] = BIOME_RGB[biome];
        let r = br, g = bg, b = bb;
        if (owner !== -1) {
          const nation = sim.nationsById[owner];
          if (nation) {
            const [nr, ng, nb] = shadeNationColor(nation, biome);
            r = br * (1 - TERRITORY_WASH_ALPHA) + nr * TERRITORY_WASH_ALPHA;
            g = bg * (1 - TERRITORY_WASH_ALPHA) + ng * TERRITORY_WASH_ALPHA;
            b = bb * (1 - TERRITORY_WASH_ALPHA) + nb * TERRITORY_WASH_ALPHA;
            let sum = centroidSum.get(owner);
            if (!sum) { sum = { sx: 0, sy: 0, n: 0 }; centroidSum.set(owner, sum); }
            sum.sx += x; sum.sy += y; sum.n++;
          }
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

    this.buildBorders();
  }

  buildBorders() {
    const map = this.sim.map;
    const cellPx = this.cellPx;
    const general = new Path2D();
    const perNation = new Map();
    const addSeg = (path, x0, y0, x1, y1) => {
      path.moveTo(x0 * cellPx, y0 * cellPx);
      path.lineTo(x1 * cellPx, y1 * cellPx);
    };
    const nationPath = (id) => {
      if (!perNation.has(id)) perNation.set(id, new Path2D());
      return perNation.get(id);
    };
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = map.idx(x, y);
        const owner = map.owner[i];
        if (x < map.width - 1) {
          const j = map.idx(x + 1, y);
          const oOwner = map.owner[j];
          if (oOwner !== owner) {
            addSeg(general, x + 1, y, x + 1, y + 1);
            if (owner !== -1) addSeg(nationPath(owner), x + 1, y, x + 1, y + 1);
            if (oOwner !== -1) addSeg(nationPath(oOwner), x + 1, y, x + 1, y + 1);
          }
        }
        if (y < map.height - 1) {
          const j = map.idx(x, y + 1);
          const oOwner = map.owner[j];
          if (oOwner !== owner) {
            addSeg(general, x, y + 1, x + 1, y + 1);
            if (owner !== -1) addSeg(nationPath(owner), x, y + 1, x + 1, y + 1);
            if (oOwner !== -1) addSeg(nationPath(oOwner), x, y + 1, x + 1, y + 1);
          }
        }
      }
    }
    this._generalBorderPath = general;
    this._nationBorderPaths = perNation;
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

  render() {
    const { ctx, canvas, sim } = this;
    const map = sim.map;
    if (this._bufDirtyTurn !== sim.turn || !this._bufCanvas) this.buildBuffer();

    ctx.save();
    ctx.fillStyle = '#2a2014';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(this.camera.x, this.camera.y);
    ctx.scale(this.camera.zoom, this.camera.zoom);

    // No bilinear smoothing: keep the terrain fill crisp. Smooth-looking
    // borders come from the thick, round-jointed ink strokes below, which
    // are wide enough to visually mask the underlying per-cell jaggedness.
    ctx.imageSmoothingEnabled = false;
    const cellPx = this.cellPx;
    ctx.drawImage(this._bufCanvas, 0, 0, map.width * cellPx, map.height * cellPx);

    if (this._generalBorderPath) {
      ctx.strokeStyle = 'rgba(59,42,25,0.6)';
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke(this._generalBorderPath);
    }

    if (this.selectedNationId != null && this._nationBorderPaths.has(this.selectedNationId)) {
      ctx.strokeStyle = '#c9a227';
      ctx.lineWidth = 4.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke(this._nationBorderPaths.get(this.selectedNationId));
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

    ctx.restore();

    if (this.showLabels) this.drawLabels();

    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = this._grainPattern;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}
