# 🏴‍☠️ AnzeigenPiraten

Ein **Kleinanzeigen-Deal-Finder als GitHub-Pages-Seite**, der neue Anzeigen
automatisch einsammelt und **per KI bewerten** lässt.

Die Seite selbst ist komplett statisch (kein Build, kein Framework, keine
Abhängigkeiten). Das „Backend“ ist ein **geplanter GitHub-Actions-Workflow**, der
regelmäßig Kleinanzeigen durchsucht, neue Anzeigen erkennt, sie von einer KI
bewerten lässt und die Ergebnisse als JSON zurück ins Repository committet.
GitHub Pages baut die Seite danach automatisch neu.

```
GitHub Actions (Cron, alle 30 Min)
        │
        ├─ 1. Kleinanzeigen-Suchen crawlen      scripts/lib/kleinanzeigen.mjs
        ├─ 2. neue / preisgeänderte Anzeigen    scripts/scan.mjs
        ├─ 3. KI-Bewertung (Score, Fairpreis)   scripts/lib/evaluate.mjs
        └─ 4. data/*.json committen ─────────► GitHub Pages
                                                     │
                                        index.html + assets/app.js
                                        liest data/deals.json
```

---

## Was die Seite kann

* **Automatischer Scan** aller konfigurierten Suchaufträge (Cron: alle 30 Minuten).
* **KI-Bewertung** jeder neuen Anzeige: Deal-Score (0–100), geschätzter fairer
  Marktwert, Ersparnis in Prozent, Kurzbegründung und Warnsignale.
* **Volltextsuche**, Kategorie-Filter, Mindest-Score-Slider und Sortierung
  (Score, Ersparnis, Preis, Neueste).
* **„Neu seit deinem letzten Besuch“** – via `localStorage`, ohne Login.
* **Detailansicht** im Modal mit Beschreibung, Anzeigen-Attributen,
  Preisverlauf und Link zur Original-Anzeige.
* **Ohne API-Key voll funktionsfähig**: dann übernimmt eine deterministische
  Heuristik (Preis vs. Median des Suchtreffers + Warn-/Bonus-Keywords).

---

## Projektstruktur

```
├── index.html                     # Frontend (GitHub Pages)
├── assets/
│   ├── app.js                     # Filter, Rendering, Modal – Vanilla JS
│   └── styles.css                 # Dark Theme
├── data/                          # vom Scanner erzeugt (committet!)
│   ├── deals.json                 #   der Deal-Feed, den das Frontend liest
│   ├── meta.json                  #   Lauf-Infos für das Status-Panel
│   └── state.json                 #   Dedup-Zwischenspeicher („was ist neu?“)
├── config/
│   └── dealfinder.config.json     # Suche, KI, Schwellen, Limits
├── scripts/                       # Scanner (Node ≥ 20, keine Dependencies)
│   ├── scan.mjs                   #   Orchestrierung (Einstiegspunkt)
│   ├── lib/
│   │   ├── config.mjs             #   Konfiguration + ENV-Overrides
│   │   ├── kleinanzeigen.mjs      #   Suche bauen, Seiten holen, normalisieren
│   │   ├── parse.mjs              #   HTML/JSON-Parsing (Astro-Islands + klassisch)
│   │   ├── evaluate.mjs           #   KI-Bewertung + Heuristik-Fallback
│   │   ├── store.mjs              #   JSON lesen/schreiben (atomar)
│   │   └── util.mjs               #   fetch-Retry, Median, Chunking, …
│   └── test/                      # `node --test` – 20 Tests, keine Dependencies
└── .github/workflows/scan.yml     # Cron-Scan + Commit
```

---

## Setup in 4 Schritten

### 1. Repository veröffentlichen

```bash
git init -b main
git add .
git commit -m "AnzeigenPiraten: Kleinanzeigen-Deal-Finder"
git remote add origin https://github.com/<DEIN-USER>/<DEIN-REPO>.git
git push -u origin main
```

### 2. GitHub Pages aktivieren

**Settings → Pages → Source: „Deploy from a branch“ → Branch: `main` / `/ (root)` → Save**

Die Seite ist danach unter `https://<DEIN-USER>.github.io/<DEIN-REPO>/`
erreichbar. `index.html` liegt bewusst im Wurzelverzeichnis, damit die
Ordner-struktur ohne weiteren Deployment-Workflow funktioniert.

### 3. KI aktivieren (optional, aber empfohlen)

Ohne Schlüssel läuft die Seite mit der Heuristik. Für echte KI-Bewertung:

**Settings → Secrets and variables → Actions → New repository secret**

| Typ    | Name              | Beispielwert       | Bedeutung                                   |
| ------ | ----------------- | ------------------ | ------------------------------------------- |
| Secret | `OPENAI_API_KEY`  | `sk-…`             | API-Key (OpenAI-kompatibel)                  |
| Variable | `AI_MODEL`      | `gpt-4o-mini`      | Modellname                                   |
| Variable | `AI_BASE_URL`   | `https://api.openai.com/v1` | Auch OpenRouter/Groq/Azure/Ollama möglich |

