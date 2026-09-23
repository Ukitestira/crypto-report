/* Crypto FOMO pregled - vse tece v brskalniku, podatki se pridobijo ob vsakem osvezevanju. */
(function () {
  "use strict";

  var CG_BASE = "https://api.coingecko.com/api/v3";
  var BINANCE_BASES = ["https://api.binance.com", "https://data-api.binance.vision"];
  var FNG_URL = "https://api.alternative.me/fng/?limit=1";
  var AUTO_MS = 5 * 60 * 1000;
  var CG_CHART_LIMIT = 6; // najvec market_chart klicev (12h) na osvezitev - brezplacni CoinGecko je omejen
  var SETTINGS_KEY = "fomo-settings-v1";

  var DEFAULTS = {
    h24: Fomo.DEFAULT_THRESHOLDS.h24,
    h12: Fomo.DEFAULT_THRESHOLDS.h12,
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
    return { h24: Number(settings.h24), h12: Number(settings.h12), h1: Number(settings.h1) };
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
      };
    });
  }

  function fetchFng() {
    return getJson(FNG_URL).then(function (res) {
      var d = res.data[0];
      return { value: Number(d.value), label: d.value_classification };
    });
  }

  function cg12h(id) {
    return cgGet("/coins/" + encodeURIComponent(id) + "/market_chart", { vs_currency: "usd", days: 1 })
      .then(function (res) { return Fomo.changeFromSeries(res.prices, 12); });
  }

  // Binance: vsi USDT pari -> top kandidati po 24h rasti -> 12h in 1h drsno okno.
  function scanBinance(th) {
    return binanceGet("/api/v3/ticker/24hr").then(function (tickers) {
      var cands = Fomo.binanceCandidates(tickers, { minQuoteVolume: Number(settings.minVol) || 0, minCh24: 0, limit: 200 });
      var byPair = {};
      cands.forEach(function (c) { byPair[c.pair] = c; });
      var jobs = [];
      Fomo.chunk(cands.map(function (c) { return c.pair; }), 100).forEach(function (pairs) {
        ["12h", "1h"].forEach(function (win) {
          jobs.push(binanceGet("/api/v3/ticker", { symbols: JSON.stringify(pairs), windowSize: win })
            .then(function (rows) {
              rows.forEach(function (r) {
                var c = byPair[r.symbol];
                if (c) c[win === "12h" ? "h12" : "h1"] = Fomo.num(r.priceChangePercent);
              });
            }));
        });
      });
      return Promise.all(jobs).then(function () {
        return cands.map(function (c) {
          return {
            symbol: c.base, name: "", price: c.price, volume: c.volume,
            h24: c.h24, h12: c.h12 === undefined ? null : c.h12, h1: c.h1 === undefined ? null : c.h1,
            source: "Binance", url: "https://www.binance.com/en/trade/" + c.base + "_USDT",
          };
        });
      });
    });
  }

  // CoinGecko: top 250 po volumnu (ujame tudi kovance, ki jih ni na Binance). 12h samo za mocne kandidate.
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
          h24: h24, h12: null, h1: h1, source: "CoinGecko", url: "https://www.coingecko.com/en/coins/" + r.id,
        });
      });
      var need = out.filter(function (r) { return r.h24 >= th.h24 && r.h1 >= th.h1; })
        .sort(function (a, b) { return Fomo.score(b, th) - Fomo.score(a, th); })
        .slice(0, CG_CHART_LIMIT);
      return Promise.all(need.map(function (r) {
        return cg12h(r.id).then(function (v) { r.h12 = v; }).catch(function () {});
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
        h1: Fomo.num(m.price_change_percentage_1h_in_currency), h24: ch24, h12: null,
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
    $("th-chips").innerHTML =
      "<span class='chip'>24h ≥ " + th.h24 + "%</span>" +
      "<span class='chip'>12h ≥ " + th.h12 + "%</span>" +
      "<span class='chip'>1h ≥ " + th.h1 + "%</span>";
  }

  function pctCell(v, hit) {
    return "<td class='" + (hit ? "hit" : pctCls(v)) + "'>" + fmtPct(v) + "</td>";
  }

  function fomoRowHtml(r, ownSymbols) {
    var sym = "<a href='" + esc(r.url) + "' target='_blank' rel='noopener'>" + esc(r.symbol) + "</a>";
    if (r.name) sym += " <span class='muted small'>" + esc(r.name) + "</span>";
    if (ownSymbols.has(r.symbol)) sym += "<span class='badge own'>v portfelju</span>";
    if (r.pending12h) sym += "<span class='badge' title='12h podatek ni bil pridobljen'>12h ?</span>";
    return "<tr><td class='l sym'>" + sym + "</td>" +
      "<td>" + fmtMoney(r.price) + "</td>" +
      pctCell(r.h1, r.checks.h1) + pctCell(r.h12, r.checks.h12) + pctCell(r.h24, r.checks.h24) +
      "<td>" + fmtBig(r.volume) + "</td>" +
      "<td class='l muted small'>" + esc(r.source) + "</td></tr>";
  }

  function renderFomo(result, ownSymbols, scanned) {
    var f = result.fomo, rad = result.radar.slice(0, 25);
    $("fomo-empty").textContent = scanned
      ? "Trenutno noben kovanec ne izpolnjuje vseh treh pogojev."
      : "Lov ni uspel \u2013 Binance in CoinGecko nista odgovorila. Poskusi znova cez minuto.";
    $("fomo-empty").hidden = f.length > 0;
    $("fomo-wrap").hidden = f.length === 0;
    $("fomo-table").tBodies[0].innerHTML = f.map(function (r) { return fomoRowHtml(r, ownSymbols); }).join("");
    $("radar-empty").hidden = rad.length > 0;
    $("radar-wrap").hidden = rad.length === 0;
    $("radar-table").tBodies[0].innerHTML = rad.map(function (r) { return fomoRowHtml(r, ownSymbols); }).join("");
    document.title = (f.length ? "(" + f.length + ") " : "") + "Crypto FOMO pregled";
  }

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
        body: fresh.map(function (r) { return r.symbol + " 1h " + fmtPct(r.h1) + " · 12h " + fmtPct(r.h12) + " · 24h " + fmtPct(r.h24); }).join("\n"),
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

    var huntP = Promise.all([binP, globP]).then(function (res) {
      var bin = res[0] || [];
      var skip = new Set(bin.map(function (r) { return r.symbol; }));
      return scanCoinGecko(th, skip).catch(soft("CoinGecko (lov)")).then(function (cg) {
        return bin.concat(cg || []);
      });
    });

    return Promise.all([portP, globP, fngP, huntP]).then(function (res) {
      var p = res[0], glob = res[1], fng = res[2], hunt = res[3];
      var own = new Set(p ? p.rows.map(function (r) { return r.symbol; }) : []);

      // 12h za lastne kovance, ki izpolnijo 24h in 1h pogoj (preostanek limita CoinGecko klicev).
      var ownFill = Promise.resolve();
      if (p) {
        var bySym = {};
        hunt.forEach(function (r) { if (r.source === "Binance") bySym[r.symbol] = r; });
        var need = [];
        p.rows.forEach(function (r) {
          if (!(r.h24 !== null && r.h1 !== null && r.h24 >= th.h24 && r.h1 >= th.h1)) return;
          if (bySym[r.symbol] && bySym[r.symbol].h12 !== null) r.h12 = bySym[r.symbol].h12;
          else need.push(r);
        });
        ownFill = Promise.all(need.slice(0, CG_CHART_LIMIT).map(function (r) {
          return cg12h(r.id).then(function (v) { r.h12 = v; }).catch(function () {});
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
    form.h24.value = s.h24; form.h12.value = s.h12; form.h1.value = s.h1;
    form.minVol.value = s.minVol; form.cgKey.value = s.cgKey || ""; form.notify.checked = !!s.notify;
  }
  $("btn-settings").addEventListener("click", function () { fillForm(settings); dlg.showModal(); });
  $("btn-reset").addEventListener("click", function () {
    fillForm(Object.assign({}, settings, { h24: DEFAULTS.h24, h12: DEFAULTS.h12, h1: DEFAULTS.h1, minVol: DEFAULTS.minVol }));
  });
  dlg.addEventListener("close", function () {
    if (dlg.returnValue !== "save") return;
    settings.h24 = Number(form.h24.value);
    settings.h12 = Number(form.h12.value);
    settings.h1 = Number(form.h1.value);
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
