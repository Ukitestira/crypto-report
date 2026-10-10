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
for q in ["TRUTH", "Swarm Network"]:
    time.sleep(3)
    coins = ((get("/search", {"query": q}) or {}).get("coins") or [])[:8]
    time.sleep(3)
    ids = [c["id"] for c in coins]
    pr = {r["id"]: r["current_price"] for r in (get("/coins/markets", {"vs_currency": "usd", "ids": ",".join(ids)}) or [])} if ids else {}
    print("--", q, "(posnetek 0.01326)")
    for c in coins:
        p = pr.get(c["id"]); m = " <== CENA SE UJEMA" if p and abs(p / 0.01326 - 1) < 0.25 else ""
        print("   %-34s %-10s %-30s rank=%s cena=%s%s" % (c["id"], c["symbol"], c["name"][:30], c.get("market_cap_rank"), p, m))
