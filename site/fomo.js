/*
 * FOMO logika (brez DOM-a, da jo lahko testiramo z Node-om).
 *
 * Kovanec je "FOMO", ce hkrati velja:
 *   rast v zadnjih 24h >= th.h24  IN  12h >= th.h12  IN  4h >= th.h4  IN  1h >= th.h1
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Fomo = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var WINDOWS = ["h24", "h12", "h4", "h1"];
  var WINDOW_HOURS = { h24: 24, h12: 12, h4: 4, h1: 1 };
  var DEFAULT_THRESHOLDS = { h24: 12, h12: 9, h4: 8, h1: 7 };

  // Osnove, ki jih pri lovu ne zelimo (stabilni kovanci, zavite verzije ipd.).
  var EXCLUDED_BASES = new Set([
    "USDC", "FDUSD", "TUSD", "BUSD", "USDP", "DAI", "USD1", "USDE", "PYUSD", "EUR", "EURI",
    "AEUR", "XUSD", "BFUSD", "RLUSD", "USDS", "TRY", "BRL", "GBP", "PAXG", "WBTC", "WBETH",
  ]);
  var LEVERAGED = /(UP|DOWN|BULL|BEAR)$/;

  function num(x) {
    if (x === null || x === undefined || x === "") return null;
    var n = Number(x);
    return isFinite(n) ? n : null;
  }

  function val(ch, k) {
    return ch[k] === undefined ? null : ch[k];
  }

  function checks(ch, th) {
    var c = {};
    WINDOWS.forEach(function (k) { c[k] = val(ch, k) !== null && ch[k] >= th[k]; });
    return c;
  }

  function hits(ch, th) {
    var c = checks(ch, th);
    return WINDOWS.filter(function (k) { return c[k]; }).length;
  }

  function isFomo(ch, th) {
    return hits(ch, th) === WINDOWS.length;
  }

  // Koliko "mocno" coin presega pragove - za razvrscanje (vsak prag = 1.0, navzgor neomejeno).
  function score(ch, th) {
    var s = 0;
    WINDOWS.forEach(function (k) {
      if (val(ch, k) !== null && th[k] > 0) s += ch[k] / th[k];
    });
    return s;
  }

  /*
   * Razvrsti vrstice v FOMO (vsi pogoji) in radar (manjka najvec en pogoj).
   * Vrstica z manjkajocimi podatki (npr. 12h/4h ni pridobljen), ki izpolni vse znane
   * pogoje (vsaj dva), gre v radar z oznako pending.
   */
  function classify(rows, th) {
    var fomo = [], radar = [];
    rows.forEach(function (r) {
      var h = hits(r, th);
      var unknown = WINDOWS.filter(function (k) { return val(r, k) === null; }).length;
      var known = WINDOWS.length - unknown;
      var out = Object.assign({}, r, { hits: h, checks: checks(r, th), score: score(r, th), pending: false });
      if (h === WINDOWS.length) fomo.push(out);
      else if (unknown > 0 && known >= 2 && h === known) { out.pending = true; radar.push(out); }
      else if (h >= WINDOWS.length - 1) radar.push(out);
    });
    var byScore = function (a, b) { return b.score - a.score; };
    fomo.sort(byScore);
    radar.sort(byScore);
    return { fomo: fomo, radar: radar };
  }

  // Iz Binance /api/v3/ticker/24hr izbere USDT pare, ki so vredni podrobnejsega pregleda.
  function binanceCandidates(tickers, opts) {
    var minVol = opts.minQuoteVolume || 0;
    var minCh24 = opts.minCh24 === undefined ? 0 : opts.minCh24;
    var limit = opts.limit || 200;
    var out = [];
    (tickers || []).forEach(function (t) {
      var sym = t.symbol || "";
      if (sym.slice(-4) !== "USDT") return;
      var base = sym.slice(0, -4);
      if (!base || EXCLUDED_BASES.has(base) || LEVERAGED.test(base)) return;
      if (!(Number(t.count) > 0)) return;
      var qv = num(t.quoteVolume);
      var ch = num(t.priceChangePercent);
      if (qv === null || ch === null || qv < minVol || ch < minCh24) return;
      out.push({ pair: sym, base: base, h24: ch, price: num(t.lastPrice), volume: qv });
    });
    out.sort(function (a, b) { return b.h24 - a.h24; });
    return out.slice(0, limit);
  }

  function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /*
   * Sprememba cene v % v zadnjih `hours` urah iz CoinGecko market_chart "prices" ([[ms, cena], ...]).
   * Za izhodisce vzame zadnjo tocko, ki je starejsa ali enaka (zadnja - hours).
   */
  function changeFromSeries(prices, hours) {
    if (!prices || prices.length < 2) return null;
    var last = prices[prices.length - 1];
    var cutoff = last[0] - hours * 3600 * 1000;
    var base = null;
    for (var i = prices.length - 1; i >= 0; i--) {
      if (prices[i][0] <= cutoff) { base = prices[i]; break; }
    }
    if (!base) {
      // Serija ne seze dovolj nazaj: sprejmemo prvo tocko, ce je znotraj 30 min od cilja.
      if (prices[0][0] - cutoff <= 30 * 60 * 1000) base = prices[0];
      else return null;
    }
    if (!base[1]) return null;
    return (last[1] - base[1]) / base[1] * 100;
  }

  /*
   * Kako blizu je potek cene "idealni paraboli": krivulja, ki zacne ravno ob
   * zacetni ceni in se vedno bolj strmo dviga do trenutne cene:
   *   ideal(x) = p0 + (pN - p0) * x^2,  x = 0..1 (od prve do zadnje tocke)
   * match = 1 - SSE/SST (R^2 glede na idealno krivuljo), omejeno na 0..1.
   * Vrne null, ce cena v obdobju ni zrasla (parabola navzgor nima smisla).
   */
  function parabolaFit(series) {
    if (!series || series.length < 5) return null;
    var t0 = series[0][0], t1 = series[series.length - 1][0];
    var p0 = series[0][1], pN = series[series.length - 1][1];
    if (!(t1 > t0) || !(pN > p0)) return null;
    var mean = 0;
    series.forEach(function (pt) { mean += pt[1]; });
    mean /= series.length;
    var sse = 0, sst = 0;
    series.forEach(function (pt) {
      var x = (pt[0] - t0) / (t1 - t0);
      var ideal = p0 + (pN - p0) * x * x;
      sse += (pt[1] - ideal) * (pt[1] - ideal);
      sst += (pt[1] - mean) * (pt[1] - mean);
    });
    var match = sst > 0 ? Math.max(0, Math.min(1, 1 - sse / sst)) : 0;
    return {
      match: match,
      ideal: function (t) { var x = (t - t0) / (t1 - t0); return p0 + (pN - p0) * x * x; },
    };
  }

  return {
    WINDOWS: WINDOWS,
    WINDOW_HOURS: WINDOW_HOURS,
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
    parabolaFit: parabolaFit,
    num: num,
    checks: checks,
    hits: hits,
    isFomo: isFomo,
    score: score,
    classify: classify,
    binanceCandidates: binanceCandidates,
    chunk: chunk,
    changeFromSeries: changeFromSeries,
  };
});
