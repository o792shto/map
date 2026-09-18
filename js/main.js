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
  const mapHint = document.getElementById('mapHint');
  const eventBannerStack = document.getElementById('eventBannerStack');
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
  const ndPolitical = document.getElementById('ndPolitical');
  const ndLifestyle = document.getElementById('ndLifestyle');
  const ndTrait = document.getElementById('ndTrait');
  const ndFounded = document.getElementById('ndFounded');
  const ndPop = document.getElementById('ndPop');
  const ndMil = document.getElementById('ndMil');
  const ndEco = document.getElementById('ndEco');
  const ndTerritory = document.getElementById('ndTerritory');
  const ndRelations = document.getElementById('ndRelations');
  const ndHistory = document.getElementById('ndHistory');
  const ndDirectiveSection = document.getElementById('ndDirectiveSection');
  const ndDirExpand = document.getElementById('ndDirExpand');
  const ndDirWar = document.getElementById('ndDirWar');
  const ndDirAlly = document.getElementById('ndDirAlly');
  const ndDirPeace = document.getElementById('ndDirPeace');

  const mapSettingsBtn = document.getElementById('mapSettingsBtn');
  const setupOverlay = document.getElementById('setupOverlay');
  const randomMapOptions = document.getElementById('randomMapOptions');
  const mapChoiceButtons = [...document.querySelectorAll('.map-choice')];
  const landAmountSlider = document.getElementById('landAmountSlider');
  const mountainAmountSlider = document.getElementById('mountainAmountSlider');
  const coastDetailSlider = document.getElementById('coastDetailSlider');
  const seedInput = document.getElementById('seedInput');
  const msRandomSeedBtn = document.getElementById('msRandomSeedBtn');
  const msGenerateBtn = document.getElementById('msGenerateBtn');

  const startModeButtons = [...document.querySelectorAll('.start-mode-choice')];
  const fromZeroOptions = document.getElementById('fromZeroOptions');
  const manualPlacementToggle = document.getElementById('manualPlacementToggle');
  const manualPlacementPanel = document.getElementById('manualPlacementPanel');
  const placementPreviewCanvas = document.getElementById('placementPreview');
  const placementSlotListEl = document.getElementById('placementSlotList');
  const placementRandomFillBtn = document.getElementById('placementRandomFillBtn');
  const placementResetBtn = document.getElementById('placementResetBtn');

  const DEFAULT_MAP_HINT = 'ホイールでズーム / ドラッグで移動 / クリックで国家を選択';

  let sim = null;
  let renderer = null;
  let chart = null;
  let paused = false;
  let tickAccumulator = 0;
  let lastFrameTime = null;
  let selectedNationId = null;
  let pendingDirective = null; // {type: 'expand'|'war'|'ally'|'peace', sourceId}
  let lastGeneratedSeed = null;
  let currentPreset = 'random'; // 'random' | 'europe' | 'asia'
  let gameStarted = false;
  let startMode = 'established'; // 'established' | 'fromZero'
  let manualPlacementActive = false;
  let placementSlots = []; // [{idx: number|null, name: string}]
  let previewMap = null;
  let previewSeed = null;

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

  function computeMapOptionsFromUI() {
    const landAmount = parseInt(landAmountSlider.value, 10);
    const mountainAmount = parseInt(mountainAmountSlider.value, 10);
    const coastDetail = parseInt(coastDetailSlider.value, 10);
    const options = {
      mountainThreshold: 0.9 - (mountainAmount / 100) * 0.5,
    };
    if (currentPreset === 'random') {
      options.seaLevel = 0.56 - (landAmount / 100) * 0.42;
      options.coastPasses = 4 - coastDetail;
    } else {
      options.presetId = currentPreset;
    }
    return options;
  }

  // --- Manual capital placement (0-start mode) -----------------------------

  function ensurePlacementSlotCount(n) {
    while (placementSlots.length < n) placementSlots.push({ idx: null, name: '' });
    while (placementSlots.length > n) placementSlots.pop();
  }

  function worldMapOptionsFromUI() {
    const mapOptions = computeMapOptionsFromUI();
    let width = 240, height = 150;
    const opts = { mountainThreshold: mapOptions.mountainThreshold };
    if (mapOptions.presetId) {
      const preset = PRESET_MAPS[mapOptions.presetId];
      width = preset.width; height = preset.height;
      opts.presetMask = decodePresetMask(preset);
    } else {
      opts.seaLevel = mapOptions.seaLevel;
      opts.coastPasses = mapOptions.coastPasses;
    }
    return { width, height, opts };
  }

  function rebuildPreview() {
    if (!manualPlacementActive) return;
    let seed = parseInt(seedInput.value, 10);
    if (!Number.isFinite(seed)) {
      seed = Math.floor(Math.random() * 1e9);
      seedInput.value = String(seed);
    }
    previewSeed = seed;
    const { width, height, opts } = worldMapOptionsFromUI();
    previewMap = new WorldMap(width, height, seed, opts);
    ensurePlacementSlotCount(parseInt(nationCountSlider.value, 10));
    for (const slot of placementSlots) slot.idx = null; // terrain changed, positions no longer valid
    renderPreviewMap();
    updatePlacementSlotList();
  }

  function renderPreviewMap() {
    if (!previewMap) return;
    const canvas = placementPreviewCanvas;
    const ctx = canvas.getContext('2d');
    const map = previewMap;
    const scaleX = canvas.width / map.width, scaleY = canvas.height / map.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        ctx.fillStyle = BIOME_INFO[map.biome[map.idx(x, y)]].color;
        ctx.fillRect(x * scaleX, y * scaleY, Math.ceil(scaleX), Math.ceil(scaleY));
      }
    }
    placementSlots.forEach((slot, i) => {
      if (slot.idx == null) return;
      const x = slot.idx % map.width, y = Math.floor(slot.idx / map.width);
      const px = (x + 0.5) * scaleX, py = (y + 0.5) * scaleY;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#c9a227';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#241a08';
      ctx.stroke();
      ctx.fillStyle = '#241a08';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), px, py);
    });
  }

  function updatePlacementSlotList() {
    placementSlotListEl.innerHTML = placementSlots.map((slot, i) => {
      const status = slot.idx != null ? '配置済み' : '未配置';
      return `<div class="placement-slot-row" data-i="${i}">
        <span class="slot-num">${i + 1}</span>
        <input type="text" class="slot-name-input" placeholder="国名(自動)" value="${escapeHtml(slot.name)}" maxlength="24">
        <span class="slot-status ${slot.idx != null ? 'placed' : ''}">${status}</span>
        <button class="slot-clear" title="配置を解除">×</button>
      </div>`;
    }).join('');
    placementSlotListEl.querySelectorAll('.placement-slot-row').forEach((row) => {
      const i = parseInt(row.dataset.i, 10);
      row.querySelector('.slot-name-input').addEventListener('input', (e) => {
        placementSlots[i].name = e.target.value;
      });
      row.querySelector('.slot-clear').addEventListener('click', () => {
        placementSlots[i].idx = null;
        renderPreviewMap();
        updatePlacementSlotList();
      });
    });
  }

  function randomFillRemainingSlots() {
    if (!previewMap) return;
    const map = previewMap;
    const placed = placementSlots.filter(s => s.idx != null).map(s => s.idx);
    for (const slot of placementSlots) {
      if (slot.idx != null) continue;
      for (let attempt = 0; attempt < 400; attempt++) {
        const x = Math.floor(Math.random() * map.width), y = Math.floor(Math.random() * map.height);
        if (!map.isLand(x, y)) continue;
        const idx = map.idx(x, y);
        if (placed.includes(idx)) continue;
        const tooClose = placed.some((p) => {
          const px = p % map.width, py = Math.floor(p / map.width);
          return Math.hypot(x - px, y - py) < Math.max(4, Math.min(map.width, map.height) / (placementSlots.length * 1.2));
        });
        if (tooClose) continue;
        slot.idx = idx;
        placed.push(idx);
        break;
      }
    }
    renderPreviewMap();
    updatePlacementSlotList();
  }

  placementPreviewCanvas.addEventListener('click', (e) => {
    if (!manualPlacementActive || !previewMap) return;
    const rect = placementPreviewCanvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (placementPreviewCanvas.width / rect.width);
    const py = (e.clientY - rect.top) * (placementPreviewCanvas.height / rect.height);
    const map = previewMap;
    const mx = Math.floor(px / (placementPreviewCanvas.width / map.width));
    const my = Math.floor(py / (placementPreviewCanvas.height / map.height));
    if (mx < 0 || my < 0 || mx >= map.width || my >= map.height || !map.isLand(mx, my)) return;
    const idx = map.idx(mx, my);
    if (placementSlots.some(s => s.idx === idx)) return;
    const slot = placementSlots.find(s => s.idx == null);
    if (!slot) return;
    slot.idx = idx;
    renderPreviewMap();
    updatePlacementSlotList();
  });

  placementRandomFillBtn.addEventListener('click', randomFillRemainingSlots);
  placementResetBtn.addEventListener('click', () => {
    for (const slot of placementSlots) slot.idx = null;
    renderPreviewMap();
    updatePlacementSlotList();
  });

  startModeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      startMode = btn.dataset.mode;
      startModeButtons.forEach((b) => b.classList.toggle('active', b === btn));
      fromZeroOptions.classList.toggle('hidden', startMode !== 'fromZero');
    });
  });

  manualPlacementToggle.addEventListener('change', () => {
    manualPlacementActive = manualPlacementToggle.checked;
    manualPlacementPanel.classList.toggle('hidden', !manualPlacementActive);
    if (manualPlacementActive) {
      ensurePlacementSlotCount(parseInt(nationCountSlider.value, 10));
      rebuildPreview();
    }
  });

  [landAmountSlider, mountainAmountSlider, coastDetailSlider].forEach((el) => {
    el.addEventListener('input', () => rebuildPreview());
  });
  seedInput.addEventListener('change', () => rebuildPreview());

  function createNewSimulation(seedOverride, extraConfig) {
    const nationCount = parseInt(nationCountSlider.value, 10);
    const mapOptions = computeMapOptionsFromUI();
    const config = { nationCount, endless: endlessToggle.checked, startMode, ...mapOptions, ...(extraConfig || {}) };
    if (seedOverride != null) config.seed = seedOverride;
    sim = new Simulation(config);
    lastGeneratedSeed = sim.seed;
    seedInput.value = String(sim.seed);
    sim.onLog = (entry) => { appendLogEntry(entry); maybeShowEventBanner(entry); };
    sim.onEnd = () => showEndOverlay();
    if (!renderer) {
      renderer = new Renderer(mapCanvas, sim);
      renderer.onCellClick = onMapClick;
    } else {
      renderer.setSim(sim);
    }
    if (!chart) chart = new ChartRenderer(chartCanvas);
    logListEl.innerHTML = '';
    if (eventBannerStack) eventBannerStack.innerHTML = '';
    // placeNations() logs founding events during construction, before onLog
    // was wired up above, so replay whatever is already in the log.
    for (const entry of sim.eventLog) appendLogEntry(entry);
    endOverlay.classList.add('hidden');
    tickAccumulator = 0;
    pendingDirective = null;
    updateMapHint();
    selectNation(null);
    updateTurnBadge();
    updateNationList();
    chart.render(sim);
  }

  function updateMapHint() {
    if (renderer) renderer.pendingDirective = pendingDirective;
    if (!pendingDirective) {
      mapHint.textContent = DEFAULT_MAP_HINT;
      mapHint.classList.remove('active-directive');
      return;
    }
    const labels = {
      expand: '拡張したい地点を地図上でクリック（Escでキャンセル）',
      war: '宣戦布告する相手の国家を地図上の「戦」マークか一覧でクリック（Escでキャンセル）',
      ally: '同盟を提案する相手の国家を地図上の🤝マークか一覧でクリック（Escでキャンセル）',
      peace: '休戦を提案する相手の国家を地図上の「和」マークか一覧でクリック（Escでキャンセル）',
    };
    mapHint.textContent = labels[pendingDirective.type];
    mapHint.classList.add('active-directive');
  }

  function startDirective(type) {
    if (selectedNationId == null || !sim.nationsById[selectedNationId] || !sim.nationsById[selectedNationId].alive) return;
    pendingDirective = { type, sourceId: selectedNationId };
    updateMapHint();
  }

  function cancelDirective() {
    pendingDirective = null;
    updateMapHint();
  }

  function resolveDirectiveWithNation(targetId) {
    const { type, sourceId } = pendingDirective;
    pendingDirective = null;
    updateMapHint();
    if (targetId == null || targetId === sourceId) return;
    if (type === 'war') sim.issueDeclareWar(sourceId, targetId);
    else if (type === 'ally') sim.issueProposeAlliance(sourceId, targetId);
    else if (type === 'peace') sim.issueSuePeace(sourceId, targetId);
    updateNationList();
    updateNationDetail();
  }

  function resolveDirectiveWithCell(cellIdx) {
    const { sourceId } = pendingDirective;
    pendingDirective = null;
    updateMapHint();
    if (cellIdx != null) sim.issueExpansionDirective(sourceId, cellIdx);
  }

  function onMapClick(cellIdx) {
    if (pendingDirective) {
      if (pendingDirective.type === 'expand') { resolveDirectiveWithCell(cellIdx); return; }
      const owner = cellIdx != null ? sim.map.owner[cellIdx] : null;
      resolveDirectiveWithNation(owner === -1 ? null : owner);
      return;
    }
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
    div.className = `log-entry kind-${entry.kind || 'info'}`;
    div.innerHTML = `<span class="t">${entry.turn}年</span>${escapeHtml(entry.text)}`;
    logListEl.appendChild(div);
    while (logListEl.children.length > 250) logListEl.removeChild(logListEl.firstChild);
    logListEl.scrollTop = logListEl.scrollHeight;
  }

  // A small subset of "notable" log kinds also get a transient banner over
  // the map, so major turning points (a war, a nation's fall, a golden age)
  // register as an event rather than scrolling past unnoticed in the feed.
  const BANNER_TAGS = {
    war: '宣戦布告', death: '滅亡', found: '建国', goldenage: '黄金時代',
    disaster: '天災', crisis: '内乱', rebellion: '反乱', raid: '異民族侵入',
    hero: '英雄の出現', exploration: '新天地', end: '終幕',
  };
  function maybeShowEventBanner(entry) {
    const tag = BANNER_TAGS[entry.kind];
    if (!tag || !eventBannerStack) return;
    while (eventBannerStack.children.length >= 4) eventBannerStack.removeChild(eventBannerStack.firstChild);
    const div = document.createElement('div');
    div.className = `event-banner kind-${entry.kind}`;
    div.innerHTML = `<span class="eb-tag">${tag}</span><span class="eb-text">${escapeHtml(entry.text)}</span>`;
    eventBannerStack.appendChild(div);
    setTimeout(() => {
      div.classList.add('leaving');
      setTimeout(() => div.remove(), 450);
    }, 4200);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function updateTurnBadge() {
    turnBadge.textContent = `${sim.turn}年` + (sim.config.endless ? '（エンドレス）' : ` / ${sim.config.maxTurns}年`);
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
      row.addEventListener('click', () => {
        const id = parseInt(row.dataset.id, 10);
        if (pendingDirective) {
          if (pendingDirective.type === 'expand') return; // list rows aren't map locations
          resolveDirectiveWithNation(id);
          return;
        }
        selectNation(id);
      });
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
    ndPolitical.textContent = POLITICAL_SYSTEM_INFO[n.politicalSystem].label;
    ndLifestyle.textContent = LIFESTYLE_INFO[n.lifestyle].label;
    ndTrait.textContent = n.trait ? n.trait.label : '-';
    ndFounded.textContent = `${n.foundedAtTick}年`;
    ndPop.textContent = formatNumber(n.population);
    ndMil.textContent = formatNumber(n.military);
    ndEco.textContent = formatNumber(n.economy);
    const landTotal = countLandCells(sim.map);
    const pct = landTotal > 0 ? ((n.territorySize / landTotal) * 100).toFixed(1) : '0.0';
    ndTerritory.textContent = n.alive ? `${n.territorySize}マス (${pct}%)` : `滅亡 (${n.diedAtTick}年)`;
    ndDirectiveSection.style.display = n.alive ? '' : 'none';

    const chips = [];
    const warIds = new Set();
    for (const [otherId, state] of n.relations) {
      if (state !== 'war') continue;
      warIds.add(otherId);
      const other = sim.nationsById[otherId];
      if (other) chips.push(`<span class="nd-chip war">${escapeHtml(other.name)}: 交戦中</span>`);
    }
    for (const otherId of n.allies) {
      const other = sim.nationsById[otherId];
      if (other) chips.push(`<span class="nd-chip ally">${escapeHtml(other.name)}: 同盟</span>`);
    }
    for (const [otherId, score] of n.relationScore) {
      if (warIds.has(otherId) || n.allies.has(otherId)) continue;
      if (Math.abs(score) < 15) continue;
      const other = sim.nationsById[otherId];
      if (!other || !other.alive) continue;
      const cls = score > 0 ? 'friendly' : 'hostile';
      const sign = score > 0 ? '+' : '';
      chips.push(`<span class="nd-chip ${cls}">${escapeHtml(other.name)}: ${relationLabel(score)}(${sign}${Math.round(score)})</span>`);
    }
    ndRelations.innerHTML = chips.length ? chips.join('') : '<span class="nd-empty">目立った外交関係はない</span>';

    const hist = n.history.slice().reverse();
    ndHistory.innerHTML = hist.length
      ? hist.map(h => `<div class="nd-history-entry"><span class="t">${h.turn}年</span>${escapeHtml(h.text)}</div>`).join('')
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
  ndDirExpand.addEventListener('click', () => startDirective('expand'));
  ndDirWar.addEventListener('click', () => startDirective('war'));
  ndDirAlly.addEventListener('click', () => startDirective('ally'));
  ndDirPeace.addEventListener('click', () => startDirective('peace'));

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
      ? `${sim.winner.name}（${PERSONALITY_INFO[sim.winner.personality].label}、指導者 ${sim.winner.leaderName}）が${sim.turn}年で天下を統一、または最大の勢力となりました。`
      : `${sim.turn}年で全ての国家が滅亡しました。`;
    const landTotal = countLandCells(sim.map);
    const ranked = sim.nations.slice().sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (b.territorySize !== a.territorySize) return b.territorySize - a.territorySize;
      return (b.diedAtTick || 0) - (a.diedAtTick || 0);
    });
    endRanking.innerHTML = ranked.map((n, i) => {
      const pct = landTotal > 0 ? ((n.territorySize / landTotal) * 100).toFixed(1) : '0.0';
      const status = n.alive ? `領土 ${pct}%` : `${n.diedAtTick}年に滅亡`;
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
    if (manualPlacementActive) {
      ensurePlacementSlotCount(parseInt(nationCountSlider.value, 10));
      renderPreviewMap();
      updatePlacementSlotList();
    }
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

  function closeSetupOverlay() {
    if (!gameStarted) return; // the initial lobby can't be dismissed without starting
    setupOverlay.classList.add('hidden');
  }

  mapChoiceButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      currentPreset = btn.dataset.preset;
      mapChoiceButtons.forEach((b) => b.classList.toggle('active', b === btn));
      randomMapOptions.classList.toggle('hidden', currentPreset !== 'random');
      rebuildPreview();
    });
  });

  mapSettingsBtn.addEventListener('click', () => {
    setupOverlay.classList.add('dim');
    setupOverlay.classList.remove('hidden');
    msGenerateBtn.textContent = 'この設定で生成';
  });
  setupOverlay.addEventListener('click', (e) => {
    if (e.target === setupOverlay) closeSetupOverlay();
  });
  msRandomSeedBtn.addEventListener('click', () => {
    seedInput.value = String(Math.floor(Math.random() * 1e9));
    rebuildPreview();
  });
  msGenerateBtn.addEventListener('click', () => {
    let seed, extraConfig;
    if (startMode === 'fromZero' && manualPlacementActive) {
      randomFillRemainingSlots(); // silently fill any slots the user skipped
      extraConfig = {
        manualCapitals: placementSlots.filter(s => s.idx != null).map(s => ({ idx: s.idx, name: s.name })),
      };
      seed = previewSeed; // keep the exact terrain the user clicked on
    } else {
      seed = parseInt(seedInput.value, 10);
      if (!Number.isFinite(seed) || seed === lastGeneratedSeed) seed = Math.floor(Math.random() * 1e9);
    }
    createNewSimulation(seed, extraConfig);
    setupOverlay.classList.add('hidden');
    paused = false;
    playPauseBtn.textContent = '一時停止';
    if (!gameStarted) {
      gameStarted = true;
      requestAnimationFrame(frame);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (pendingDirective) { cancelDirective(); return; }
    if (!setupOverlay.classList.contains('hidden')) closeSetupOverlay();
  });

  window.addEventListener('resize', resizeMapCanvas);

  resizeMapCanvas();
})();
