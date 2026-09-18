// Grid map generation: elevation/moisture noise -> biome classification -> resources.
// A coastline-smoothing pass removes single-cell noise so continents read as
// continuous landmasses with gentler coastlines instead of a speckled grid.

const BIOME = Object.freeze({
  OCEAN: 0,
  PLAINS: 1,
  GRASSLAND: 2,
  FOREST: 3,
  MOUNTAIN: 4,
  DESERT: 5,
});

// Single-pigment "ink on paper" palette: every biome is a shade of the same
// sepia/tan hue family (no greens or blues), like a hand-tinted antique map
// where terrain is read from tone and texture rather than color.
const BIOME_INFO = {
  [BIOME.OCEAN]:     { name: '海',   color: '#b7ae95', passable: false, cost: Infinity },
  [BIOME.PLAINS]:    { name: '平地', color: '#dccb9a', passable: true,  cost: 1.0 },
  [BIOME.GRASSLAND]: { name: '草原', color: '#d2c28e', passable: true,  cost: 1.0 },
  [BIOME.FOREST]:    { name: '森',   color: '#a8987a', passable: true,  cost: 1.5 },
  [BIOME.MOUNTAIN]:  { name: '山',   color: '#94835f', passable: true,  cost: 3.0 },
  [BIOME.DESERT]:    { name: '砂漠', color: '#e6d7a8', passable: true,  cost: 2.0 },
};

class WorldMap {
  constructor(width, height, seed, options = {}) {
    this.width = width;
    this.height = height;
    this.seed = seed;
    const n = width * height;
    this.elevation = new Float32Array(n);
    this.moisture = new Float32Array(n);
    this.resourceVariance = new Float32Array(n);
    this.biome = new Uint8Array(n);
    this.food = new Uint8Array(n);
    this.gold = new Uint8Array(n);
    this.iron = new Uint8Array(n);
    this.owner = new Int16Array(n).fill(-1);
    this.unrest = new Float32Array(n);
    this.ownerSinceTick = new Int32Array(n);
    this.coastal = null; // Uint8Array, computed lazily
    this.landmassId = null; // Int32Array, computed lazily: connected land component per cell (-1 = ocean)
    // Generation knobs, tunable from the map settings panel.
    this.seaLevel = options.seaLevel != null ? options.seaLevel : 0.35;
    this.mountainThreshold = options.mountainThreshold != null ? options.mountainThreshold : 0.72;
    this.coastPasses = options.coastPasses != null ? options.coastPasses : 2;
    // Average cell count per "state" (province): the atomic unit of
    // ownership/expansion, several grid cells grouped together so territory
    // changes hands in visible chunks instead of flickering cell by cell.
    this.stateTargetCells = options.stateTargetCells != null ? options.stateTargetCells : 60;
    // When set, land/sea comes from this real-world coastline mask (1=land)
    // instead of noise, so preset maps (Europe/Asia) stay recognizable.
    this.presetMask = options.presetMask || null;
    // Per-cell state membership + per-state data, computed once after
    // biome/coastline generation finishes (see computeStates below).
    this.stateId = null; // Int32Array, land cell -> state id (-1 = ocean)
    this.states = null; // [{id, cells:[cellIdx,...], size, coastal, cx, cy, avgCost}]
    this.stateNeighbors = null; // Set<stateId>[], indexed by state id
    this.stateOwner = null; // Int16Array, indexed by state id (-1 = unclaimed)
    this.stateUnrest = null; // Float32Array, indexed by state id
    this.stateOwnerSinceTick = null; // Int32Array, indexed by state id
    this.generate();
  }

  idx(x, y) { return y * this.width + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }

  neighbors4(x, y) {
    const out = [];
    if (x > 0) out.push([x - 1, y]);
    if (x < this.width - 1) out.push([x + 1, y]);
    if (y > 0) out.push([x, y - 1]);
    if (y < this.height - 1) out.push([x, y + 1]);
    return out;
  }

