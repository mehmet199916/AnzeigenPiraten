# 🏴‍☠️ AnzeigenPiraten

AnzeigenPiraten collects Kleinanzeigen listings into one shared feed. The scan
pipeline identifies the product in each listing so similar products can be
grouped later—for example, an iPhone 13, an iPhone 14 Pro Max, a PS5 console,
and a PS5 controller each get separate product identities.

**The classifier does not evaluate prices.** Asking prices remain visible in the
feed and their history is kept, but the model receives no price or market data.
A separate, stronger model can evaluate prices by product in a later step.

## How a scan works

The website has an editable **Deine PLZ** field beside the radius selector.
Entering a valid German postal code applies a 50 km radius by default. The
radius and distance sorting then use approximate straight-line distances
between postal-code centres, rather than the scanner's original search centre.
Listings without a recognised postal code are excluded when a radius is active.
This filters the existing shared feed; changing the browser input does not run a
new scan or change `config/dealfinder.config.json`.

`data/postal-centres.json` is derived from the German GeoNames postal-code dump
by averaging places sharing a postal code. Source: https://download.geonames.org/export/zip/DE.zip
(downloaded 2026-10-10), CC BY 4.0; attribution: https://www.geonames.org/.
Regenerate after extracting DE.zip with
`node scripts/build-postal-data.mjs /path/to/DE.txt`.

1. Fetch the configured Kleinanzeigen searches.
2. Classify listings without a known product identity.
3. Keep the product identity, listing, asking price, and price history in
   `data/deals.json`.
4. Store asking-price observations by product key in `data/prices.json`,
   append every price change to the permanent per-listing price history, and
   compare each listing with other listings for that same product.
5. Publish changed JSON files so the static site shows the updated feed.

Recent stored listings are classified in capped batches, including listings
outside the latest crawl window. Use `--force` to classify every fetched listing
again.

## Run locally with Ollama

Install and start Ollama, then download the configured model once:

```bash
ollama pull qwen3:4b
```

Run a local scan from the `scripts/` directory:

```bash
node scan.mjs --local
```

The local classifier uses Ollama's native structured-output API. It sends the
listing title, description, search label, and listing attributes, but omits the
asking price. `--local` selects `qwen3:4b` and `http://127.0.0.1:11434`.

To classify every fetched listing again:

```bash
node scan.mjs --local --force
```

For automatic five-minute scans on the Windows machine running Ollama, run
`.\scripts\register-local-task.ps1` once from an elevated or normal PowerShell
session. The scan runs through a hidden Windows Script Host launcher, without
opening a terminal window. It runs while your Windows user is signed in,
requires Ollama and Git credentials to be available, and pushes updated
feed/price JSON to `main` for GitHub Pages to publish. Its log is
`%LOCALAPPDATA%\AnzeigenPiraten\local-scan.log`. The local runner skips a tick
if another scan is active or if the repository has uncommitted changes.

The scan updates `data/deals.json`, `data/meta.json`, `data/state.json`,
`data/prices.json`, and `data/product-prices.json`. The product prices file is the manual
product price catalog: it has one entry per product key and is never populated
from listing prices. Each scan adds newly identified product keys while
preserving prices you entered. Set `referencePrice` to a number in euros, or
leave it `null` until you know the price. For example:

```json
"apple-iphone-15-pro-128-gb": {
  "name": "Apple iPhone 15 Pro 128 GB",
  "category": "Smartphones",
  "referencePrice": 450,
  "updatedAt": null
}
```

Commit and push edits to this file so the scanner can pull them and the site can
publish the results. A listing below its product's reference price is marked
**Guter Preis**; one at the reference is marked accordingly, and one above it
shows the difference. When no manual price is set, the scanner falls back to
the average of the collected asking prices for that product and labels it with
its sample count in the feed. The separate `data/prices.json` remains the
history of observed asking prices: it powers the market median/range comparison
and holds the permanent per-listing price history the average is computed from.

## Configure searches

