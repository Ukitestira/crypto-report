#!/usr/bin/env python3
"""
Jutranje crypto porocilo -> email.

Vira podatkov (brezplacna):
  - CoinGecko  (cene, spremembe 24h/7d, trzni pregled)
  - Alternative.me  (Fear & Greed indeks)

Posiljanje: SMTP (privzeto Gmail).

Nastavitve coinov: config.json
Skrivnosti (email, opc. API kljuc): okoljske spremenljivke / GitHub Secrets.

Zavestno informativno: porocilo povzema trg, ne daje nasvetov za trgovanje.
"""

import os
import sys
import json
import ssl
import smtplib
import urllib.parse
import urllib.request
import urllib.error
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from datetime import datetime, timezone

CG_BASE = "https://api.coingecko.com/api/v3"
FNG_URL = "https://api.alternative.me/fng/?limit=1"
CONFIG_PATH = os.environ.get("CONFIG_PATH", "config.json")

# Opcijski onchain modul (borzni tokovi). Ce ga ni, porocilo tece brez njega.
try:
    from onchain_flows import build_onchain_section
except Exception:
    build_onchain_section = None

# Opcijski AI modul (povzetek/priporocila). Ce ga ni ali ni API kljuca, porocilo tece brez njega.
try:
    from ai_synthesis import generate_ai_briefing
except Exception as e:
    print("  ! ai_synthesis uvoz ni uspel:", repr(e))
    generate_ai_briefing = None

print("  DEBUG: generate_ai_briefing =", generate_ai_briefing)

# --- okoljske spremenljivke ---
EMAIL_USER = os.environ.get("EMAIL_USER", "")
EMAIL_APP_PASSWORD = os.environ.get("EMAIL_APP_PASSWORD", "")
EMAIL_TO = os.environ.get("EMAIL_TO", EMAIL_USER)
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
COINGECKO_API_KEY = os.environ.get("COINGECKO_API_KEY", "")  # opcijsko (Demo kljuc)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def http_get_json(url, params=None, timeout=30):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "morning-crypto-report/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def cg_get(path, params=None):
    params = dict(params or {})
    if COINGECKO_API_KEY:
        params["x_cg_demo_api_key"] = COINGECKO_API_KEY
    return http_get_json(CG_BASE + path, params)


# ---------------------------------------------------------------------------
# Pomozne
# ---------------------------------------------------------------------------
def fmt_money(x):
    if x is None:
        return "-"
    if abs(x) >= 1:
        return "${:,.2f}".format(x)
    return "${:,.6f}".format(x)


def fmt_big(x):
    if x is None:
        return "-"
    for unit in ["", "K", "M", "B", "T"]:
        if abs(x) < 1000:
            return "${:,.2f}{}".format(x, unit)
        x /= 1000.0
    return "${:,.2f}Q".format(x)


def fmt_pct(x):
    if x is None:
        return "-"
    return "{:+.2f}%".format(x)


def pct_color(x):
    if x is None:
        return "#888"
    return "#127c2b" if x >= 0 else "#c0392b"


# ---------------------------------------------------------------------------
# Razresevanje CoinGecko ID iz simbola (za tokene brez rocno vpisanega id)
# ---------------------------------------------------------------------------
def resolve_id(symbol):
    try:
        data = cg_get("/search", {"query": symbol})
    except Exception as e:
        print("  ! iskanje id za {} ni uspelo: {}".format(symbol, e))
        return None
    coins = data.get("coins", []) or []
    sym = symbol.lower().strip()
    exact = [c for c in coins if (c.get("symbol") or "").lower() == sym]
    pool = exact or coins

    def rank(c):
        r = c.get("market_cap_rank")
        return r if isinstance(r, int) else 10 ** 9

    pool.sort(key=rank)
    return pool[0]["id"] if pool else None


# ---------------------------------------------------------------------------
# Nalaganje in priprava portfelja
# ---------------------------------------------------------------------------
def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def build_holdings(cfg):
    holdings = []
    auto_resolved = []
    for h in cfg.get("holdings", []):
        cid = h.get("id")
        if not cid:
            cid = resolve_id(h["symbol"])
            if cid:
                auto_resolved.append((h["symbol"], cid))
        holdings.append({
            "symbol": h["symbol"].upper(),
            "amount": float(h["amount"]),
            "id": cid,
            "note": h.get("note", ""),
        })
    return holdings, auto_resolved


