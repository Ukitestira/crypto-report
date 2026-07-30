"""
ai_synthesis.py

Opcijski AI modul: doda "AI Povzetek" razdelek na vrh dnevnega crypto
porocila. Namesto da samo ponovi surove podatke, ki so ze v tabeli spodaj,
poklice Claude, naj oznaci, kaj je DEJANSKO nenavadno in zakaj je to
pomembno - podobno kot onchain_flows.py modul, ta modul je opcijski in
porocilo tece naprej tudi ce klic spodleti ali ni API kljuca.

Setup:
  1. GitHub secret: ANTHROPIC_API_KEY (ze dodano)
  2. V workflow yaml, env bloku koraka "Poslji porocilo", dodaj:
       ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  3. V crypto_report.py: glej integracijska navodila v chatu.
"""

import os
import json
import urllib.request
import urllib.error

API_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-5"
ANTHROPIC_VERSION = "2023-06-01"

SYSTEM_PROMPT = """Si jedrnat analitik crypto portfelja, ki pise vrh
dnevnega email porocila za tehnicno podkovanega imetnika. Dobis surove
podatke o portfelju (cene, 24h/7d spremembe, vrednosti), trzni pregled
(skupna trzna kapitalizacija, BTC dominanca), Fear & Greed indeks, in
povzetek onchain borznih tokov za BTC/ETH/SOL.

Tvoja naloga:
- Izpostavi samo tisto, kar je DEJANSKO nenavadno danes (velik premik,
  neobicajen volumen, borzni tok, ki nakazuje kopicenje/razprodajo,
  koncentracijsko ali korelacijsko tveganje v portfelju). NE ponavljaj
  rutinskih, majhnih ali pricakovanih premikov.
- Ce ni nic nenavadnega, to na kratko povej namesto da izumljas pomen.
- Napisi 3-5 kratkih tock. Vsaka tocka naj pove KAJ opazis IN ZAKAJ je
  pomembno (npr. "SOL -9% ob 3x povprecnega volumna - najvecji dnevni
  premik v zadnjih 30 dneh").
- Ce onchain podatki nakazujejo vzorec kopicenja ali distribucije, to
  eksplicitno imenuj.
- Konca z eno vrstico o portfeljskem tveganju, ce je relevantno
  (koncentracija, korelacija, osamelec glede na ostale).
- Navaden tekst, brez markdown naslovov. En kratek zakljucni stavek, da
  to ni financni nasvet - ne vec.
- Ne ponavljaj tocnih stevilk, ki so ze v tabeli spodaj, razen ce je to
  nujno za tocko, ki jo delas.
- Pisi v slovenscini.
"""


def _build_prompt(rows, total, port_ch24, glob, fng, onchain_text):
    lines = ["PORTFELJ (kolicina, cena, 24h/7d sprememba, vrednost):"]
    for r in rows:
        lines.append(
            "- {sym}: kolicina={amt}, cena=${price:.4f}, 24h={ch24}%, "
            "7d={ch7d}%, vrednost=${val:.2f}".format(
                sym=r["symbol"], amt=r["amount"], price=r["price"],
                ch24=r.get("ch24"), ch7d=r.get("ch7d"), val=r["value"],
            )
        )
    lines.append("\nSKUPNA VREDNOST PORTFELJA: ${:.2f} ({:+.2f}% cez noc)".format(
        total, port_ch24 if port_ch24 is not None else 0.0))

    if glob:
        lines.append(
            "\nTRG: skupna trzna kapitalizacija=${:.0f}, sprememba 24h={}%, "
            "BTC dominanca={}%, 24h volumen=${:.0f}".format(
                glob.get("total_mcap") or 0, glob.get("mcap_24h"),
                glob.get("btc_dom"), glob.get("total_vol") or 0,
            )
        )

    if fng:
        lines.append("\nFEAR & GREED INDEKS: {}/100 ({})".format(fng["value"], fng["label"]))

    if onchain_text:
        lines.append("\nONCHAIN BORZNI TOKOVI:\n" + onchain_text)

    return "\n".join(lines)


def generate_ai_briefing(rows, total, port_ch24, glob=None, fng=None, onchain_text=""):
    """
    Vrne kratek AI povzetek (navaden tekst) ali None, ce ni API kljuca.
    Ob napaki vrne kratek opisni string namesto da vrze exception -
    porocilo mora vedno uspesno tici naprej.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None

    prompt = _build_prompt(rows, total, port_ch24, glob, fng, onchain_text)

    payload = {
        "model": MODEL,
        "max_tokens": 600,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": prompt}],
    }

    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text_blocks = [
            block["text"] for block in data.get("content", [])
            if block.get("type") == "text"
        ]
        return "\n".join(text_blocks).strip() or None
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = "(telesa napake ni bilo mogoce prebrati)"
        print("  ! AI API napaka, telo odgovora:", body)
        return "(AI povzetek ni uspel: HTTP {} - {} - {})".format(e.code, e.reason, body)
    except Exception as e:
        return "(AI povzetek ni uspel: {})".format(e)