  generate() {
    const elevNoise = new Noise2D(this.seed);
    const moistNoise = new Noise2D(this.seed + 7919);
    const resNoise = new Noise2D(this.seed + 40433);
    const { width, height } = this;
    // A larger feature scale yields bigger, smoother continents (fewer speckles)
    const scale = Math.max(width, height) / 5;
    const cx = width / 2, cy = height / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    const usingPreset = !!this.presetMask;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = this.idx(x, y);
        let e = elevNoise.fbm(x / scale, y / scale, 4) * 0.5 + 0.5; // 0..1
        if (!usingPreset) {
          // gentle radial falloff so oceans frame the map without dominating it
          const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxDist;
          e -= Math.pow(dist, 2.6) * 0.36;
        }
        this.elevation[i] = e;

        let m = moistNoise.fbm(x / (scale * 0.7) + 100, y / (scale * 0.7) + 100, 4) * 0.5 + 0.5;
        this.moisture[i] = m;

        const rv = resNoise.fbm(x / 6 + 50, y / 6 + 50, 3) * 0.5 + 0.5; // 0..1 local variance
        this.resourceVariance[i] = rv;

        const biome = usingPreset
          ? (this.presetMask[i] ? this.classifyBiome(e, m, true) : BIOME.OCEAN)
          : this.classifyBiome(e, m, false);
        this.biome[i] = biome;
        const [food, gold, iron] = this.rollResources(biome, rv);
        this.food[i] = food;
        this.gold[i] = gold;
        this.iron[i] = iron;
      }
    }

    // Real coastlines are already clean; only noise-generated ones need the
    // cellular-automaton smoothing pass.
    if (!usingPreset) this.smoothCoastline(this.coastPasses);

    this.computeStates(this.stateTargetCells);
  }

  // `landAlready` is set when land/sea is decided externally (a preset
  // coastline mask): `e` is then used directly as the 0..1 "how rugged"
  // signal instead of being renormalized above a noise-based sea level.
  classifyBiome(e, m, landAlready) {
    let ne;
    if (landAlready) {
      ne = clamp(e, 0, 1);
    } else {
      if (e < this.seaLevel) return BIOME.OCEAN;
      ne = (e - this.seaLevel) / (1 - this.seaLevel);
    }
    if (ne > this.mountainThreshold) return BIOME.MOUNTAIN;
    if (m < 0.32) return BIOME.DESERT;
    if (m < 0.52) return BIOME.PLAINS;
    if (m < 0.72) return BIOME.GRASSLAND;
    return BIOME.FOREST;
  }

  // Cellular-automaton smoothing: a cell surrounded mostly by land becomes land,
  // one surrounded mostly by sea becomes sea. Removes single-cell noise so
  // coastlines look like continuous continents rather than a jagged grid.
  smoothCoastline(passes) {
    const { width, height } = this;
    for (let p = 0; p < passes; p++) {
      const isLand = new Uint8Array(width * height);
      for (let i = 0; i < isLand.length; i++) isLand[i] = this.biome[i] === BIOME.OCEAN ? 0 : 1;
      const next = isLand.slice();

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = this.idx(x, y);
          let landCount = 0, total = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              total++;
              if (isLand[this.idx(nx, ny)]) landCount++;
            }
          }
          if (total === 0) continue;
          const ratio = landCount / total;
          if (ratio >= 0.62) next[i] = 1;
          else if (ratio <= 0.38) next[i] = 0;
        }
      }

      for (let i = 0; i < next.length; i++) {
        if (next[i] === isLand[i]) continue;
        if (next[i] === 0) {
          this.biome[i] = BIOME.OCEAN;
          this.food[i] = 0; this.gold[i] = 0; this.iron[i] = 0;
        } else {
          const biome = this.classifyBiome(Math.max(this.elevation[i], this.seaLevel + 0.02), this.moisture[i]);
          this.biome[i] = biome;
          const [food, gold, iron] = this.rollResources(biome, this.resourceVariance[i]);
          this.food[i] = food; this.gold[i] = gold; this.iron[i] = iron;
        }
      }
    }
    this.coastal = null; // invalidate cache
  }

  rollResources(biome, rv) {
    // rv in 0..1 adds local variance so same biome differs tile to tile
    switch (biome) {
      case BIOME.OCEAN: return [0, 0, 0];
      case BIOME.PLAINS: return [Math.round(6 + rv * 3), Math.round(1 + rv * 2), Math.round(rv * 1)];
      case BIOME.GRASSLAND: return [Math.round(7 + rv * 2), Math.round(2 + rv * 2), Math.round(rv * 1)];
      case BIOME.FOREST: return [Math.round(3 + rv * 3), Math.round(2 + rv * 2), Math.round(1 + rv * 2)];
      case BIOME.MOUNTAIN: return [Math.round(rv * 1), Math.round(2 + rv * 3), Math.round(5 + rv * 4)];
      case BIOME.DESERT: return [Math.round(rv * 1), Math.round(3 + rv * 4), Math.round(rv * 2)];
      default: return [0, 0, 0];
    }
  }

  isLand(x, y) {
    return BIOME_INFO[this.biome[this.idx(x, y)]].passable;
  }

  // Lazily computed: true for land cells that have at least one ocean neighbor (ports).
  computeCoastal() {
    const { width, height } = this;
    const coastal = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = this.idx(x, y);
        if (this.biome[i] === BIOME.OCEAN) continue;
        for (const [nx, ny] of this.neighbors4(x, y)) {
          if (this.biome[this.idx(nx, ny)] === BIOME.OCEAN) { coastal[i] = 1; break; }
        }
      }
    }
    this.coastal = coastal;
    return coastal;
  }

  isCoastal(idx) {
    if (!this.coastal) this.computeCoastal();
    return this.coastal[idx] === 1;
  }

  // Lazily computed: flood-fills (4-connectivity) every land cell into a
  // numbered landmass. Two cells share a landmassId only if there's a
  // continuous land path between them — used to tell a real overseas island
  // apart from a spot on the same continent that's merely reachable by a
  // short hop across a bay.
  computeLandmass() {
    const { width, height } = this;
    const ids = new Int32Array(width * height).fill(-1);
    let nextId = 0;
    for (let start = 0; start < ids.length; start++) {
      if (ids[start] !== -1 || !BIOME_INFO[this.biome[start]].passable) continue;
      const id = nextId++;
      const queue = [start];
      ids[start] = id;
      let qi = 0;
      while (qi < queue.length) {
        const cur = queue[qi++];
        const cx = cur % width, cy = Math.floor(cur / width);
        for (const [nx, ny] of this.neighbors4(cx, cy)) {
          const ni = this.idx(nx, ny);
          if (ids[ni] !== -1 || !BIOME_INFO[this.biome[ni]].passable) continue;
          ids[ni] = id;
          queue.push(ni);
        }
      }
    }
    this.landmassId = ids;
    return ids;
  }

  getLandmassId(idx) {
    if (!this.landmassId) this.computeLandmass();
    return this.landmassId[idx];
  }

  // Groups land cells into "states" (provinces): the atomic unit of
  // ownership from here on, so a nation's territory changes in visible,
  // meaningful chunks rather than one grid cell at a time. Seeds are spread
  // across land with roughly even spacing (relaxed until the target count is
  // reached), then every land cell is assigned to its nearest seed via a
  // single multi-source BFS (all seeds enqueued together, so cells are
  // claimed by whichever seed's wavefront reaches them first — a graph
  // Voronoi diagram). Any land left unreached (a tiny islet with no seed of
  // its own, usually because it's disconnected from every seeded landmass)
  // becomes a singleton state of its own, so every land cell always ends up
  // in exactly one state.
  computeStates(targetCells) {
    const { width, height } = this;
    const n = width * height;
    const landIdxs = [];
    for (let i = 0; i < n; i++) if (BIOME_INFO[this.biome[i]].passable) landIdxs.push(i);
    if (landIdxs.length === 0) {
      this.stateId = new Int32Array(n).fill(-1);
      this.states = [];
      this.stateNeighbors = [];
      this.stateOwner = new Int16Array(0);
      this.stateUnrest = new Float32Array(0);
      this.stateOwnerSinceTick = new Int32Array(0);
      return;
    }

    const numStates = Math.max(1, Math.round(landIdxs.length / targetCells));
    const rng = new RNG(((this.seed ^ 0x5bd1e995) >>> 0) || 1);
    const shuffled = rng.shuffle(landIdxs);
    const seedSet = new Set();
    const seeds = [];
    let minDist = Math.sqrt(targetCells / Math.PI) * 1.6;
    while (seeds.length < numStates && minDist >= 1) {
      for (const idx of shuffled) {
        if (seeds.length >= numStates) break;
        if (seedSet.has(idx)) continue;
        const x = idx % width, y = Math.floor(idx / width);
        let ok = true;
        for (const s of seeds) {
          const sx = s % width, sy = Math.floor(s / width);
          if (Math.hypot(x - sx, y - sy) < minDist) { ok = false; break; }
        }
        if (ok) { seeds.push(idx); seedSet.add(idx); }
      }
      minDist *= 0.7;
    }
    for (const idx of shuffled) {
      if (seeds.length >= numStates) break;
      if (!seedSet.has(idx)) { seeds.push(idx); seedSet.add(idx); }
    }

    const stateId = new Int32Array(n).fill(-1);
    const queue = [];
    seeds.forEach((s, id) => { stateId[s] = id; queue.push(s); });
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const cx = cur % width, cy = Math.floor(cur / width);
      const sid = stateId[cur];
      for (const [nx, ny] of this.neighbors4(cx, cy)) {
        const ni = this.idx(nx, ny);
        if (stateId[ni] !== -1 || !BIOME_INFO[this.biome[ni]].passable) continue;
        stateId[ni] = sid;
        queue.push(ni);
      }
    }
    let nextId = seeds.length;
    for (const idx of landIdxs) {
      if (stateId[idx] === -1) stateId[idx] = nextId++;
    }

    const states = [];
    for (let i = 0; i < nextId; i++) states.push({ id: i, cells: [], size: 0, coastal: false, cx: 0, cy: 0, avgCost: 0 });
    for (const idx of landIdxs) states[stateId[idx]].cells.push(idx);
    for (const s of states) {
      let sx = 0, sy = 0, costSum = 0;
      for (const idx of s.cells) {
        const x = idx % width, y = Math.floor(idx / width);
        sx += x; sy += y;
        costSum += BIOME_INFO[this.biome[idx]].cost;
        if (!s.coastal && this.isCoastal(idx)) s.coastal = true;
      }
      s.size = s.cells.length;
      s.cx = sx / s.size;
      s.cy = sy / s.size;
      s.avgCost = costSum / s.size;
    }

    const stateNeighbors = states.map(() => new Set());
    for (const idx of landIdxs) {
      const x = idx % width, y = Math.floor(idx / width);
      const sid = stateId[idx];
      for (const [nx, ny] of this.neighbors4(x, y)) {
        const ni = this.idx(nx, ny);
        if (!BIOME_INFO[this.biome[ni]].passable) continue;
        const nsid = stateId[ni];
        if (nsid !== sid) { stateNeighbors[sid].add(nsid); stateNeighbors[nsid].add(sid); }
      }
    }

    this.stateId = stateId;
    this.states = states;
    this.stateNeighbors = stateNeighbors;
    this.stateOwner = new Int16Array(states.length).fill(-1);
    this.stateUnrest = new Float32Array(states.length);
    this.stateOwnerSinceTick = new Int32Array(states.length);
  }

  getState(idx) { return this.states[this.stateId[idx]]; }
}
