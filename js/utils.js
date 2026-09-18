// Small seeded RNG + helpers shared across modules.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class RNG {
  constructor(seed) { this.fn = mulberry32(seed); }
  next() { return this.fn(); }
  int(min, max) { return Math.floor(this.next() * (max - min + 1)) + min; }
  float(min, max) { return this.next() * (max - min) + min; }
  chance(p) { return this.next() < p; }
  choice(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function formatNumber(v) {
  if (v >= 10000) return Math.round(v / 1000) + 'k';
  return Math.round(v).toString();
}
