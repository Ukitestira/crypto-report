#!/usr/bin/env python3
"""
Pionex BTC/USDT futures grid bot - opomnik, kdaj je smiselno dodati sredstva.

Vir: Pionex privatni API (https://api.pionex.com), rabi PIONEX_API_KEY + PIONEX_API_SECRET
z read-only pravico (Query account/order info). Ne rabi Trade/Transfer pravice - modul
nikoli ne pise/trguje, samo bere stanje bota.

Logika priporocila (informativen signal, NE financni nasvet):
  1. Pozicija cene v nastavljenem grid razponu (top/bottom) - blizu roba = tvegano.
  2. Trzni rezim zadnjih ~14 dni (OKX BTC perp) - sideways (ozek razpon) vs trending
     (mocan enosmeren premik). Grid boti najbolje delujejo v sideways rezimu.
  3. Kombinacija obeh + stanje marze bota (marginStatus) -> DODAJ / PREVIDNO / NE.

Ni state persistence - vsak zagon je neodvisna ocena trenutnega stanja.
"""

import os
import json
import time
import hmac
import hashlib
import urllib.request
import urllib.parse

PIONEX_API_KEY = os.environ.get("PIONEX_API_KEY", "")
PIONEX_API_SECRET = os.environ.get("PIONEX_API_SECRET", "")
PIONEX_BASE = "https://api.pionex.com"

OKX_BASE = "https://www.okx.com"
UA = {"User-Agent": "morning-crypto-report/1.0"}

REGIME_LOOKBACK_DAYS = 14
SIDEWAYS_RANGE_PCT = 8.0     # (max-min)/cena < to % => sideways
TRENDING_MOVE_PCT = 10.0     # |zadnja - prva|/prva cena > to % => trending
EDGE_ZONE_PCT = 15.0         # ce je cena znotraj tega % od roba razpona, je "blizu roba"


