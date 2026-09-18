// Simple canvas line chart of territory size over time, no external chart library.

class ChartRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  resize() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  render(sim) {
    this.resize();
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0f1c2b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const history = sim.territoryHistory;
    const padding = { left: 30, right: 6, top: 8, bottom: 14 };
    const w = canvas.width - padding.left - padding.right;
    const h = canvas.height - padding.top - padding.bottom;
    if (w <= 0 || h <= 0) return;

    if (history.length < 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '11px sans-serif';
      ctx.fillText('データ収集中...', padding.left, padding.top + h / 2);
      return;
    }

    let maxSize = 1;
    for (const p of history) for (const e of p.entries) if (e.size > maxSize) maxSize = e.size;

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + h * (i / 4);
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + w, y);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '9px sans-serif';
    for (let i = 0; i <= 4; i++) {
      const val = Math.round(maxSize * (1 - i / 4));
      ctx.fillText(String(val), 2, padding.top + h * (i / 4) + 3);
    }

    const n = history.length;
    for (const nation of sim.nations) {
      ctx.beginPath();
      for (let idx = 0; idx < n; idx++) {
        const entry = history[idx].entries.find(e => e.id === nation.id);
        const size = entry ? entry.size : 0;
        const x = padding.left + (n === 1 ? 0 : w * (idx / (n - 1)));
        const y = padding.top + h * (1 - size / maxSize);
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = nation.color;
      ctx.lineWidth = nation.alive ? 2 : 1;
      ctx.globalAlpha = nation.alive ? 1 : 0.3;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
