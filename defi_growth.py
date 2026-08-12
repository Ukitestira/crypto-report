#!/usr/bin/env python3
"""
DeFi rastni potencial - kateri protokoli najhitreje pridobivajo TVL (Total Value Locked).

Vir: DefiLlama javni API (https://api.llama.fi/protocols), brezplacen, brez kljuca.

Kaj to JE: razvrstitev DeFi protokolov po 7-dnevni % spremembi TVL (change_7d),
z minimalnim pragom TVL, da izlocimo sum/mikroskopske projekte.

Kaj to NI: napoved cene ali priporocilo za vlaganje. Hitra rast TVL je pogosto
posledica zacasnih spodbud (token emisij, farming kampanj) in ni zanesljiv
signal trajne rasti. Vedno omenjeno v porocilu.

Ni state persistence - podatek (change_7d) je ze sam po sebi trend, dodatno
sledenje med zagoni ni potrebno za v1.
"""

import json
import urllib.request

DL_PROTOCOLS_URL = "https://api.llama.fi/protocols"
UA = {"User-Agent": "morning-crypto-report/1.0"}

MIN_TVL = 5_000_000          # izloci mikroskopske/sumljive projekte
TOP_N = 8                    # stevilo prikazanih protokolov
EXCLUDE_CATEGORIES = {"CEX", "Chain"}   # niso "DeFi protokoli" v ozjem smislu


def _get_json(url, timeout=25):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_protocols():
    data = _get_json(DL_PROTOCOLS_URL)
    if not isinstance(data, list):
        raise RuntimeError("Nepricakovana oblika odgovora DefiLlama API.")
    return data


def filter_and_rank(protocols, min_tvl=MIN_TVL, top_n=TOP_N,
                     exclude_categories=EXCLUDE_CATEGORIES):
    candidates = []
    for p in protocols:
        tvl = p.get("tvl")
        change_7d = p.get("change_7d")
        category = p.get("category") or ""
        if tvl is None or change_7d is None:
            continue
        if tvl < min_tvl:
            continue
        if category in exclude_categories:
            continue
        candidates.append(p)
    candidates.sort(key=lambda p: p["change_7d"], reverse=True)
    return candidates[:top_n]


def fmt_usd(n):
    n = n or 0
    if n >= 1_000_000_000:
        return "${:.2f}B".format(n / 1_000_000_000)
    if n >= 1_000_000:
        return "${:.1f}M".format(n / 1_000_000)
    return "${:,.0f}".format(n)


def fmt_pct(n):
    if n is None:
        return "n/a"
    sign = "+" if n >= 0 else ""
    return "{}{:.1f}%".format(sign, n)


# ---------------------------------------------------------------------------
def build_defi_growth_section(min_tvl=MIN_TVL, top_n=TOP_N):
    """
    Vrne (html, text). Ce karkoli spodleti, vrne prazen html in opis napake v text,
    da glavno porocilo ne obstane.
    """
    try:
        protocols = fetch_protocols()
    except Exception as e:
        return ("", "DeFi rastni potencial: pridobivanje podatkov ni uspelo ({}).".format(e))

    top = filter_and_rank(protocols, min_tvl=min_tvl, top_n=top_n)
    if not top:
        return ("", "DeFi rastni potencial: ni zadetkov nad pragom TVL.")

    rows_html, rows_text = [], []
    for p in top:
        name = p.get("name", "?")
        category = p.get("category") or "-"
        chains = p.get("chains") or []
        chain_str = ", ".join(chains[:2]) + (" +{}".format(len(chains) - 2) if len(chains) > 2 else "")
        tvl_str = fmt_usd(p.get("tvl"))
        d1 = fmt_pct(p.get("change_1d"))
        d7 = fmt_pct(p.get("change_7d"))
        url = p.get("url") or ""

        name_html = "<a href='{u}' style='color:#243b53'>{n}</a>".format(u=url, n=name) if url else name
        rows_html.append(
            "<tr>"
            "<td style='padding:6px 10px;font-weight:600'>{name}</td>"
            "<td style='padding:6px 10px;color:#666;font-size:12px'>{cat}</td>"
            "<td style='padding:6px 10px;color:#666;font-size:12px'>{chain}</td>"
            "<td style='padding:6px 10px'>{tvl}</td>"
            "<td style='padding:6px 10px'>{d1}</td>"
            "<td style='padding:6px 10px;font-weight:600;color:#2e7d32'>{d7}</td>"
            "</tr>".format(name=name_html, cat=category, chain=chain_str, tvl=tvl_str, d1=d1, d7=d7)
        )
        rows_text.append(
            "  {:<20} {:<14} TVL {:>10}  1d {:>7}  7d {:>7}".format(
                name[:20], category[:14], tvl_str, d1, d7)
        )

    html = (
        "<div style='margin-top:16px;padding:14px 16px;background:#f2fbf3;border-radius:8px;"
        "font-size:14px;color:#1a3350'>"
        "<b>\U0001F331 DeFi rastni potencial (najvecja 7d rast TVL)</b>"
        "<table style='width:100%;margin-top:8px;font-size:13px;border-collapse:collapse'>"
        "<thead><tr style='color:#666;font-size:11px;text-transform:uppercase'>"
        "<th style='text-align:left;padding:6px 10px'>Protokol</th>"
        "<th style='text-align:left;padding:6px 10px'>Kategorija</th>"
        "<th style='text-align:left;padding:6px 10px'>Verige</th>"
        "<th style='text-align:left;padding:6px 10px'>TVL</th>"
        "<th style='text-align:left;padding:6px 10px'>1d</th>"
        "<th style='text-align:left;padding:6px 10px'>7d</th></tr></thead>"
        "<tbody>{rows}</tbody></table>"
        "<div style='margin-top:10px;font-size:11px;color:#888;line-height:1.5'>"
        "Prag TVL: {min_tvl}. Hitra rast TVL je pogosto posledica zacasnih spodbud "
        "(token emisije, farming kampanje) in ni zanesljiv signal trajne rasti. "
        "Ni financni nasvet."
        "</div></div>"
    ).format(rows="".join(rows_html), min_tvl=fmt_usd(min_tvl))

    text_lines = ["DeFi rastni potencial (najvecja 7d rast TVL, prag {}):".format(fmt_usd(min_tvl))]
    text_lines.extend(rows_text)

    return html, "\n".join(text_lines)
