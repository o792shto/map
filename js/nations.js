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

// Political system: how the nation is governed. Adds a second, independent
// layer of behavioral modifiers on top of personality.
const POLITICAL_SYSTEM = Object.freeze({
  MONARCHY: 'monarchy',
  REPUBLIC: 'republic',
  FEDERATION: 'federation',
  THEOCRACY: 'theocracy',
  TRIBAL: 'tribal',
});
const POLITICAL_SYSTEM_INFO = {
  [POLITICAL_SYSTEM.MONARCHY]:   { label: '君主制',   warChanceMul: 1.1,  allianceMul: 1.0,  unrestMul: 1.0,  militaryMul: 1.05 },
  [POLITICAL_SYSTEM.REPUBLIC]:   { label: '共和制',   warChanceMul: 0.9,  allianceMul: 1.15, unrestMul: 0.85, militaryMul: 0.95 },
  [POLITICAL_SYSTEM.FEDERATION]: { label: '連邦制',   warChanceMul: 0.85, allianceMul: 1.1,  unrestMul: 0.7,  expansionMul: 0.9 },
  [POLITICAL_SYSTEM.THEOCRACY]:  { label: '神権政治', warChanceMul: 1.2,  allianceMul: 0.8,  unrestMul: 0.9,  militaryMul: 1.1 },
  [POLITICAL_SYSTEM.TRIBAL]:     { label: '部族連合', warChanceMul: 1.15, allianceMul: 0.9,  unrestMul: 1.15, expansionMul: 1.15 },
};

// Lifestyle: how the nation's people subsist. Mainly shapes expansion style
// and how strongly they project power overseas.
const LIFESTYLE = Object.freeze({
  AGRARIAN: 'agrarian',
  NOMADIC: 'nomadic',
  FISHING: 'fishing',
  MARITIME: 'maritime',
});
const LIFESTYLE_INFO = {
  [LIFESTYLE.AGRARIAN]: { label: '農耕民', foodMul: 1.15, navalMul: 0.75, expansionMul: 1.0 },
  [LIFESTYLE.NOMADIC]:  { label: '遊牧民', foodMul: 0.9,  navalMul: 0.55, expansionMul: 1.25, unrestMul: 0.8 },
  [LIFESTYLE.FISHING]:  { label: '漁労民', foodMul: 1.05, navalMul: 1.3,  expansionMul: 0.95 },
  [LIFESTYLE.MARITIME]: { label: '海洋民族', foodMul: 0.95, navalMul: 1.6, expansionMul: 1.0, militaryMul: 1.05 },
};

// A single distinguishing trait rolled per nation, layered on top of
// personality/political system/lifestyle.
const TRAITS = [
  { id: 'offense',   label: '侵攻の達人', warChanceMul: 1.2,  militaryMul: 1.1 },
  { id: 'defense',   label: '鉄壁の守り', militaryMul: 1.15,  unrestMul: 0.85 },
  { id: 'trade',     label: '交易の民',   allianceMul: 1.3,   expansionMul: 0.9 },
  { id: 'resilient', label: '不屈の意志', unrestMul: 0.7 },
  { id: 'ambitious', label: '拡張の野心', expansionMul: 1.3,  warChanceMul: 1.1 },
  { id: 'diplomat',  label: '外交巧者',   allianceMul: 1.25,  warChanceMul: 0.8 },
];

function pickTrait(rng) { return rng.choice(TRAITS); }

const NAME_PREFIX = ['アル', 'ヴェル', 'カル', 'ドラ', 'エス', 'フィン', 'ガル', 'ハイ', 'イル', 'ジョ', 'ケル', 'ロン', 'マル', 'ノル', 'オル', 'パル', 'クイ', 'ラス', 'セル', 'ター'];
const NAME_SUFFIX = ['ディア', 'ニア', 'ゴス', 'リア', 'ドール', 'ラント', 'ヴィア', 'モア', 'ノス', 'シア', 'バル', 'テック', 'ザール', 'ミア', 'クス'];
const STATE_SUFFIX = ['帝国', '王国', '共和国', '首長国', '連邦', '公国'];

function generateNationName(rng) {
  const base = rng.choice(NAME_PREFIX) + rng.choice(NAME_SUFFIX);
  const state = rng.choice(STATE_SUFFIX);
  return `${base}${state}`;
}