Beispiele für kompatible Endpunkte:

* OpenAI: `https://api.openai.com/v1` + `gpt-4o-mini`
* OpenRouter: `https://openrouter.ai/api/v1` + `openai/gpt-4o-mini`
* Groq: `https://api.groq.com/openai/v1` + `llama-3.3-70b-versatile`
* Ollama (lokal, nur mit eigenem Runner): `http://localhost:11434/v1` + `llama3.1`

### 4. Ersten Scan starten

**Actions → „AnzeigenPiraten Scan“ → Run workflow**

Optional `force` aktivieren, um alle gefundenen Anzeigen neu zu bewerten.
Danach läuft der Scan automatisch alle 30 Minuten.

---

## Suche konfigurieren

Alles Wichtige steht in [`config/dealfinder.config.json`](config/dealfinder.config.json):

```jsonc
{
  "searches": [
    {
      "id": "ebike",              // stabile ID (erscheint als Kategorie-Filter)
      "label": "E-Bikes",         // Anzeigename im Frontend
      "keywords": "e-bike",       // Suchbegriff
      "categoryId": "",           // optional: Kleinanzeigen-Kategorie-ID
      "locationId": "",           // optional: PLZ/Orts-ID (leer = deutschlandweit)
      "radius": "",               // optional: "10"|"20"|"50"|"100"|"200" km
      "minPrice": "150",
      "maxPrice": "2500",
      "adType": "OFFER",          // OFFER = Angebote, WANTED = Gesuche
      "posterType": "",           // PRIVATE | COMMERCIAL | leer
      "maxPages": 1               // 1–5 Seiten pro Suche
    }
  ],
  "ai": {
    "enabled": true,
    "batchSize": 8,               // Anzeigen pro KI-Anfrage
    "maxEvaluationsPerRun": 80    // Kostenbremse pro Lauf
  },
  "scoring": {
    "minScoreToKeep": 0,          // z. B. 55 → nur gute Deals speichern
    "recalculateOnPriceChange": true
  },
  "output": {
    "maxDeals": 600,              // Größe des Feeds
    "maxAgeHours": 336            // Anzeigen nach 14 Tagen nicht mehr zeigen
  },
  "http": {
    "requestDelayMs": 1200,       // Pause zwischen Requests (höflich bleiben!)
    "enrichDetails": false        // true = zusätzlich jede Detailseite laden
  }
}
```

**Kategorie- und Orts-IDs finden:** auf kleinanzeigen.de die gewünschte Suche
im Browser zusammenklicken und in der Adresszeile ablesen – `c216` ist z. B. die
Kategorie 216, `l3331` die Orts-ID 3331. Diese Zahlen in `categoryId` bzw.
`locationId` eintragen.

---

## Lokal ausführen

Es sind **keine Abhängigkeiten** zu installieren:

```bash
# Tests
cd scripts && node --test

# Scan (schreibt nach ../data)
OPENAI_API_KEY=sk-… node scan.mjs          # macOS / Linux
$env:OPENAI_API_KEY="sk-…"; node scan.mjs  # PowerShell

# nur einen bestimmten Suchauftrag testen: config temporär reduzieren
```

Andere Konfigurationsdatei verwenden:

```bash
DEALFINDER_CONFIG=../meine-config.json node scan.mjs
```

Lokalen Vorschaubetrieb:

```bash
python -m http.server 8080     # im Projektwurzelverzeichnis
# → http://localhost:8080
```

---

## Wie die KI-Bewertung funktioniert

1. Der Scanner ermittelt pro Suchauftrag Marktstatistiken
   (Median, 25 %/75 %-Quantil, Min/Max, Anzahl) über **alle** bekannten Anzeigen.
2. Pro Batch (Standard: 8 Anzeigen) geht ein strukturierter Prompt an das Modell:
   Titel, Preis, Beschreibung, Ort, Suchbegriff und die Marktstatistik.
3. Das Modell antwortet ausschließlich mit JSON
   (`response_format: json_object`):

   ```json
   {
     "evaluations": [
       {
         "index": 0,
         "dealScore": 88,
         "verdict": "top",
         "fairPrice": 820,
         "reasoning": "Deutlich unter dem üblichen Marktpreis, Rechnung vorhanden.",
         "redFlags": []
       }
     ]
   }
   ```

4. Schlägt ein Batch fehl (Rate-Limit, Timeout, ungültiges JSON), fällt der
   Scanner für diesen Batch automatisch auf die Heuristik zurück – ein Lauf
   bricht dadurch nie ab.

### Heuristik-Fallback (ohne API-Key)

