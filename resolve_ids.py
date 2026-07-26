#!/usr/bin/env python3
"""
Pomocnik: za vsak simbol iz config.json izpise kandidate za CoinGecko API ID.
Zazeni lokalno enkrat, izberi pravi id in ga vpisi v config.json (polje "id").

Uporaba:
    python resolve_ids.py
"""

import os
import json
import urllib.parse
import urllib.request

CG_BASE = "https://api.coingecko.com/api/v3"
CONFIG_PATH = os.environ.get("CONFIG_PATH", "config.json")
API_KEY = os.environ.get("COINGECKO_API_KEY", "")


def cg_get(path, params):
    if API_KEY:
        params["x_cg_demo_api_key"] = API_KEY
    url = CG_BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "resolve-ids/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)

    for h in cfg.get("holdings", []):
        sym = h["symbol"]
        cur = h.get("id")
        print("\n=== {} === (trenutni id: {})".format(sym, cur or "—"))
        try:
            coins = cg_get("/search", {"query": sym}).get("coins", [])
        except Exception as e:
            print("  napaka:", e)
            continue
        exact = [c for c in coins if (c.get("symbol") or "").lower() == sym.lower()]
        pool = (exact or coins)[:8]
        if not pool:
            print("  ni zadetkov")
            continue
        for c in pool:
            rank = c.get("market_cap_rank")
            print("  id={:<28} simbol={:<8} ime={:<24} rank={}".format(
                c.get("id", "?"), (c.get("symbol") or "").upper(),
                c.get("name", ""), rank if rank is not None else "-"))
        print("  -> najverjetneje: {}".format(pool[0].get("id")))


if __name__ == "__main__":
    main()
