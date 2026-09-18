// Core turn-based simulation: expansion, diplomacy/war declarations, combat,
// naval crossings, random events, unrest/rebellion, and a running chronicle.

const DEFAULT_CONFIG = Object.freeze({
  width: 240,
  height: 150,
  nationCount: 8,
  maxTurns: 2000,
  endless: false,
});

const NAVAL_RANGE = 22;
const NAVAL_THROTTLE_TICKS = 5;

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
    this._navalContacts = new Map(); // "a-b" -> {a,b}
    this._landTotal = null;
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
      const leaderName = generateLeaderName(this.rng, personality);
      const nation = new Nation(i, name, colors[i], personality, idx, leaderName);
      nation.population = this.rng.float(60, 100);
      nation.military = this.rng.float(20, 40);
      nation.economy = this.rng.float(25, 45);
      map.owner[idx] = i;
      map.ownerSinceTick[idx] = 0;
      this.nations.push(nation);
      this.nationsById[i] = nation;
      const biomeName = BIOME_INFO[map.biome[idx]].name;
      this.log(`${name}が${biomeName}の地に建国された。指導者は${leaderName}（${PERSONALITY_INFO[personality].label}）。`);
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
    map.coastal = null; // ownership doesn't change coastlines, but be safe if biome ever does
  }

  getAlive() { return this.nations.filter(n => n.alive); }

  countLand() {
    if (this._landTotal != null) return this._landTotal;
    let c = 0;
    for (let i = 0; i < this.map.biome.length; i++) if (BIOME_INFO[this.map.biome[i]].passable) c++;
    this._landTotal = c;
    return c;
  }

  tick() {
    if (this.ended) return;
    this.turn++;
    const map = this.map;
    const aliveNations = this.getAlive();
    if (aliveNations.length === 0) { this.checkEnd(); return; }

    // --- single grid pass: gather expansion candidates & land border contacts ---
    const expansionCandidates = new Map();
    const borderPairs = new Map();
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
            if (!borderPairs.has(key)) borderPairs.set(key, { a, b, cellsOfAAdjB: new Set(), cellsOfBAdjA: new Set() });
            const rec = borderPairs.get(key);
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
    this.processNaval(aliveNations);
    this.processDiplomacy(aliveNations);
    this.processCombat(aliveNations, borderPairs);
    this.processPeace(aliveNations);
    this.processEvents(aliveNations);
    this.processUnrest(aliveNations);
    this.recomputeStats();
    this.recordHistory();
    if (this.turn % 150 === 0) this.logChronicle();
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

  // BFS across contiguous ocean from a coastal cell; returns land-cell indices
  // reachable within `range` sea hops (the first landfall in each direction,
  // i.e. a beachhead) regardless of who owns them.
  navalTargetsFrom(originIdx, range) {
    const map = this.map;
    const visited = new Set([originIdx]);
    let frontier = [originIdx];
    const landTargets = new Set();
    for (let step = 0; step < range && frontier.length; step++) {
      const next = [];
      for (const cur of frontier) {
        const cx = cur % map.width, cy = Math.floor(cur / map.width);
        for (const [nx, ny] of map.neighbors4(cx, cy)) {
          const ni = map.idx(nx, ny);
          if (visited.has(ni)) continue;
          visited.add(ni);
          if (map.biome[ni] === BIOME.OCEAN) {
            next.push(ni);
          } else {
            landTargets.add(ni);
          }
        }
      }
      frontier = next;
    }
    return [...landTargets];
  }

  registerNavalContact(idA, idB) {
    const a = Math.min(idA, idB), b = Math.max(idA, idB);
    this._navalContacts.set(a + '-' + b, { a, b });
  }

  // Overseas colonization of empty coastland, and amphibious invasion of
  // enemy coastland when already at war with them. Throttled since it walks
  // BFS fans out from several coastal cells per nation.
  processNaval(aliveNations) {
    if (this.turn % NAVAL_THROTTLE_TICKS !== 0) return;
    const map = this.map;
    this._navalContacts = new Map();
    const MAX_COLONIZE = 2, MAX_INVADE = 2;
    for (const nation of aliveNations) {
      if (nation.territorySize === 0) continue;
      const coastalCells = [...nation.territory].filter(idx => map.isCoastal(idx));
      if (coastalCells.length === 0) continue;
      const origins = this.rng.shuffle(coastalCells).slice(0, 3);
      let colonized = 0, invaded = 0;
      const invadedTargets = new Map(); // otherId -> count
      for (const origin of origins) {
        const targets = this.rng.shuffle(this.navalTargetsFrom(origin, NAVAL_RANGE)).slice(0, 6);
        for (const targetIdx of targets) {
          const owner = map.owner[targetIdx];
          if (owner === -1) {
            if (colonized >= MAX_COLONIZE) continue;
            const power = (nation.population * 0.4 + nation.economy * 0.6) / 120;
            const prob = clamp(0.1 * power * nation.info.expansionMul, 0, 0.3);
            if (this.rng.chance(prob)) {
              this.claimCell(targetIdx, nation, false);
              colonized++;
            }
          } else if (owner !== nation.id) {
            const other = this.nationsById[owner];
            if (!other || !other.alive) continue;
            this.registerNavalContact(nation.id, owner);
            if (invaded >= MAX_INVADE || !nation.isAtWarWith(owner) || !this.rng.chance(0.4)) continue;
            const strA = nation.strength() * (1 + this.rng.float(-0.2, 0.2));
            const strB = other.strength() * (1 + this.rng.float(-0.2, 0.2));
            if (strA > strB) {
              this.claimCell(targetIdx, nation, true);
              nation.military = Math.max(0, nation.military - nation.military * 0.08);
              other.military = Math.max(0, other.military - other.military * 0.05);
              invaded++;
              invadedTargets.set(other.id, (invadedTargets.get(other.id) || 0) + 1);
              if (other.territorySize === 0 && other.alive) {
                other.alive = false;
                other.diedAtTick = this.turn;
                nation.relations.delete(other.id);
                this.log(`${nation.name}が海上遠征の末、${other.name}を滅ぼした！`);
              }
            }
          }
        }
      }
      if (colonized > 0) {
        this.log(`${nation.name}が海を渡り、${colonized}箇所の新天地に入植した。`);
      }
      for (const [otherId, count] of invadedTargets) {
        const other = this.nationsById[otherId];
        if (other) this.log(`${nation.name}が海を越えて${other.name}領に上陸侵攻し、${count}地域を占領した。`);
      }
    }
  }

  declareWar(attacker, defender, reason) {
    attacker.relations.set(defender.id, 'war');
    defender.relations.set(attacker.id, 'war');
    attacker.warSinceTick.set(defender.id, this.turn);
    defender.warSinceTick.set(attacker.id, this.turn);
    this.log(`${attacker.name}（${attacker.leaderName}）が${defender.name}に宣戦布告した。理由: ${reason}`);
    attacker.recordEvent(this.turn, `${defender.name}に宣戦布告（${reason}）`);
    defender.recordEvent(this.turn, `${attacker.name}より宣戦布告を受けた（${reason}）`);
  }

  // Nations only go to war after an explicit declaration. Bordering (land or
  // naval-reachable) pairs at peace occasionally decide to declare war based
  // on personality and relative strength; allied pairs may instead betray.
  processDiplomacy(aliveNations) {
    const contactPairs = new Set();
    for (const [a, others] of this._neighborMap) {
      for (const b of others) if (a < b) contactPairs.add(a + '-' + b);
    }
    for (const key of this._navalContacts.keys()) contactPairs.add(key);

    for (const key of contactPairs) {
      const [aStr, bStr] = key.split('-');
      const nationA = this.nationsById[+aStr], nationB = this.nationsById[+bStr];
      if (!nationA || !nationB || !nationA.alive || !nationB.alive) continue;
      if (nationA.isAtWarWith(nationB.id)) continue;

      if (nationA.allies.has(nationB.id)) {
        const betrayChance = 0.006 * Math.max(nationA.info.betrayalMul, nationB.info.betrayalMul);
        if (this.rng.chance(betrayChance)) {
          nationA.allies.delete(nationB.id);
          nationB.allies.delete(nationA.id);
          const traitor = this.rng.chance(0.5) ? nationA : nationB;
          const victim = traitor === nationA ? nationB : nationA;
          this.declareWar(traitor, victim, '同盟の破棄と裏切り');
        }
        continue;
      }

      const aggressiveness = (nationA.info.warChanceMul + nationB.info.warChanceMul) / 2;
      const warChance = 0.01 * aggressiveness;
      if (this.rng.chance(warChance)) {
        const scoreA = nationA.strength() * nationA.info.warChanceMul + 1;
        const scoreB = nationB.strength() * nationB.info.warChanceMul + 1;
        const initiator = this.rng.chance(scoreA / (scoreA + scoreB)) ? nationA : nationB;
        const target = initiator === nationA ? nationB : nationA;
        this.declareWar(initiator, target, pickWarReason(this.rng));
      }
    }
  }

  // Resolves ongoing fights only between nations currently at war with each
  // other, and only where they share a land border this tick.
  processCombat(aliveNations, borderPairs) {
    const processed = new Set();
    for (const nation of aliveNations) {
      for (const [otherId, state] of nation.relations) {
        if (state !== 'war') continue;
        const other = this.nationsById[otherId];
        if (!other || !other.alive) continue;
        const a = Math.min(nation.id, otherId), b = Math.max(nation.id, otherId);
        const key = a + '-' + b;
        if (processed.has(key)) continue;
        processed.add(key);
        const rec = borderPairs.get(key);
        if (!rec) continue; // no shared land front this tick (naval combat handled in processNaval)
        if (!this.rng.chance(0.35)) continue; // not every front is active every tick
        this.resolveLandBattle(rec);
      }
    }
  }

  resolveLandBattle({ a, b, cellsOfAAdjB, cellsOfBAdjA }) {
    const nationA = this.nationsById[a], nationB = this.nationsById[b];
    const strA = nationA.strength() * (1 + this.rng.float(-0.15, 0.15));
    const strB = nationB.strength() * (1 + this.rng.float(-0.15, 0.15));
    const total = strA + strB;
    if (total <= 0.001) return;
    const winner = strA > strB ? nationA : nationB;
    const loser = winner === nationA ? nationB : nationA;
    const loserFrontier = loser.id === b ? [...cellsOfBAdjA] : [...cellsOfAAdjB];
    if (loserFrontier.length === 0) return;

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
      winner.relations.delete(loser.id);
      this.log(`${winner.name}が${loser.name}を滅ぼした！`);
      winner.recordEvent(this.turn, `${loser.name}を滅ぼし版図に加えた`);
    }
  }

  // At-war pairs periodically negotiate peace; exhausted or less aggressive
  // nations sue for it sooner.
  processPeace(aliveNations) {
    const processed = new Set();
    for (const nation of aliveNations) {
      for (const [otherId, state] of nation.relations) {
        if (state !== 'war') continue;
        const other = this.nationsById[otherId];
        if (!other) continue;
        const a = Math.min(nation.id, otherId), b = Math.max(nation.id, otherId);
        const key = a + '-' + b;
        if (processed.has(key)) continue;
        processed.add(key);
        if (!other.alive || nation.territorySize === 0 || other.territorySize === 0) continue;

        const duration = this.turn - (nation.warSinceTick.get(otherId) || this.turn);
        const combinedMilitary = nation.military + other.military;
        const combinedEconomy = (nation.economy + other.economy) * 0.8 + 1;
        const exhaustion = clamp(1 - combinedMilitary / combinedEconomy, 0, 1);
        const warDesire = (nation.info.warChanceMul + other.info.warChanceMul) / 2;
        const peaceChance = clamp((0.002 + duration * 0.00004 + exhaustion * 0.01) / warDesire, 0, 0.05);
        if (this.rng.chance(peaceChance)) {
          nation.relations.delete(otherId);
          other.relations.delete(nation.id);
          nation.warSinceTick.delete(otherId);
          other.warSinceTick.delete(nation.id);
          this.log(`${nation.name}と${other.name}が休戦協定を結んだ。`);
          nation.recordEvent(this.turn, `${other.name}と休戦`);
          other.recordEvent(this.turn, `${nation.name}と休戦`);
        }
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
        nation.recordEvent(this.turn, '疫病が流行');
        continue;
      }

      if (nation.foodTotal != null && nation.foodTotal < nation.population * 0.035 && this.rng.chance(0.02)) {
        nation.population = Math.max(1, nation.population * 0.78);
        this.log(`${nation.name}で飢饉が発生し、人口が減少した。`);
        nation.recordEvent(this.turn, '飢饉が発生');
        continue;
      }

      if (this.rng.chance(0.003 * info.allianceMul)) {
        const neighborIds = [...(this._neighborMap.get(nation.id) || [])];
        const candidates = neighborIds.filter(id =>
          !nation.allies.has(id) && !nation.isAtWarWith(id) &&
          this.nationsById[id] && this.nationsById[id].alive);
        if (candidates.length) {
          const otherId = this.rng.choice(candidates);
          const other = this.nationsById[otherId];
          nation.allies.add(otherId);
          other.allies.add(nation.id);
          this.log(`${nation.name}と${other.name}が同盟を締結した。`);
          nation.recordEvent(this.turn, `${other.name}と同盟`);
          other.recordEvent(this.turn, `${nation.name}と同盟`);
        }
      }

      if (this.rng.chance(0.002)) {
        nation.heroBoostTicks = 200;
        this.log(`${nation.name}に英雄が現れ、軍を鼓舞した！`);
        nation.recordEvent(this.turn, '英雄の出現');
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
        nation.recordEvent(this.turn, `反乱で${toRebel.length}地域を喪失`);
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

  logChronicle() {
    const alive = this.getAlive().slice().sort((a, b) => b.territorySize - a.territorySize);
    if (alive.length === 0) return;
    const landTotal = this.countLand();
    const top = alive.slice(0, 3)
      .map(n => `${n.name}(${((n.territorySize / landTotal) * 100).toFixed(0)}%)`)
      .join('、');
    this.log(`【年代記 T${this.turn}】情勢: ${top}。生存国家数: ${alive.length}。`);
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
