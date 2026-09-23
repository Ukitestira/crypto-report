// Zagon: node --test site/sentiment.test.js
const test = require("node:test");
const assert = require("node:assert");
const S = require("./sentiment.js");

test("sma in rsi", () => {
  assert.strictEqual(S.sma([1, 2, 3, 4], 2), 3.5);
  assert.strictEqual(S.sma([1], 2), null);
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.strictEqual(S.rsi(up, 14), 100);
  assert.ok(S.rsi(down, 14) < 1);
  const zig = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  assert.ok(Math.abs(S.rsi(zig, 14) - 50) < 5);
});

test("mapRisk interpolira in omeji", () => {
  const pts = [[0, 10], [10, 30], [20, 90]];
  assert.strictEqual(S.mapRisk(-5, pts), 10);
  assert.strictEqual(S.mapRisk(5, pts), 20);
  assert.strictEqual(S.mapRisk(15, pts), 60);
  assert.strictEqual(S.mapRisk(99, pts), 90);
  assert.strictEqual(S.mapRisk(null, pts), null);
});

test("level", () => {
  assert.strictEqual(S.level(10).key, "low");
  assert.strictEqual(S.level(50).key, "moderate");
  assert.strictEqual(S.level(60).key, "elevated");
  assert.strictEqual(S.level(80).key, "high");
  assert.strictEqual(S.level(null).key, "na");
});

test("izkljuci stabilne in zavite kovance", () => {
  assert.ok(S.isExcludedCoin({ symbol: "usdt", name: "Tether" }));
  assert.ok(S.isExcludedCoin({ symbol: "usde", name: "Ethena USDe" }));
  assert.ok(S.isExcludedCoin({ symbol: "wbtc", name: "Wrapped Bitcoin" }));
  assert.ok(S.isExcludedCoin({ symbol: "steth", name: "Lido Staked Ether" }));
  assert.ok(!S.isExcludedCoin({ symbol: "btc", name: "Bitcoin" }));
  assert.ok(!S.isExcludedCoin({ symbol: "sol", name: "Solana" }));
});

test("breadth in altseason", () => {
  const mk = (id, c7, c30) => ({ id, symbol: id, name: id, price_change_percentage_7d_in_currency: c7, price_change_percentage_30d_in_currency: c30 });
  const m = [mk("bitcoin", 5, 10), mk("usdt", 0, 0)];
  for (let i = 0; i < 20; i++) m.push(mk("alt" + i, i < 15 ? 3 : -3, i < 5 ? 20 : 1));
  assert.strictEqual(Math.round(S.breadth(m, 100)), Math.round(16 / 21 * 100)); // btc + 15 altov v plusu
  assert.strictEqual(S.altseason(m), 25); // 5 od 20 premaga BTC
});

test("evaluate: pregret trg -> visoko tveganje, ohlajen -> nizko", () => {
  // 400 dni rasti, zadnji skok (visok RSI, Mayer > 2)
  const hot = Array.from({ length: 400 }, (_, i) => 20000 * Math.pow(1.004, i));
  const h = S.evaluate({
    fng: { value: 88, label: "Extreme Greed", week: 70 }, funding: 0.0005, oiChange30: 45, lsRatio: 2.6,
    closes: hot, breadth7: 92, altseason: 85, stableDom: 4.5, btcDom: 45,
  });
  assert.strictEqual(h.level.key, "high");
  assert.ok(h.items.find((i) => i.id === "btcdom").risk === null);
  assert.ok(h.phase);

  const cold = Array.from({ length: 400 }, (_, i) => 60000 * Math.pow(0.998, i));
  const c = S.evaluate({
    fng: { value: 15, label: "Extreme Fear" }, funding: -0.0001, oiChange30: -25, lsRatio: 0.8,
    closes: cold, breadth7: 12, altseason: 15, stableDom: 11.5, btcDom: 60,
  });
  assert.strictEqual(c.level.key, "low");
  assert.match(c.phase, /medvedji/i);
});

test("evaluate brez podatkov", () => {
  const e = S.evaluate({});
  assert.strictEqual(e.items.length, 0);
  assert.strictEqual(e.score, null);
  assert.strictEqual(e.level.key, "na");
});
