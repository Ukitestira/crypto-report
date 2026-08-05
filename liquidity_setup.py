#!/usr/bin/env python3
"""
Likvidnostni signali in R:R scenariji za BTC perpetual (referenca za BTC/USDC spot).

POMEMBNO - kaj ta modul JE in kaj NI:
  - NI napoved smeri cene. Nihce (vkljucno z avtomatiziranimi sistemi) ne more
    zanesljivo napovedati kratkorocne smeri iz javnih podatkov.
  - JE zbirka objektivnih trznih signalov (funding rate, open interest trend,
    orderbook imbalance) + matematicni izracun SL/TP nivojev za R:R = 1:4 v
    OBEH smereh (long in short), da uporabnik lahko sam presodi in nastavi
    poziciji na podlagi lastne analize.

Vir podatkov (oba brezplacna, brez kljuca) - poskusi po vrsti, prvi ki uspe zmaga:
  1. OKX  - /api/v5/market/ticker, /public/funding-rate, /public/open-interest,
            /market/books, /market/candles  (BTC-USDT-SWAP)
  2. Bybit V5 - /v5/market/tickers, /v5/market/orderbook, /v5/market/kline (BTCUSDT)
     (rezerva - Bybit je opazovano blokiral GitHub Actions runner IP-je s HTTP 403)

Stanje (prejsnji OI) se hrani v state/liquidity_state.json in ga GitHub
Actions po vsakem zagonu commita nazaj v repo (enak vzorec kot onchain_flows.py).

Informativno, ne financni nasvet.
"""

import os
import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone

OKX_BASE = "https://www.okx.com/api/v5"
BYBIT_BASE = "https://api.bybit.com/v5/market"
STATE_DIR = os.environ.get("STATE_DIR", "state")
STATE_PATH = os.path.join(STATE_DIR, "liquidity_state.json")
UA = {"User-Agent": "morning-crypto-report/1.0"}

OKX_INST = "BTC-USDT-SWAP"  # OKX perpetual - primarni vir
SYMBOL = "BTCUSDT"          # Bybit linear perpetual - rezervni vir
KLINE_INTERVAL = "240"       # 240 min = 4h (bybit)
ATR_PERIOD = 14
SWING_LOOKBACK = 20          # sveke za swing high/low (na 4h ~ 3-4 dni)
ORDERBOOK_DEPTH = 50         # nivojev na vsako stran za imbalance
RR_RATIO = 4.0                # risk:reward = 1:4
SL_ATR_BUFFER = 0.5           # dodaten prostor za SL preko swing nivoja, v enotah ATR


# ---------------------------------------------------------------------------
def _get_json(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _bybit_get(path, params):
    url = BYBIT_BASE + path + "?" + urllib.parse.urlencode(params)
    d = _get_json(url)
    if d.get("retCode") != 0:
        raise RuntimeError("Bybit napaka ({}): {}".format(path, d.get("retMsg")))
    return d["result"]


def _okx_get(path, params):
    url = OKX_BASE + path + "?" + urllib.parse.urlencode(params)
    d = _get_json(url)
    if d.get("code") != "0":
        raise RuntimeError("OKX napaka ({}): {}".format(path, d.get("msg")))
    return d["data"]


# ---------------------------------------------------------------------------
def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_state(open_interest, mark_price):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "open_interest": open_interest,
            "mark_price": mark_price,
        }, f, indent=2)


# ---------------------------------------------------------------------------
# OKX - primarni vir
def _fetch_all_okx():
    tk = _okx_get("/market/ticker", {"instId": OKX_INST})[0]
    fr = _okx_get("/public/funding-rate", {"instId": OKX_INST})[0]
    oi = _okx_get("/public/open-interest", {"instId": OKX_INST})[0]
    last = float(tk["last"])
    open24h = float(tk.get("open24h", 0)) or None

    ticker = {
        "last_price": last,
        "mark_price": last,   # OKX ticker nima locenega mark price polja tukaj - last je dovolj natancen
        "funding_rate": float(fr["fundingRate"]),
        "open_interest": float(oi["oiCcy"]),          # v BTC
        "open_interest_usd": float(oi["oiCcy"]) * last,
        "prev_price_24h": open24h,
    }

    book = _okx_get("/market/books", {"instId": OKX_INST, "sz": str(ORDERBOOK_DEPTH)})[0]
    bid_vol = sum(float(b[1]) for b in book.get("bids", []))
    ask_vol = sum(float(a[1]) for a in book.get("asks", []))

    limit = max(ATR_PERIOD, SWING_LOOKBACK) + 5
    rows = _okx_get("/market/candles", {"instId": OKX_INST, "bar": "4H", "limit": str(limit)})
    candles = []
    for r in rows:
        # okx format: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
        candles.append({"open": float(r[1]), "high": float(r[2]),
                         "low": float(r[3]), "close": float(r[4])})
    candles.reverse()  # okx vraca najnovejso prvo -> obrnemo v kronolosko

    return ticker, (bid_vol, ask_vol), candles


