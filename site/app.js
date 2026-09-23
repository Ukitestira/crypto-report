/* Crypto FOMO pregled - vse tece v brskalniku, podatki se pridobijo ob vsakem osvezevanju. */
(function () {
  "use strict";

  var CG_BASE = "https://api.coingecko.com/api/v3";
  var BINANCE_BASES = ["https://api.binance.com", "https://data-api.binance.vision"];
  var FNG_URL = "https://api.alternative.me/fng/?limit=31";
  var FAPI_BASE = "https://fapi.binance.com";
  var OKX_BASE = "https://www.okx.com/api/v5";
  var AUTO_MS = 5 * 60 * 1000;
  var CG_CHART_LIMIT = 6; // najvec market_chart klicev (12h) na osvezitev - brezplacni CoinGecko je omejen
  var SETTINGS_KEY = "fomo-settings-v1";

  var DEFAULTS = {
    h24: Fomo.DEFAULT_THRESHOLDS.h24,
    h12: Fomo.DEFAULT_THRESHOLDS.h12,
    h4: Fomo.DEFAULT_THRESHOLDS.h4,
    h1: Fomo.DEFAULT_THRESHOLDS.h1,
    minVol: 100000,
    cgKey: "",
    notify: false,
    auto: true,
  };

  var $ = function (id) { return document.getElementById(id); };
  var settings = loadSettings();
  var lastFomoKeys = null;
  var autoTimer = null;
  var busy = false;
  var shownRows = {};      // kljuc -> vrstica, prikazana v FOMO/radar tabeli (za grafe)
  var expanded = new Set(); // kljuci vrstic z odprtim velikim grafom

  // ------------------------------------------------------------------ nastavitve
  function loadSettings() {
    var s = Object.assign({}, DEFAULTS);
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) Object.assign(s, JSON.parse(raw));
    } catch (e) { /* brez shrambe - privzete vrednosti */ }
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignoriraj */ }
  }
  function thresholds() {
    var th = {};
    Fomo.WINDOWS.forEach(function (k) { th[k] = Number(settings[k]); });
    return th;
  }

  // ------------------------------------------------------------------ oblikovanje
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtMoney(x) {
    if (x === null || x === undefined) return "–";
    var a = Math.abs(x);
    var d = a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    return "$" + x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtBig(x) {
    if (x === null || x === undefined) return "–";
    var units = ["", "K", "M", "B", "T"];
    for (var i = 0; i < units.length; i++) {
      if (Math.abs(x) < 1000) return "$" + x.toFixed(2) + units[i];
      x /= 1000;
    }
    return "$" + x.toFixed(2) + "Q";
  }
  function fmtPct(x) {
    if (x === null || x === undefined || !isFinite(x)) return "–";
    return (x >= 0 ? "+" : "") + x.toFixed(2) + "%";
  }
  function pctCls(x) {
    if (x === null || x === undefined) return "na";
    return x >= 0 ? "pos" : "neg";
  }
  function fmtAmount(x) {
    return x.toLocaleString("en-US", { maximumFractionDigits: 6 });
  }

  // ------------------------------------------------------------------ HTTP
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function getJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) {
        var err = new Error("HTTP " + r.status);
        err.status = r.status;
        throw err;
      }
      return r.json();
    });
  }

  // CoinGecko klici gredo zaporedno z razmikom, da ne naletimo na 429.
  var cgQueue = Promise.resolve();
  function cgGet(path, params) {
    params = Object.assign({}, params || {});
    if (settings.cgKey) params.x_cg_demo_api_key = settings.cgKey;
    var url = CG_BASE + path + "?" + new URLSearchParams(params).toString();
    var gap = settings.cgKey ? 300 : 1500;
    var p = cgQueue.then(function () {
      return getJson(url).catch(function (e) {
        if (e.status !== 429) throw e;
        return sleep(20000).then(function () { return getJson(url); });
      });
    });
    cgQueue = p.catch(function () {}).then(function () { return sleep(gap); });
    return p;
  }

  function binanceGet(path, params) {
    var qs = new URLSearchParams(params || {}).toString();
    var i = 0;
    function attempt() {
      var url = BINANCE_BASES[i] + path + (qs ? "?" + qs : "");
      return getJson(url).catch(function (e) {
        i++;
        if (i < BINANCE_BASES.length) return attempt();
        throw e;
      });
    }
    return attempt();
  }

  // ------------------------------------------------------------------ podatki
  function loadConfig() {
    // Na GitHub Pages je config.json poleg strani; lokalno (repo koren) je en nivo vise.
    return getJson("config.json").catch(function () { return getJson("../config.json"); });
  }

  function fetchHoldingsMarkets(ids, vs) {
    if (!ids.length) return Promise.resolve({});
    return cgGet("/coins/markets", {
      vs_currency: vs,
      ids: ids.join(","),
      price_change_percentage: "1h,24h,7d",
      per_page: 250,
      page: 1,
    }).then(function (rows) {
      var map = {};
      rows.forEach(function (r) { map[r.id] = r; });
      return map;
    });
  }

  function fetchGlobal() {
    return cgGet("/global").then(function (res) {
      var g = res.data;
      return {
        mcap: g.total_market_cap.usd,
        dom: g.market_cap_percentage.btc,
        mcap24: g.market_cap_change_percentage_24h_usd,
        vol: g.total_volume.usd,
        stableDom: (g.market_cap_percentage.usdt || 0) + (g.market_cap_percentage.usdc || 0),
      };
    });
  }

  function fetchFng() {
    return getJson(FNG_URL).then(function (res) {
      var d = res.data;
      var at = function (i) { return d[i] ? Number(d[i].value) : null; };
      return { value: Number(d[0].value), label: d[0].value_classification, week: at(7), month: at(30) };
    });
  }

  // ------------------------------------------------------------------ sentiment trga
  // Vsak vir je neodvisen: ce eden ne odgovori, se indikator preprosto ne prikaze.
  function fetchSentiment(glob, fng) {
    var failed = [];
    var soft = function (label) { return function () { failed.push(label); return null; }; };

    var closesP = binanceGet("/api/v3/klines", { symbol: "BTCUSDT", interval: "1d", limit: 400 })
      .then(function (k) { return k.map(function (c) { return Number(c[4]); }); })
      .catch(soft("Binance (BTC dnevne cene)"));
    var fundingP = getJson(FAPI_BASE + "/fapi/v1/premiumIndex?symbol=BTCUSDT")
      .then(function (r) { return Fomo.num(r.lastFundingRate); })
      .catch(function () {
        return getJson(OKX_BASE + "/public/funding-rate?instId=BTC-USDT-SWAP")
          .then(function (r) { return Fomo.num(r.data[0].fundingRate); });
      })
      .catch(soft("funding rate"));
    var oiP = getJson(FAPI_BASE + "/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=30")
      .then(function (a) {
        var first = Number(a[0].sumOpenInterestValue), last = Number(a[a.length - 1].sumOpenInterestValue);
        return first > 0 ? (last / first - 1) * 100 : null;
      })
      .catch(soft("open interest"));
    var lsP = getJson(FAPI_BASE + "/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=1")
      .then(function (a) { return Fomo.num(a[a.length - 1].longShortRatio); })
      .catch(soft("long/short razmerje"));
    var marketsP = cgGet("/coins/markets", {
      vs_currency: "usd", order: "market_cap_desc", per_page: 100, page: 1, price_change_percentage: "7d,30d",
    }).catch(soft("CoinGecko (top 100)"));

    return Promise.all([closesP, fundingP, oiP, lsP, marketsP]).then(function (r) {
      var markets = r[4];
      if (!glob) failed.push("CoinGecko (dominanca)");
      if (!fng) failed.push("Fear & Greed");
      var res = Sentiment.evaluate({
        fng: fng, closes: r[0], funding: r[1], oiChange30: r[2], lsRatio: r[3],
        breadth7: markets ? Sentiment.breadth(markets, 100) : null,
        altseason: markets ? Sentiment.altseason(markets) : null,
        stableDom: glob ? glob.stableDom : null, btcDom: glob ? glob.dom : null,
      });
      res.failed = failed;
      return res;
    });
  }

  var LEVEL_ICON = { low: "\u2193", moderate: "\u2192", elevated: "\u2197", high: "\u2191", na: "\u00b7" };

  function stateBadge(lv) {
    return "<span class='st st-" + lv.key + "'><i aria-hidden='true'>" + LEVEL_ICON[lv.key] + "</i>" + esc(lv.label) + "</span>";
  }

  function meterHtml(score) {
    var pin = score === null ? "" : "<i class='pin' style='left:" + Math.max(0, Math.min(100, score)).toFixed(1) + "%'></i>";
    return "<div class='meter' role='img' aria-label='Tveganje " + (score === null ? "ni podatka" : Math.round(score) + " od 100") + "'>" +
      "<span class='seg st-low' style='width:35%'></span><span class='seg st-moderate' style='width:20%'></span>" +
      "<span class='seg st-elevated' style='width:15%'></span><span class='seg st-high' style='width:30%'></span>" + pin + "</div>" +
      "<div class='meter-scale'><span>0</span><span style='left:35%'>35</span><span style='left:55%'>55</span><span style='left:70%'>70</span><span class='end'>100</span></div>";
  }

  function scoreTile(title, score, lv, big) {
    return "<div class='risk-tile" + (big ? " big" : "") + "'>" +
      "<div class='kpi-label'>" + title + "</div>" +
      "<div class='risk-num'>" + (score === null ? "\u2013" : Math.round(score)) + "<small>/100</small> " + stateBadge(lv) + "</div>" +
      (big ? meterHtml(score) : "<div class='mini-bar'><span class='st-" + lv.key + "' style='width:" + (score || 0).toFixed(0) + "%'></span></div>") +
      "</div>";
  }

  function renderSentiment(res) {
    if (!res || !res.items.length) {
      $("sent-phase").hidden = true;
      $("sent-body").innerHTML = "<div class='empty'>Podatki za sentiment niso dosegljivi \u2013 poskusi znova cez minuto.</div>";
      return;
    }
    $("sent-phase").hidden = !res.phase;
    $("sent-phase").textContent = res.phase ? "Faza: " + res.phase : "";
    var groups = [
      ["short", "Kratkorocno (dnevi\u2013tedni)"],
      ["cycle", "Cikel (meseci)"],
      ["context", "Kontekst"],
    ];
    var list = groups.map(function (g) {
      var items = res.items.filter(function (i) { return i.group === g[0]; });
      if (!items.length) return "";
      return "<h3>" + g[1] + "</h3><div class='ind-list'>" + items.map(function (i) {
        return "<div class='ind'>" +
          "<div class='ind-name'>" + esc(i.name) + "</div>" +
          "<div class='ind-val'>" + esc(i.value) + "</div>" +
          "<div class='ind-state'>" + (i.risk === null ? "<span class='muted small'>informativno</span>" : stateBadge(i.level)) + "</div>" +
          (i.risk === null ? "<div></div>" : "<div class='ind-bar'><span class='st-" + i.level.key + "' style='width:" + i.risk.toFixed(0) + "%'></span></div>") +
          "<div class='ind-note'>" + esc(i.note) + "</div></div>";
      }).join("") + "</div>";
    }).join("");
    $("sent-body").innerHTML =
      "<div class='risk-grid'>" +
        scoreTile("Tveganje popravka", res.score, res.level, true) +
        "<div class='risk-sub'>" +
          scoreTile("Kratkorocno", res.shortScore, res.shortLevel) +
          scoreTile("Cikel", res.cycleScore, res.cycleLevel) +
        "</div>" +
      "</div>" +
      "<p class='sent-summary'>" + esc(res.summary) + "</p>" + list +
      (res.failed.length ? "<p class='muted small'>Ni podatka: " + esc(res.failed.join(", ")) + ".</p>" : "");
  }


  // 24h potek cene iz CoinGecko (tocke na ~5 min) - iz njega izracunamo 12h in 4h ter narisemo graf.
  function cgSeries(id) {
    return cgGet("/coins/" + encodeURIComponent(id) + "/market_chart", { vs_currency: "usd", days: 1 })
      .then(function (res) { return res.prices; });
  }
  function applySeries(r, prices) {
    r.series = prices;
    r.h12 = Fomo.changeFromSeries(prices, 12);
    r.h4 = Fomo.changeFromSeries(prices, 4);
  }

  // 24h potek cene iz Binance (15-min svece).
  function binanceSeries(pair) {
    return binanceGet("/api/v3/klines", { symbol: pair, interval: "15m", limit: 97 }).then(function (k) {
      if (!k.length) return [];
      var pts = k.map(function (c) { return [c[0], Number(c[1])]; });
      var last = k[k.length - 1];
      pts.push([Math.min(last[6], Date.now()), Number(last[4])]);
      return pts;
    });
  }

  // Binance: vsi USDT pari -> top kandidati po 24h rasti -> 12h, 4h in 1h drsno okno.
  function scanBinance(th) {
    return binanceGet("/api/v3/ticker/24hr").then(function (tickers) {
      var cands = Fomo.binanceCandidates(tickers, { minQuoteVolume: Number(settings.minVol) || 0, minCh24: 0, limit: 200 });
      var byPair = {};
      cands.forEach(function (c) { byPair[c.pair] = c; });
      var jobs = [];
      Fomo.chunk(cands.map(function (c) { return c.pair; }), 100).forEach(function (pairs) {
        ["12h", "4h", "1h"].forEach(function (win) {
          jobs.push(binanceGet("/api/v3/ticker", { symbols: JSON.stringify(pairs), windowSize: win })
            .then(function (rows) {
              rows.forEach(function (r) {
                var c = byPair[r.symbol];
                if (c) c["h" + win.slice(0, -1)] = Fomo.num(r.priceChangePercent);
              });
            }));
        });
      });
      return Promise.all(jobs).then(function () {
        return cands.map(function (c) {
          return {
            symbol: c.base, pair: c.pair, name: "", price: c.price, volume: c.volume,
            h24: c.h24, h12: c.h12 === undefined ? null : c.h12,
            h4: c.h4 === undefined ? null : c.h4, h1: c.h1 === undefined ? null : c.h1,
            source: "Binance", url: "https://www.binance.com/en/trade/" + c.base + "_USDT",
          };
        });
      });
    });
  }

  // CoinGecko: top 250 po volumnu (ujame tudi kovance, ki jih ni na Binance). 12h/4h samo za mocne kandidate.
  function scanCoinGecko(th, skipSymbols) {
    return cgGet("/coins/markets", {
      vs_currency: "usd", order: "volume_desc", per_page: 250, page: 1, price_change_percentage: "1h,24h",
    }).then(function (rows) {
      var out = [];
      rows.forEach(function (r) {
        var sym = (r.symbol || "").toUpperCase();
        if (skipSymbols.has(sym)) return;
        var h24 = Fomo.num(r.price_change_percentage_24h_in_currency);
        var h1 = Fomo.num(r.price_change_percentage_1h_in_currency);
        if (h24 === null || h1 === null) return;
        if (!(h24 >= th.h24 || h1 >= th.h1)) return;
        out.push({
          id: r.id, symbol: sym, name: r.name, price: r.current_price, volume: r.total_volume,
          h24: h24, h12: null, h4: null, h1: h1, source: "CoinGecko", url: "https://www.coingecko.com/en/coins/" + r.id,
        });
      });
      var need = out.filter(function (r) { return r.h24 >= th.h24 && r.h1 >= th.h1; })
        .sort(function (a, b) { return Fomo.score(b, th) - Fomo.score(a, th); })
        .slice(0, CG_CHART_LIMIT);
      return Promise.all(need.map(function (r) {
        return cgSeries(r.id).then(function (p) { applySeries(r, p); }).catch(function () {});
      })).then(function () { return out; });
    });
  }

  // ------------------------------------------------------------------ portfelj (kot email porocilo)
  function computePortfolio(holdings, mmap) {
    var rows = [], missing = [], total = 0, prev = 0;
    holdings.forEach(function (h) {
      var m = h.id ? mmap[h.id] : null;
      if (!m || m.current_price === null || m.current_price === undefined) { missing.push(h); return; }
      var price = m.current_price;
      var ch24 = Fomo.num(m.price_change_percentage_24h_in_currency);
      var value = price * h.amount;
      total += value;
      prev += ch24 !== null ? value / (1 + ch24 / 100) : value;
      rows.push({
        symbol: h.symbol, id: h.id, amount: h.amount, price: price, value: value,
        h1: Fomo.num(m.price_change_percentage_1h_in_currency), h24: ch24, h12: null, h4: null,
        d7: Fomo.num(m.price_change_percentage_7d_in_currency),
        target: h.target_price || null,
        pctToTarget: h.target_price ? (h.target_price - price) / price * 100 : null,
        avgBuy: h.avg_buy_price || null,
        pctSinceBuy: h.avg_buy_price ? (price - h.avg_buy_price) / h.avg_buy_price * 100 : null,
      });
    });
    rows.sort(function (a, b) { return b.value - a.value; });
    return { rows: rows, missing: missing, total: total, ch24: prev > 0 ? (total - prev) / prev * 100 : null };
  }

  function agentNote(rows, fng, portCh) {
    var notes = [];
    if (portCh !== null) {
      if (portCh >= 3) notes.push("Portfelj je v zadnjih 24h opazno v plusu (" + fmtPct(portCh) + ").");
      else if (portCh <= -3) notes.push("Portfelj je v zadnjih 24h opazno v minusu (" + fmtPct(portCh) + ").");
    }
    var movers = rows.filter(function (r) { return r.h24 !== null; });
    if (movers.length) {
      var top = movers.reduce(function (a, b) { return b.h24 > a.h24 ? b : a; });
      var bot = movers.reduce(function (a, b) { return b.h24 < a.h24 ? b : a; });
      if (top.h24 >= 8) notes.push("Najvecji dobitnik: " + top.symbol + " (" + fmtPct(top.h24) + ").");
      if (bot.h24 <= -8) notes.push("Najvecji izgubljalec: " + bot.symbol + " (" + fmtPct(bot.h24) + ").");
    }
    if (fng) {
      if (fng.value <= 25) notes.push("Trzni sentiment je 'Extreme Fear' (" + fng.value + ").");
      else if (fng.value >= 75) notes.push("Trzni sentiment je 'Extreme Greed' (" + fng.value + ").");
    }
    return notes.length ? notes.join(" ") : "Brez izstopajocih premikov v zadnjih 24h.";
  }

  // ------------------------------------------------------------------ izris
  function renderChips(th) {
    $("th-chips").innerHTML = Fomo.WINDOWS.map(function (k) {
      return "<span class='chip'>" + Fomo.WINDOW_HOURS[k] + "h \u2265 " + th[k] + "%</span>";
    }).join("");
  }

  function pctCell(v, hit) {
    return "<td class='" + (hit ? "hit" : pctCls(v)) + "'>" + fmtPct(v) + "</td>";
  }

  function rowKey(r) { return r.source + ":" + r.symbol; }

  function fomoRowHtml(r, ownSymbols) {
    var key = rowKey(r);
    var sym = "<a href='" + esc(r.url) + "' target='_blank' rel='noopener'>" + esc(r.symbol) + "</a>";
    if (r.name) sym += " <span class='muted small'>" + esc(r.name) + "</span>";
    if (ownSymbols.has(r.symbol)) sym += "<span class='badge own'>v portfelju</span>";
    if (r.pending) sym += "<span class='badge' title='Podatek za 12h/4h ni bil pridobljen'>12h/4h ?</span>";
    return "<tr class='fomo-row' data-key='" + esc(key) + "' tabindex='0' title='Klikni za vecji graf'>" +
      "<td class='l sym'>" + sym + "</td>" +
      "<td>" + fmtMoney(r.price) + "</td>" +
      pctCell(r.h1, r.checks.h1) + pctCell(r.h4, r.checks.h4) +
      pctCell(r.h12, r.checks.h12) + pctCell(r.h24, r.checks.h24) +
      "<td class='chart-cell' data-spark='" + esc(key) + "'><span class='muted small'>\u2026</span></td>" +
      "<td>" + fmtBig(r.volume) + "</td>" +
      "<td class='l muted small'>" + esc(r.source) + "</td></tr>";
  }

  function renderFomo(result, ownSymbols, scanned) {
    var f = result.fomo, rad = result.radar.slice(0, 25);
    $("fomo-empty").textContent = scanned
      ? "Trenutno noben kovanec ne izpolnjuje vseh stirih pogojev."
      : "Lov ni uspel \u2013 Binance in CoinGecko nista odgovorila. Poskusi znova cez minuto.";
    $("fomo-empty").hidden = f.length > 0;
    $("fomo-wrap").hidden = f.length === 0;
    $("fomo-table").tBodies[0].innerHTML = f.map(function (r) { return fomoRowHtml(r, ownSymbols); }).join("");
    $("radar-empty").hidden = rad.length > 0;
    $("radar-wrap").hidden = rad.length === 0;
    $("radar-table").tBodies[0].innerHTML = rad.map(function (r) { return fomoRowHtml(r, ownSymbols); }).join("");
    document.title = (f.length ? "(" + f.length + ") " : "") + "Crypto FOMO pregled";

    shownRows = {};
    f.concat(rad).forEach(function (r) { shownRows[rowKey(r)] = r; });
    loadCharts(f.concat(rad));
  }

  // ------------------------------------------------------------------ grafi
  // Nalozi 24h potek za vsak prikazan kovanec (Binance svece; CoinGecko potek je ze nalozen, ce je bil potreben).
  function loadCharts(rows) {
    rows.forEach(function (r) {
      var done = function () {
        r.fit = Fomo.parabolaFit(r.series);
        drawSpark(r);
        if (expanded.has(rowKey(r))) openDetail(rowKey(r));
      };
      if (r.series) return done();
      var p = r.pair ? binanceSeries(r.pair) : r.id ? cgSeries(r.id) : null;
      if (!p) return drawSpark(r);
      p.then(function (pts) { r.series = pts; }).catch(function () { r.series = null; }).then(done);
    });
  }

  function cellFor(key) {
    var cells = document.querySelectorAll("td[data-spark]");
    for (var i = 0; i < cells.length; i++) if (cells[i].getAttribute("data-spark") === key) return cells[i];
    return null;
  }

  function fitLabel(fit) {
    if (!fit) return "<span class='muted small' title='Cena v 24h ni zrasla'>\u2013</span>";
    var pct = Math.round(fit.match * 100);
    return "<span class='" + (fit.match >= 0.8 ? "para-good" : "muted") + " small' title='Ujemanje poteka cene z idealno parabolo'>" + pct + "%</span>";
  }

  function drawSpark(r) {
    var cell = cellFor(rowKey(r));
    if (!cell) return;
    if (!r.series || r.series.length < 5) { cell.innerHTML = "<span class='muted small'>ni podatkov</span>"; return; }
    cell.innerHTML = "<span class='spark'>" + chartSvg(r, { w: 120, h: 34, pad: 2 }) + fitLabel(r.fit) + "</span>";
  }

  // Skupni izris (majhen in velik graf). Os y = sprememba v % glede na zacetek 24h obdobja.
  function chartSvg(r, o) {
    var pts = r.series, t0 = pts[0][0], t1 = pts[pts.length - 1][0], base = pts[0][1];
    var pct = function (p) { return (p / base - 1) * 100; };
    var ys = pts.map(function (p) { return pct(p[1]); });
    var lo = Math.min(0, Math.min.apply(null, ys)), hi = Math.max.apply(null, ys);
    if (hi - lo < 1) hi = lo + 1;
    var ml = o.ml || o.pad, mr = o.mr || o.pad, mt = o.mt || o.pad, mb = o.mb || o.pad;
    var X = function (t) { return ml + (t - t0) / (t1 - t0 || 1) * (o.w - ml - mr); };
    var Y = function (v) { return mt + (hi - v) / (hi - lo) * (o.h - mt - mb); };
    var path = function (arr) {
      return arr.map(function (p, i) { return (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1); }).join("");
    };
    var out = "<svg class='chart' viewBox='0 0 " + o.w + " " + o.h + "' width='" + (o.full ? "100%" : o.w) + "'" +
      (o.full ? "" : " height='" + o.h + "'") + " role='img' aria-label='24h potek cene " + esc(r.symbol) + "'>";

    if (o.full) {
      // mreza + oznake osi y
      ticks(lo, hi).forEach(function (v) {
        out += "<line class='grid" + (v === 0 ? " zero" : "") + "' x1='" + ml + "' x2='" + (o.w - mr) + "' y1='" + Y(v) + "' y2='" + Y(v) + "'/>" +
          "<text class='axis' x='" + (ml - 6) + "' y='" + (Y(v) + 4) + "' text-anchor='end'>" + (v > 0 ? "+" : "") + v + "%</text>";
      });
    }
    if (r.fit) {
      var ideal = [];
      for (var i = 0; i <= 40; i++) { var t = t0 + (t1 - t0) * i / 40; ideal.push([t, pct(r.fit.ideal(t))]); }
      out += "<path class='ideal' d='" + path(ideal) + "'/>";
    }
    out += "<path class='price' d='" + path(pts.map(function (p) { return [p[0], pct(p[1])]; })) + "'/>";

    if (o.full) {
      // oznake zacetkov oken (-24h, -12h, -4h, -1h): polna pika = pogoj izpolnjen
      var checks = Fomo.checks(r, thresholds());
      Fomo.WINDOWS.forEach(function (k) {
        var t = t1 - Fomo.WINDOW_HOURS[k] * 3600e3;
        if (t < t0 - 20 * 60e3) return;
        t = Math.max(t, t0);
        var near = pts.reduce(function (a, b) { return Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a; });
        var x = X(t), y = Y(pct(near[1]));
        out += "<line class='mark' x1='" + x + "' x2='" + x + "' y1='" + mt + "' y2='" + (o.h - mb) + "'/>" +
          "<text class='axis' x='" + x + "' y='" + (o.h - 8) + "' text-anchor='middle'>\u2212" + Fomo.WINDOW_HOURS[k] + "h</text>" +
          "<circle class='dot" + (checks[k] ? " ok" : "") + "' cx='" + x + "' cy='" + y + "' r='5'><title>" +
          Fomo.WINDOW_HOURS[k] + "h: " + fmtPct(r[k]) + (checks[k] ? " (pogoj izpolnjen)" : " (pod pragom)") + "</title></circle>";
      });
      out += "<line class='cross' x1='0' x2='0' y1='" + mt + "' y2='" + (o.h - mb) + "' visibility='hidden'/>" +
        "<circle class='cross-dot' r='4' visibility='hidden'/>" +
        "<rect class='hit-area' x='" + ml + "' y='" + mt + "' width='" + (o.w - ml - mr) + "' height='" + (o.h - mt - mb) + "'/>";
    }
    return out + "</svg>";
  }

  function ticks(lo, hi) {
    var span = hi - lo, raw = span / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 5, 10].map(function (m) { return m * mag; }).find(function (s2) { return s2 >= raw; });
    var out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  }

  function openDetail(key) {
    var r = shownRows[key];
    var tr = document.querySelector("tr.fomo-row[data-key='" + key.replace(/'/g, "\\'") + "']");
    if (!r || !tr) return;
    var next = tr.nextElementSibling;
    if (next && next.classList.contains("detail-row")) next.remove();
    var td = document.createElement("td");
    td.colSpan = tr.children.length;
    if (!r.series || r.series.length < 5) {
      td.innerHTML = "<div class='detail muted'>Graf se nalaga ali ni na voljo.</div>";
    } else {
      var fit = r.fit;
      var verdict = !fit ? "Cena v zadnjih 24h ni zrasla."
        : fit.match >= 0.8 ? "Rast se lepo pospesuje \u2013 potek je <b>blizu parabole</b>."
        : fit.match >= 0.5 ? "Rast je bolj enakomerna kot parabolicna."
        : "Potek ni parabolicen (npr. en sam skok ali nihanje).";
      td.innerHTML = "<div class='detail'>" +
        "<div class='detail-head'><b>" + esc(r.symbol) + "</b> &middot; 24h potek" +
        (fit ? " &middot; ujemanje s parabolo: <b class='" + (fit.match >= 0.8 ? "para-good" : "") + "'>" + Math.round(fit.match * 100) + "%</b>" : "") +
        "<span class='legend'><i class='lg-price'></i>cena <i class='lg-ideal'></i>idealna parabola <i class='lg-dot'></i>pogoj izpolnjen</span></div>" +
        "<div class='chart-wrap'>" + chartSvg(r, { w: 640, h: 220, full: true, ml: 48, mr: 12, mt: 12, mb: 28 }) +
        "<div class='tip' hidden></div></div>" +
        "<div class='muted small'>" + verdict + "</div></div>";
      bindHover(td.querySelector(".chart-wrap"), r, { w: 640, ml: 48, mr: 12 });
    }
    var row = document.createElement("tr");
    row.className = "detail-row";
    row.appendChild(td);
    tr.after(row);
  }

  // Crosshair + tooltip na velikem grafu.
  function bindHover(wrap, r, o) {
    var svg = wrap.querySelector("svg"), tip = wrap.querySelector(".tip");
    var cross = svg.querySelector(".cross"), dot = svg.querySelector(".cross-dot");
    var pts = r.series, t0 = pts[0][0], t1 = pts[pts.length - 1][0], base = pts[0][1];
    var price = svg.querySelector(".price");
    function move(ev) {
      var box = svg.getBoundingClientRect();
      var sx = (ev.clientX - box.left) / box.width * o.w;
      var t = t0 + (sx - o.ml) / (o.w - o.ml - o.mr) * (t1 - t0);
      var i = 0, best = Infinity;
      pts.forEach(function (p, j) { var d = Math.abs(p[0] - t); if (d < best) { best = d; i = j; } });
      var seg = price.getAttribute("d").split(/[ML]/).filter(Boolean)[i].split(" ");
      var x = Number(seg[0]), y = Number(seg[1]);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("visibility", "visible");
      var ago = (t1 - pts[i][0]) / 3600e3;
      tip.innerHTML = "<b>" + fmtMoney(pts[i][1]) + "</b> <span class='" + pctCls(pts[i][1] - base) + "'>" +
        fmtPct((pts[i][1] / base - 1) * 100) + "</span><br><span class='muted'>" +
        (ago < 0.05 ? "zdaj" : "pred " + ago.toFixed(1).replace(".", ",") + " h") + "</span>";
      tip.hidden = false;
      var px = x / o.w * box.width;
      tip.style.left = Math.min(Math.max(px + 10, 0), box.width - tip.offsetWidth) + "px";
      tip.style.top = Math.max(y / 220 * box.height - 50, 0) + "px";
    }
    function leave() {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      dot.setAttribute("visibility", "hidden");
    }
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerleave", leave);
  }

  function toggleRow(tr) {
    var key = tr.getAttribute("data-key");
    var next = tr.nextElementSibling;
    if (next && next.classList.contains("detail-row")) { next.remove(); expanded.delete(key); return; }
    expanded.add(key);
    openDetail(key);
  }

  ["fomo-table", "radar-table"].forEach(function (id) {
    var tb = $(id).tBodies[0];
    tb.addEventListener("click", function (e) {
      if (e.target.closest("a")) return;
      var tr = e.target.closest("tr.fomo-row");
      if (tr) toggleRow(tr);
    });
    tb.addEventListener("keydown", function (e) {
      var tr = e.target.closest("tr.fomo-row");
      if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleRow(tr); }
    });
  });

  function renderPortfolio(p, glob, fng, th) {
    $("total").textContent = fmtMoney(p.total);
    $("total-ch").innerHTML = "<span class='" + pctCls(p.ch24) + "'>" + fmtPct(p.ch24) + "</span> v zadnjih 24h";

    $("market").innerHTML = glob
      ? "Trg skupaj: <b>" + fmtBig(glob.mcap) + "</b> (<span class='" + pctCls(glob.mcap24) + "'>" + fmtPct(glob.mcap24) +
        "</span>) &nbsp;|&nbsp; BTC dominanca: <b>" + (glob.dom || 0).toFixed(1) + "%</b> &nbsp;|&nbsp; 24h volumen: <b>" + fmtBig(glob.vol) + "</b>"
      : "";
    $("fng").innerHTML = fng ? "Fear &amp; Greed: <b>" + fng.value + "/100</b> &ndash; " + esc(fng.label) : "";

    var movers = p.rows.filter(function (r) { return r.h24 !== null; });
    var mover = movers.length ? movers.reduce(function (a, b) { return Math.abs(b.h24) > Math.abs(a.h24) ? b : a; }) : null;
    if (mover) {
      var lines = "<div><b>" + esc(mover.symbol) + "</b> &middot; <b class='" + pctCls(mover.h24) + "'>" + fmtPct(mover.h24) + "</b> v 24h</div>";
      if (mover.pctToTarget !== null) {
        lines += mover.pctToTarget >= 0
          ? "<div>Do ciljne cene (" + fmtMoney(mover.target) + ") manjka <b>" + mover.pctToTarget.toFixed(1) + "%</b></div>"
          : "<div>Ciljna cena (" + fmtMoney(mover.target) + ") je <b>presezena za " + (-mover.pctToTarget).toFixed(1) + "%</b></div>";
      }
      if (mover.pctSinceBuy !== null) {
        lines += "<div>Od nakupa (" + fmtMoney(mover.avgBuy) + "): <b class='" + pctCls(mover.pctSinceBuy) + "'>" + fmtPct(mover.pctSinceBuy) + "</b></div>";
      }
      $("mover").innerHTML = "<div class='mover'><div class='lbl'>⚡ Najvecji premik</div>" + lines + "</div>";
    } else {
      $("mover").innerHTML = "";
    }

    var alertThr = Number(p.alertThreshold);
    var alerts = p.rows.filter(function (r) { return r.pctToTarget !== null && r.pctToTarget <= alertThr; })
      .sort(function (a, b) { return a.pctToTarget - b.pctToTarget; });
    $("alerts").innerHTML = alerts.length
      ? "<div class='warn'><b>🔔 Target alert</b><ul>" + alerts.map(function (r) {
          var msg = r.pctToTarget >= 0
            ? "manjka " + r.pctToTarget.toFixed(1) + "% do cilja (" + fmtMoney(r.target) + ")"
            : "cilj (" + fmtMoney(r.target) + ") presezen za " + (-r.pctToTarget).toFixed(1) + "%";
          return "<li><b>" + esc(r.symbol) + "</b>: " + msg + " &mdash; trenutno " + fmtMoney(r.price) + "</li>";
        }).join("") + "</ul></div>"
      : "";

    $("port-table").tBodies[0].innerHTML = p.rows.map(function (r) {
      var badge = "";
      var h = Fomo.hits(r, th);
      if (h === 3) badge = "<span class='badge fomo'>FOMO</span>";
      else if (r.h24 !== null && r.h1 !== null && r.h24 >= th.h24 && r.h1 >= th.h1) badge = "<span class='badge'>radar</span>";
      var tgt = r.pctToTarget === null ? null : -r.pctToTarget;
      return "<tr><td class='l sym'>" + esc(r.symbol) + badge + "</td>" +
        "<td>" + fmtMoney(r.price) + "</td>" +
        "<td class='" + pctCls(r.h1) + "'>" + fmtPct(r.h1) + "</td>" +
        "<td class='" + pctCls(r.h24) + "'>" + fmtPct(r.h24) + "</td>" +
        "<td class='" + pctCls(r.d7) + "'>" + fmtPct(r.d7) + "</td>" +
        "<td>" + fmtAmount(r.amount) + "</td>" +
        "<td><b>" + fmtMoney(r.value) + "</b></td>" +
        "<td class='" + pctCls(tgt) + "'>" + fmtPct(tgt) + "</td></tr>";
    }).join("");

    $("note").innerHTML = "<b>Opazanje:</b> " + esc(agentNote(p.rows, fng, p.ch24));
    $("missing").innerHTML = p.missing.length
      ? "<div class='warn'>Ni cene za: " + p.missing.map(function (m) { return esc(m.symbol); }).join(", ") +
        ". Preveri CoinGecko id v config.json.</div>"
      : "";
  }

  function renderErrors(errs) {
    $("errors").innerHTML = errs.length
      ? "<div class='warn'><b>Nekateri viri niso odgovorili</b><ul>" +
        errs.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul></div>"
      : "";
  }

  function notifyNew(fomo) {
    var keys = new Set(fomo.map(function (r) { return r.source + ":" + r.symbol; }));
    var fresh = lastFomoKeys ? fomo.filter(function (r) { return !lastFomoKeys.has(r.source + ":" + r.symbol); }) : [];
    lastFomoKeys = keys;
    if (!fresh.length || !settings.notify || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification("FOMO: " + fresh.map(function (r) { return r.symbol; }).join(", "), {
        body: fresh.map(function (r) { return r.symbol + " 1h " + fmtPct(r.h1) + " · 4h " + fmtPct(r.h4) + " · 12h " + fmtPct(r.h12) + " · 24h " + fmtPct(r.h24); }).join("\n"),
      });
    } catch (e) { /* nekateri brskalniki (mobilni) ne podpirajo */ }
  }

  // ------------------------------------------------------------------ glavni tok
  function refresh() {
    if (busy) return;
    busy = true;
    $("btn-refresh").disabled = true;
    $("updated").textContent = "Osvezujem …";
    var th = thresholds();
    renderChips(th);
    var errs = [];
    var soft = function (label) {
      return function (e) { errs.push(label + ": " + (e && e.message ? e.message : e)); return null; };
    };

    var cfgP = loadConfig().catch(soft("config.json"));
    var binP = scanBinance(th).catch(soft("Binance"));
    var fngP = fetchFng().catch(soft("Fear & Greed"));

    // CoinGecko klici gredo v vrsto: najprej portfelj, nato globalni podatki, nato lov.
    var portP = cfgP.then(function (cfg) {
      if (!cfg) return null;
      var vs = cfg.vs_currency || "usd";
      var holdings = (cfg.holdings || []).map(function (h) {
        return {
          symbol: String(h.symbol).toUpperCase(), amount: Number(h.amount), id: h.id,
          target_price: h.target_price, avg_buy_price: h.avg_buy_price,
        };
      });
      return fetchHoldingsMarkets(holdings.map(function (h) { return h.id; }).filter(Boolean), vs)
        .then(function (mmap) {
          var p = computePortfolio(holdings, mmap);
          p.alertThreshold = cfg.target_alert_threshold_pct === undefined ? 5 : cfg.target_alert_threshold_pct;
          return p;
        })
        .catch(soft("CoinGecko (portfelj)"));
    });
    var globP = portP.then(function () { return fetchGlobal(); }).catch(soft("CoinGecko (trg)"));

    var sentP = Promise.all([globP, fngP])
      .then(function (r) { return fetchSentiment(r[0], r[1]); })
      .catch(soft("Sentiment"))
      .then(function (res) { renderSentiment(res); });

    var huntP = Promise.all([binP, globP]).then(function (res) {
      var bin = res[0] || [];
      var skip = new Set(bin.map(function (r) { return r.symbol; }));
      return scanCoinGecko(th, skip).catch(soft("CoinGecko (lov)")).then(function (cg) {
        return bin.concat(cg || []);
      });
    });

    return Promise.all([portP, globP, fngP, huntP, sentP]).then(function (res) {
      var p = res[0], glob = res[1], fng = res[2], hunt = res[3];
      var own = new Set(p ? p.rows.map(function (r) { return r.symbol; }) : []);

      // 12h/4h za lastne kovance, ki izpolnijo 24h in 1h pogoj (Binance, sicer CoinGecko potek).
      var ownFill = Promise.resolve();
      if (p) {
        var bySym = {};
        hunt.forEach(function (r) { if (r.source === "Binance") bySym[r.symbol] = r; });
        var need = [];
        p.rows.forEach(function (r) {
          if (!(r.h24 !== null && r.h1 !== null && r.h24 >= th.h24 && r.h1 >= th.h1)) return;
          var b = bySym[r.symbol];
          if (b && b.h12 !== null && b.h4 !== null) { r.h12 = b.h12; r.h4 = b.h4; }
          else need.push(r);
        });
        ownFill = Promise.all(need.slice(0, CG_CHART_LIMIT).map(function (r) {
          return cgSeries(r.id).then(function (pts) { applySeries(r, pts); }).catch(function () {});
        }));
      }

      var result = Fomo.classify(hunt, th);
      renderFomo(result, own, hunt.length > 0);
      var bin = hunt.filter(function (r) { return r.source === "Binance"; }).length;
      var cg = hunt.length - bin;
      $("scan-status").textContent = "Pregledanih kandidatov: Binance " + bin + ", CoinGecko " + cg + ".";
      notifyNew(result.fomo);

      return ownFill.then(function () {
        if (p) renderPortfolio(p, glob, fng, th);
        renderErrors(errs);
      });
    }).catch(function (e) {
      errs.push(String(e && e.message ? e.message : e));
      renderErrors(errs);
    }).then(function () {
      busy = false;
      $("btn-refresh").disabled = false;
      $("updated").textContent = "Posodobljeno: " + new Date().toLocaleString("sl-SI");
    });
  }

  function setAuto(on) {
    settings.auto = on;
    saveSettings();
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = on ? setInterval(refresh, AUTO_MS) : null;
  }

  // ------------------------------------------------------------------ nastavitve (dialog)
  var dlg = $("settings"), form = $("settings-form");
  function fillForm(s) {
    Fomo.WINDOWS.forEach(function (k) { form[k].value = s[k]; });
    form.minVol.value = s.minVol; form.cgKey.value = s.cgKey || ""; form.notify.checked = !!s.notify;
  }
  $("btn-settings").addEventListener("click", function () { fillForm(settings); dlg.showModal(); });
  $("btn-reset").addEventListener("click", function () {
    fillForm(Object.assign({}, settings, Fomo.DEFAULT_THRESHOLDS, { minVol: DEFAULTS.minVol }));
  });
  dlg.addEventListener("close", function () {
    if (dlg.returnValue !== "save") return;
    Fomo.WINDOWS.forEach(function (k) { settings[k] = Number(form[k].value); });
    settings.minVol = Number(form.minVol.value) || 0;
    settings.cgKey = form.cgKey.value.trim();
    settings.notify = form.notify.checked;
    saveSettings();
    if (settings.notify && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    refresh();
  });

  $("btn-refresh").addEventListener("click", refresh);
  $("auto").checked = !!settings.auto;
  $("auto").addEventListener("change", function (e) { setAuto(e.target.checked); });

  setAuto(!!settings.auto);
  refresh();
})();
