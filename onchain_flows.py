#!/usr/bin/env python3
"""
Onchain borzni tokovi (brezplacno, brez placljivih API-jev).

Ideja: spremljamo SALDO znanih borznih naslovov. Sprememba cez noc:
  saldo GOR  -> coini so prisli NA borzo  -> priliv (moznost pritiska prodaje)
  saldo DOL  -> coini so odsli Z borze    -> odliv (moznost akumulacije)

Vira saldov (brez kljuca):
  BTC -> mempool.space
  ETH -> Blockscout   (opc. Etherscan, ce nastavljen ETHERSCAN_API_KEY)
  SOL -> Solana public RPC (opc. SOLANA_RPC_URL, npr. Helius, za vecjo zanesljivost)

Stanje (vcerajsnji saldi) se hrani v state/onchain_snapshot.json in ga
GitHub Actions po vsakem zagonu commita nazaj v repo.

Informativno, ne financni nasvet.
"""

import os
import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ADDRESSES_PATH = os.environ.get("ADDRESSES_PATH", "exchange_addresses.json")
STATE_DIR = os.environ.get("STATE_DIR", "state")
SNAPSHOT_PATH = os.path.join(STATE_DIR, "onchain_snapshot.json")

ETHERSCAN_API_KEY = os.environ.get("ETHERSCAN_API_KEY", "")
SOLANA_RPC_URL = os.environ.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

# chain -> coingecko id (za ceno v USD)
CHAIN_TO_CGID = {"btc": "bitcoin", "eth": "ethereum", "sol": "solana"}
CHAIN_LABEL = {"btc": "BTC", "eth": "ETH", "sol": "SOL"}
UA = {"User-Agent": "morning-crypto-report/1.0"}


