// Zagon: node --test site/fomo.test.js
const test = require("node:test");
const assert = require("node:assert");
const Fomo = require("./fomo.js");

const TH = Fomo.DEFAULT_THRESHOLDS; // 24h 12%, 12h 9%, 1h 7%

test("FOMO zahteva vse tri pogoje", () => {
  assert.ok(Fomo.isFomo({ h24: 12, h12: 9, h1: 7 }, TH));
  assert.ok(Fomo.isFomo({ h24: 40, h12: 25, h1: 10 }, TH));
  assert.ok(!Fomo.isFomo({ h24: 11.99, h12: 9, h1: 7 }, TH));
  assert.ok(!Fomo.isFomo({ h24: 20, h12: 9, h1: 6.9 }, TH));
  assert.ok(!Fomo.isFomo({ h24: 20, h12: null, h1: 8 }, TH));
});

test("classify loci FOMO in radar", () => {
  const rows = [
    { symbol: "A", h24: 30, h12: 20, h1: 8 },
    { symbol: "B", h24: 15, h12: 10, h1: 1 },
    { symbol: "C", h24: 15, h12: null, h1: 9 },
    { symbol: "D", h24: 5, h12: 1, h1: 0 },
    { symbol: "E", h24: 13, h12: 9.5, h1: 7.1 },
  ];
  const r = Fomo.classify(rows, TH);
  assert.deepStrictEqual(r.fomo.map((x) => x.symbol), ["A", "E"]);
  assert.deepStrictEqual(r.radar.map((x) => x.symbol).sort(), ["B", "C"]);
  assert.strictEqual(r.radar.find((x) => x.symbol === "C").pending12h, true);
  assert.strictEqual(r.radar.find((x) => x.symbol === "B").pending12h, false);
});

test("binanceCandidates filtrira stabilne, leveraged, nizek volumen in ne-USDT pare", () => {
  const t = (symbol, ch, qv, count = 10) => ({
    symbol, priceChangePercent: String(ch), quoteVolume: String(qv), lastPrice: "1", count,
  });
  const out = Fomo.binanceCandidates([
    t("PEPEUSDT", 30, 5e6),
    t("USDCUSDT", 0.1, 1e9),
    t("BTCUPUSDT", 50, 1e7),
    t("ETHBTC", 20, 1e7),
    t("TINYUSDT", 80, 5000),
    t("DEADUSDT", 90, 1e7, 0),
    t("SOLUSDT", 3, 1e8),
  ], { minQuoteVolume: 100000, minCh24: 0 });
  assert.deepStrictEqual(out.map((c) => c.base), ["PEPE", "SOL"]);
  assert.strictEqual(out[0].h24, 30);
});

test("changeFromSeries izracuna spremembo v zadnjih 12h", () => {
  const H = 3600 * 1000;
  const now = 1_700_000_000_000;
  const prices = [];
  for (let i = 24; i >= 0; i--) prices.push([now - i * H, 100 + (24 - i)]); // 100 .. 124
  // 12h nazaj = 112, zadnja = 124
  assert.ok(Math.abs(Fomo.changeFromSeries(prices, 12) - (124 - 112) / 112 * 100) < 1e-9);
  assert.strictEqual(Fomo.changeFromSeries(prices.slice(-3), 12), null);
  assert.strictEqual(Fomo.changeFromSeries([], 12), null);
});

test("chunk", () => {
  assert.deepStrictEqual(Fomo.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
