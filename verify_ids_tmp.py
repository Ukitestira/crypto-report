# ZACASNO: preveri CoinGecko id-je za posodobitev portfelja (izbrisano pred zdruzitvijo).
import json, os, time, urllib.parse, urllib.request
KEY = os.environ.get("COINGECKO_API_KEY", "")
def get(path, params):
    if KEY: params = dict(params, x_cg_demo_api_key=KEY)
    url = "https://api.coingecko.com/api/v3" + path + "?" + urllib.parse.urlencode(params)
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "verify/1.0"}), timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            print("  retry", path, e); time.sleep(15)
    return None
# id -> cena s posnetka
EXPECT = {
 "usd-coin": 0.9999, "bitcoin": 82990.61, "near": 5.3782, "ethereum": 2503.73, "solana": 109.97, "tether": 0.9991,
 "ethena": 0.2213, "avalanche-2": None, "arbitrum": 0.1857, "blackhole": 0.005262, "jupiter-exchange-solana": 0.3671,
 "ondo-finance": 0.493, "hyperliquid": 85.32, "the-open-network": 1.4582, "aioz-network": 0.1166, "beam-2": 0.002619,
 "aster-2": 0.7101, "zcash": 1228.12, "pyth-network": 0.07905, "cardano": 0.2549, "superfarm": 0.2226,
 "pump-fun": 0.005573, "uniswap": 7.5714, "echelon-prime": 0.2309, "lido-dao": 0.434, "crypto-com-chain": 0.06125,
 "origintrail": 0.4172, "apple-xstock": 336.78, "sandisk-xstock": 1592.87, "pendle": 2.1529, "virtual-protocol": 0.7343,
 "aurora-near": 0.0605, "wrapped-bitcoin": 82839.53, "aptos": 0.8427, "hey-anon": 0.357, "swarm-network-2": 0.01326,
 "zebec-network": 0.002287, "karrat": 0.002931, "stargate-finance": 0.1733, "akash-network": 0.7309,
 "cetus-protocol": 0.02703, "derive": 0.5528, "arrow-2": 0.3153,
}
rows = get("/coins/markets", {"vs_currency": "usd", "ids": ",".join(EXPECT), "per_page": 250}) or []
got = {r["id"]: r for r in rows}
print("=== PREVERJANJE ID ===")
for cid, exp in EXPECT.items():
    r = got.get(cid)
    if not r:
        print("MANJKA  ", cid); continue
    p = r["current_price"]; ok = "" if exp is None else ("OK " if p and abs(p / exp - 1) < 0.25 else "RAZLIKA")
    print("%-8s %-26s %-8s %-28s cena=%s posnetek=%s" % (ok, cid, r["symbol"], r["name"][:28], p, exp))
print("=== ISKANJE ===")
SEARCH = {"BP": 1.2054, "LIT": 3.6116, "CC": 0.1192, "PONS": 0.3684, "SNDK": 1592.87, "RSNDK": 1592.87, "GRAM": 1.4582,
          "ASTER": 0.7101, "DRV": 0.5528, "ANON": 0.357, "SUPER": 0.2226, "BEAM": 0.002619, "TON": 1.4582, "LIGHTER": 3.6116,
          "BACKPACK": 1.2054, "CANTON": 0.1192}
for q, exp in SEARCH.items():
    time.sleep(3)
    d = get("/search", {"query": q}) or {}
    coins = (d.get("coins") or [])[:8]
    ids = [c["id"] for c in coins]
    time.sleep(3)
    pr = {r["id"]: r["current_price"] for r in (get("/coins/markets", {"vs_currency": "usd", "ids": ",".join(ids)}) or [])} if ids else {}
    print("--", q, "(posnetek", exp, ")")
    for c in coins:
        p = pr.get(c["id"]); m = " <== CENA SE UJEMA" if p and abs(p / exp - 1) < 0.25 else ""
        print("   %-34s %-10s %-30s rank=%s cena=%s%s" % (c["id"], c["symbol"], c["name"][:30], c.get("market_cap_rank"), p, m))
