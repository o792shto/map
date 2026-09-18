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

    const preset = this.config.presetId && PRESET_MAPS[this.config.presetId];
    const mapOptions = {
      seaLevel: this.config.seaLevel,
      mountainThreshold: this.config.mountainThreshold,
      coastPasses: this.config.coastPasses,
    };
    let mapWidth = this.config.width, mapHeight = this.config.height;
    if (preset) {
      mapWidth = preset.width;
      mapHeight = preset.height;
      mapOptions.presetMask = decodePresetMask(preset);
    }
    this.map = new WorldMap(mapWidth, mapHeight, this.seed, mapOptions);
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

  // Random capitals, spread at least `dist` cells apart (relaxed if the map
  // can't fit that many), skipping any cell already in `avoidIdxs`.
  pickRandomCapitals(count, avoidIdxs) {
    const map = this.map;
    const landCells = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.isLand(x, y)) landCells.push(map.idx(x, y));
      }
    }
    const shuffled = this.rng.shuffle(landCells);
    const capitals = [];
    const taken = capitals.concat(avoidIdxs);
    let dist = Math.max(6, Math.floor(Math.min(map.width, map.height) / (count * 0.9)));
    while (capitals.length < count && dist >= 2) {
      for (const idx of shuffled) {
        if (capitals.length >= count) break;
        if (taken.includes(idx) || capitals.includes(idx)) continue;
        const x = idx % map.width, y = Math.floor(idx / map.width);
        let ok = true;
        for (const c of taken.concat(capitals)) {
          const cx = c % map.width, cy = Math.floor(c / map.width);
          if (Math.hypot(x - cx, y - cy) < dist) { ok = false; break; }
        }
        if (ok) capitals.push(idx);
      }
      dist -= 2;
    }
    return capitals;
  }

  // Claims land outward from a fresh capital via BFS until `targetSize`
  // cells are held (or the reachable landmass runs out / bumps into another
  // nation), so "established" nations start with a real foothold rather
  // than a single pixel.
  seedInitialTerritory(nation, targetSize) {
    const map = this.map;
    const visited = new Set([nation.capitalIdx]);
    const queue = [nation.capitalIdx];
    const claimed = [];
    let qi = 0;
    while (qi < queue.length && claimed.length < targetSize) {
      const cur = queue[qi++];
      const cx = cur % map.width, cy = Math.floor(cur / map.width);
      for (const [nx, ny] of map.neighbors4(cx, cy)) {
        if (!map.isLand(nx, ny)) continue;
        const ni = map.idx(nx, ny);
        if (visited.has(ni)) continue;
        visited.add(ni);
        if (map.owner[ni] !== -1) continue; // bumped into another nation's land
        queue.push(ni);
        claimed.push(ni);
        if (claimed.length >= targetSize) break;
      }
    }
    for (const idx of claimed) this.claimCell(idx, nation, false);
  }

  placeNations(count) {
    const map = this.map;
    const manual = (this.config.manualCapitals || []).filter(c => c && c.idx != null).slice(0, count);
    let capitalSpecs = manual.slice();
    if (capitalSpecs.length < count) {
      const avoid = capitalSpecs.map(c => c.idx);
      const extra = this.pickRandomCapitals(count - capitalSpecs.length, avoid);
      capitalSpecs = capitalSpecs.concat(extra.map(idx => ({ idx })));
    }

    const colors = pickDistinctColors(capitalSpecs.length, this.rng);
    const personalities = Object.values(PERSONALITY);
    const politicalSystems = Object.values(POLITICAL_SYSTEM);
    const lifestyles = Object.values(LIFESTYLE);
    const established = this.config.startMode !== 'fromZero';
    const landTotal = this.countLand();
    const initialSize = clamp(Math.round(Math.sqrt(landTotal / capitalSpecs.length) * 1.5), 8, 60);

    capitalSpecs.forEach((spec, i) => {
      const idx = spec.idx;
      const personality = this.rng.choice(personalities);
      const politicalSystem = this.rng.choice(politicalSystems);
      const lifestyle = this.rng.choice(lifestyles);
      const trait = pickTrait(this.rng);
      const name = (spec.name && spec.name.trim()) || generateNationName(this.rng);
      const leaderName = generateLeaderName(this.rng, personality);
      const nation = new Nation(i, name, colors[i], personality, idx, leaderName, politicalSystem, lifestyle, trait);
      if (spec.name && spec.name.trim()) nation.userNamed = true;
      nation.population = this.rng.float(60, 100);
      nation.military = this.rng.float(20, 40);
      nation.economy = this.rng.float(25, 45);
      map.owner[idx] = i;
      map.ownerSinceTick[idx] = 0;
      this.nations.push(nation);
      this.nationsById[i] = nation;
      if (established) this.seedInitialTerritory(nation, initialSize);
      const biomeName = BIOME_INFO[map.biome[idx]].name;
      this.log(`${name}（${POLITICAL_SYSTEM_INFO[politicalSystem].label}・${LIFESTYLE_INFO[lifestyle].label}）が${biomeName}の地に建国された。指導者は${leaderName}（${PERSONALITY_INFO[personality].label}、${trait.label}）。`, 'found');
    });
  }

  // `kind` categorizes the entry for the UI (log color-coding, and a toast
  // banner for the subset of kinds worth interrupting the player for).
  log(text, kind = 'info') {
    const entry = { turn: this.turn, text, kind };
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

  capitalDistance(a, b) {
    const w = this.map.width;
    const ax = a.capitalIdx % w, ay = Math.floor(a.capitalIdx / w);
    const bx = b.capitalIdx % w, by = Math.floor(b.capitalIdx / w);
    return Math.hypot(ax - bx, ay - by);
  }

  // Where a nation "leans" its everyday (non-directed) growth: strongly
  // toward the nearest nation it's at war with (a visible front line),
  // more mildly toward the nearest nation it's merely in contact with.
  // Without this, growth is a uniform blob with no sense of who's pushing
  // against whom.
  computeFocusPoint(nation) {
    let bestWar = null, bestWarDist = Infinity;
    for (const [otherId, state] of nation.relations) {
      if (state !== 'war') continue;
      const other = this.nationsById[otherId];
      if (!other || !other.alive || other.territorySize === 0) continue;
      const d = this.capitalDistance(nation, other);
      if (d < bestWarDist) { bestWarDist = d; bestWar = other; }
    }
    if (bestWar) return { idx: bestWar.capitalIdx, strength: 1.8 };

    const contactIds = new Set(this._neighborMap.get(nation.id) || []);
    for (const { a, b } of this._navalContacts.values()) {
      if (a === nation.id) contactIds.add(b);
      else if (b === nation.id) contactIds.add(a);
    }
    let bestNeighbor = null, bestNeighborDist = Infinity;
    for (const otherId of contactIds) {
      const other = this.nationsById[otherId];
      if (!other || !other.alive || other.territorySize === 0) continue;
      const d = this.capitalDistance(nation, other);
      if (d < bestNeighborDist) { bestNeighborDist = d; bestNeighbor = other; }
    }
    if (bestNeighbor) return { idx: bestNeighbor.capitalIdx, strength: 1.3 };
    return null;
  }

  // Per-(nation, candidate-cell) claim probability, isolated from the
  // resolution logic below so it can be reused for both uncontested cells
  // (one bidder) and contested no-man's-land cells (two+ nations bidding on
  // the same empty cell at once).
  expansionBidProb(nation, ctx, cellIdx) {
    const map = this.map;
    const cost = BIOME_INFO[map.biome[cellIdx]].cost;
    let prob = clamp(0.5 * ctx.power * nation.mods.expansionMul / cost, 0, 0.9);
    if (ctx.directed) {
      prob = clamp(prob * 1.6, 0, 0.95); // player-directed expansion pushes harder
    } else if (ctx.focus) {
      // Cells that bring us closer to the rival than our capital already is
      // get pushed harder; cells that grow away from the front are held
      // back, so territory visibly leans toward the conflict.
      const cx = cellIdx % map.width, cy = Math.floor(cellIdx / map.width);
      const cellToFocus = Math.hypot(cx - ctx.fx, cy - ctx.fy);
      prob = cellToFocus < ctx.capToFocus
        ? clamp(prob * ctx.focus.strength, 0, 0.95)
        : clamp(prob * (2 - ctx.focus.strength), 0, 0.9);
    }
    return prob;
  }

  // Growing territory used to let every bordering nation roll independently
  // for the very same empty cell, so a contested strip between two expanding
  // nations resolved as an interlaced, checkerboard-like mess instead of a
  // clean front line. Cells with only one bidder still resolve with a plain
  // probability roll as before; cells two or more nations are reaching for
  // are resolved once, with a single weighted winner, so a front settles
  // along a coherent line instead of flickering cell-by-cell.
  processExpansion(aliveNations, expansionCandidates) {
    const map = this.map;
    for (const nation of aliveNations) {
      if (nation.directiveTarget && this.turn > nation.directiveTarget.expiresAtTurn) {
        nation.directiveTarget = null;
      }
    }

    const cellBidders = new Map(); // cellIdx -> [nationId, ...]
    for (const [nationId, candSet] of expansionCandidates) {
      for (const cellIdx of candSet) {
        if (!cellBidders.has(cellIdx)) cellBidders.set(cellIdx, []);
        cellBidders.get(cellIdx).push(nationId);
      }
    }

    const nationCtx = new Map();
    for (const nation of aliveNations) {
      if (!expansionCandidates.has(nation.id)) continue;
      const directed = nation.directiveTarget;
      const focus = directed ? null : this.computeFocusPoint(nation);
      const capX = nation.capitalIdx % map.width, capY = Math.floor(nation.capitalIdx / map.width);
      const fx = focus ? focus.idx % map.width : 0, fy = focus ? Math.floor(focus.idx / map.width) : 0;
      nationCtx.set(nation.id, {
        power: (nation.population * 0.4 + nation.economy * 0.6) / 120,
        directed, focus, fx, fy,
        capToFocus: focus ? Math.hypot(capX - fx, capY - fy) : 0,
        claims: 0,
        maxClaims: directed ? 5 : 3,
      });
    }

    // Contested cells first, resolved one at a time in random order.
    const contestedCells = this.rng.shuffle(
      [...cellBidders.entries()].filter(([, ids]) => ids.length > 1).map(([idx]) => idx)
    );
    for (const cellIdx of contestedCells) {
      const bids = [];
      for (const nationId of cellBidders.get(cellIdx)) {
        const ctx = nationCtx.get(nationId);
        if (!ctx || ctx.claims >= ctx.maxClaims) continue;
        const nation = this.nationsById[nationId];
        const prob = this.expansionBidProb(nation, ctx, cellIdx);
        if (prob > 0) bids.push({ nation, ctx, prob });
      }
      if (bids.length === 0) continue;
      const pAny = 1 - bids.reduce((acc, b) => acc * (1 - b.prob), 1);
      if (!this.rng.chance(pAny)) continue;
      const totalWeight = bids.reduce((s, b) => s + b.prob, 0);
      let r = this.rng.float(0, totalWeight);
      let winner = bids[bids.length - 1];
      for (const b of bids) {
        r -= b.prob;
        if (r <= 0) { winner = b; break; }
      }
      this.claimCell(cellIdx, winner.nation, false);
      winner.ctx.claims++;
    }

    // Uncontested cells: same plain roll as before, per nation, with the
    // player-directed target (nearest-first) or war-focus shuffle preserved.
    for (const nation of aliveNations) {
      const ctx = nationCtx.get(nation.id);
      if (!ctx || ctx.claims >= ctx.maxClaims) continue;
      const candidates = expansionCandidates.get(nation.id);
      let candArr = [...candidates].filter((idx) => cellBidders.get(idx).length === 1);
      if (candArr.length === 0) continue;
      if (ctx.directed) {
        const tx = ctx.directed.idx % map.width, ty = Math.floor(ctx.directed.idx / map.width);
        candArr.sort((c1, c2) => {
          const x1 = c1 % map.width, y1 = Math.floor(c1 / map.width);
          const x2 = c2 % map.width, y2 = Math.floor(c2 / map.width);
          return Math.hypot(x1 - tx, y1 - ty) - Math.hypot(x2 - tx, y2 - ty);
        });
      } else {
        candArr = this.rng.shuffle(candArr);
      }
      for (const cellIdx of candArr) {
        if (ctx.claims >= ctx.maxClaims) break;
        const prob = this.expansionBidProb(nation, ctx, cellIdx);
        if (this.rng.chance(prob)) {
          this.claimCell(cellIdx, nation, false);
          ctx.claims++;
        }
      }
    }
  }

  // BFS across contiguous ocean from a coastal cell; returns land-cell indices
  // reachable within `range` sea hops (the first landfall in each direction,
  // i.e. a beachhead) regardless of who owns them. Only cells on a *different*
  // landmass than the origin are returned: a naval crossing represents
  // reaching a real overseas island/continent, not hopping a few cells across
  // a bay to an unclaimed pocket on the nation's own mainland (which used to
  // spawn odd, unearned exclaves with no land route back to the capital).
  navalTargetsFrom(originIdx, range) {
    const map = this.map;
    const homeLandmass = map.getLandmassId(originIdx);
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
          } else if (map.getLandmassId(ni) !== homeLandmass) {
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
            const prob = clamp(0.1 * power * nation.mods.expansionMul * nation.mods.navalMul, 0, 0.3);
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
                this.log(`${nation.name}が海上遠征の末、${other.name}を滅ぼした！`, 'death');
              }
            }
          }
        }
      }
      if (colonized > 0) {
        this.log(`${nation.name}が海を渡り、${colonized}箇所の新天地に入植した。`, 'naval');
      }
      for (const [otherId, count] of invadedTargets) {
        const other = this.nationsById[otherId];
        if (other) this.log(`${nation.name}が海を越えて${other.name}領に上陸侵攻し、${count}地域を占領した。`, 'naval');
      }
    }
  }

  declareWar(attacker, defender, reason) {
    attacker.relations.set(defender.id, 'war');
    defender.relations.set(attacker.id, 'war');
    attacker.warSinceTick.set(defender.id, this.turn);
    defender.warSinceTick.set(attacker.id, this.turn);
    attacker.adjustRelation(defender.id, -40);
    defender.adjustRelation(attacker.id, -40);
    this.log(`${attacker.name}（${attacker.leaderName}）が${defender.name}に宣戦布告した。理由: ${reason}`, 'war');
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
        const betrayChance = 0.006 * Math.max(nationA.mods.betrayalMul, nationB.mods.betrayalMul);
        if (this.rng.chance(betrayChance)) {
          nationA.allies.delete(nationB.id);
          nationB.allies.delete(nationA.id);
          const traitor = this.rng.chance(0.5) ? nationA : nationB;
          const victim = traitor === nationA ? nationB : nationA;
          traitor.adjustRelation(victim.id, -60);
          victim.adjustRelation(traitor.id, -60);
          this.declareWar(traitor, victim, '同盟の破棄と裏切り');
        } else {
          nationA.adjustRelation(nationB.id, 0.4);
          nationB.adjustRelation(nationA.id, 0.4);
        }
        continue;
      }

      // Shared political system or lifestyle breeds slow cultural affinity;
      // otherwise relations drift gently back toward neutral.
      const affinity = (nationA.politicalSystem === nationB.politicalSystem || nationA.lifestyle === nationB.lifestyle) ? 0.06 : -0.02;
      nationA.adjustRelation(nationB.id, affinity);
      nationB.adjustRelation(nationA.id, affinity);

      const relScore = nationA.getRelation(nationB.id);
      const aggressiveness = (nationA.mods.warChanceMul + nationB.mods.warChanceMul) / 2;
      const relationFactor = clamp(1 - relScore / 120, 0.4, 1.8);
      const warChance = 0.01 * aggressiveness * relationFactor;
      if (this.rng.chance(warChance)) {
        const scoreA = nationA.strength() * nationA.mods.warChanceMul + 1;
        const scoreB = nationB.strength() * nationB.mods.warChanceMul + 1;
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
    winner.adjustRelation(loser.id, -3);
    loser.adjustRelation(winner.id, -3);

    if (captured.length > 0) {
      this.log(`${winner.name}が${loser.name}と交戦し、${captured.length}地域を奪取した。`, 'battle');
    }

    if (loser.territorySize === 0 && loser.alive) {
      loser.alive = false;
      loser.diedAtTick = this.turn;
      winner.relations.delete(loser.id);
      this.log(`${winner.name}が${loser.name}を滅ぼした！`, 'death');
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
        const warDesire = (nation.mods.warChanceMul + other.mods.warChanceMul) / 2;
        const relScore = nation.getRelation(otherId);
        const relationFactor = clamp(1 + relScore / 150, 0.5, 2);
        const peaceChance = clamp((0.002 + duration * 0.00004 + exhaustion * 0.01) * relationFactor / warDesire, 0, 0.06);
        if (this.rng.chance(peaceChance)) {
          nation.relations.delete(otherId);
          other.relations.delete(nation.id);
          nation.warSinceTick.delete(otherId);
          other.warSinceTick.delete(nation.id);
          nation.adjustRelation(otherId, 15);
          other.adjustRelation(nation.id, 15);
          this.log(`${nation.name}と${other.name}が休戦協定を結んだ。`, 'peace');
          nation.recordEvent(this.turn, `${other.name}と休戦`);
          other.recordEvent(this.turn, `${nation.name}と休戦`);
        }
      }
    }
  }

  // Flavor text for a succession/legitimacy crisis, tuned to how the nation
  // is actually governed so the same mechanical hit (military & economy
  // dip, a flare of unrest) reads as a different kind of history each time.
  successionFlavor(nation) {
    switch (nation.politicalSystem) {
      case POLITICAL_SYSTEM.MONARCHY: return '王位継承を巡る争いが勃発し';
      case POLITICAL_SYSTEM.TRIBAL: return '有力部族間の内紛が激化し';
      case POLITICAL_SYSTEM.THEOCRACY: return '教義解釈を巡る宗派対立が起こり';
      case POLITICAL_SYSTEM.REPUBLIC: return '深刻な政争と汚職疑惑が広がり';
      case POLITICAL_SYSTEM.FEDERATION: return '構成諸州の足並みが乱れ';
      default: return '国内の混乱が広がり';
    }
  }

  // Flavor for a natural disaster, picked from the capital's terrain so the
  // hazard fits the land (mountains quake, forests/plains burn, coasts flood).
  disasterFlavor(nation) {
    const biome = this.map.biome[nation.capitalIdx];
    if (biome === BIOME.MOUNTAIN) return '大地震';
    if (biome === BIOME.DESERT) return '大干ばつ';
    if (this.map.isCoastal(nation.capitalIdx)) return '大洪水';
    return '大火災';
  }

  processEvents(aliveNations) {
    for (const nation of aliveNations) {
      if (nation.territorySize === 0) continue;
      const mods = nation.mods;

      if (this.rng.chance(0.0025)) {
        nation.population = Math.max(1, nation.population * 0.65);
        this.log(`${nation.name}で疫病が流行し、人口が激減した。`, 'plague');
        nation.recordEvent(this.turn, '疫病が流行');
        continue;
      }

      if (nation.foodTotal != null && nation.foodTotal < nation.population * 0.035 && this.rng.chance(0.02)) {
        nation.population = Math.max(1, nation.population * 0.78);
        this.log(`${nation.name}で飢饉が発生し、人口が減少した。`, 'famine');
        nation.recordEvent(this.turn, '飢饉が発生');
        continue;
      }

      // A prosperous era: population and economy surge together, the polar
      // opposite of plague/famine, so good times are visible as often as bad.
      if (this.rng.chance(0.0018)) {
        nation.population = Math.min(nation.population * 1.25, nation.population + 40);
        nation.economy *= 1.2;
        this.log(`${nation.name}に黄金時代が到来し、国力が大いに栄えた。`, 'goldenage');
        nation.recordEvent(this.turn, '黄金時代の到来');
        continue;
      }

      // A legitimacy crisis: military and economy dip, and a handful of
      // territories flare up in unrest, flavored to match how the nation
      // is actually governed.
      if (this.rng.chance(0.0016)) {
        nation.military *= 0.75;
        nation.economy *= 0.9;
        const territoryArr = [...nation.territory];
        for (const idx of this.rng.shuffle(territoryArr).slice(0, 8)) {
          this.map.unrest[idx] = clamp(this.map.unrest[idx] + 20, 0, 100);
        }
        this.log(`${nation.name}で${this.successionFlavor(nation)}、国内が動揺した。`, 'crisis');
        nation.recordEvent(this.turn, '国内の継承・政争危機');
        continue;
      }

      // Natural disaster: a one-off economic/military shock flavored by the
      // capital's terrain, independent of war or internal politics.
      if (this.rng.chance(0.0016)) {
        const kind = this.disasterFlavor(nation);
        nation.economy *= 0.82;
        nation.military = Math.max(0, nation.military - nation.military * 0.12);
        this.log(`${nation.name}を${kind}が襲い、国土に大きな被害をもたらした。`, 'disaster');
        nation.recordEvent(this.turn, `${kind}による被害`);
        continue;
      }

      // Barbarian/raider incursion along the frontier: more common for
      // tribal and nomadic peoples living on the edges of settled land.
      const frontierRisk = (nation.politicalSystem === POLITICAL_SYSTEM.TRIBAL ? 2.2 : 1)
        * (nation.lifestyle === LIFESTYLE.NOMADIC ? 1.6 : 1);
      if (this.rng.chance(0.0011 * frontierRisk)) {
        nation.military = Math.max(0, nation.military - nation.military * 0.15);
        this.log(`${nation.name}の国境地帯に異民族の侵入があり、防衛線が乱れた。`, 'raid');
        nation.recordEvent(this.turn, '異民族の侵入');
        continue;
      }

      // Peaceful hand-off of leadership: no mechanical penalty, mostly a
      // narrative beat that keeps a centuries-long run from having a single
      // immortal ruler the whole way through.
      if (this.rng.chance(0.0013)) {
        const newLeader = generateLeaderName(this.rng, nation.personality);
        const oldLeader = nation.leaderName;
        nation.leaderName = newLeader;
        this.log(`${nation.name}で指導者${oldLeader}の代替わりがあり、${newLeader}が新たに即位した。`, 'succession');
        nation.recordEvent(this.turn, `${newLeader}が新指導者に即位`);
      }

      // Age-of-exploration flavor for seafaring peoples: an expedition finds
      // and settles new coastland outright, on top of the regular slow
      // naval colonization roll.
      if ((nation.lifestyle === LIFESTYLE.MARITIME || nation.lifestyle === LIFESTYLE.FISHING) && this.rng.chance(0.0015)) {
        const coastalCells = [...nation.territory].filter((idx) => this.map.isCoastal(idx));
        if (coastalCells.length) {
          const origin = this.rng.choice(coastalCells);
          const targets = this.navalTargetsFrom(origin, NAVAL_RANGE).filter((idx) => this.map.owner[idx] === -1);
          if (targets.length) {
            const claimed = this.rng.choice(targets);
            this.claimCell(claimed, nation, false);
            this.log(`${nation.name}の船団が新たな海岸を発見し、入植地を築いた。`, 'exploration');
            nation.recordEvent(this.turn, '新天地の発見と入植');
          }
        }
      }

      // Good governance: an active, deliberate calming of unrest, the
      // counterweight to the slow creep modeled in processUnrest.
      if (this.rng.chance(0.0018)) {
        for (const idx of nation.territory) {
          this.map.unrest[idx] = Math.max(0, this.map.unrest[idx] - 30);
        }
        this.log(`${nation.name}で善政が敷かれ、各地の民心が落ち着きを取り戻した。`, 'governance');
        nation.recordEvent(this.turn, '善政による民心安定');
      }

      // Trade boom: a one-off economic windfall, more likely for merchant-
      // minded or seafaring nations with routes to profit from.
      const tradeAffinity = (nation.personality === PERSONALITY.MERCHANT ? 1.8 : 1)
        * (nation.trait && nation.trait.id === 'trade' ? 1.5 : 1);
      if (this.rng.chance(0.0018 * tradeAffinity)) {
        nation.economy *= 1.18;
        this.log(`${nation.name}で交易が空前の活況を呈し、国庫が潤った。`, 'trade');
        nation.recordEvent(this.turn, '交易ブーム');
      }

      if (this.rng.chance(0.003 * mods.allianceMul)) {
        const neighborIds = [...(this._neighborMap.get(nation.id) || [])];
        const candidates = neighborIds.filter(id =>
          !nation.allies.has(id) && !nation.isAtWarWith(id) && nation.getRelation(id) > -10 &&
          this.nationsById[id] && this.nationsById[id].alive);
        if (candidates.length) {
          const otherId = this.rng.choice(candidates);
          const other = this.nationsById[otherId];
          nation.allies.add(otherId);
          other.allies.add(nation.id);
          nation.adjustRelation(otherId, 25);
          other.adjustRelation(nation.id, 25);
          this.log(`${nation.name}と${other.name}が同盟を締結した。`, 'alliance');
          nation.recordEvent(this.turn, `${other.name}と同盟`);
          other.recordEvent(this.turn, `${nation.name}と同盟`);
        }
      }

      if (this.rng.chance(0.002)) {
        nation.heroBoostTicks = 200;
        this.log(`${nation.name}に英雄が現れ、軍を鼓舞した！`, 'hero');
        nation.recordEvent(this.turn, '英雄の出現');
      }
    }
  }

  // A cell fully boxed in by the same nation's own territory on every side
  // (no coastline, no foreign or unclaimed neighbor). Letting these rebel at
  // the normal rate punches random single-cell holes deep inside otherwise
  // solid territory, which reads as unrealistic salt-and-pepper noise rather
  // than a believable secession.
  isInteriorCell(nation, x, y, map) {
    for (const [nx, ny] of map.neighbors4(x, y)) {
      if (map.owner[map.idx(nx, ny)] !== nation.id) return false;
    }
    return true;
  }

  processUnrest(aliveNations) {
    const map = this.map;
    const mapScale = Math.max(map.width, map.height) * 0.5;
    for (const nation of aliveNations) {
      if (nation.territorySize === 0) continue;
      const baseGrowth = 0.14 * nation.mods.unrestMul;
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
        if (map.unrest[idx] > 75) {
          const interior = this.isInteriorCell(nation, x, y, map);
          if (this.rng.chance(interior ? 0.0007 : 0.015)) toRebel.push(idx);
        }
      }
      for (const idx of toRebel) {
        nation.territory.delete(idx);
        map.owner[idx] = -1;
        map.unrest[idx] = 0;
      }
      if (toRebel.length > 0) {
        this.log(`${nation.name}の統治下で反乱が発生し、${toRebel.length}地域が独立した。`, 'rebellion');
        nation.recordEvent(this.turn, `反乱で${toRebel.length}地域を喪失`);
      }
      if (nation.territorySize === 0 && nation.alive) {
        nation.alive = false;
        nation.diedAtTick = this.turn;
        this.log(`${nation.name}が内部崩壊により消滅した。`, 'death');
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
      const capacity = food * nation.mods.foodMul * 8 + 10;
      nation.population += (capacity - nation.population) * 0.01;
      nation.population = clamp(nation.population, 0, 1e7);
      nation.economy = gold * 3 + iron * 1.5 + nation.population * 0.02;
      const militaryCapacity = nation.economy * 0.8 * nation.mods.militaryMul + iron * 2;
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
    this.log(`【年代記 ${this.turn}年】情勢: ${top}。生存国家数: ${alive.length}。`, 'chronicle');
  }

  checkEnd() {
    if (this.ended) return;
    const alive = this.getAlive();
    if (this.nations.length > 1 && alive.length <= 1) {
      this.ended = true;
      this.winner = alive[0] || null;
      this.log(alive[0] ? `${alive[0].name}が唯一残った国家として勝利した！` : '全ての国家が滅亡した。', 'end');
      if (this.onEnd) this.onEnd();
      return;
    }
    if (!this.config.endless && this.turn >= this.config.maxTurns) {
      this.ended = true;
      this.winner = alive.slice().sort((x, y) => y.territorySize - x.territorySize)[0] || null;
      this.log('既定の年数に到達し、シミュレーションを終了した。', 'end');
      if (this.onEnd) this.onEnd();
    }
  }

  // --- Player directives -------------------------------------------------
  // Lightweight "nudges": the player picks a nation and a target, and the
  // simulation biases or immediately resolves that one decision, while
  // everything else keeps running on its own (semi-automatic, not manual
  // unit control).

  issueExpansionDirective(nationId, cellIdx) {
    const nation = this.nationsById[nationId];
    if (!nation || !nation.alive || cellIdx == null) return false;
    if (!this.map.isLand(cellIdx % this.map.width, Math.floor(cellIdx / this.map.width))) return false;
    nation.directiveTarget = { idx: cellIdx, expiresAtTurn: this.turn + 200 };
    this.log(`${nation.name}の指導者${nation.leaderName}が新たな拡張方針を示した。`, 'directive');
    nation.recordEvent(this.turn, '拡張方針を指示');
    return true;
  }

  issueDeclareWar(nationId, targetId) {
    const nation = this.nationsById[nationId], target = this.nationsById[targetId];
    if (!nation || !target || !nation.alive || !target.alive) return false;
    if (nation.isAtWarWith(targetId)) return false;
    nation.allies.delete(targetId);
    target.allies.delete(nationId);
    this.declareWar(nation, target, '指導者の決断による開戦');
    return true;
  }

  issueProposeAlliance(nationId, targetId) {
    const nation = this.nationsById[nationId], target = this.nationsById[targetId];
    if (!nation || !target || !nation.alive || !target.alive) return false;
    if (nation.isAtWarWith(targetId) || nation.allies.has(targetId)) return false;
    const rel = nation.getRelation(targetId);
    const chance = clamp(0.3 + rel / 150, 0.05, 0.9);
    if (this.rng.chance(chance)) {
      nation.allies.add(targetId);
      target.allies.add(nationId);
      nation.adjustRelation(targetId, 25);
      target.adjustRelation(nationId, 25);
      this.log(`${nation.name}の提案により、${nation.name}と${target.name}が同盟を締結した。`, 'alliance');
      nation.recordEvent(this.turn, `${target.name}と同盟（指導者提案）`);
      target.recordEvent(this.turn, `${nation.name}と同盟（指導者提案）`);
    } else {
      this.log(`${nation.name}の同盟提案は${target.name}に拒否された。`, 'directive');
      nation.adjustRelation(targetId, -3);
      target.adjustRelation(nationId, -3);
    }
    return true;
  }

  issueSuePeace(nationId, targetId) {
    const nation = this.nationsById[nationId], target = this.nationsById[targetId];
    if (!nation || !target || !nation.isAtWarWith(targetId)) return false;
    const rel = nation.getRelation(targetId);
    const chance = clamp(0.35 + rel / 200, 0.1, 0.8);
    if (this.rng.chance(chance)) {
      nation.relations.delete(targetId);
      target.relations.delete(nationId);
      nation.warSinceTick.delete(targetId);
      target.warSinceTick.delete(nationId);
      nation.adjustRelation(targetId, 15);
      target.adjustRelation(nationId, 15);
      this.log(`${nation.name}の提案により、${nation.name}と${target.name}が休戦協定を結んだ。`, 'peace');
      nation.recordEvent(this.turn, `${target.name}と休戦（指導者提案）`);
      target.recordEvent(this.turn, `${nation.name}と休戦（指導者提案）`);
    } else {
      this.log(`${nation.name}の休戦提案は${target.name}に拒否された。`, 'directive');
    }
    return true;
  }
}
