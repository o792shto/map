// Wires the simulation, renderer, chart and UI controls together.

(function () {
  const mapCanvas = document.getElementById('mapCanvas');
  const chartCanvas = document.getElementById('chartCanvas');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const speedSlider = document.getElementById('speedSlider');
  const nationCountSlider = document.getElementById('nationCountSlider');
  const nationCountLabel = document.getElementById('nationCountLabel');
  const endlessToggle = document.getElementById('endlessToggle');
  const regenerateBtn = document.getElementById('regenerateBtn');
  const nationListEl = document.getElementById('nationList');
  const logListEl = document.getElementById('logList');
  const turnBadge = document.getElementById('turnBadge');
  const endOverlay = document.getElementById('endOverlay');
  const endTitle = document.getElementById('endTitle');
  const endSummary = document.getElementById('endSummary');
  const endRanking = document.getElementById('endRanking');
  const endContinueBtn = document.getElementById('endContinueBtn');
  const endRegenerateBtn = document.getElementById('endRegenerateBtn');

  let sim = null;
  let renderer = null;
  let chart = null;
  let paused = false;
  let tickAccumulator = 0;
  let lastFrameTime = null;

  function resizeMapCanvas() {
    const rect = mapCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (mapCanvas.width !== w || mapCanvas.height !== h) {
      mapCanvas.width = w;
      mapCanvas.height = h;
      if (renderer) renderer.fitToScreen();
    }
  }

  function createNewSimulation() {
    const nationCount = parseInt(nationCountSlider.value, 10);
    sim = new Simulation({ nationCount, endless: endlessToggle.checked });
    sim.onLog = (entry) => appendLogEntry(entry);
    sim.onEnd = () => showEndOverlay();
    if (!renderer) {
      renderer = new Renderer(mapCanvas, sim);
    } else {
      renderer.setSim(sim);
    }
    if (!chart) chart = new ChartRenderer(chartCanvas);
    logListEl.innerHTML = '';
    endOverlay.classList.add('hidden');
    tickAccumulator = 0;
    updateTurnBadge();
    updateNationList();
    chart.render(sim);
  }

  function appendLogEntry(entry) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `<span class="t">T${entry.turn}</span>${escapeHtml(entry.text)}`;
    logListEl.appendChild(div);
    while (logListEl.children.length > 250) logListEl.removeChild(logListEl.firstChild);
    logListEl.scrollTop = logListEl.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function updateTurnBadge() {
    turnBadge.textContent = `Turn ${sim.turn}` + (sim.config.endless ? ' (endless)' : ` / ${sim.config.maxTurns}`);
  }

  function updateNationList() {
    const landTotal = countLandCells(sim.map);
    const rows = sim.nations.slice().sort((a, b) => b.territorySize - a.territorySize);
    nationListEl.innerHTML = rows.map((n) => {
      const pct = landTotal > 0 ? ((n.territorySize / landTotal) * 100).toFixed(1) : '0.0';
      return `<div class="nation-row ${n.alive ? '' : 'dead'}">
        <span class="nation-swatch" style="background:${n.color}"></span>
        <span class="nation-name">${escapeHtml(n.name)}</span>
        <span class="nation-meta">${PERSONALITY_INFO[n.personality].label} ・ ${n.alive ? pct + '%' : '滅亡'}</span>
      </div>`;
    }).join('');
  }

  let cachedLandTotal = null;
  function countLandCells(map) {
    if (cachedLandTotal !== null && cachedLandTotal.map === map) return cachedLandTotal.value;
    let count = 0;
    for (let i = 0; i < map.biome.length; i++) if (BIOME_INFO[map.biome[i]].passable) count++;
    cachedLandTotal = { map, value: count };
    return count;
  }

  function showEndOverlay() {
    paused = true;
    playPauseBtn.textContent = '再生';
    endTitle.textContent = sim.winner ? '勝者が決定しました' : 'シミュレーション終了';
    endSummary.textContent = sim.winner
      ? `${sim.winner.name}（${PERSONALITY_INFO[sim.winner.personality].label}）が最終ターン ${sim.turn} で天下を統一、または最大の勢力となりました。`
      : `ターン ${sim.turn} で全ての国家が滅亡しました。`;
    const landTotal = countLandCells(sim.map);
    const ranked = sim.nations.slice().sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (b.territorySize !== a.territorySize) return b.territorySize - a.territorySize;
      return (b.diedAtTick || 0) - (a.diedAtTick || 0);
    });
    endRanking.innerHTML = ranked.map((n, i) => {
      const pct = landTotal > 0 ? ((n.territorySize / landTotal) * 100).toFixed(1) : '0.0';
      const status = n.alive ? `領土 ${pct}%` : `${n.diedAtTick}ターンに滅亡`;
      return `<div class="rank-row"><b>${i + 1}.</b><span class="nation-swatch" style="background:${n.color}"></span>${escapeHtml(n.name)} <span class="nation-meta">${status}</span></div>`;
    }).join('');
    endOverlay.classList.remove('hidden');
  }

  function ticksPerSecond() {
    return parseInt(speedSlider.value, 10);
  }

  function frame(now) {
    if (lastFrameTime === null) lastFrameTime = now;
    const dt = Math.min(0.25, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    if (!paused && !sim.ended) {
      tickAccumulator += dt * ticksPerSecond();
      let ticked = false;
      let safety = 0;
      while (tickAccumulator >= 1 && safety < 60) {
        sim.tick();
        tickAccumulator -= 1;
        ticked = true;
        safety++;
        if (sim.ended) break;
      }
      if (ticked) {
        updateTurnBadge();
        updateNationList();
        chart.render(sim);
      }
    }

    renderer.render();
    requestAnimationFrame(frame);
  }

  playPauseBtn.addEventListener('click', () => {
    paused = !paused;
    playPauseBtn.textContent = paused ? '再生' : '一時停止';
  });

  nationCountSlider.addEventListener('input', () => {
    nationCountLabel.textContent = nationCountSlider.value;
  });

  endlessToggle.addEventListener('change', () => {
    if (sim) {
      sim.config.endless = endlessToggle.checked;
      updateTurnBadge();
    }
  });

  regenerateBtn.addEventListener('click', () => {
    createNewSimulation();
  });

  endRegenerateBtn.addEventListener('click', () => {
    createNewSimulation();
    paused = false;
    playPauseBtn.textContent = '一時停止';
  });

  endContinueBtn.addEventListener('click', () => {
    sim.config.endless = true;
    endlessToggle.checked = true;
    sim.ended = false;
    endOverlay.classList.add('hidden');
    paused = false;
    playPauseBtn.textContent = '一時停止';
    updateTurnBadge();
  });

  window.addEventListener('resize', resizeMapCanvas);

  resizeMapCanvas();
  createNewSimulation();
  resizeMapCanvas();
  requestAnimationFrame(frame);
})();