# ---------------------------------------------------------------------------
# Bybit - rezervni vir (ce OKX ne uspe)
def _fetch_all_bybit():
    result = _bybit_get("/tickers", {"category": "linear", "symbol": SYMBOL})
    row = result["list"][0]
    ticker = {
        "last_price": float(row["lastPrice"]),
        "mark_price": float(row["markPrice"]),
        "funding_rate": float(row["fundingRate"]),
        "open_interest": float(row["openInterest"]),
        "open_interest_usd": float(row.get("openInterestValue", 0)),
        "prev_price_24h": float(row.get("prevPrice24h", 0)) or None,
    }

    ob = _bybit_get("/orderbook", {"category": "linear", "symbol": SYMBOL, "limit": ORDERBOOK_DEPTH})
    bid_vol = sum(float(b[1]) for b in ob.get("b", []))
    ask_vol = sum(float(a[1]) for a in ob.get("a", []))

    limit = max(ATR_PERIOD, SWING_LOOKBACK) + 5
    kl = _bybit_get("/kline", {"category": "linear", "symbol": SYMBOL,
                                "interval": KLINE_INTERVAL, "limit": limit})
    candles = []
    for r in kl.get("list", []):
        candles.append({"open": float(r[1]), "high": float(r[2]),
                         "low": float(r[3]), "close": float(r[4])})
    candles.reverse()

    return ticker, (bid_vol, ask_vol), candles


# ---------------------------------------------------------------------------
def fetch_all():
    """Poskusi ponudnike po vrsti (OKX, nato Bybit); prvi ki uspe zmaga."""
    providers = [("OKX", _fetch_all_okx), ("Bybit", _fetch_all_bybit)]
    last_err = None
    for name, fn in providers:
        try:
            ticker, (bid_vol, ask_vol), candles = fn()
            print("  vir likvidnostnih podatkov: {}".format(name))
            return ticker, bid_vol, ask_vol, candles, name
        except Exception as e:
            print("  ! vir {} ni uspel: {}".format(name, e))
            last_err = e
    raise last_err


# ---------------------------------------------------------------------------
def compute_atr(candles, period=ATR_PERIOD):
    if len(candles) < period + 1:
        return None
    trs = []
    for i in range(1, len(candles)):
        h, l, pc = candles[i]["high"], candles[i]["low"], candles[i - 1]["close"]
        tr = max(h - l, abs(h - pc), abs(l - pc))
        trs.append(tr)
    recent = trs[-period:]
    return sum(recent) / len(recent)


def swing_high_low(candles, lookback=SWING_LOOKBACK):
    # zadnja sveka je se "v teku", zato jo izlocimo iz swing izracuna
    window = candles[-(lookback + 1):-1] if len(candles) > lookback else candles[:-1]
    if not window:
        window = candles
    highs = [c["high"] for c in window]
    lows = [c["low"] for c in window]
    return max(highs), min(lows)


# ---------------------------------------------------------------------------
def _fmt_usd(x):
    if x is None:
        return "n/a"
    sign = "-" if x < 0 else ""
    ax = abs(x)
    for unit in ["", "K", "M", "B"]:
        if ax < 1000:
            return "{}${:,.2f}{}".format(sign, ax, unit)
        ax /= 1000.0
    return "{}${:,.2f}T".format(sign, ax)


def _funding_note(rate):
    """Opisni komentar, ne priporocilo."""
    pct = rate * 100
    if pct > 0.02:
        return "precej pozitiven ({:+.4f}% / 8h) - dolge pozicije placujejo kratke; " \
               "vzvod je pretezno na long strani, kar poveca obcutljivost za sunke navzdol (long squeeze).".format(pct)
    if pct < -0.02:
        return "precej negativen ({:+.4f}% / 8h) - kratke pozicije placujejo dolge; " \
               "vzvod je pretezno na short strani, kar poveca obcutljivost za sunke navzgor (short squeeze).".format(pct)
    return "blizu nevtralnega ({:+.4f}% / 8h) - vzvod med long/short je relativno uravnotezen.".format(pct)


