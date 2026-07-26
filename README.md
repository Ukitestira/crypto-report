# Jutranje crypto poročilo (email)

Vsako jutro po urniku pošlje email s pregledom tvojega portfelja: cene, spremembe 24h/7d,
skupna vrednost, nočna sprememba, tržni pregled in Fear & Greed indeks.

Brez strežnika, brezplačno (teče na GitHub Actions). Samo Python (standardna knjižnica, brez dodatnih paketov).

---

## Datoteke

- `config.json` – tvoji coini in količine (tukaj urejaš / dodajaš)
- `crypto_report.py` – glavna skripta
- `resolve_ids.py` – pomočnik za iskanje pravih CoinGecko id-jev
- `.github/workflows/daily-report.yml` – dnevni urnik

---

## Namestitev (enkratno, ~10 min)

### 1. Ustvari **zaseben** GitHub repozitorij
Pomembno: zaseben, ker vsebuje tvoj portfelj. Naloži vse te datoteke vanj
(ohrani mapo `.github/workflows/`).

### 2. Pripravi email pošiljanje (Gmail)
1. Vklopi 2-faktorsko avtentikacijo na Google računu.
2. Ustvari **App Password**: Google račun → Security → App passwords → generiraj geslo za "Mail".
   Dobiš 16-mestno geslo (brez presledkov).

(Če ne uporabljaš Gmaila: nastavi `SMTP_HOST` in `SMTP_PORT` kot secrets za svojega ponudnika.)

### 3. Vnesi skrivnosti v GitHub
V repozitoriju: **Settings → Secrets and variables → Actions → New repository secret**.
Dodaj:

| Ime | Vrednost |
|-----|----------|
| `EMAIL_USER` | tvoj.email@gmail.com |
| `EMAIL_APP_PASSWORD` | 16-mestno app password |
| `EMAIL_TO` | kam naj pride poročilo (lahko isti email; več naslovov loči z vejico) |
| `COINGECKO_API_KEY` | *(opcijsko)* Demo API ključ, če ga imaš – ni nujen |

### 4. Zakleni id-je za manj enolične tokene
Za KARRAT, BLACK, JITO, PUMP simboli niso enolični. Lokalno zaženi:

```bash
python resolve_ids.py
```

Izpiše kandidate z market-cap rankom. Izberi pravi in vpiši njegov `id` v `config.json`.
Posebej **JITO**: preveri, ali gre za `jito-governance-token` (JTO) ali `jito-staked-sol` (JitoSOL).

> Če id-ja ne vpišeš, ga skripta poišče sama in ti ga javi na dnu emaila – a za zanesljivost ga raje zakleni.

### 5. Vklopi in testiraj
1. V zavihku **Actions** omogoči workflowe (če GitHub vpraša).
2. Odpri "Jutranje crypto poročilo" → **Run workflow** (ročni zagon).
3. Preveri, ali email prispe in ali so cene pravilne.

---

## Kako dodam coin

Odpri `config.json` in dodaj vrstico v `holdings`:

```json
{"symbol": "LINK", "amount": 100, "id": "chainlink"}
```

`id` je CoinGecko API ID (na coin strani labela **API ID**). Če ga ne veš, daj `"id": null`
in ga skripta poišče sama (ter ti ga javi v emailu).

## Kako spremenim uro dostave

V `.github/workflows/daily-report.yml` uredi vrstico `cron`. **Čas je v UTC.**
Primeri (slovenski čas ≈ UTC+1 pozimi, UTC+2 poleti):

- `"0 6 * * *"` → ~07:00 (zima) / ~08:00 (poletje)
- `"0 5 * * *"` → ~06:00 / ~07:00

Ker je cron v UTC, se ob prehodu na poletni/zimski čas lokalna ura premakne za 1 h.

---

## Opomba
Poročilo je **informativno**, ne finančni nasvet. Podatki: CoinGecko, Alternative.me (Fear & Greed).
GitHub Actions urniki lahko včasih zamudijo nekaj minut – to je normalno.

---

## Onchain: borzni prilivi/odlivi (BTC, ETH, SOL)

Poročilo doda razdelek **"Borzni tokovi čez noč"**: spremlja saldo znanih borznih naslovov in
javi neto premik. Saldo gor = priliv na borzo (pogosto pritisk prodaje), saldo dol = odliv
(pogosto akumulacija).

**Datoteke:** `onchain_flows.py` (modul), `exchange_addresses.json` (naslovi), mapa `state/` (dnevni posnetki).

### Kako deluje
Vsak dan skripta prebere saldo naslovov, ga primerja z včerajšnjim posnetkom in shrani novega.
Posnetek se commita nazaj v repo (zato ima workflow `contents: write`). **Prvi zagon** postavi
izhodišče – prilivi/odlivi se pokažejo šele od drugega poročila naprej.

### Viri (brezplačni, brez ključa)
- BTC → mempool.space
- ETH → Blockscout *(opcijsko Etherscan, če dodaš `ETHERSCAN_API_KEY`)*
- SOL → Solana public RPC *(za večjo zanesljivost dodaj `SOLANA_RPC_URL`, npr. brezplačni Helius)*

### POMEMBNO: preveri naslove
Kakovost signala je odvisna od seznama v `exchange_addresses.json`. Priloženi so **slavni začetni
naslovi, ki jih moraš preveriti** na explorerju (labela borze), ker se lahko spremenijo. Dodajanje
naslova je ena vrstica:

```json
{"chain": "eth", "exchange": "Coinbase 10", "address": "0x....", "verify": true}
```

Ta DIY pristop je brezplačen in pokriva le naslove s tvojega seznama (delen signal).
Za popolno pokritost in atribucijo (kateri žep je čigav) služijo plačljivi servisi
(npr. Whale Alert) – to je smiselna kasnejša nadgradnja.

### Prag za velike posamezne premike
V `config.json` lahko dodaš `"onchain_threshold_usd": 250000` (privzeto). Premiki nad tem
zneskom se posebej izpišejo pod tabelo.

