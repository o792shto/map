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

  const nationDetail = document.getElementById('nationDetail');
  const ndSwatch = document.getElementById('ndSwatch');
  const ndNameInput = document.getElementById('ndNameInput');
  const ndCloseBtn = document.getElementById('ndCloseBtn');
  const ndLeader = document.getElementById('ndLeader');
  const ndPersonality = document.getElementById('ndPersonality');
  const ndFounded = document.getElementById('ndFounded');
  const ndPop = document.getElementById('ndPop');
  const ndMil = document.getElementById('ndMil');
  const ndEco = document.getElementById('ndEco');
  const ndTerritory = document.getElementById('ndTerritory');
  const ndRelations = document.getElementById('ndRelations');
  const ndHistory = document.getElementById('ndHistory');

  let sim = null;
  let renderer = null;
  let chart = null;
  let paused = false;
  let tickAccumulator = 0;
  let lastFrameTime = null;
  let selectedNationId = null;

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
      renderer.onCellClick = onMapClick;
    } else {
      renderer.setSim(sim);
    }
    if (!chart) chart = new ChartRenderer(chartCanvas);
    logListEl.innerHTML = '';
    // placeNations() logs founding events during construction, before onLog
    // was wired up above, so replay whatever is already in the log.
    for (const entry of sim.eventLog) appendLogEntry(entry);
    endOverlay.classList.add('hidden');
    tickAccumulator = 0;
    selectNation(null);
    updateTurnBadge();
    updateNationList();
    chart.render(sim);
  }

  function onMapClick(cellIdx) {
    if (cellIdx == null) { selectNation(null); return; }
    const owner = sim.map.owner[cellIdx];
    selectNation(owner === -1 ? null : owner);
  }

  function selectNation(nationId) {
    selectedNationId = nationId;
    if (renderer) renderer.selectedNationId = nationId;
    updateNationDetail();
    updateNationList();
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

  function warCount(nation) {
    let c = 0;
    for (const state of nation.relations.values()) if (state === 'war') c++;
    return c;
  }

  function updateNationList() {
    const landTotal = countLandCells(sim.map);
    const rows = sim.nations.slice().sort((a, b) => b.territorySize - a.territorySize);
    nationListEl.innerHTML = rows.map((n) => {
      const pct = landTotal > 0 ? ((n.territorySize / landTotal) * 100).toFixed(1) : '0.0';
      const wars = warCount(n);
      const allies = n.allies.size;
      const badges = (n.alive ? (
        (wars > 0 ? `<span class="badge-war">交戦×${wars}</span>` : '') +
        (allies > 0 ? `<span class="badge-ally">同盟×${allies}</span>` : '')
      ) : '');
      return `<div class="nation-row ${n.alive ? '' : 'dead'} ${n.id === selectedNationId ? 'selected' : ''}" data-id="${n.id}">
        <span class="nation-swatch" style="background:${n.color}"></span>
        <span class="nation-name ${n.userNamed ? 'user-named' : ''}">${escapeHtml(n.name)}</span>
        <span class="nation-meta">${PERSONALITY_INFO[n.personality].label} ・ ${n.alive ? pct + '%' : '滅亡'}${badges}</span>
      </div>`;
    }).join('');
    nationListEl.querySelectorAll('.nation-row').forEach((row) => {
      row.addEventListener('click', () => selectNation(parseInt(row.dataset.id, 10)));
    });
  }

  function updateNationDetail() {
    if (selectedNationId == null || !sim.nationsById[selectedNationId]) {
      nationDetail.classList.add('hidden');
      return;
    }
    const n = sim.nationsById[selectedNationId];
    nationDetail.classList.remove('hidden');
    ndSwatch.style.background = n.color;
    if (document.activeElement !== ndNameInput) ndNameInput.value = n.name;
    ndLeader.textContent = n.leaderName || '不明';
    ndPersonality.textContent = PERSONALITY_INFO[n.personality].label;
    ndFounded.textContent = `T${n.foundedAtTick}`;
    ndPop.textContent = formatNumber(n.population);
    ndMil.textContent = formatNumber(n.military);
    ndEco.textContent = formatNumber(n.economy);
    const landTotal = countLandCells(sim.map);
    const pct = landTotal > 0 ? ((n.territorySize / landTotal) * 100).toFixed(1) : '0.0';
    ndTerritory.textContent = n.alive ? `${n.territorySize}マス (${pct}%)` : `滅亡 (T${n.diedAtTick})`;

    const chips = [];
    for (const [otherId, state] of n.relations) {
      if (state !== 'war') continue;
      const other = sim.nationsById[otherId];
      if (other) chips.push(`<span class="nd-chip war">${escapeHtml(other.name)}と交戦中</span>`);
    }
    for (const otherId of n.allies) {
      const other = sim.nationsById[otherId];
      if (other) chips.push(`<span class="nd-chip ally">${escapeHtml(other.name)}と同盟</span>`);
    }
    ndRelations.innerHTML = chips.length ? chips.join('') : '<span class="nd-empty">目立った外交関係はない</span>';

    const hist = n.history.slice().reverse();
    ndHistory.innerHTML = hist.length
      ? hist.map(h => `<div class="nd-history-entry"><span class="t">T${h.turn}</span>${escapeHtml(h.text)}</div>`).join('')
      : '<div class="nd-empty">記録なし</div>';
  }

  ndNameInput.addEventListener('change', () => {
    if (selectedNationId == null || !sim.nationsById[selectedNationId]) return;
    const n = sim.nationsById[selectedNationId];
    const trimmed = ndNameInput.value.trim();
    if (trimmed && trimmed !== n.name) {
      n.name = trimmed;
      n.userNamed = true;
      updateNationList();
    } else {
      ndNameInput.value = n.name;
    }
  });
  ndCloseBtn.addEventListener('click', () => selectNation(null));

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
      ? `${sim.winner.name}（${PERSONALITY_INFO[sim.winner.personality].label}、指導者 ${sim.winner.leaderName}）が最終ターン ${sim.turn} で天下を統一、または最大の勢力となりました。`
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
        updateNationDetail();
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