# ---------------------------------------------------------------------------
def _sign(method, path, query=None, body_str=""):
    query = dict(query or {})
    query["timestamp"] = str(int(time.time() * 1000))
    sorted_items = sorted(query.items(), key=lambda kv: kv[0])
    query_str = "&".join("{}={}".format(k, v) for k, v in sorted_items)
    path_url = "{}?{}".format(path, query_str)
    sign_src = method.upper() + path_url + (body_str or "")
    signature = hmac.new(
        PIONEX_API_SECRET.encode("utf-8"),
        sign_src.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return path_url, signature


def _pionex_get(path, query=None):
    if not (PIONEX_API_KEY and PIONEX_API_SECRET):
        raise RuntimeError("PIONEX_API_KEY / PIONEX_API_SECRET nista nastavljena.")
    path_url, signature = _sign("GET", path, query)
    url = PIONEX_BASE + path_url
    req = urllib.request.Request(url, headers={
        "PIONEX-KEY": PIONEX_API_KEY,
        "PIONEX-SIGNATURE": signature,
        **UA,
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8"))
    if not data.get("result", False):
        raise RuntimeError("Pionex API napaka: {}".format(data.get("message", data)))
    return data


def get_running_futures_grid(base="BTC", quote="USDT"):
    data = _pionex_get("/api/v1/bot/orders", {
        "status": "running",
        "base": base,
        "quote": quote,
        "buOrderTypes": "futures_grid",
    })
    results = (data.get("data") or {}).get("results") or []
    if not results:
        return None
    return results[0]


# ---------------------------------------------------------------------------
def _okx_get_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_btc_price_and_regime():
    """Vrne (current_price, regime, range_pct, move_pct)."""
    url = OKX_BASE + "/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1D&limit={}".format(
        REGIME_LOOKBACK_DAYS + 1)
    data = _okx_get_json(url)
    candles = data.get("data") or []
    if not candles:
        raise RuntimeError("OKX ni vrnil svec za BTC.")
    # OKX vrne najnovejse najprej; vsaka sveca: [ts, o, h, l, c, ...]
    highs = [float(c[2]) for c in candles]
    lows = [float(c[3]) for c in candles]
    closes = [float(c[4]) for c in candles]
    current_price = closes[0]
    period_high = max(highs)
    period_low = min(lows)
    oldest_close = closes[-1]

    range_pct = (period_high - period_low) / current_price * 100 if current_price else 0
    move_pct = abs(current_price - oldest_close) / oldest_close * 100 if oldest_close else 0

    if range_pct <= SIDEWAYS_RANGE_PCT and move_pct <= TRENDING_MOVE_PCT:
        regime = "sideways"
    elif move_pct > TRENDING_MOVE_PCT:
        regime = "trending"
    else:
        regime = "mesano"

    return current_price, regime, range_pct, move_pct


# ---------------------------------------------------------------------------
def _recommend(price_pos_pct, regime, margin_status):
    if margin_status == "INSUFFICIENT":
        return "NE DODAJAJ", "Marza bota je nezadostna (INSUFFICIENT) - najprej preveri bota rocno."
    near_edge = price_pos_pct is not None and (price_pos_pct < EDGE_ZONE_PCT or price_pos_pct > 100 - EDGE_ZONE_PCT)
    if regime == "sideways" and not near_edge:
        return "DODAJ", "Trg je sideways in cena je lepo znotraj sredine razpona - ugoden trenutek za dodajanje."
    if regime == "trending":
        return "PREVIDNO", "Trg kaze mocan trend - grid boti v trendu delajo slabse, razmisli o pocakanju ali prilagoditvi razpona."
    if near_edge:
        return "PREVIDNO", "Cena je blizu roba nastavljenega razpona - tvegano dodajati, razpon se lahko kmalu prebije."
    return "NEVTRALNO", "Mesani signali - ni jasnega ugodnega ali neugodnega trenutka."


def build_pionex_grid_section(base="BTC", quote="USDT"):
    """
    Vrne (html, text). Ce karkoli spodleti (ni kljuca, ni aktivnega bota, API napaka),
    vrne prazen html in opis v text, da glavno porocilo ne obstane.
    """
    try:
        order = get_running_futures_grid(base, quote)
    except Exception as e:
        return ("", "Pionex grid bot: pridobivanje podatkov ni uspelo ({}).".format(e))

    if order is None:
        return ("", "Pionex grid bot: ni najdenega aktivnega {}/{} futures grid bota.".format(base, quote))

    bu = order.get("buOrderData") or {}
    top = bu.get("top")
    bottom = bu.get("bottom")
    quote_investment = bu.get("quoteInvestment")
    margin_balance = bu.get("marginBalance")
    margin_status = bu.get("marginStatus", "NORMAL")
    risk_status = bu.get("riskStatus", "TRADING")

    try:
        current_price, regime, range_pct, move_pct = fetch_btc_price_and_regime()
    except Exception as e:
        return ("", "Pionex grid bot: pridobivanje BTC rezima ni uspelo ({}).".format(e))

    price_pos_pct = None
    if top and bottom:
        try:
            t, b = float(top), float(bottom)
            if t > b:
                price_pos_pct = (current_price - b) / (t - b) * 100
        except (ValueError, ZeroDivisionError):
            price_pos_pct = None

    action, reason = _recommend(price_pos_pct, regime, margin_status)

    color = {"DODAJ": "#2e7d32", "PREVIDNO": "#b26a00", "NE DODAJAJ": "#c62828", "NEVTRALNO": "#555"}.get(action, "#555")
    pos_str = "{:.0f}% razpona".format(price_pos_pct) if price_pos_pct is not None else "n/a"

    html = (
        "<div style='margin-top:16px;padding:14px 16px;background:#fff7ed;border-radius:8px;"
        "font-size:14px;color:#1a3350'>"
        "<b>\U0001F3AF Pionex BTC/USDT grid bot</b>"
        "<div style='margin-top:8px;font-size:16px;font-weight:700;color:{color}'>{action}</div>"
        "<div style='font-size:13px;color:#333;margin-top:4px'>{reason}</div>"
        "<table style='width:100%;margin-top:10px;font-size:13px;border-collapse:collapse'>"
        "<tr><td style='padding:4px 10px;color:#666'>BTC cena</td><td style='padding:4px 10px'>${price:,.0f}</td></tr>"
        "<tr><td style='padding:4px 10px;color:#666'>Razpon bota</td><td style='padding:4px 10px'>${bottom} - ${top} ({pos})</td></tr>"
        "<tr><td style='padding:4px 10px;color:#666'>Trzni rezim (14d)</td><td style='padding:4px 10px'>{regime} (razpon {range_pct:.1f}%, premik {move_pct:.1f}%)</td></tr>"
        "<tr><td style='padding:4px 10px;color:#666'>Investicija / marza</td><td style='padding:4px 10px'>{qi} / {mb} ({mstatus})</td></tr>"
        "</table>"
        "<div style='margin-top:10px;font-size:11px;color:#888;line-height:1.5'>"
        "Informativen signal na podlagi cenovnega polozaja v razponu in 14-dnevnega trznega rezima. "
        "Ni financni nasvet - odlocitev o dodajanju sredstev je tvoja."
        "</div></div>"
    ).format(color=color, action=action, reason=reason, price=current_price,
              bottom=bottom, top=top, pos=pos_str, regime=regime, range_pct=range_pct,
              move_pct=move_pct, qi=quote_investment, mb=margin_balance, mstatus=margin_status)

    text = (
        "Pionex BTC/USDT grid bot: {action}\n"
        "  {reason}\n"
        "  BTC cena: ${price:,.0f} | Razpon: ${bottom}-${top} ({pos})\n"
        "  Rezim (14d): {regime} (razpon {range_pct:.1f}%, premik {move_pct:.1f}%)\n"
        "  Investicija/marza: {qi}/{mb} ({mstatus}), status: {rstatus}"
    ).format(action=action, reason=reason, price=current_price, bottom=bottom, top=top,
              pos=pos_str, regime=regime, range_pct=range_pct, move_pct=move_pct,
              qi=quote_investment, mb=margin_balance, mstatus=margin_status, rstatus=risk_status)

    return html, text