# ---------------------------------------------------------------------------
# Pridobivanje trznih podatkov
# ---------------------------------------------------------------------------
def fetch_market_map(ids, vs):
    ids = [i for i in ids if i]
    if not ids:
        return {}
    data = cg_get("/coins/markets", {
        "vs_currency": vs,
        "ids": ",".join(sorted(set(ids))),
        "price_change_percentage": "24h,7d",
        "per_page": 250,
        "page": 1,
    })
    return {row["id"]: row for row in data}


def fetch_global():
    try:
        g = cg_get("/global")["data"]
        return {
            "total_mcap": g["total_market_cap"].get("usd"),
            "btc_dom": g["market_cap_percentage"].get("btc"),
            "mcap_24h": g.get("market_cap_change_percentage_24h_usd"),
            "total_vol": g["total_volume"].get("usd"),
        }
    except Exception as e:
        print("  ! global podatki niso dosegljivi:", e)
        return None


def fetch_fng():
    try:
        d = http_get_json(FNG_URL)["data"][0]
        return {"value": int(d["value"]), "label": d["value_classification"]}
    except Exception as e:
        print("  ! Fear & Greed ni dosegljiv:", e)
        return None


# ---------------------------------------------------------------------------
# Sestavljanje porocila
# ---------------------------------------------------------------------------
def compute_portfolio(holdings, mmap, vs):
    rows = []
    missing = []
    total = 0.0
    total_prev = 0.0
    for h in holdings:
        row = mmap.get(h["id"]) if h["id"] else None
        if not row or row.get("current_price") is None:
            missing.append(h)
            continue
        price = row["current_price"]
        ch24 = row.get("price_change_percentage_24h_in_currency")
        ch7d = row.get("price_change_percentage_7d_in_currency")
        value = price * h["amount"]
        total += value
        if ch24 is not None:
            total_prev += value / (1 + ch24 / 100.0)
        else:
            total_prev += value
        rows.append({
            "symbol": h["symbol"], "amount": h["amount"], "price": price,
            "ch24": ch24, "ch7d": ch7d, "value": value,
        })
    rows.sort(key=lambda r: r["value"], reverse=True)
    port_ch24 = ((total - total_prev) / total_prev * 100.0) if total_prev > 0 else None
    return rows, missing, total, port_ch24


def agent_note(rows, fng, port_ch24):
    notes = []
    if port_ch24 is not None:
        if port_ch24 >= 3:
            notes.append("Portfelj je cez noc opazno v plusu ({:+.1f}%).".format(port_ch24))
        elif port_ch24 <= -3:
            notes.append("Portfelj je cez noc opazno v minusu ({:+.1f}%).".format(port_ch24))
    movers = [r for r in rows if r["ch24"] is not None]
    if movers:
        top = max(movers, key=lambda r: r["ch24"])
        bot = min(movers, key=lambda r: r["ch24"])
        if top["ch24"] >= 8:
            notes.append("Najvecji dobitnik: {} ({}).".format(top["symbol"], fmt_pct(top["ch24"])))
        if bot["ch24"] <= -8:
            notes.append("Najvecji izgubljalec: {} ({}).".format(bot["symbol"], fmt_pct(bot["ch24"])))
    if fng:
        if fng["value"] <= 25:
            notes.append("Trzni sentiment je 'Extreme Fear' ({}).".format(fng["value"]))
        elif fng["value"] >= 75:
            notes.append("Trzni sentiment je 'Extreme Greed' ({}).".format(fng["value"]))
    if not notes:
        notes.append("Brez izstopajocih premikov cez noc.")
    return " ".join(notes)