| Faktor | Wirkung |
| --- | --- |
| Preis / Median | ≤ 0,35 → 97 Punkte … ≥ 1,6 → 20 Punkte |
| „defekt“, „Bastler“, „Ersatzteil“, … | −12 Punkte pro Treffer (max. −30) |
| „Originalverpackt“, „Garantie“, „Rechnung“, … | +6 Punkte pro Treffer (max. +18) |
| „Zu verschenken“ | 96 Punkte |

Score ⇒ Verdikt: **≥ 85 Top-Deal · ≥ 70 Guter Deal · ≥ 50 Marktüblich · < 50 Zu teuer**

---

## Datenformat (`data/deals.json`)

```jsonc
{
  "generatedAt": "2026-01-01T12:00:00.000Z",
  "engine": "ai:gpt-4o-mini",
  "count": 1,
  "queries": [{ "id": "ebike", "label": "E-Bikes", "count": 12, "medianPrice": 1290 }],
  "market": { "ebike": { "count": 40, "median": 1290, "p25": 900, "p75": 1800 } },
  "deals": [
    {
      "id": "3001234567",
      "title": "Cube Reaction Hybrid Pro 500",
      "price": 1050,
      "priceRaw": "1.050 € VB",
      "location": "50667 Köln (12 km)",
      "postedAt": "2026-01-01T09:30:00.000Z",
      "image": "https://img.kleinanzeigen.de/…",
      "url": "https://www.kleinanzeigen.de/s-anzeige/3001234567",
      "queryId": "ebike",
      "queryLabel": "E-Bikes",
      "firstSeenAt": "2026-01-01T10:00:00.000Z",
      "ai": {
        "dealScore": 88,
        "verdict": "top",
        "fairPrice": 1290,
        "savingsPct": 19,
        "reasoning": "…",
        "redFlags": [],
        "engine": "ai:gpt-4o-mini"
      }
    }
  ]
}
```

---

## Kosten & Rate-Limits

* Standardmäßig läuft der Scan **alle 30 Minuten** und bewertet höchstens
  `maxEvaluationsPerRun` Anzeigen pro Lauf – nur neue bzw. preisgeänderte.
  Nach dem ersten Befüllen sind die Läufe dadurch sehr günstig.
* 8 Anzeigen pro Anfrage mit kurzen Beschreibungen kosten mit `gpt-4o-mini`
  typischerweise Bruchteile eines Cents pro Batch.
* `http.requestDelayMs` bewusst nicht zu klein stellen. Der Scanner sendet eine
  normale Browser-User-Agent-Zeile und einen Wiederholungs-Backoff.
* Bei vielen Suchen: `maxEvaluationsPerRun` senken oder den Cron auf
  `0 * * * *` (stündlich) stellen.

---

## Fehlerbehebung

| Problem | Lösung |
| --- | --- |
| Seite bleibt leer / „Daten konnten nicht geladen werden“ | Workflow einmal manuell starten (**Actions → Run workflow**). |
| Seite aktualisiert sich nach dem Scan nicht | **Settings → Pages** prüfen (Branch `main`, Ordner `/ root`). Wird der Push durch Branch Protection blockiert, in **Settings → Actions → General → Workflow permissions** „Read and write permissions“ setzen. |
| `OPENAI_API_KEY` wird ignoriert | Key als **Secret** anlegen; in `data/meta.json` prüfen, ob `"aiUsed": true` steht. |
| Alle Läufe zeigen `"engine": "heuristic"` | Kein Key gesetzt oder Modell/Base-URL falsch → `meta.errors` ansehen. |
| Keine Anzeigen gefunden | Keywords/Kategorie-IDs prüfen; ggf. `maxPages` erhöhen. |
| Zu viele Anzeigen / hohe Kosten | `maxEvaluationsPerRun` senken, `minScoreToKeep` erhöhen, `maxPages` auf `1`. |

### Falls GitHub Pages trotz Commit nicht neu baut

Commits, die mit dem eingebauten `GITHUB_TOKEN` gepusht werden, lösen
grundsätzlich keine *Workflow*-Ketten aus (Pages-Builds vom Branch sind davon
nicht betroffen). Sollte deine Pages-Konfiguration dennoch nicht reagieren,
ersetze das Secret im Checkout-Schritt durch ein Personal Access Token:

```yaml
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.PAGES_PUSH_TOKEN }}   # PAT mit "repo"-Scope
```

---

## Rechtlicher Hinweis

Dieses Projekt ist ein technisches Beispiel und steht in **keiner Verbindung**
zu Kleinanzeigen. Es liest öffentlich zugängliche Suchergebnisseiten aus.
Bitte beachte die Nutzungsbedingungen von kleinanzeigen.de, halte die
Anfragefrequenz niedrig (`http.requestDelayMs`) und nutze das Projekt nur für
den privaten Gebrauch. Alle KI-Bewertungen sind Schätzungen ohne Gewähr.

## Lizenz

[MIT](LICENSE)