def _oi_note(prev, cur, price_change_pct):
    if prev is None:
        return "izhodisce postavljeno, trend bo viden od naslednjega porocila naprej."
    if prev == 0:
        return "ni primerljivega izhodisca."
    delta_pct = (cur - prev) / prev * 100
    if abs(delta_pct) < 0.5:
        return "brez vecje spremembe ({:+.2f}%).".format(delta_pct)
    rising = delta_pct > 0
    price_up = (price_change_pct or 0) > 0
    if rising and price_up:
        interp = "narascajoc OI + rastoca cena = odpirajo se nove pozicije (potencialno bolj krhko gibanje)."
    elif rising and not price_up:
        interp = "narascajoc OI + padajoca cena = odpirajo se nove short pozicije ali dolgi se ne umikajo."
    elif not rising and price_up:
        interp = "padajoc OI + rastoca cena = verjetno pokrivanje kratkih pozicij (short covering)."
    else:
        interp = "padajoc OI + padajoca cena = zapiranje dolgih pozicij (long unwind)."
    return "{:+.2f}% cez noc. {}".format(delta_pct, interp)


def _imbalance_note(bid_vol, ask_vol):
    total = bid_vol + ask_vol
    if total == 0:
        return "ni podatka.", 0.5
    ratio = bid_vol / total
    if ratio > 0.58:
        desc = "vec kupne likvidnosti v knjigi ({:.0f}% bid)".format(ratio * 100)
    elif ratio < 0.42:
        desc = "vec prodajne likvidnosti v knjigi ({:.0f}% ask)".format((1 - ratio) * 100)
    else:
        desc = "relativno uravnotezena knjiga ({:.0f}% bid / {:.0f}% ask)".format(ratio * 100, (1 - ratio) * 100)
    return desc, ratio


# ---------------------------------------------------------------------------
def compute_setups(price, atr, swing_high, swing_low_, portfolio_value=None, risk_pct=1.0):
    """
    Vrne dict z 'long' in 'short' scenarijema, vsak z entry/sl/tp/risk/velikost.
    SL se postavi ZA strukturni swing nivo + ATR blazino - to je namerno:
    prav ta obmocja so tipicno tarca za pobiranje likvidnosti (stop hunt),
    zato blazina zmanjsa verjetnost, da te "otrese" preden gre v pravo smer.
    """
    buffer_ = atr * SL_ATR_BUFFER

    long_sl = swing_low_ - buffer_
    long_risk = price - long_sl
    long_tp = price + RR_RATIO * long_risk if long_risk > 0 else None

    short_sl = swing_high + buffer_
    short_risk = short_sl - price
    short_tp = price - RR_RATIO * short_risk if short_risk > 0 else None

    def sizing(risk_per_unit):
        if not portfolio_value or risk_per_unit <= 0:
            return None, None
        risk_usd = portfolio_value * (risk_pct / 100.0)
        size_btc = risk_usd / risk_per_unit
        return risk_usd, size_btc

    long_risk_usd, long_size = sizing(long_risk)
    short_risk_usd, short_size = sizing(short_risk)

    return {
        "long": {"entry": price, "sl": long_sl, "tp": long_tp, "risk_per_unit": long_risk,
                 "risk_usd": long_risk_usd, "size_btc": long_size},
        "short": {"entry": price, "sl": short_sl, "tp": short_tp, "risk_per_unit": short_risk,
                  "risk_usd": short_risk_usd, "size_btc": short_size},
    }


