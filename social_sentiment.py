#!/usr/bin/env python3
"""
Social sentiment razdelek - koliko in v kaksnem tonu se govori o posameznem coinu.

POMEMBNO - kaj ta modul JE in kaj NI:
  - NI Twitter/X podatek. Twitter/X API je placljiv (Basic tier), zato ta modul
    namesto "tweetov" uporablja CryptoPanic - agregator novic s community glasovi
    (bullish/bearish/important/toxic ...). "Najpomembnejse objave" spodaj so torej
    najbolj glasovane/pomembne NOVICE, ne tweeti.
  - Volumen = stevilo najdenih objav na CryptoPanic, ki omenjajo coin (zadnjih
    do MAX_PAGES strani rezultatov).
  - Ton = razmerje pozitivnih (positive+liked) proti negativnim (negative+disliked+toxic)
    glasovom uporabnikov CryptoPanic. Ce je glasov premalo, ton ni ocenjen.

Vir podatkov: CryptoPanic javni API v1 (brezplacen developer tier, auth_token).
Stanje (prejsnji ton) se hrani v state/social_state.json za primerjavo trenda
med zagoni (enak vzorec kot liquidity_setup.py / onchain_flows.py).

Informativno, ne financni nasvet.
"""

import os
import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone

CP_BASE_CANDIDATES = [
    "https://cryptopanic.com/api/v1/posts/",
    "https://cryptopanic.com/api/developer/v2/posts/",
    "https://cryptopanic.com/api/free/v2/posts/",
]
CRYPTOPANIC_API_KEY = os.environ.get("CRYPTOPANIC_API_KEY", "")
STATE_DIR = os.environ.get("STATE_DIR", "state")
STATE_PATH = os.path.join(STATE_DIR, "social_state.json")
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

STABLES = {"USDC", "USDT", "DAI", "BUSD"}
MAX_PAGES = 3                 # koliko strani rezultatov max potegnemo (varcevanje s klici)
TOP_HIGHLIGHTS = 4            # stevilo izpostavljenih objav v porocilu
MIN_VOTES_FOR_TONE = 3        # ce je manj glasov skupaj, tona ne ocenjujemo
TREND_DELTA = 0.05            # sprememba razmerja, ki sprozi puscico trenda


# ---------------------------------------------------------------------------
def _get_json(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _cp_get(symbols, page_url=None, base_url=None):
    if page_url:
        return _get_json(page_url)
    params = {
        "auth_token": CRYPTOPANIC_API_KEY,
        "public": "true",
        "currencies": ",".join(symbols),
        "kind": "news",
    }
    query = "?" + urllib.parse.urlencode(params)
    if base_url:
        return _get_json(base_url + query)
    # Poizkusi vse znane variante API-ja, dokler ena ne uspe (CryptoPanic je
    # spreminjal strukturo URL-ja med v1 in v2/{plan}, plan pa je odvisen
    # od nastavitev racuna in ga ne moremo vnaprej poznati).
    last_err = None
    for candidate in CP_BASE_CANDIDATES:
        try:
            data = _get_json(candidate + query)
            return data, candidate
        except Exception as e:
            last_err = e
            continue
    raise last_err or RuntimeError("Noben CryptoPanic API endpoint ni deloval.")


# ---------------------------------------------------------------------------
def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_state(scores):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "scores": scores,
        }, f, indent=2)


# ---------------------------------------------------------------------------
def fetch_posts(symbols):
    if not CRYPTOPANIC_API_KEY:
        raise RuntimeError("CRYPTOPANIC_API_KEY ni nastavljen.")
    posts, seen = [], set()
    next_url = None
    working_base = None
    for _ in range(MAX_PAGES):
        if next_url is None:
            result = _cp_get(symbols)
            data, working_base = result
        else:
            data = _cp_get(symbols, page_url=next_url)
        for p in (data.get("results") or []):
            key = p.get("url") or p.get("id")
            if key in seen:
                continue
            seen.add(key)
            posts.append(p)
        next_url = data.get("next")
        if not next_url:
            break
    return posts


def aggregate(posts, symbols):
    per_coin = {s: {"posts": 0, "bull": 0, "bear": 0, "important": 0} for s in symbols}
    for p in posts:
        codes = {(c.get("code") or "").upper() for c in (p.get("currencies") or [])}
        v = p.get("votes") or {}
        bull = (v.get("positive", 0) or 0) + (v.get("liked", 0) or 0)
        bear = (v.get("negative", 0) or 0) + (v.get("disliked", 0) or 0) + (v.get("toxic", 0) or 0)
        important = v.get("important", 0) or 0
        for s in symbols:
            if s in codes:
                d = per_coin[s]
                d["posts"] += 1
                d["bull"] += bull
                d["bear"] += bear
                d["important"] += important
    return per_coin


def tone_label(bull, bear):
    total = bull + bear
    if total < MIN_VOTES_FOR_TONE:
        return "premalo glasov za oceno", None
    ratio = bull / total
    if ratio >= 0.65:
        return "pozitiven", ratio
    if ratio <= 0.35:
        return "negativen", ratio
    return "mesan/nevtralen", ratio


def trend_arrow(ratio, prev_ratio):
    if ratio is None or prev_ratio is None:
        return ""
    delta = ratio - prev_ratio
    if delta > TREND_DELTA:
        return " \u2191"
    if delta < -TREND_DELTA:
        return " \u2193"
    return " \u2192"


