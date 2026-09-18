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

// Muted, hand-tinted antique-atlas palette instead of bright flat colors.
const BIOME_INFO = {
  [BIOME.OCEAN]:     { name: '海',   color: '#6f97a0', passable: false, cost: Infinity },
  [BIOME.PLAINS]:    { name: '平地', color: '#c9b784', passable: true,  cost: 1.0 },
  [BIOME.GRASSLAND]: { name: '草原', color: '#a3a86a', passable: true,  cost: 1.0 },
  [BIOME.FOREST]:    { name: '森',   color: '#5f7a4d', passable: true,  cost: 1.5 },
  [BIOME.MOUNTAIN]:  { name: '山',   color: '#8c7b64', passable: true,  cost: 3.0 },
  [BIOME.DESERT]:    { name: '砂漠', color: '#d2b478', passable: true,  cost: 2.0 },
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
    // Generation knobs, tunable from the map settings panel.
    this.seaLevel = options.seaLevel != null ? options.seaLevel : 0.35;
    this.mountainThreshold = options.mountainThreshold != null ? options.mountainThreshold : 0.72;
    this.coastPasses = options.coastPasses != null ? options.coastPasses : 2;
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
    const seaLevel = this.seaLevel;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = this.idx(x, y);
        let e = elevNoise.fbm(x / scale, y / scale, 4) * 0.5 + 0.5; // 0..1
        // gentle radial falloff so oceans frame the map without dominating it
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxDist;
        e -= Math.pow(dist, 2.6) * 0.36;
        this.elevation[i] = e;

        let m = moistNoise.fbm(x / (scale * 0.7) + 100, y / (scale * 0.7) + 100, 4) * 0.5 + 0.5;
        this.moisture[i] = m;

        const rv = resNoise.fbm(x / 6 + 50, y / 6 + 50, 3) * 0.5 + 0.5; // 0..1 local variance
        this.resourceVariance[i] = rv;

        const biome = this.classifyBiome(e, m);
        this.biome[i] = biome;
        const [food, gold, iron] = this.rollResources(biome, rv);
        this.food[i] = food;
        this.gold[i] = gold;
        this.iron[i] = iron;
      }
    }

    this.smoothCoastline(this.coastPasses);
  }

  classifyBiome(e, m) {
    if (e < this.seaLevel) return BIOME.OCEAN;
    const ne = (e - this.seaLevel) / (1 - this.seaLevel);
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
}
