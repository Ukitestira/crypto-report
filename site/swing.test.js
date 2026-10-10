// Zagon: node --test site/swing.test.js
const test = require("node:test");
const assert = require("node:assert");
const S = require("./swing.js");

const DAY = 864e5, H4 = 4 * 3600e3;
function candles(closes, step, opts = {}) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: i * step, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: (opts.vol && opts.vol[i]) || 1000 };
  });
}
// miren 4h niz brez signalov, ki se konca pri ceni p (rahla enakomerna rast: brez preprodanosti in krizanj)
const flatH4 = (p) => candles(Array.from({ length: 120 }, (_, i) => p * (1 - 0.0001 * (119 - i))), H4);

test("ema, sma, rsi", () => {
  const e = S.ema([1, 2, 3, 4, 5], 3);
  assert.strictEqual(e[1], null);
  assert.strictEqual(e[2], 2);
  assert.strictEqual(e[4], 4);
  assert.strictEqual(S.smaLast([1, 2, 3, 4], 2), 3.5);
  const up = S.rsiSeries(Array.from({ length: 30 }, (_, i) => i), 14);
  assert.strictEqual(up[13], null);
  assert.strictEqual(up[29], 100);
});

test("pullback v dvigajocem trendu", () => {
  // 250 dni rasti, nato 6-dnevni popravek do EMA20 in obrat
  const c = Array.from({ length: 250 }, (_, i) => 50 * Math.pow(1.004, i));
  const top = c[c.length - 1];
  [0.985, 0.97, 0.955, 0.95, 0.955, 0.965].forEach((f) => c.push(top * f));
  c.push(top * 0.97); // trenutna (odprta) sveca
  const r = S.analyze(candles(c, DAY), flatH4(top * 0.97));
  assert.strictEqual(r.trend, "dvigajoc");
  const p = r.setups.find((s) => s.type === "pullback");
  assert.ok(p, "pricakovan pullback setup");
  assert.ok(p.stop < p.entry && p.target > p.entry && p.rr > 0);
});

test("preboj z volumnom", () => {
  const c = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 2); // bocno 98-102
  const vol = c.map(() => 1000);
  c.push(108); vol.push(3000); // zaprta sveca preboja ob 3x volumnu
  c.push(109); vol.push(500);  // trenutna
  const r = S.analyze(candles(c, DAY, { vol }), flatH4(109));
  const b = r.setups.find((s) => s.type === "breakout");
  assert.ok(b, "pricakovan preboj");
  assert.ok(b.target > b.entry && b.stop < b.entry);

  // brez volumna ni preboja
  const vol2 = vol.slice(); vol2[60] = 1100;
  assert.ok(!S.analyze(candles(c, DAY, { vol: vol2 }), flatH4(109)).setups.find((s) => s.type === "breakout"));
});

test("odboj iz preprodanosti (4h)", () => {
  const d = candles(Array.from({ length: 60 }, () => 100), DAY);
  const h = Array.from({ length: 80 }, () => 100);
  for (let i = 0; i < 14; i++) h.push(100 - (i + 1) * 1.5); // mocan padec -> RSI < 30
  h.push(h[h.length - 1] + 2.5, h[h.length - 1] + 4.5); // dve zeleni sveci
  h.push(h[h.length - 1] + 0.5); // trenutna
  const r = S.analyze(d, candles(h, H4));
  assert.ok(r.setups.find((s) => s.type === "oversold"), "pricakovan odboj");
});

test("krizanje EMA20/50 na 4h", () => {
  const d = candles(Array.from({ length: 60 }, () => 100), DAY);
  const h = [];
  for (let i = 0; i < 70; i++) h.push(120 - i * 0.3); // padec: EMA20 pod EMA50
  for (let i = 0; i < 200 && h.length < 400; i++) {
    h.push(h[h.length - 1] + 0.6);
    const closes = h.slice();
    const e20 = S.ema(closes, 20), e50 = S.ema(closes, 50), n = closes.length - 1;
    if (e20[n - 1] <= e50[n - 1] && e20[n] > e50[n]) break; // ravno prekrizano
  }
  h.push(h[h.length - 1] + 0.3); // trenutna
  const r = S.analyze(d, candles(h, H4));
  assert.ok(r.setups.find((s) => s.type === "emacross"), "pricakovano krizanje");
});

test("bocni trg brez setupov in premalo podatkov", () => {
  const d = candles(Array.from({ length: 260 }, (_, i) => 100 + Math.sin(i / 2) * 0.5), DAY);
  assert.strictEqual(S.analyze(d, flatH4(d[d.length - 1].c)).setups.length, 0);
  assert.deepStrictEqual(S.analyze([], []).setups, []);
});

test("pretvorba svec in univerzum", () => {
  const b = S.fromBinance([[1, "1", "2", "0.5", "1.5", "10", 2, "15"]]);
  assert.deepStrictEqual(b[0], { t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 15 });
  const y = S.fromBybit([["2", "2", "3", "1", "2.5", "5", "12"], ["1", "1", "2", "0.5", "1.5", "4", "6"]]);
  assert.strictEqual(y[0].t, 1);
  assert.strictEqual(y[1].v, 12);
  const u = S.universe([
    { symbol: "BTCUSDT", volume: 9e9 }, { symbol: "USDCUSDT", volume: 8e9 }, { symbol: "ETHBTC", volume: 7e9 },
    { symbol: "BTC3LUSDT", volume: 6e9 }, { symbol: "SOLUSDT", volume: 5e9 }, { symbol: "TINYUSDT", volume: 10 },
  ], { minVolume: 1e6, limit: 10 });
  assert.deepStrictEqual(u.map((x) => x.base), ["BTC", "SOL"]);
});