# ---------------------------------------------------------------------------
def build_liquidity_section(portfolio_value=None, risk_pct=1.0):
    """
    Vrne (html, text). Ce karkoli spodleti, vrne prazen html in opis napake v text,
    da glavno porocilo ne obstane.
    """
    try:
        ticker, bid_vol, ask_vol, candles, source = fetch_all()
    except Exception as e:
        return ("", "Likvidnostni razdelek: pridobivanje podatkov ni uspelo ({}).".format(e))

    atr = compute_atr(candles)
    if atr is None:
        return ("", "Likvidnostni razdelek: premalo sveck za ATR izracun.")
    swing_high, swing_low_ = swing_high_low(candles)

    price = ticker["mark_price"]
    prev_price_24h = ticker.get("prev_price_24h")
    price_change_pct = ((price - prev_price_24h) / prev_price_24h * 100) if prev_price_24h else None

    state = load_state()
    prev_oi = state.get("open_interest") if state else None
    save_state(ticker["open_interest"], price)

    funding_note = _funding_note(ticker["funding_rate"])
    oi_note = _oi_note(prev_oi, ticker["open_interest"], price_change_pct)
    imbalance_desc, imbalance_ratio = _imbalance_note(bid_vol, ask_vol)

    setups = compute_setups(price, atr, swing_high, swing_low_, portfolio_value, risk_pct)
    L, S = setups["long"], setups["short"]

    def setup_row(label, s, color):
        size_str = ""
        if s["size_btc"] is not None:
            size_str = ("<br><span style='color:#888;font-size:12px'>Velikost pozicije pri {rp:.1f}% "
                        "tveganja portfelja: &asymp;{sz:.4f} BTC (tveganje {ru})</span>").format(
                rp=risk_pct, sz=s["size_btc"], ru=_fmt_usd(s["risk_usd"]))
        tp_str = _fmt_usd(s["tp"]) if s["tp"] else "n/a"
        return (
            "<div style='margin-top:10px;padding:10px 12px;background:#fff;border-left:3px solid {col};"
            "border-radius:4px;font-size:13px;line-height:1.6'>"
            "<b style='color:{col}'>{lab}</b><br>"
            "Vstop &asymp; {entry} &nbsp;|&nbsp; SL {sl} &nbsp;|&nbsp; TP (1:4) {tp}"
            "{size}</div>"
        ).format(lab=label, col=color, entry=_fmt_usd(s["entry"]),
                  sl=_fmt_usd(s["sl"]), tp=tp_str, size=size_str)

    html = (
        "<div style='margin-top:16px;padding:14px 16px;background:#f7f5ff;border-radius:8px;"
        "font-size:14px;color:#2b2440'>"
        "<b>&#9878; BTC likvidnostni signali in R:R 1:4 scenariji</b>"
        "<div style='margin-top:8px;font-size:13px;color:#444;line-height:1.6'>"
        "<b>Funding rate:</b> {fund}<br>"
        "<b>Open interest:</b> {oi}<br>"
        "<b>Orderbook (top {depth}):</b> {imb}<br>"
        "<b>ATR(14, 4h):</b> {atr} &nbsp;|&nbsp; <b>Swing high/low ({lb} sveck):</b> {sh} / {sl_}"
        "</div>"
        "{long_row}{short_row}"
        "<div style='margin-top:10px;font-size:11px;color:#888;line-height:1.5'>"
        "SL je postavljen za strukturni swing nivo + {buf}&times;ATR blazino, ker so ta obmocja "
        "pogosta tarca za pobiranje likvidnosti (stop hunt). To ni napoved smeri - oba scenarija "
        "sta izracunana vzporedno; smer izberes na podlagi lastne analize. Vir: {src} javni API. "
        "Ni financni nasvet."
        "</div>"
        "</div>"
    ).format(
        fund=funding_note, oi=oi_note, depth=ORDERBOOK_DEPTH, imb=imbalance_desc,
        atr=_fmt_usd(atr), lb=SWING_LOOKBACK, sh=_fmt_usd(swing_high), sl_=_fmt_usd(swing_low_),
        long_row=setup_row("LONG scenarij", L, "#127c2b"),
        short_row=setup_row("SHORT scenarij", S, "#c0392b"),
        buf=SL_ATR_BUFFER, src=source,
    )

    text_lines = [
        "BTC likvidnostni signali:",
        "  Funding: {}".format(funding_note),
        "  Open interest: {}".format(oi_note),
        "  Orderbook: {}".format(imbalance_desc),
        "  ATR(14,4h): {}  Swing H/L: {} / {}".format(_fmt_usd(atr), _fmt_usd(swing_high), _fmt_usd(swing_low_)),
        "  LONG  -> vstop {} / SL {} / TP {}".format(_fmt_usd(L["entry"]), _fmt_usd(L["sl"]), _fmt_usd(L["tp"]) if L["tp"] else "n/a"),
        "  SHORT -> vstop {} / SL {} / TP {}".format(_fmt_usd(S["entry"]), _fmt_usd(S["sl"]), _fmt_usd(S["tp"]) if S["tp"] else "n/a"),
        "  (ni financni nasvet, oba scenarija vzporedno - smer izberes sam)",
    ]
    return html, "\n".join(text_lines)
