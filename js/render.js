// Canvas rendering: map cells, nation territory colors, capitals, zoom & pan camera.

const BIOME_SHADE = {
  [BIOME.PLAINS]: 0,
  [BIOME.GRASSLAND]: 0,
  [BIOME.FOREST]: -8,
  [BIOME.MOUNTAIN]: -16,
  [BIOME.DESERT]: 6,
};

function shadeNationColor(nation, biome) {
  if (!nation._hsl) {
    const m = nation.color.match(/hsl\(([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)/);
    nation._hsl = { h: parseFloat(m[1]), s: parseFloat(m[2]), l: parseFloat(m[3]) };
    nation._shadeCache = {};
  }
  if (nation._shadeCache[biome]) return nation._shadeCache[biome];
  const { h, s, l } = nation._hsl;
  const nl = clamp(l + (BIOME_SHADE[biome] || 0), 10, 85);
  const color = `hsl(${h.toFixed(1)}, ${s}%, ${nl}%)`;
  nation._shadeCache[biome] = color;
  return color;
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
    this.bindEvents();
    this.fitToScreen();
  }

  setSim(sim) {
    this.sim = sim;
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
    const newZoom = clamp(this.camera.zoom * factor, this.minZoom(), 10);
    this.camera.zoom = newZoom;
    this.camera.x = mx - worldX * newZoom;
    this.camera.y = my - worldY * newZoom;
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
    });
    window.addEventListener('mouseup', () => { this.dragging = false; });

    // touch support
    let lastTouchDist = null;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.dragging = true;
        this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
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
    canvas.addEventListener('touchend', () => { this.dragging = false; lastTouchDist = null; });
  }

  touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  render() {
    const { ctx, canvas, sim } = this;
    const map = sim.map;
    ctx.save();
    ctx.fillStyle = '#0a1622';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(this.camera.x, this.camera.y);
    ctx.scale(this.camera.zoom, this.camera.zoom);

    const cellPx = this.cellPx;
    const x0 = clamp(Math.floor(-this.camera.x / this.camera.zoom / cellPx) - 1, 0, map.width - 1);
    const y0 = clamp(Math.floor(-this.camera.y / this.camera.zoom / cellPx) - 1, 0, map.height - 1);
    const x1 = clamp(Math.ceil((canvas.width - this.camera.x) / this.camera.zoom / cellPx) + 1, 0, map.width - 1);
    const y1 = clamp(Math.ceil((canvas.height - this.camera.y) / this.camera.zoom / cellPx) + 1, 0, map.height - 1);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = map.idx(x, y);
        const owner = map.owner[i];
        const biome = map.biome[i];
        let color;
        if (owner === -1) {
          color = BIOME_INFO[biome].color;
        } else {
          const nation = sim.nationsById[owner];
          color = nation ? shadeNationColor(nation, biome) : BIOME_INFO[biome].color;
        }
        ctx.fillStyle = color;
        ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);

        if (this.showUnrest && owner !== -1) {
          const u = map.unrest[i];
          if (u > 40) {
            const a = clamp((u - 40) / 60, 0, 0.55);
            ctx.fillStyle = `rgba(220,30,30,${a.toFixed(2)})`;
            ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
          }
        }
      }
    }

    for (const nation of sim.nations) {
      if (!nation.alive) continue;
      if (map.owner[nation.capitalIdx] !== nation.id) continue;
      const cx = nation.capitalIdx % map.width, cy = Math.floor(nation.capitalIdx / map.width);
      ctx.beginPath();
      ctx.arc((cx + 0.5) * cellPx, (cy + 0.5) * cellPx, cellPx * 0.65, 0, Math.PI * 2);
      ctx.fillStyle = '#fff8e0';
      ctx.fill();
      ctx.lineWidth = Math.max(0.5, cellPx * 0.15);
      ctx.strokeStyle = '#20140a';
      ctx.stroke();
    }

    ctx.restore();
  }
}
