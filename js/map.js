// Grid map generation: elevation/moisture noise -> biome classification -> resources.

const BIOME = Object.freeze({
  OCEAN: 0,
  PLAINS: 1,
  GRASSLAND: 2,
  FOREST: 3,
  MOUNTAIN: 4,
  DESERT: 5,
});

const BIOME_INFO = {
  [BIOME.OCEAN]:     { name: '海',   color: '#2f6a9e', passable: false, cost: Infinity },
  [BIOME.PLAINS]:    { name: '平地', color: '#c8d788', passable: true,  cost: 1.0 },
  [BIOME.GRASSLAND]: { name: '草原', color: '#8fbf5c', passable: true,  cost: 1.0 },
  [BIOME.FOREST]:    { name: '森',   color: '#3f7a45', passable: true,  cost: 1.5 },
  [BIOME.MOUNTAIN]:  { name: '山',   color: '#8a8478', passable: true,  cost: 3.0 },
  [BIOME.DESERT]:    { name: '砂漠', color: '#dcc27a', passable: true,  cost: 2.0 },
};

class WorldMap {
  constructor(width, height, seed) {
    this.width = width;
    this.height = height;
    this.seed = seed;
    const n = width * height;
    this.elevation = new Float32Array(n);
    this.moisture = new Float32Array(n);
    this.biome = new Uint8Array(n);
    this.food = new Uint8Array(n);
    this.gold = new Uint8Array(n);
    this.iron = new Uint8Array(n);
    this.owner = new Int16Array(n).fill(-1);
    this.unrest = new Float32Array(n);
    this.ownerSinceTick = new Int32Array(n);
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
    const scale = Math.max(width, height) / 4;
    const cx = width / 2, cy = height / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);

    const seaLevel = 0.44;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = this.idx(x, y);
        let e = elevNoise.fbm(x / scale, y / scale, 5) * 0.5 + 0.5; // 0..1
        // radial falloff so continents cluster toward the middle, oceans frame the map
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxDist;
        e -= Math.pow(dist, 2.2) * 0.55;
        this.elevation[i] = e;

        let m = moistNoise.fbm(x / (scale * 0.7) + 100, y / (scale * 0.7) + 100, 4) * 0.5 + 0.5;
        this.moisture[i] = m;

        let biome;
        if (e < seaLevel) {
          biome = BIOME.OCEAN;
        } else {
          const ne = (e - seaLevel) / (1 - seaLevel);
          if (ne > 0.72) biome = BIOME.MOUNTAIN;
          else if (m < 0.32) biome = BIOME.DESERT;
          else if (m < 0.52) biome = BIOME.PLAINS;
          else if (m < 0.72) biome = BIOME.GRASSLAND;
          else biome = BIOME.FOREST;
        }
        this.biome[i] = biome;

        const rv = resNoise.fbm(x / 6 + 50, y / 6 + 50, 3) * 0.5 + 0.5; // 0..1 local variance
        const [food, gold, iron] = this.rollResources(biome, rv);
        this.food[i] = food;
        this.gold[i] = gold;
        this.iron[i] = iron;
      }
    }
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
}