# ---------------------------------------------------------------------------
def _get_json(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _post_json(url, payload, timeout=30):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json", **UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# --- saldo po verigah (v nativni enoti) -----------------------------------
def balance_btc(addr):
    d = _get_json("https://mempool.space/api/address/" + urllib.parse.quote(addr))
    cs = d.get("chain_stats", {})
    sats = cs.get("funded_txo_sum", 0) - cs.get("spent_txo_sum", 0)
    return sats / 1e8


def balance_eth(addr):
    if ETHERSCAN_API_KEY:
        url = ("https://api.etherscan.io/api?module=account&action=balance"
               "&address={}&tag=latest&apikey={}").format(addr, ETHERSCAN_API_KEY)
    else:
        url = ("https://eth.blockscout.com/api?module=account&action=balance"
               "&address={}").format(addr)
    d = _get_json(url)
    return int(d["result"]) / 1e18


def balance_sol(addr):
    d = _post_json(SOLANA_RPC_URL, {
        "jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [addr]})
    return d["result"]["value"] / 1e9


BALANCE_FN = {"btc": balance_btc, "eth": balance_eth, "sol": balance_sol}


# ---------------------------------------------------------------------------
def load_addresses():
    with open(ADDRESSES_PATH, encoding="utf-8") as f:
        return json.load(f).get("addresses", [])


def load_snapshot():
    try:
        with open(SNAPSHOT_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_snapshot(balances):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(SNAPSHOT_PATH, "w", encoding="utf-8") as f:
        json.dump({"timestamp": datetime.now(timezone.utc).isoformat(),
                   "balances": balances}, f, indent=2)


def fetch_all_balances(addresses):
    out = {}
    for a in addresses:
        chain = a["chain"].lower()
        fn = BALANCE_FN.get(chain)
        if not fn:
            continue
        key = "{}:{}".format(chain, a["address"])
        try:
            out[key] = {"balance": fn(a["address"]),
                        "chain": chain, "exchange": a.get("exchange", "?")}
        except Exception as e:
            print("  ! saldo ni dosegljiv za {} ({}): {}".format(a.get("exchange"), key, e))
    return out


# ---------------------------------------------------------------------------
def _fmt_usd(x):
    sign = "-" if x < 0 else ""
    ax = abs(x)
    for unit in ["", "K", "M", "B"]:
        if ax < 1000:
            return "{}${:,.1f}{}".format(sign, ax, unit)
        ax /= 1000.0
    return "{}${:,.1f}T".format(sign, ax)


def build_onchain_section(prices, threshold_usd=250000):
    """
    prices: dict coingecko_id -> USD cena (npr. {'bitcoin':..,'ethereum':..,'solana':..})
    Vrne (html, text).
    """
    try:
        addresses = load_addresses()
    except Exception as e:
        return ("", "Onchain: napaka pri branju naslovov: {}".format(e))
    if not addresses:
        return ("", "")

    prev = load_snapshot()
    current = fetch_all_balances(addresses)

    # vedno shranimo novo stanje (za jutrisnjo primerjavo)
    save_snapshot({k: v["balance"] for k, v in current.items()})

    if not prev or not prev.get("balances"):
        html = ("<div style='margin-top:16px;padding:12px 16px;background:#fff7e6;"
                "border-radius:8px;font-size:14px;color:#7a5b00'>"
                "<b>Onchain borzni tokovi:</b> izhodisce postavljeno. "
                "Prilivi/odlivi bodo prikazani od naslednjega porocila naprej.</div>")
        return (html, "Onchain: izhodisce postavljeno (tokovi od jutri).")

    prevb = prev["balances"]

    # agregacija po sredstvu (asset)
    per_asset = {}   # cgid -> {"delta_native":, "usd":, "n":}
    movers = []      # veliki posamezni premiki
    for key, cur in current.items():
        if key not in prevb:
            continue
        chain = cur["chain"]
        cgid = CHAIN_TO_CGID.get(chain)
        price = prices.get(cgid)
        delta = cur["balance"] - prevb[key]
        usd = delta * price if price else None
        a = per_asset.setdefault(cgid, {"chain": chain, "native": 0.0, "usd": 0.0})
        a["native"] += delta
        if usd is not None:
            a["usd"] += usd
        if usd is not None and abs(usd) >= threshold_usd:
            movers.append((cur["exchange"], CHAIN_LABEL.get(chain, chain), delta, usd))

    if not per_asset:
        return ("", "Onchain: ni primerljivih naslovov.")

    rows = ""
    text_lines = ["Onchain borzni tokovi (cez noc):"]
    for cgid, a in sorted(per_asset.items(), key=lambda kv: -abs(kv[1]["usd"])):
        label = CHAIN_LABEL.get(a["chain"], a["chain"])
        if abs(a["usd"]) < 1:
            direction = "brez neto spremembe"
            color = "#888"
        elif a["usd"] > 0:
            direction = "priliv NA borze"
            color = "#127c2b"   # priliv = zeleno
        else:
            direction = "odliv Z borz"
            color = "#c0392b"   # odliv = rdece
        rows += (
            "<tr><td style='padding:8px 10px;font-weight:600'>{lab}</td>"
            "<td style='padding:8px 10px;text-align:right'>{nat:+.3f}</td>"
            "<td style='padding:8px 10px;text-align:right;color:{col};font-weight:600'>{usd}</td>"
            "<td style='padding:8px 10px;color:{col}'>{dir}</td></tr>"
        ).format(lab=label, nat=a["native"], col=color,
                 usd=_fmt_usd(a["usd"]), dir=direction)
        text_lines.append("  {}: {:+.3f} ({}) - {}".format(
            label, a["native"], _fmt_usd(a["usd"]), direction))

    movers_html = ""
    if movers:
        movers.sort(key=lambda m: -abs(m[3]))
        items = "".join(
            "<li>{ex} ({ch}): {nat:+.3f} &nbsp;{usd}</li>".format(
                ex=m[0], ch=m[1], nat=m[2], usd=_fmt_usd(m[3]))
            for m in movers[:6])
        movers_html = ("<div style='margin-top:8px;font-size:13px;color:#555'>"
                       "Veliki posamezni premiki:<ul style='margin:6px 0 0'>{}</ul></div>"
                       ).format(items)

    html = (
        "<div style='margin-top:16px'>"
        "<div style='font-size:13px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px'>"
        "Onchain: borzni tokovi cez noc</div>"
        "<table style='width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;font-size:14px'>"
        "<thead><tr style='background:#fafafa;color:#666;font-size:12px;text-transform:uppercase'>"
        "<th style='padding:10px;text-align:left'>Sredstvo</th>"
        "<th style='padding:10px;text-align:right'>Neto (nativno)</th>"
        "<th style='padding:10px;text-align:right'>Neto (USD)</th>"
        "<th style='padding:10px;text-align:left'>Smer</th></tr></thead>"
        "<tbody>{rows}</tbody></table>{movers}"
        "<p style='margin:8px 0 0;font-size:12px;color:#999'>"
        "Priliv na borze pogosto spremlja pritisk prodaje, odliv pogosto akumulacijo. "
        "Signal je delen - pokriva le naslove iz tvojega seznama.</p>"
        "</div>"
    ).format(rows=rows, movers=movers_html)

    return (html, "\n".join(text_lines))


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # samostojni test (potrebuje internet do explorerjev)
    demo_prices = {"bitcoin": 98000, "ethereum": 3400, "solana": 190}
    h, t = build_onchain_section(demo_prices)
    print(t)