Edit `config/dealfinder.config.json`. Each entry under `searches` defines a
Kleinanzeigen search. `maxClassificationsPerRun` limits the number of listings
sent to the model in one run; uncategorized listings remain in the feed and are
eligible on a later scan.

### Standort und Umkreis

Mit dem oberen `location`-Block suchst du nur noch in deiner Nähe:

```json
"location": {
  "plz": "50667",
  "radius": "50"
}
```

* `plz` ist deine Postleitzahl (oder ein Ort). Der Scan löst sie zu Beginn über
  den offiziellen Vorschlags-Endpunkt von kleinanzeigen.de auf und hängt den
  Standort an alle Suchaufträge, die nicht selbst eine `locationId` gesetzt
  haben. Ist `plz` leer, gilt weiterhin die bundesweite Suche.
* `radius` ist der Umkreis in Kilometern. Erlaubt sind die von der Seite
  angebotenen Stufen `5`, `10`, `20`, `30`, `50`, `100`, `150`, `200`;
  andere Werte werden auf die nächstgelegene Stufe gerundet. Ein leerer
  String oder `0` bedeutet „ganzer Ort" ohne Umkreis.
* Wird die PLZ nicht gefunden, bricht der Scan mit einer Fehlermeldung ab,
  statt stillschweigend bundesweit zu suchen.
* Die Distanz jeder Anzeige (`distanceKm`) wird mitgeliefert: Die Karten und
  die Detailansicht zeigen die Entfernung, die Filterleiste kennt einen
  Umkreis-Filter und eine Sortierung nach Entfernung.
* Bereits gespeicherte Feed-Einträge außerhalb des Umkreises verlassen den
  Feed beim nächsten Scan (Preis- und Produktgeschichten in `data/prices.json`
  bleiben davon unberührt).

The classifier model and endpoint can also be configured with `AI_MODEL` and
`AI_BASE_URL`. For a non-local OpenAI-compatible endpoint, set `AI_API_KEY` (or
`OPENAI_API_KEY`).

## Listing product data

Each classified listing has a `product` object in `data/deals.json`:

```json
{
  "product": {
    "key": "apple-iphone-13-128-gb",
    "name": "Apple iPhone 13 128 GB",
    "category": "Smartphones",
    "variant": "Schwarz",
    "confidence": 0.94,
    "engine": "ai:qwen3:4b",
    "classifiedAt": "2026-10-01T12:00:00.000Z"
  }
}
```

`product.key` is a normalized version of the canonical model name and groups
listings in `data/prices.json`. Model and storage capacity belong in `name`;
color, condition, and included accessories belong in `variant`. If the model
cannot identify a product confidently, it returns `Unbekanntes Produkt` with
the key `unknown`.

`data/prices.json` stores asking-price observations by product and listing ID.
The scanner compares a listing against other observations for the same product
and excludes that listing's own price from the comparison. The comparison
window keeps up to 20,000 observations from the last 90 days. In addition,
every listing keeps a permanent price history under
`product.history[listingId]` that is only appended to when a price changes and
never overwritten; `product.stats.average` is recomputed from it on every scan
and serves as the automatic reference price. Set
`database.historyMaxPointsPerListing` above 0 to cap each listing's history
instead of keeping it forever. A future larger model can use these product
groups for deeper price evaluation.

## Project structure

* `scripts/scan.mjs` — crawl, classify, merge, and persist listings.
* `scripts/lib/products.mjs` — product-only model prompt and response handling.
* `scripts/lib/kleinanzeigen.mjs` — listing collection and normalization.
* `data/deals.json` — shared listing feed and product identities.
* `data/prices.json` — product-keyed asking-price observations, permanent price history, and comparisons.
* `data/state.json` — IDs already observed by the scanner.
* `index.html`, `assets/` — static browser interface.

The site supports full-text search, search filters, sorting by date or asking
price, new-listing badges, and a listing detail view. It does not display deal
scores or model-generated fair prices.
