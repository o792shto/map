// Nation data model: personalities, name/color generation, stats.

const PERSONALITY = Object.freeze({
  AGGRESSIVE: 'aggressive',
  DEFENSIVE: 'defensive',
  EXPANSIONIST: 'expansionist',
  MERCHANT: 'merchant',
});

const PERSONALITY_INFO = {
  [PERSONALITY.AGGRESSIVE]: {
    label: '好戦的',
    expansionMul: 0.9, warChanceMul: 2.2, allianceMul: 0.5, betrayalMul: 2.5,
    militaryMul: 1.3, unrestMul: 1.1,
  },
  [PERSONALITY.DEFENSIVE]: {
    label: '防御的',
    expansionMul: 0.7, warChanceMul: 0.4, allianceMul: 1.2, betrayalMul: 0.3,
    militaryMul: 1.1, unrestMul: 0.7,
  },
  [PERSONALITY.EXPANSIONIST]: {
    label: '拡張主義',
    expansionMul: 1.6, warChanceMul: 1.1, allianceMul: 0.8, betrayalMul: 1.0,
    militaryMul: 1.0, unrestMul: 1.15,
  },
  [PERSONALITY.MERCHANT]: {
    label: '商業重視',
    expansionMul: 0.85, warChanceMul: 0.5, allianceMul: 1.6, betrayalMul: 0.6,
    militaryMul: 0.75, unrestMul: 0.85,
  },
};

const NAME_PREFIX = ['アル', 'ヴェル', 'カル', 'ドラ', 'エス', 'フィン', 'ガル', 'ハイ', 'イル', 'ジョ', 'ケル', 'ロン', 'マル', 'ノル', 'オル', 'パル', 'クイ', 'ラス', 'セル', 'ター'];
const NAME_SUFFIX = ['ディア', 'ニア', 'ゴス', 'リア', 'ドール', 'ラント', 'ヴィア', 'モア', 'ノス', 'シア', 'バル', 'テック', 'ザール', 'ミア', 'クス'];
const STATE_SUFFIX = ['帝国', '王国', '共和国', '首長国', '連邦', '公国'];

function generateNationName(rng) {
  const base = rng.choice(NAME_PREFIX) + rng.choice(NAME_SUFFIX);
  const state = rng.choice(STATE_SUFFIX);
  return `${base}${state}`;
}

function pickDistinctColors(count, rng) {
  const golden = 137.508; // golden angle in degrees, spreads hues evenly
  const startHue = rng.float(0, 360);
  const colors = [];
  for (let i = 0; i < count; i++) {
    const hue = (startHue + i * golden) % 360;
    const sat = 62 + (i % 3) * 8;
    const light = 46 + ((i * 5) % 3) * 6;
    colors.push(`hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`);
  }
  return colors;
}

class Nation {
  constructor(id, name, color, personality, capitalIdx) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.personality = personality;
    this.capitalIdx = capitalIdx;
    this.territory = new Set([capitalIdx]);
    this.population = 0;
    this.military = 0;
    this.economy = 0;
    this.alive = true;
    this.allies = new Set();
    this.heroBoostTicks = 0;
    this.diedAtTick = null;
    this.foundedAtTick = 0;
    this.history = [];
  }

  get info() { return PERSONALITY_INFO[this.personality]; }
  get territorySize() { return this.territory.size; }

  strength() {
    const heroMul = this.heroBoostTicks > 0 ? 1.4 : 1.0;
    return this.military * heroMul;
  }
}