# ---------------------------------------------------------------------------
def _post_score(votes):
    v = votes or {}
    return ((v.get("important", 0) or 0) * 3
             + (v.get("positive", 0) or 0) + (v.get("negative", 0) or 0)
             + (v.get("liked", 0) or 0) + (v.get("disliked", 0) or 0))


def top_highlights(posts, symbols, limit=TOP_HIGHLIGHTS):
    watched = set(symbols)
    scored = []
    for p in posts:
        codes = {(c.get("code") or "").upper() for c in (p.get("currencies") or [])}
        if not (codes & watched):
            continue
        scored.append((_post_score(p.get("votes")), p, sorted(codes & watched)))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[:limit]


# ---------------------------------------------------------------------------
def build_social_section(symbols):
    """
    Vrne (html, text). Ce karkoli spodleti, vrne prazen html in opis napake v text,
    da glavno porocilo ne obstane.
    """
    symbols = sorted({s.upper() for s in symbols if s.upper() not in STABLES})
    if not symbols:
        return ("", "")

    try:
        posts = fetch_posts(symbols)
    except Exception as e:
        return ("", "Social sentiment razdelek: pridobivanje podatkov ni uspelo ({}).".format(e))

    per_coin = aggregate(posts, symbols)
    state = load_state()
    prev_scores = (state or {}).get("scores", {})

    new_scores = {}
    coin_rows_html, coin_rows_text = [], []
    for s in symbols:
        d = per_coin[s]
        label, ratio = tone_label(d["bull"], d["bear"])
        if ratio is not None:
            new_scores[s] = ratio
        arrow = trend_arrow(ratio, prev_scores.get(s))
        vol_note = "{} objav".format(d["posts"]) if d["posts"] else "brez zadetkov"
        coin_rows_html.append(
            "<tr>"
            "<td style='padding:6px 10px;font-weight:600'>{sym}</td>"
            "<td style='padding:6px 10px'>{vol}</td>"
            "<td style='padding:6px 10px'>{ton}{arrow}</td>"
            "</tr>".format(sym=s, vol=vol_note, ton=label, arrow=arrow)
        )
        coin_rows_text.append("  {:<8} {:>12}  ton: {}{}".format(s, vol_note, label, arrow))

    save_state(new_scores)

    highlights = top_highlights(posts, symbols)
    hl_html_items, hl_text_items = [], []
    for score, p, codes in highlights:
        title = (p.get("title") or "").strip()
        url = p.get("url") or (p.get("source") or {}).get("region_url") or ""
        source = (p.get("source") or {}).get("title", "")
        v = p.get("votes") or {}
        vote_str = "\U0001F44D{} \U0001F44E{} \u2757{}".format(
            (v.get("positive", 0) or 0) + (v.get("liked", 0) or 0),
            (v.get("negative", 0) or 0) + (v.get("disliked", 0) or 0),
            v.get("important", 0) or 0,
        )
        coin_tag = "/".join(codes)
        if url:
            hl_html_items.append(
                "<li style='margin-bottom:6px'><a href='{u}' style='color:#243b53'>{t}</a> "
                "<span style='color:#888;font-size:12px'>({src} &middot; {coin} &middot; {votes})</span></li>"
                .format(u=url, t=title, src=source, coin=coin_tag, votes=vote_str)
            )
            hl_text_items.append("  - [{}] {} ({}) - {}".format(coin_tag, title, source, url))

    highlights_html = ""
    if hl_html_items:
        highlights_html = (
            "<div style='margin-top:10px'>"
            "<b style='font-size:13px'>Najpomembnejse objave (CryptoPanic novice, ne tweeti):</b>"
            "<ul style='margin:6px 0 0;padding-left:18px;font-size:13px;color:#333'>{}</ul>"
            "</div>"
        ).format("".join(hl_html_items))

    html = (
        "<div style='margin-top:16px;padding:14px 16px;background:#f0f7ff;border-radius:8px;"
        "font-size:14px;color:#1a3350'>"
        "<b>\U0001F4E3 Social sentiment (CryptoPanic)</b>"
        "<table style='width:100%;margin-top:8px;font-size:13px;border-collapse:collapse'>"
        "<thead><tr style='color:#666;font-size:11px;text-transform:uppercase'>"
        "<th style='text-align:left;padding:6px 10px'>Coin</th>"
        "<th style='text-align:left;padding:6px 10px'>Volumen</th>"
        "<th style='text-align:left;padding:6px 10px'>Ton</th></tr></thead>"
        "<tbody>{rows}</tbody></table>"
        "{highlights}"
        "<div style='margin-top:10px;font-size:11px;color:#888;line-height:1.5'>"
        "Ton = razmerje pozitivnih/negativnih community glasov na CryptoPanic novicah, "
        "ne napoved cene. Ni financni nasvet."
        "</div></div>"
    ).format(rows="".join(coin_rows_html), highlights=highlights_html)

    text_lines = ["Social sentiment (CryptoPanic):"]
    text_lines.extend(coin_rows_text)
    if hl_text_items:
        text_lines.append("  Najpomembnejse objave (novice, ne tweeti):")
        text_lines.extend(hl_text_items)

    return html, "\n".join(text_lines)
