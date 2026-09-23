/*
 * FOMO logika (brez DOM-a, da jo lahko testiramo z Node-om).
 *
 * Kovanec je "FOMO", ce hkrati velja:
 *   rast v zadnjih 24h >= th.h24  IN  v zadnjih 12h >= th.h12  IN  v zadnji 1h >= th.h1
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Fomo = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_THRESHOLDS = { h24: 12, h12: 9, h1: 7 };

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

  function checks(ch, th) {
    return {
      h24: ch.h24 !== null && ch.h24 >= th.h24,
      h12: ch.h12 !== null && ch.h12 >= th.h12,
      h1: ch.h1 !== null && ch.h1 >= th.h1,
    };
  }

  function hits(ch, th) {
    var c = checks(ch, th);
    return (c.h24 ? 1 : 0) + (c.h12 ? 1 : 0) + (c.h1 ? 1 : 0);
  }

  function isFomo(ch, th) {
    return hits(ch, th) === 3;
  }

  // Koliko "mocno" coin presega pragove - za razvrscanje (vsak prag = 1.0, navzgor neomejeno).
  function score(ch, th) {
    var s = 0;
    ["h24", "h12", "h1"].forEach(function (k) {
      if (ch[k] !== null && th[k] > 0) s += ch[k] / th[k];
    });
    return s;
  }

  /*
   * Razvrsti vrstice v FOMO (vsi 3 pogoji) in radar (2 od 3).
   * Vrstica brez 12h podatka, ki izpolni 24h + 1h, gre v radar z oznako pending12h.
   */
  function classify(rows, th) {
    var fomo = [], radar = [];
    rows.forEach(function (r) {
      var h = hits(r, th);
      var out = Object.assign({}, r, { hits: h, checks: checks(r, th), score: score(r, th) });
      if (h === 3) fomo.push(out);
      else if (h === 2) {
        out.pending12h = r.h12 === null;
        radar.push(out);
      }
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

  return {
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
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
