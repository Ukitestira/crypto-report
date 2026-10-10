/*
 * Swing trade setupi (samo long) iz dnevnih in 4-urnih sveč (brez DOM-a, testirano z Node-om).
 *
 * Sveče: [{t, o, h, l, c, v}, ...] od najstarejše do najnovejše; zadnja sveča je lahko se odprta
 * (trenutna cena), zato signali uporabljajo samo zaprte sveče, vstop pa trenutno ceno.
 *
 * Setupi:
 *   pullback  - pullback v dvigajocem trendu do EMA20/EMA50, RSI se pobira (dnevni)
 *   breakout  - zaprtje nad 20-dnevnim vrhom ob >= 1,5x povprecnem volumnu (dnevni)
 *   oversold  - RSI(14) pod 30 in se obraca navzgor, zelena sveca (4h)
 *   emacross  - EMA20 je v zadnjih 3 svecah prekrizala EMA50 navzgor (4h)
 *
 * Informativno - ne nasvet za trgovanje.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Swing = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LABELS = {
    pullback: "Pullback v trendu",
    breakout: "Preboj z volumnom",
    oversold: "Odboj iz preprodanosti",
    emacross: "Krizanje EMA 20/50 (4h)",
  };

  // ------------------------------------------------------------------ indikatorji
  function ema(values, n) {
    var out = new Array(values.length).fill(null);
    if (values.length < n) return out;
    var k = 2 / (n + 1), s = 0;
    for (var i = 0; i < n; i++) s += values[i];
    out[n - 1] = s / n;
    for (var j = n; j < values.length; j++) out[j] = values[j] * k + out[j - 1] * (1 - k);
    return out;
  }

  function smaLast(values, n) {
    if (values.length < n) return null;
    var s = 0;
    for (var i = values.length - n; i < values.length; i++) s += values[i];
    return s / n;
  }

  // RSI po Wilderju kot serija (null, dokler ni dovolj podatkov).
  function rsiSeries(closes, n) {
    n = n || 14;
    var out = new Array(closes.length).fill(null);
    if (closes.length < n + 1) return out;
    var g = 0, l = 0;
    for (var i = 1; i <= n; i++) {
      var d = closes[i] - closes[i - 1];
      if (d >= 0) g += d; else l -= d;
    }
    g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (var j = n + 1; j < closes.length; j++) {
      var dd = closes[j] - closes[j - 1];
      g = (g * (n - 1) + Math.max(dd, 0)) / n;
      l = (l * (n - 1) + Math.max(-dd, 0)) / n;
      out[j] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  function last(a) { return a.length ? a[a.length - 1] : null; }
  function minOf(arr, f) { return Math.min.apply(null, arr.map(f)); }
  function maxOf(arr, f) { return Math.max.apply(null, arr.map(f)); }
  function pick(c, k) { return function (x) { return x[k]; }; }

  // Vstop/stop/cilj -> plan; ce stop ali cilj nista smiselna, vrne null.
  function plan(type, entry, stop, target, note) {
    if (!(entry > 0) || !(stop > 0) || !(stop < entry)) return null;
    var risk = entry - stop;
    if (!(target > entry * 1.01)) target = entry + 2 * risk; // ni jasnega cilja -> 2R
    return {
      type: type, label: LABELS[type], entry: entry, stop: stop, target: target,
      rr: (target - entry) / risk, riskPct: risk / entry * 100, note: note,
    };
  }

  // ------------------------------------------------------------------ setupi
  function analyze(daily, h4) {
    var res = { setups: [], trend: "neznan", rsiD: null, rsi4h: null, price: null };
    daily = daily || []; h4 = h4 || [];
    if (daily.length < 25) return res;

    var D = daily.slice(0, -1); // zaprte dnevne svece
    // trenutna cena: najnovejsa sveca (4h je svezja od dnevne)
    var price = h4.length ? last(h4).c : last(daily).c;
    res.price = price;
    var closesD = D.map(pick(0, "c"));
    var ema20 = last(ema(closesD, 20)), ema50 = last(ema(closesD, 50)), sma200 = smaLast(closesD, 200);
    var rsiD = rsiSeries(closesD, 14);
    res.rsiD = last(rsiD);

    if (sma200 && ema50) {
      res.trend = price > sma200 && ema50 > sma200 ? "dvigajoc" : price < sma200 && ema50 < sma200 ? "padajoc" : "bocni";
    } else if (ema50) {
      res.trend = price > ema50 ? "dvigajoc (kratek)" : "padajoc (kratek)";
    }

    // 1) Pullback v trendu
    if (sma200 && ema50 && ema20 && res.trend === "dvigajoc" && D.length >= 30) {
      var recent = D.slice(-3);
      var touched = minOf(recent, pick(0, "l")) <= Math.max(ema20, ema50) * 1.01;
      var r0 = rsiD[rsiD.length - 1], r2 = rsiD[rsiD.length - 3];
      if (touched && price > ema50 * 0.99 && r0 >= 35 && r0 <= 58 && r0 > r2) {
        var stopP = minOf(D.slice(-10), pick(0, "l")) * 0.985;
        var targetP = maxOf(D.slice(-30), pick(0, "h"));
        var pp = plan("pullback", price, stopP, targetP,
          "Trend navzgor (nad 200-dnevnim povprecjem), popravek do EMA" + (minOf(recent, pick(0, "l")) <= ema20 * 1.01 ? "20" : "50") +
          ", RSI " + r0.toFixed(0) + " se pobira.");
        if (pp) res.setups.push(pp);
      }
    }

    // 2) Preboj z volumnom (zadnja zaprta dnevna sveca)
    if (D.length >= 22) {
      var L = last(D), prev = D.slice(-21, -1);
      var level = maxOf(prev, pick(0, "h")), lowR = minOf(prev, pick(0, "l"));
      var avgV = prev.reduce(function (s, c) { return s + c.v; }, 0) / prev.length;
      // cena se drzi nad prebito ravnjo in ni prevec ujela (max 8 % nad njo)
      if (L.c > level && avgV > 0 && L.v >= 1.5 * avgV && price >= level * 0.99 && price <= level * 1.08) {
        var stopB = level * 0.97; // nazaj pod prebito ravnjo = neuspel preboj
        // nad prebitim vrhom ni bliznjega odpora: cilj je vecji od "measured move" in 2R
        var pb = plan("breakout", price, stopB, Math.max(price + (level - lowR), price + 2 * (price - stopB)),
          "Zaprtje nad 20-dnevnim vrhom (" + level.toPrecision(4) + ") ob " + (L.v / avgV).toFixed(1) + "× volumnu.");
        if (pb) res.setups.push(pb);
      }
    }

    // 3) + 4) na 4-urnih svecah
    if (h4.length >= 60) {
      var H = h4.slice(0, -1);
      var closesH = H.map(pick(0, "c"));
      var rsiH = rsiSeries(closesH, 14);
      res.rsi4h = last(rsiH);
      var e20 = ema(closesH, 20), e50 = ema(closesH, 50);

      // 3) Odboj iz preprodanosti
      var win = rsiH.slice(-6).filter(function (x) { return x !== null; });
      var lastH = last(H);
      if (win.length) {
        var minR = Math.min.apply(null, win);
        if (minR < 30 && res.rsi4h >= minR + 4 && lastH.c > lastH.o) {
          var po = plan("oversold", price, minOf(H.slice(-12), pick(0, "l")) * 0.985, last(e50),
            "RSI (4h) je padel na " + minR.toFixed(0) + " in se obraca (" + res.rsi4h.toFixed(0) + "), zadnja sveca zelena.");
          if (po) res.setups.push(po);
        }
      }

      // 4) Krizanje EMA20/EMA50 na 4h
      var n = closesH.length, crossed = false;
      for (var i = n - 3; i < n; i++) {
        if (i > 0 && e20[i - 1] !== null && e50[i - 1] !== null && e20[i - 1] <= e50[i - 1] && e20[i] > e50[i]) crossed = true;
      }
      if (crossed && price > last(e20)) {
        var pe = plan("emacross", price, minOf(H.slice(-10), pick(0, "l")) * 0.985, null,
          "EMA20 je na 4h grafu pravkar presekala EMA50 navzgor, cena je nad obema.");
        if (pe) res.setups.push(pe);
      }
    }

    res.setups.sort(function (a, b) { return b.rr - a.rr; });
    return res;
  }

  // Normalizacija sveč z borz.
  function fromBinance(k) {
    return (k || []).map(function (c) {
      return { t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[7] }; // v = volumen v USDT
    });
  }
  function fromBybit(list) {
    // Bybit vrne od najnovejse do najstarejse: [start, open, high, low, close, volume, turnover]
    return (list || []).slice().reverse().map(function (c) {
      return { t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[6] };
    });
  }

  // Univerzum: USDT pari z dovolj volumna, brez stabilnih in vzvodnih tokenov, razvrsceni po volumnu.
  var STABLE = /^(USDC|FDUSD|TUSD|BUSD|USDP|DAI|USD1|USDE|PYUSD|EUR|EURI|AEUR|XUSD|BFUSD|RLUSD|USDS|USDD|TRY|BRL|GBP|PAXG|XAUT|WBTC|WBETH|WETH|STETH|USDQ|USDR|USDG)$/;
  var LEVER = /(UP|DOWN|BULL|BEAR|\d[LS])$/;
  function universe(rows, opts) {
    var out = [];
    (rows || []).forEach(function (r) {
      var sym = String(r.symbol || "");
      if (sym.slice(-4) !== "USDT") return;
      var base = sym.slice(0, -4);
      if (!base || STABLE.test(base) || LEVER.test(base)) return;
      var vol = Number(r.volume);
      if (!(vol >= (opts.minVolume || 0))) return;
      out.push({ pair: sym, base: base, volume: vol });
    });
    out.sort(function (a, b) { return b.volume - a.volume; });
    return out.slice(0, opts.limit || 50);
  }

  return {
    LABELS: LABELS, ema: ema, smaLast: smaLast, rsiSeries: rsiSeries, analyze: analyze,
    fromBinance: fromBinance, fromBybit: fromBybit, universe: universe,
  };
});
