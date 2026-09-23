/*
 * Sentiment trga in ocena tveganja za popravek (brez DOM-a, testirano z Node-om).
 *
 * Vsak indikator dobi "tveganje" 0-100 (0 = tveganje popravka nizko, 100 = zelo visoko).
 * Ocena je povprecje razpolozljivih indikatorjev, locena na kratkorocni del (dnevi-tedni)
 * in ciklicni del (meseci). Informativno - ne napoved in ne financni nasvet.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Sentiment = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------------ matematika
  function sma(values, n) {
    if (!values || values.length < n) return null;
    var s = 0;
    for (var i = values.length - n; i < values.length; i++) s += values[i];
    return s / n;
  }

  // RSI po Wilderju.
  function rsi(closes, n) {
    n = n || 14;
    if (!closes || closes.length < n + 1) return null;
    var gain = 0, loss = 0;
    for (var i = 1; i <= n; i++) {
      var d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    for (var j = n + 1; j < closes.length; j++) {
      var dd = closes[j] - closes[j - 1];
      gain = (gain * (n - 1) + Math.max(dd, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-dd, 0)) / n;
    }
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  }

  // Odsekoma linearna preslikava x -> tveganje skozi tocke [[x, tveganje], ...] (x narascajoce).
  function mapRisk(x, pts) {
    if (x === null || x === undefined || !isFinite(x)) return null;
    if (x <= pts[0][0]) return pts[0][1];
    for (var i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        var a = pts[i - 1], b = pts[i];
        return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      }
    }
    return pts[pts.length - 1][1];
  }

  var LEVELS = [
    { max: 35, key: "low", label: "Nizko", adj: "nizka" },
    { max: 55, key: "moderate", label: "Zmerno", adj: "zmerna" },
    { max: 70, key: "elevated", label: "Povisano", adj: "povisana" },
    { max: 101, key: "high", label: "Visoko", adj: "visoka" },
  ];
  function level(risk) {
    if (risk === null || risk === undefined) return { key: "na", label: "Ni podatka" };
    for (var i = 0; i < LEVELS.length; i++) if (risk < LEVELS[i].max) return LEVELS[i];
    return LEVELS[LEVELS.length - 1];
  }

  // Stabilni, zaviti ali "staked" tokeni ne sodijo v meritve sirine trga.
  var STABLE_SYMBOLS = new Set(["usdt", "usdc", "dai", "fdusd", "usde", "usds", "tusd", "pyusd", "usd1",
    "busd", "susde", "usdd", "frax", "gusd", "usdp", "rlusd", "usdtb", "usdx", "bfusd", "usdf", "eurc", "xaut", "paxg"]);
  function isExcludedCoin(c) {
    var sym = String(c.symbol || "").toLowerCase();
    var name = String(c.name || "").toLowerCase();
    if (STABLE_SYMBOLS.has(sym)) return true;
    if (/usd/.test(sym) && /usd|dollar/.test(name)) return true;
    if (/wrapped|staked|bridged|restaked|liquid staking/.test(name)) return true;
    if (/^(w|cb|st|wst|we|r|m)?(btc|eth)$/.test(sym) && sym !== "btc" && sym !== "eth") return true;
    return false;
  }

  // % od top N (brez stabilnih/zavitih) z rastjo v 7 dneh.
  function breadth(markets, n) {
    var list = (markets || []).filter(function (c) { return !isExcludedCoin(c); }).slice(0, n || 100);
    var ok = list.filter(function (c) { return c.price_change_percentage_7d_in_currency !== null && c.price_change_percentage_7d_in_currency !== undefined; });
    if (ok.length < 10) return null;
    return ok.filter(function (c) { return c.price_change_percentage_7d_in_currency > 0; }).length / ok.length * 100;
  }

  // Altseason: % od top 50 altcoinov (brez BTC, stabilnih, zavitih), ki so v 30 dneh premagali BTC.
  function altseason(markets) {
    var btc = (markets || []).find(function (c) { return c.id === "bitcoin"; });
    var btc30 = btc ? btc.price_change_percentage_30d_in_currency : null;
    if (btc30 === null || btc30 === undefined) return null;
    var alts = markets.filter(function (c) { return c.id !== "bitcoin" && !isExcludedCoin(c); }).slice(0, 50)
      .filter(function (c) { return c.price_change_percentage_30d_in_currency !== null && c.price_change_percentage_30d_in_currency !== undefined; });
    if (alts.length < 10) return null;
    return alts.filter(function (c) { return c.price_change_percentage_30d_in_currency > btc30; }).length / alts.length * 100;
  }

  function f1(x) { return (Math.round(x * 10) / 10).toString(); }
  function sgn(x, d) { return (x >= 0 ? "+" : "") + x.toFixed(d === undefined ? 1 : d); }

  /*
   * data = {
   *   fng: {value, label, week, month}, funding (delez na 8h, npr. 0.0001), oiChange30 (%),
   *   lsRatio, closes (dnevne BTC cene, najstarejsa prva), stableDom (%), btcDom (%),
   *   breadth7 (%), altseason (%)
   * }
   */
  function evaluate(data) {
    var items = [];
    var d = data || {};

    // --- kratkorocno ---
    if (d.fng) {
      var v = d.fng.value;
      var trend = d.fng.week !== null && d.fng.week !== undefined ? " (pred 7 dnevi " + d.fng.week + ")" : "";
      items.push({
        id: "fng", group: "short", name: "Fear & Greed indeks", value: v + "/100 – " + d.fng.label + trend,
        risk: mapRisk(v, [[0, 5], [25, 20], [50, 45], [75, 75], [90, 95]]),
        note: v >= 75 ? "Ekstremni pohlep: trg je pregret, v takih obdobjih so popravki pogosti."
          : v >= 55 ? "Pohlep: optimizem prevladuje, novi nakupi so bolj tvegani."
          : v >= 45 ? "Nevtralno razpolozenje."
          : v >= 25 ? "Strah: vlagatelji so previdni, pritisk prodaje je vecinoma ze za nami."
          : "Ekstremni strah: zgodovinsko pogosto blizu lokalnega dna.",
      });
    }
    if (d.funding !== null && d.funding !== undefined) {
      var fr = d.funding * 100;
      items.push({
        id: "funding", group: "short", name: "Funding rate (BTC perpetual)",
        value: sgn(fr, 4) + "% / 8h (≈" + sgn(fr * 3 * 365, 0) + "% letno)",
        risk: mapRisk(d.funding, [[-0.0003, 10], [0, 25], [0.0001, 40], [0.0003, 70], [0.0006, 95]]),
        note: d.funding > 0.0003 ? "Dolge pozicije placujejo veliko: trg je prenapet z vzvodom, nevarnost 'long squeeze' padca."
          : d.funding > 0.00012 ? "Nadpovprecno: vzvod na strani kupcev narasca."
          : d.funding >= 0 ? "Normalno (osnovna stopnja ≈ 0,01 %)."
          : "Negativno: prevladujejo kratke pozicije, mozen 'short squeeze' navzgor.",
      });
    }
    if (d.oiChange30 !== null && d.oiChange30 !== undefined) {
      items.push({
        id: "oi", group: "short", name: "Open interest BTC (30 dni)", value: sgn(d.oiChange30) + "%",
        risk: mapRisk(d.oiChange30, [[-30, 20], [0, 40], [20, 65], [40, 90]]),
        note: d.oiChange30 > 20 ? "Hitra rast odprtih pozicij: vec vzvoda v sistemu, vecji padci ob likvidacijah."
          : d.oiChange30 > 0 ? "Zmerna rast odprtih pozicij."
          : "Vzvod se je zmanjsal (likvidacije/zapiranje pozicij) – trg je 'ociscen'.",
      });
    }
    if (d.lsRatio !== null && d.lsRatio !== undefined) {
      items.push({
        id: "ls", group: "short", name: "Long/short razmerje (racuni, Binance)", value: d.lsRatio.toFixed(2),
        risk: mapRisk(d.lsRatio, [[0.7, 20], [1, 35], [1.5, 55], [2, 70], [3, 90]]),
        note: d.lsRatio >= 2 ? "Vecina malih vlagateljev je v dolgih pozicijah – kontrarijanski znak za previdnost."
          : d.lsRatio >= 1.2 ? "Rahla prevlada dolgih pozicij."
          : d.lsRatio >= 0.9 ? "Uravnotezeno."
          : "Prevladujejo kratke pozicije – mozen odboj navzgor.",
      });
    }
    var closes = d.closes || [];
    var r = rsi(closes, 14);
    if (r !== null) {
      items.push({
        id: "rsi", group: "short", name: "RSI(14) BTC, dnevni", value: f1(r),
        risk: mapRisk(r, [[25, 10], [30, 15], [50, 40], [70, 75], [80, 95]]),
        note: r >= 70 ? "Prekupljeno (overbought): kratkorocni oddih ali popravek je verjeten."
          : r >= 55 ? "Mocan zagon navzgor."
          : r >= 45 ? "Nevtralno."
          : r >= 30 ? "Sibek zagon."
          : "Preprodano (oversold): pogosto sledi odboj.",
      });
    }
    if (d.breadth7 !== null && d.breadth7 !== undefined) {
      items.push({
        id: "breadth", group: "short", name: "Sirina trga (top 100, 7 dni v plusu)", value: Math.round(d.breadth7) + "% kovancev",
        risk: mapRisk(d.breadth7, [[10, 20], [30, 30], [50, 45], [70, 60], [90, 80]]),
        note: d.breadth7 >= 80 ? "Skoraj vse raste hkrati – kratkorocno pregreto."
          : d.breadth7 >= 55 ? "Rast je siroka in zdrava."
          : d.breadth7 >= 35 ? "Mesano."
          : "Vecina trga pada – kratkorocno preprodano.",
      });
    }

    // --- cikel ---
    var price = closes.length ? closes[closes.length - 1] : null;
    var ma200 = sma(closes, 200);
    if (price && ma200) {
      var mayer = price / ma200;
      items.push({
        id: "mayer", group: "cycle", name: "Mayer multiple (BTC / 200-dnevno povprecje)", value: mayer.toFixed(2) + "×",
        risk: mapRisk(mayer, [[0.6, 5], [0.8, 15], [1.0, 35], [1.5, 60], [2.0, 80], [2.4, 95]]),
        note: mayer >= 2.4 ? "Zgodovinsko obmocje vrhov cikla."
          : mayer >= 1.5 ? "Cena je dalec nad dolgorocnim povprecjem – pozna faza rasti."
          : mayer >= 1.0 ? "Nad 200-dnevnim povprecjem – zdrav bikovski trend."
          : mayer >= 0.8 ? "Pod 200-dnevnim povprecjem – sibek/medvedji trend."
          : "Globoko pod povprecjem – zgodovinsko obmocje akumulacije.",
      });
    }
    var ma111 = sma(closes, 111), ma350 = sma(closes, 350);
    if (ma111 && ma350) {
      var pi = ma111 / (2 * ma350);
      items.push({
        id: "pi", group: "cycle", name: "Pi Cycle Top (111DMA / 2×350DMA)", value: (pi * 100).toFixed(0) + "% do signala",
        risk: mapRisk(pi, [[0.5, 10], [0.7, 30], [0.85, 60], [0.95, 85], [1.0, 100]]),
        note: pi >= 1 ? "Signal sprozen – v preteklosti je natancno oznacil vrhove ciklov (2013, 2017, 2021)."
          : pi >= 0.9 ? "Blizu signala za vrh cikla."
          : pi >= 0.7 ? "Srednja faza cikla."
          : "Dalec od vrha cikla.",
      });
    }
    if (d.altseason !== null && d.altseason !== undefined) {
      items.push({
        id: "alt", group: "cycle", name: "Altseason indeks (30 dni)", value: Math.round(d.altseason) + "/100",
        risk: mapRisk(d.altseason, [[10, 30], [25, 35], [50, 50], [75, 75], [90, 90]]),
        note: d.altseason >= 75 ? "Altcoin sezona: denar tece v tvegane kovance – znacilno za pozno fazo cikla."
          : d.altseason <= 25 ? "Bitcoin sezona: BTC premaguje vecino altcoinov, kapital je previden."
          : "Mesano: ni izrazite rotacije v altcoine.",
      });
    }
    if (d.stableDom !== null && d.stableDom !== undefined) {
      items.push({
        id: "stable", group: "cycle", name: "Dominanca stabilnih kovancev (USDT+USDC)", value: d.stableDom.toFixed(1) + "%",
        risk: mapRisk(d.stableDom, [[4, 85], [6, 65], [8, 45], [10, 30], [12, 15]]),
        note: d.stableDom < 6 ? "Malo 'suhega smodnika' – vlagatelji so v veliki meri ze vlozeni."
          : d.stableDom > 10 ? "Veliko denarja caka ob strani – potencial za nakupe je velik."
          : "Zmerna rezerva kapitala v stabilnih kovancih.",
      });
    }
    if (d.btcDom !== null && d.btcDom !== undefined) {
      items.push({
        id: "btcdom", group: "context", name: "BTC dominanca", value: d.btcDom.toFixed(1) + "%", risk: null,
        note: d.btcDom >= 58 ? "Visoka: kapital je v BTC, altcoini zaostajajo (bolj varno okolje)."
          : d.btcDom <= 48 ? "Nizka: kapital je razprsen v altcoine (vecja spekulacija)."
          : "Srednja.",
      });
    }

    function avg(group) {
      var xs = items.filter(function (i) { return i.risk !== null && (!group || i.group === group); })
        .map(function (i) { return i.risk; });
      return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : null;
    }
    items.forEach(function (i) { i.level = level(i.risk); });

    var score = avg(), shortScore = avg("short"), cycleScore = avg("cycle");
    return {
      items: items,
      score: score, level: level(score),
      shortScore: shortScore, shortLevel: level(shortScore),
      cycleScore: cycleScore, cycleLevel: level(cycleScore),
      phase: phase(price, ma200, items),
      summary: summary(score, shortScore, cycleScore),
    };
  }

  function phase(price, ma200, items) {
    var mayer = items.find(function (i) { return i.id === "mayer"; });
    if (!price || !ma200 || !mayer) return null;
    var m = price / ma200;
    if (m >= 2.2) return "Evforija / blizu vrha cikla";
    if (m >= 1.5) return "Pozna faza bikovskega trga";
    if (m >= 1.0) return "Bikovski trend";
    if (m >= 0.8) return "Oslabljen / medvedji trend";
    return "Medvedji trg – obmocje akumulacije";
  }

  function summary(score, shortScore, cycleScore) {
    if (score === null) return "Premalo podatkov za oceno.";
    var s = "Verjetnost popravka je " + level(score).adj + ".";
    if (shortScore !== null && cycleScore !== null) {
      if (shortScore - cycleScore >= 15) s += " Kratkorocno je trg pregret (vzvod/razpolozenje), cikel pa se ni na vrhu – mozen je oster, a zacasen popravek.";
      else if (cycleScore - shortScore >= 15) s += " Kratkorocno je trg ohlajen, dolgorocni kazalniki pa kazejo pozno fazo cikla – previdnost pri vecjih pozicijah.";
      else if (score >= 70) s += " Kratkorocni in ciklicni kazalniki so hkrati visoki.";
      else if (score < 35) s += " Tako kratkorocni kot ciklicni kazalniki so umirjeni.";
    }
    return s;
  }

  return {
    sma: sma, rsi: rsi, mapRisk: mapRisk, level: level, isExcludedCoin: isExcludedCoin,
    breadth: breadth, altseason: altseason, evaluate: evaluate,
  };
});