def render_html(cfg, rows, missing, total, port_ch24, glob, fng, auto_resolved, onchain_html="", ai_briefing=None):
    vs = cfg.get("vs_currency", "usd").upper()
    now = datetime.now(timezone.utc).strftime("%d.%m.%Y")

    def row_html(r):
        return (
            "<tr>"
            "<td style='padding:8px 10px;font-weight:600'>{sym}</td>"
            "<td style='padding:8px 10px;text-align:right'>{price}</td>"
            "<td style='padding:8px 10px;text-align:right;color:{c24}'>{p24}</td>"
            "<td style='padding:8px 10px;text-align:right;color:{c7d}'>{p7d}</td>"
            "<td style='padding:8px 10px;text-align:right'>{amt:g}</td>"
            "<td style='padding:8px 10px;text-align:right;font-weight:600'>{val}</td>"
            "</tr>"
        ).format(
            sym=r["symbol"], price=fmt_money(r["price"]),
            c24=pct_color(r["ch24"]), p24=fmt_pct(r["ch24"]),
            c7d=pct_color(r["ch7d"]), p7d=fmt_pct(r["ch7d"]),
            amt=r["amount"], val=fmt_money(r["value"]),
        )

    body = "".join(row_html(r) for r in rows)

    market = ""
    if glob:
        market = (
            "<p style='margin:6px 0;color:#444'>"
            "Trg skupaj: <b>{mc}</b> ({mc24}) &nbsp;|&nbsp; "
            "BTC dominanca: <b>{dom:.1f}%</b> &nbsp;|&nbsp; "
            "24h volumen: <b>{vol}</b></p>"
        ).format(
            mc=fmt_big(glob["total_mcap"]),
            mc24="<span style='color:{}'>{}</span>".format(pct_color(glob["mcap_24h"]), fmt_pct(glob["mcap_24h"])),
            dom=glob["btc_dom"] or 0, vol=fmt_big(glob["total_vol"]),
        )

    fng_html = ""
    if fng:
        fng_html = (
            "<p style='margin:6px 0;color:#444'>Fear &amp; Greed: "
            "<b>{v}/100</b> &ndash; {l}</p>"
        ).format(v=fng["value"], l=fng["label"])

    miss_html = ""
    if missing:
        items = ", ".join("{}{}".format(m["symbol"], " ({})".format(m["note"]) if m["note"] else "") for m in missing)
        miss_html = (
            "<p style='margin:12px 0;color:#b26a00'>Ni cene za: {}. "
            "Preveri CoinGecko id v config.json.</p>"
        ).format(items)

    resolved_html = ""
    if auto_resolved:
        items = "".join("<li>{} &rarr; <code>{}</code></li>".format(s, i) for s, i in auto_resolved)
        resolved_html = (
            "<div style='margin-top:16px;padding:10px 14px;background:#f4f6f8;border-radius:8px;font-size:13px;color:#555'>"
            "<b>Samodejno razreseni id-ji</b> (za zanesljivost jih vpisi v config.json):"
            "<ul style='margin:6px 0 0'>{}</ul></div>"
        ).format(items)

    ai_html = ""
    if ai_briefing:
        ai_html = (
            "<div style='margin-top:16px;padding:12px 16px;background:#fff7e6;border-radius:8px;font-size:14px;color:#4a3800;white-space:pre-line'>"
            "<b>\U0001F916 AI Povzetek:</b><br>{}</div>"
        ).format(ai_briefing.replace("\n", "<br>"))

    port_color = pct_color(port_ch24)

    return """<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f0f2f5">
<div style="max-width:640px;margin:0 auto;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a1a1a">
  <h1 style="font-size:20px;margin:0 0 4px">{title}</h1>
  <p style="margin:0 0 16px;color:#888;font-size:13px">{date}</p>

  <div style="background:#fff;border-radius:12px;padding:18px 20px;margin-bottom:16px">
    <div style="font-size:13px;color:#888;text-transform:uppercase;letter-spacing:.05em">Vrednost portfelja</div>
    <div style="font-size:30px;font-weight:700;margin:2px 0">{total}</div>
    <div style="font-size:15px;font-weight:600;color:{pcolor}">{pch} cez noc</div>
    {market}{fng}
  </div>

  <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;font-size:14px">
    <thead>
      <tr style="background:#fafafa;color:#666;font-size:12px;text-transform:uppercase">
        <th style="padding:10px;text-align:left">Coin</th>
        <th style="padding:10px;text-align:right">Cena</th>
        <th style="padding:10px;text-align:right">24h</th>
        <th style="padding:10px;text-align:right">7d</th>
        <th style="padding:10px;text-align:right">Kolicina</th>
        <th style="padding:10px;text-align:right">Vrednost</th>
      </tr>
    </thead>
    <tbody>{body}</tbody>
  </table>

  <div style="margin-top:16px;padding:12px 16px;background:#eef4ff;border-radius:8px;font-size:14px;color:#243b53">
    <b>Opazanje:</b> {note}
  </div>
  {missing}{resolved}
  {ai_briefing}
  {onchain}

  <p style="margin-top:20px;color:#aaa;font-size:12px;line-height:1.5">
    Informativno porocilo, ne financni nasvet. Podatki: CoinGecko, Alternative.me.
  </p>
</div></body></html>""".format(
        title=cfg.get("report_title", "Crypto porocilo"),
        date=now, total=fmt_money(total),
        pcolor=port_color, pch=fmt_pct(port_ch24),
        market=market, fng=fng_html, body=body,
        note=agent_note(rows, fng, port_ch24),
        missing=miss_html, resolved=resolved_html,
        onchain=onchain_html or "",
        ai_briefing=ai_html,
    )