const LEADER_TITLE = {
  [PERSONALITY.AGGRESSIVE]: ['将軍', '大元帥', '戦王'],
  [PERSONALITY.DEFENSIVE]: ['守護公', '摂政', '大司教'],
  [PERSONALITY.EXPANSIONIST]: ['開拓王', '征服者', '覇王'],
  [PERSONALITY.MERCHANT]: ['大商人', '総督', '議長'],
};
const LEADER_GIVEN = ['アレク', 'ヴィクト', 'カシム', 'テオ', 'レオン', 'マティ', 'ロザ', 'エリナ', 'イサベ', 'ヴォル', 'グレイ', 'シリル', 'オーウェン', 'ナディア', 'ダリオ'];
const LEADER_SUFFIX = ['ス', 'ール', 'ン', 'ヌス', 'ーヌ', 'ート', 'ア', 'オ', 'リク', 'ヴァ'];

function generateLeaderName(rng, personality) {
  const given = rng.choice(LEADER_GIVEN) + rng.choice(LEADER_SUFFIX);
  const title = rng.choice(LEADER_TITLE[personality]);
  return `${title}${given}`;
}

const WAR_REASONS = [
  '国境地帯の領有権を巡る対立',
  '資源産地の争奪',
  '積年の因縁による報復',
  '覇権拡大の野心',
  '通商路の支配権争い',
  '同胞保護を名目とした介入',
  '先の小競り合いへの報復',
  '威信をかけた示威行動',
];

function pickWarReason(rng) { return rng.choice(WAR_REASONS); }

function pickDistinctColors(count, rng) {
  // Muted, ink/watercolor-like tones (lower saturation, mid lightness) so
  // territory washes read as a hand-tinted antique map rather than a
  // neon-bright modern political map.
  const golden = 137.508; // golden angle in degrees, spreads hues evenly
  const startHue = rng.float(0, 360);
  const colors = [];
  for (let i = 0; i < count; i++) {
    const hue = (startHue + i * golden) % 360;
    const sat = 38 + (i % 3) * 7;
    const light = 38 + ((i * 5) % 3) * 5;
    colors.push(`hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`);
  }
  return colors;
}

const MOD_KEYS = ['expansionMul', 'warChanceMul', 'allianceMul', 'betrayalMul', 'militaryMul', 'unrestMul', 'navalMul', 'foodMul'];

class Nation {
  constructor(id, name, color, personality, capitalIdx, leaderName, politicalSystem, lifestyle, trait) {
    this.id = id;
    this.name = name;
    this.userNamed = false;
    this.leaderName = leaderName;
    this.color = color;
    this.personality = personality;
    this.politicalSystem = politicalSystem;
    this.lifestyle = lifestyle;
    this.trait = trait;
    this.capitalIdx = capitalIdx;
    this.territory = new Set([capitalIdx]);
    this.ownedStates = new Set(); // stateIds this nation currently holds
    this.population = 0;
    this.military = 0;
    this.economy = 0;
    this.alive = true;
    this.allies = new Set();
    this.relations = new Map(); // otherId -> 'war' (absence = peace)
    this.relationScore = new Map(); // otherId -> -100..100 goodwill, independent of war/peace state
    this.warSinceTick = new Map(); // otherId -> turn war began
    this.heroBoostTicks = 0;
    this.diedAtTick = null;
    this.foundedAtTick = 0;
    this.directiveTarget = null; // player-issued expansion focus: {idx, expiresAtTurn}
    this.history = []; // {turn, text} major events for this nation's own chronicle
    this.mods = {};
    this.computeMods();
  }

  // Multiplies personality + political system + lifestyle + rolled trait
  // together into one flat set of modifiers used throughout the sim, so a
  // nation reads as the sum of all four layers rather than any one alone.
  computeMods() {
    const layers = [
      PERSONALITY_INFO[this.personality],
      POLITICAL_SYSTEM_INFO[this.politicalSystem],
      LIFESTYLE_INFO[this.lifestyle],
      this.trait,
    ];
    const mods = {};
    for (const key of MOD_KEYS) {
      let v = 1;
      for (const layer of layers) if (layer && layer[key] != null) v *= layer[key];
      mods[key] = v;
    }
    this.mods = mods;
  }

  get info() { return PERSONALITY_INFO[this.personality]; }
  get territorySize() { return this.territory.size; }

  strength() {
    const heroMul = this.heroBoostTicks > 0 ? 1.4 : 1.0;
    return this.military * heroMul;
  }

  isAtWarWith(otherId) { return this.relations.get(otherId) === 'war'; }

  getRelation(otherId) { return this.relationScore.get(otherId) || 0; }
  adjustRelation(otherId, delta) {
    this.relationScore.set(otherId, clamp(this.getRelation(otherId) + delta, -100, 100));
  }

  recordEvent(turn, text) {
    this.history.push({ turn, text });
    if (this.history.length > 60) this.history.shift();
  }
}

function relationLabel(score) {
  if (score <= -50) return '険悪';
  if (score <= -15) return '敵対的';
  if (score < 15) return '中立';
  if (score < 50) return '友好的';
  return '親密';
}
