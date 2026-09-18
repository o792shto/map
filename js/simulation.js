// Core turn-based simulation: expansion, war, random events, unrest/rebellion.

const DEFAULT_CONFIG = Object.freeze({
  width: 150,
  height: 100,
  nationCount: 8,
  maxTurns: 1500,
  endless: false,
});

class Simulation {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.seed = (config.seed != null) ? config.seed : Math.floor(Math.random() * 1e9);
    this.rng = new RNG(this.seed);
    this.map = new WorldMap(this.config.width, this.config.height, this.seed);
    this.nations = [];
    this.nationsById = {};
    this.turn = 0;
    this.ended = false;
    this.winner = null;
    this.eventLog = [];
    this.territoryHistory = [];
    this.onLog = null;
    this.onEnd = null;
    this._neighborMap = new Map();
    this.placeNations(this.config.nationCount);
    this.recomputeStats(); // establish foodTotal etc before first render
  }

  placeNations(count) {
    const map = this.map;
    const landCells = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.isLand(x, y)) landCells.push(map.idx(x, y));
      }
    }
    const shuffled = this.rng.shuffle(landCells);
    const capitals = [];
    let dist = Math.max(6, Math.floor(Math.min(map.width, map.height) / (count * 0.9)));
    while (capitals.length < count && dist >= 2) {
      for (const idx of shuffled) {
        if (capitals.length >= count) break;
        if (capitals.includes(idx)) continue;
        const x = idx % map.width, y = Math.floor(idx / map.width);
        let ok = true;
        for (const c of capitals) {
          const cx = c % map.width, cy = Math.floor(c / map.width);
          if (Math.hypot(x - cx, y - cy) < dist) { ok = false; break; }
        }
        if (ok) capitals.push(idx);
      }
      dist -= 2;
    }
    const colors = pickDistinctColors(capitals.length, this.rng);
    const personalities = Object.values(PERSONALITY);
    capitals.forEach((idx, i) => {
      const personality = this.rng.choice(personalities);
      const name = generateNationName(this.rng);
      const nation = new Nation(i, name, colors[i], personality, idx);
      nation.population = this.rng.float(60, 100);
      nation.military = this.rng.float(20, 40);
      nation.economy = this.rng.float(25, 45);
      map.owner[idx] = i;
      map.ownerSinceTick[idx] = 0;
      this.nations.push(nation);
      this.nationsById[i] = nation;
    });
  }

  log(text) {
    const entry = { turn: this.turn, text };
    this.eventLog.push(entry);
    if (this.eventLog.length > 500) this.eventLog.shift();
    if (this.onLog) this.onLog(entry);
  }

  claimCell(cellIdx, nation, conquered) {
    const map = this.map;
    const oldOwner = map.owner[cellIdx];
    if (oldOwner !== -1 && oldOwner !== nation.id) {
      const oldNation = this.nationsById[oldOwner];
      if (oldNation) oldNation.territory.delete(cellIdx);
    }
    map.owner[cellIdx] = nation.id;
    nation.territory.add(cellIdx);
    map.unrest[cellIdx] = conquered ? 35 : 0;
    map.ownerSinceTick[cellIdx] = this.turn;
  }

  getAlive() { return this.nations.filter(n => n.alive); }

  tick() {
    if (this.ended) return;
    this.turn++;
    const map = this.map;
    const aliveNations = this.getAlive();
    if (aliveNations.length === 0) { this.checkEnd(); return; }

    // --- single pass: gather expansion candidates & war borders ---
    const expansionCandidates = new Map();
    const warPairs = new Map();
    const neighborMap = new Map();
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = map.idx(x, y);
        const owner = map.owner[i];
        if (owner === -1) continue;
        for (const [nx, ny] of map.neighbors4(x, y)) {
          if (!map.isLand(nx, ny)) continue;
          const j = map.idx(nx, ny);
          const oOwner = map.owner[j];
          if (oOwner === -1) {
            if (!expansionCandidates.has(owner)) expansionCandidates.set(owner, new Set());
            expansionCandidates.get(owner).add(j);
          } else if (oOwner !== owner) {
            const a = Math.min(owner, oOwner), b = Math.max(owner, oOwner);
            const key = a + '-' + b;
            if (!warPairs.has(key)) warPairs.set(key, { a, b, cellsOfAAdjB: new Set(), cellsOfBAdjA: new Set() });
            const rec = warPairs.get(key);
            if (owner === a) rec.cellsOfAAdjB.add(i); else rec.cellsOfBAdjA.add(i);
            if (!neighborMap.has(a)) neighborMap.set(a, new Set());
            if (!neighborMap.has(b)) neighborMap.set(b, new Set());
            neighborMap.get(a).add(b);
            neighborMap.get(b).add(a);
          }
        }
      }
    }
    this._neighborMap = neighborMap;

    this.processExpansion(aliveNations, expansionCandidates);
    this.processWars(warPairs);
    this.processEvents(aliveNations);
    this.processUnrest(aliveNations);
    this.recomputeStats();
    this.recordHistory();
    this.checkEnd();
  }

  processExpansion(aliveNations, expansionCandidates) {
    const map = this.map;
    for (const nation of aliveNations) {
      const candidates = expansionCandidates.get(nation.id);
      if (!candidates || candidates.size === 0) continue;
      const info = nation.info;
      const power = (nation.population * 0.4 + nation.economy * 0.6) / 120;
      const maxClaims = 3;
      let claims = 0;
      const candArr = this.rng.shuffle([...candidates]);
      for (const cellIdx of candArr) {
        if (claims >= maxClaims) break;
        const biome = map.biome[cellIdx];
        const cost = BIOME_INFO[biome].cost;
        const prob = clamp(0.5 * power * info.expansionMul / cost, 0, 0.9);
        if (this.rng.chance(prob)) {
          this.claimCell(cellIdx, nation, false);
          claims++;
        }
      }
    }
  }

  processWars(warPairs) {
    for (const { a, b, cellsOfAAdjB, cellsOfBAdjA } of warPairs.values()) {
      const nationA = this.nationsById[a], nationB = this.nationsById[b];
      if (!nationA || !nationB || !nationA.alive || !nationB.alive) continue;
      let allied = nationA.allies.has(b);

      const aggressiveness = (nationA.info.warChanceMul + nationB.info.warChanceMul) / 2;
      let warChance = 0.15 * aggressiveness;
      if (allied) warChance *= 0.08;
      if (!this.rng.chance(warChance)) continue;

      if (allied) {
        const betrayChance = 0.35 * Math.max(nationA.info.betrayalMul, nationB.info.betrayalMul);
        if (!this.rng.chance(betrayChance)) continue;
        nationA.allies.delete(b);
        nationB.allies.delete(a);
        const traitor = this.rng.chance(0.5) ? nationA : nationB;
        const victim = traitor === nationA ? nationB : nationA;
        this.log(`${traitor.name}が${victim.name}を裏切り、同盟を破棄して攻撃を開始した！`);
        allied = false;
      }

      const strA = nationA.strength() * (1 + this.rng.float(-0.15, 0.15));
      const strB = nationB.strength() * (1 + this.rng.float(-0.15, 0.15));
      const total = strA + strB;
      if (total <= 0.001) continue;
      const winner = strA > strB ? nationA : nationB;
      const loser = winner === nationA ? nationB : nationA;
      const loserFrontier = loser.id === b ? [...cellsOfBAdjA] : [...cellsOfAAdjB];
      if (loserFrontier.length === 0) continue;

      const diff = Math.abs(strA - strB) / total;
      const captureCount = clamp(Math.round(1 + diff * 4), 1, 5);
      const captured = this.rng.shuffle(loserFrontier).slice(0, Math.min(captureCount, loserFrontier.length));
      for (const idx of captured) this.claimCell(idx, winner, true);

      const consumption = 0.12;
      winner.military = Math.max(0, winner.military - winner.military * consumption * 0.5);
      loser.military = Math.max(0, loser.military - loser.military * consumption);

      if (captured.length > 0) {
        this.log(`${winner.name}が${loser.name}と交戦し、${captured.length}地域を奪取した。`);
      }

      if (loser.territorySize === 0 && loser.alive) {
        loser.alive = false;
        loser.diedAtTick = this.turn;
        this.log(`${winner.name}が${loser.name}を滅ぼした！`);
      }
    }
  }

  processEvents(aliveNations) {
    for (const nation of aliveNations) {
      if (nation.territorySize === 0) continue;
      const info = nation.info;

      if (this.rng.chance(0.0025)) {
        nation.population = Math.max(1, nation.population * 0.65);
        this.log(`${nation.name}で疫病が流行し、人口が激減した。`);
        continue;
      }

      if (nation.foodTotal != null && nation.foodTotal < nation.population * 0.035 && this.rng.chance(0.02)) {
        nation.population = Math.max(1, nation.population * 0.78);
        this.log(`${nation.name}で飢饉が発生し、人口が減少した。`);
        continue;
      }

      if (this.rng.chance(0.003 * info.allianceMul)) {
        const neighborIds = [...(this._neighborMap.get(nation.id) || [])];
        const candidates = neighborIds.filter(id => !nation.allies.has(id) && this.nationsById[id] && this.nationsById[id].alive);
        if (candidates.length) {
          const otherId = this.rng.choice(candidates);
          const other = this.nationsById[otherId];
          nation.allies.add(otherId);
          other.allies.add(nation.id);
          this.log(`${nation.name}と${other.name}が同盟を締結した。`);
        }
      }

      if (this.rng.chance(0.002)) {
        nation.heroBoostTicks = 200;
        this.log(`${nation.name}に英雄が現れ、軍を鼓舞した！`);
      }
    }
  }

  processUnrest(aliveNations) {
    const map = this.map;
    const mapScale = Math.max(map.width, map.height) * 0.5;
    for (const nation of aliveNations) {
      if (nation.territorySize === 0) continue;
      const baseGrowth = 0.14 * nation.info.unrestMul;
      const capX = nation.capitalIdx % map.width, capY = Math.floor(nation.capitalIdx / map.width);
      const toRebel = [];
      for (const idx of nation.territory) {
        if (idx === nation.capitalIdx) {
          map.unrest[idx] = Math.max(0, map.unrest[idx] - 0.5);
          continue;
        }
        const age = this.turn - map.ownerSinceTick[idx];
        const x = idx % map.width, y = Math.floor(idx / map.width);
        const distFactor = clamp(Math.hypot(x - capX, y - capY) / mapScale, 0.25, 1.6);
        const u = map.unrest[idx];
        let delta;
        if (age < 60) {
          delta = baseGrowth * 1.6 * distFactor; // freshly annexed land resents new rule
        } else if (u < 45) {
          delta = -0.25; // settled frontier slowly assimilates
        } else {
          delta = baseGrowth * 0.5 * distFactor; // already resentful land keeps simmering
        }
        map.unrest[idx] = clamp(u + delta, 0, 100);
        if (map.unrest[idx] > 75 && this.rng.chance(0.015)) toRebel.push(idx);
      }
      for (const idx of toRebel) {
        nation.territory.delete(idx);
        map.owner[idx] = -1;
        map.unrest[idx] = 0;
      }
      if (toRebel.length > 0) {
        this.log(`${nation.name}の統治下で反乱が発生し、${toRebel.length}地域が独立した。`);
      }
      if (nation.territorySize === 0 && nation.alive) {
        nation.alive = false;
        nation.diedAtTick = this.turn;
        this.log(`${nation.name}が内部崩壊により消滅した。`);
      }
    }
  }

  recomputeStats() {
    const map = this.map;
    for (const nation of this.nations) {
      if (!nation.alive || nation.territorySize === 0) continue;
      let food = 0, gold = 0, iron = 0;
      for (const idx of nation.territory) {
        food += map.food[idx]; gold += map.gold[idx]; iron += map.iron[idx];
      }
      nation.foodTotal = food; nation.goldTotal = gold; nation.ironTotal = iron;
      const capacity = food * 8 + 10;
      nation.population += (capacity - nation.population) * 0.01;
      nation.population = clamp(nation.population, 0, 1e7);
      nation.economy = gold * 3 + iron * 1.5 + nation.population * 0.02;
      const militaryCapacity = nation.economy * 0.8 * nation.info.militaryMul + iron * 2;
      nation.military += (militaryCapacity - nation.military) * 0.02;
      nation.military = Math.max(0, nation.military);
      if (nation.heroBoostTicks > 0) nation.heroBoostTicks--;
    }
  }

  recordHistory() {
    if (this.turn % 3 !== 0) return;
    const entries = this.nations.map(n => ({ id: n.id, size: n.alive ? n.territorySize : 0 }));
    this.territoryHistory.push({ turn: this.turn, entries });
    if (this.territoryHistory.length > 2000) this.territoryHistory.shift();
  }

  checkEnd() {
    if (this.ended) return;
    const alive = this.getAlive();
    if (this.nations.length > 1 && alive.length <= 1) {
      this.ended = true;
      this.winner = alive[0] || null;
      this.log(alive[0] ? `${alive[0].name}が唯一残った国家として勝利した！` : '全ての国家が滅亡した。');
      if (this.onEnd) this.onEnd();
      return;
    }
    if (!this.config.endless && this.turn >= this.config.maxTurns) {
      this.ended = true;
      this.winner = alive.slice().sort((x, y) => y.territorySize - x.territorySize)[0] || null;
      this.log('規定ターン数に到達し、シミュレーションを終了した。');
      if (this.onEnd) this.onEnd();
    }
  }
}