def render_text(cfg, rows, total, port_ch24, onchain_text="", ai_briefing=None):
    lines = [cfg.get("report_title", "Crypto porocilo"),
             datetime.now(timezone.utc).strftime("%d.%m.%Y"), ""]
    lines.append("Vrednost portfelja: {}  ({} cez noc)".format(fmt_money(total), fmt_pct(port_ch24)))
    lines.append("")
    for r in rows:
        lines.append("{:<8} {:>14}  24h {:>8}  7d {:>8}  = {}".format(
            r["symbol"], fmt_money(r["price"]), fmt_pct(r["ch24"]),
            fmt_pct(r["ch7d"]), fmt_money(r["value"])))
    if ai_briefing:
        lines.append("")
        lines.append("AI POVZETEK:")
        lines.append(ai_briefing)
    if onchain_text:
        lines.append("")
        lines.append(onchain_text)
    lines.append("")
    lines.append("Informativno, ne financni nasvet.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Posiljanje
# ---------------------------------------------------------------------------
def send_email(subject, html, text):
    if not (EMAIL_USER and EMAIL_APP_PASSWORD and EMAIL_TO):
        print("  ! Manjkajo EMAIL_USER / EMAIL_APP_PASSWORD / EMAIL_TO. Email ni poslan.")
        print("---- predogled (text) ----")
        print(text)
        return False
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = EMAIL_USER
    msg["To"] = EMAIL_TO
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))
    ctx = ssl.create_default_context()
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.starttls(context=ctx)
        s.login(EMAIL_USER, EMAIL_APP_PASSWORD)
        s.sendmail(EMAIL_USER, [a.strip() for a in EMAIL_TO.split(",")], msg.as_string())
    print("  + Email poslan na", EMAIL_TO)
    return True


# ---------------------------------------------------------------------------
def main():
    print("Nalagam config...")
    cfg = load_config()
    vs = cfg.get("vs_currency", "usd")

    print("Razresujem coine...")
    holdings, auto_resolved = build_holdings(cfg)
    for s, i in auto_resolved:
        print("  auto: {} -> {}".format(s, i))

    print("Pridobivam trzne podatke...")
    mmap = fetch_market_map([h["id"] for h in holdings], vs)
    glob = fetch_global()
    fng = fetch_fng()

    rows, missing, total, port_ch24 = compute_portfolio(holdings, mmap, vs)
    if missing:
        print("  ! brez cene:", ", ".join(m["symbol"] for m in missing))

    # --- onchain borzni tokovi (opcijsko) ---
    onchain_html, onchain_text = "", ""
    if build_onchain_section is not None:
        print("Pridobivam onchain borzne tokove...")
        prices = {row_id: mmap[row_id].get("current_price")
                  for row_id in ("bitcoin", "ethereum", "solana") if row_id in mmap}
        threshold = float(cfg.get("onchain_threshold_usd", 250000))
        try:
            onchain_html, onchain_text = build_onchain_section(prices, threshold)
        except Exception as e:
            print("  ! onchain razdelek ni uspel:", e)

    # --- AI povzetek (opcijsko) ---
    ai_briefing = None
    if generate_ai_briefing is not None:
        print("Generiram AI povzetek...")
        try:
            ai_briefing = generate_ai_briefing(rows, total, port_ch24, glob, fng, onchain_text)
        except Exception as e:
            print("  ! AI povzetek ni uspel:", e)

    html = render_html(cfg, rows, missing, total, port_ch24, glob, fng, auto_resolved, onchain_html, ai_briefing)
    text = render_text(cfg, rows, total, port_ch24, onchain_text, ai_briefing)

    subject = "{} - {} ({})".format(
        cfg.get("report_title", "Crypto porocilo"),
        fmt_money(total), fmt_pct(port_ch24))
    send_email(subject, html, text)
    print("Koncano.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("NAPAKA:", e)
        sys.exit(1)
