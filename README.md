# 🏴‍☠️ AnzeigenPiraten

AnzeigenPiraten collects Kleinanzeigen listings into one shared feed. The scan
pipeline identifies the product in each listing so similar products can be
grouped later—for example, an iPhone 13, an iPhone 14 Pro Max, a PS5 console,
and a PS5 controller each get separate product identities.

**The classifier does not evaluate prices.** Asking prices remain visible in the
feed and their history is kept, but the model receives no price or market data.
A separate, stronger model can evaluate prices by product in a later step.

## How a scan works

1. Fetch the configured Kleinanzeigen searches.
2. Classify listings without a known product identity.
3. Keep the product identity, listing, asking price, and price history in
   `data/deals.json`.
4. Store asking-price observations by product key in `data/prices.json` and
   compare each listing with other listings for that same product.
5. Publish changed JSON files so the static site shows the updated feed.

Existing listing records are classified when they next appear in a scan. Use
`--force` to classify every fetched listing again.

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
session. The task runs while your Windows user is signed in, requires Ollama and
Git credentials to be available, and pushes updated feed/price JSON to `main`
for GitHub Pages to publish. Its log is
`%LOCALAPPDATA%\AnzeigenPiraten\local-scan.log`. The local runner skips a tick
if another scan is active or if the repository has uncommitted changes.

The scan updates `data/deals.json`, `data/meta.json`, `data/state.json`, and
`data/prices.json`. Product price comparisons are calculated from other
listings with the same product key. The page shows the observed median and
middle price range when at least three other listings are available; it does
not call that comparison an AI fair price.

## Configure searches

Edit `config/dealfinder.config.json`. Each entry under `searches` defines a
Kleinanzeigen search. `maxClassificationsPerRun` limits the number of listings
sent to the model in one run; uncategorized listings remain in the feed and are
eligible on a later scan.

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
and excludes that listing's own price from the comparison. It keeps up to
20,000 observations from the last 90 days. A future larger model can use these
product groups for deeper price evaluation.

## Project structure

* `scripts/scan.mjs` — crawl, classify, merge, and persist listings.
* `scripts/lib/products.mjs` — product-only model prompt and response handling.
* `scripts/lib/kleinanzeigen.mjs` — listing collection and normalization.
* `data/deals.json` — shared listing feed and product identities.
* `data/prices.json` — product-keyed asking-price observations and comparisons.
* `data/state.json` — IDs already observed by the scanner.
* `index.html`, `assets/` — static browser interface.

The site supports full-text search, search filters, sorting by date or asking
price, new-listing badges, and a listing detail view. It does not display deal
scores or model-generated fair prices.
