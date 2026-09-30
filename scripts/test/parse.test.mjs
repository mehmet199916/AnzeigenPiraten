import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeEntities,
  parseDetailPage,
  parsePostedAt,
  parsePrice,
  parseSearchResults,
  readAttribute,
  scrubPersonalData,
  stripTags,
  unwrapAstro,
  upscaleImageUrl,
} from '../lib/parse.mjs';

/**
 * Builds a realistic Astro island tag the way kleinanzeigen.de renders it:
 * props are Astro-serialised as nested `[typeIndex, value]` tuples and the
 * attribute value is HTML-escaped.
 */
function astroIslandHtml(adObjects) {
  const resultAds = [0, adObjects.map((ad) => [0, enc(ad)] )];
  const props = { resultAds };
  const json = JSON.stringify(props);
  return `<astro-island uid="1" props="${json.replace(/"/g, '&quot;')}"></astro-island>`;
}

/** Wraps every field of an object in the Astro `[0, value]` tuple form. */
function enc(value) {
  if (Array.isArray(value)) return [0, value.map(enc)];
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) out[key] = enc(nested);
    return out;
  }
  return [0, value];
}

test('decodeEntities decodes named, decimal and hex entities in one pass', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&quot;quoted&quot;'), '"quoted"');
  assert.equal(decodeEntities('&#8364;'), '€');
  assert.equal(decodeEntities('&#x20AC;'), '€');
  assert.equal(decodeEntities('&amp;quot;'), '&quot;', 'must not double-decode');
});

test('stripTags removes markup and collapses whitespace', () => {
  assert.equal(stripTags('<p>Hallo&nbsp;<b>Welt</b></p>'), 'Hallo Welt');
  assert.equal(stripTags('Zeile1<br>Zeile2'), 'Zeile1 Zeile2');
  assert.equal(stripTags('<script>evil()</script>ok'), 'ok');
});

test('stripTags keeps line breaks when asked to', () => {
  assert.equal(
    stripTags('<p>Zeile1<br>Zeile2</p><p>Zeile3</p>', { preserveLineBreaks: true }),
    'Zeile1\nZeile2\nZeile3',
  );
});

test('readAttribute supports double and single quotes', () => {
  assert.equal(readAttribute('<div data-adid="123">', 'data-adid'), '123');
  assert.equal(readAttribute("<div data-adid='456'>", 'data-adid'), '456');
  assert.equal(readAttribute('<div>', 'data-adid'), null);
});

test('unwrapAstro collapses nested tuple encoding', () => {
  const wrapped = { resultAds: [0, [[0, { id: [0, '42'], tags: [0, [[0, 'a']]] }]]] };
  assert.deepEqual(unwrapAstro(wrapped), { resultAds: [{ id: '42', tags: ['a'] }] });
});

test('upscaleImageUrl switches to the largest CDN rule', () => {
  assert.equal(
    upscaleImageUrl('https://img.kleinanzeigen.de/api/v1/prod-ads/images/x?rule=$_2.JPG'),
    'https://img.kleinanzeigen.de/api/v1/prod-ads/images/x?rule=$_57.JPG',
  );
  assert.equal(upscaleImageUrl('https://example.com/a.png'), 'https://example.com/a.png');
});

test('parseSearchResults reads the modern astro-island payload', () => {
  const html = astroIslandHtml([
    {
      id: '1234567890',
      title: 'Apple iPhone 13 128GB',
      description: 'Neuwertig, mit Rechnung',
      price: '450 € VB',
      locationName: '10115 Berlin',
      parentLocationName: 'Mitte',
      distanceInKilometers: 12,
      sortingDate: '2025-09-30T10:00:00.000Z',
      imageList: [{ adTableThumbnailPrioUrl: 'https://img.kleinanzeigen.de/api/v1/prod-ads/images/abc?rule=$_2.JPG' }],
    },
    {
      id: '999',
      title: 'iPhone 12 defekt',
      description: 'Display kaputt',
      price: 'Zu verschenken',
      locationName: '50667 Köln',
      sortingDate: 'Heute, 06:24',
    },
  ]);

  const listings = parseSearchResults(html);
  assert.equal(listings.length, 2);

  const [first, second] = listings;
  assert.equal(first.id, '1234567890');
  assert.equal(first.title, 'Apple iPhone 13 128GB');
  assert.equal(first.priceRaw, '450 € VB');
  assert.equal(first.location, '10115 Berlin Mitte (12 km)');
  assert.equal(first.url, 'https://www.kleinanzeigen.de/s-anzeige/1234567890');
  assert.equal(first.image, 'https://img.kleinanzeigen.de/api/v1/prod-ads/images/abc?rule=$_2.JPG');
  assert.equal(first.postedRaw, '2025-09-30T10:00:00.000Z');

  assert.equal(second.id, '999');
  assert.equal(second.distanceKm, null);
  assert.equal(second.image, '');
});

test('parseSearchResults falls back to classic article markup', () => {
  const html = `
    <article class="aditem" data-adid="314159">
      <div class="aditem-main--top--left"> 50667 Köln&nbsp;</div>
      <div class="aditem-main--top--right">Heute, 08:15</div>
      <div class="aditem-main--middle">
        <h2 class="text-module-begin"><a class="ellipsis" href="/s-anzeige/kamera/314159">Sony A7 III</a></h2>
        <p class="aditem-main--middle--description">Sehr guter Zustand, wenig genutzt</p>
        <p class="aditem-main--middle--price-shipping--price">1.250 €</p>
      </div>
      <img src="https://img.kleinanzeigen.de/api/v1/prod-ads/images/sony?rule=$_2.JPG" alt="">
    </article>`;

  const listings = parseSearchResults(html);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].id, '314159');
  assert.equal(listings[0].title, 'Sony A7 III');
  assert.equal(listings[0].priceRaw, '1.250 €');
  assert.equal(listings[0].location, '50667 Köln');
  assert.equal(listings[0].url, 'https://www.kleinanzeigen.de/s-anzeige/kamera/314159');
});

test('parseSearchResults ignores empty and non-listing markup', () => {
  assert.deepEqual(parseSearchResults(''), []);
  assert.deepEqual(parseSearchResults('<html><body>Keine Treffer</body></html>'), []);
});

test('parsePrice handles German formats, negotiable and free listings', () => {
  assert.deepEqual(parsePrice('450 € VB'), {
    text: '450 € VB', amount: 450, free: false, negotiable: true, trade: false,
  });
  assert.equal(parsePrice('1.234 €').amount, 1234);
  assert.equal(parsePrice('1.234,56 €').amount, 1234.56);
  assert.equal(parsePrice('50,50 €').amount, 50.5);
  assert.equal(parsePrice('€ 89').amount, 89);

  const free = parsePrice('Zu verschenken');
  assert.equal(free.amount, 0);
  assert.equal(free.free, true);

  const trade = parsePrice('Tausch möglich');
  assert.equal(trade.amount, null);
  assert.equal(trade.trade, true);

  assert.equal(parsePrice('').amount, null);
  assert.equal(parsePrice('Preis auf Anfrage').amount, null);
});

test('parsePostedAt understands relative and absolute German dates', () => {
  const reference = new Date('2025-09-30T12:00:00.000Z');

  assert.equal(
    parsePostedAt('2025-09-29T08:00:00.000Z', reference),
    '2025-09-29T08:00:00.000Z',
  );

  const today = new Date(parsePostedAt('Heute, 06:24', reference));
  assert.equal(today.getHours(), 6);
  assert.equal(today.getMinutes(), 24);

  const yesterday = new Date(parsePostedAt('Gestern, 23:38', reference));
  assert.equal(yesterday.getHours(), 23);
  assert.equal(yesterday.getDate(), new Date(reference.getTime() - 86400000).getDate());

  assert.equal(parsePostedAt('05.09.2025', reference), '2025-09-05T12:00:00.000Z');
  assert.equal(parsePostedAt('05.09.25', reference), '2025-09-05T12:00:00.000Z');
  assert.equal(parsePostedAt('', reference), null);
});

test('parseDetailPage extracts the JSON-LD Product offering', () => {
  const html = `
    <script type="application/ld+json">
      {"@type":"Product","name":"Sony A7 III","description":"Top Zustand",
       "offers":{"price":"1250","priceCurrency":"EUR"},
       "image":"https://img.kleinanzeigen.de/x?rule=$_57.JPG"}
    </script>`;

  const detail = parseDetailPage(html);
  assert.equal(detail.title, 'Sony A7 III');
  assert.equal(detail.priceRaw, '1250');
  assert.equal(detail.currency, 'EUR');
  assert.equal(parseDetailPage('<html>nothing</html>'), null);
});

test('scrubPersonalData removes contact details but keeps normal text and prices', () => {
  assert.equal(
    scrubPersonalData('Kontakt: max.mustermann@example.com'),
    'Kontakt: [E-Mail entfernt]',
  );
  assert.equal(
    scrubPersonalData('Ruf an: 0171 1234567 oder 030/12345678'),
    'Ruf an: [Telefonnummer entfernt] oder [Telefonnummer entfernt]',
  );
  assert.equal(
    scrubPersonalData('IBAN DE89 3704 0044 0532 0130 00'),
    'IBAN [IBAN entfernt]',
  );
  assert.equal(scrubPersonalData('Preis 1234 €, nur 12 km entfernt'), 'Preis 1234 €, nur 12 km entfernt');
  assert.equal(scrubPersonalData('iPhone 13 Pro Max 256 GB'), 'iPhone 13 Pro Max 256 GB');
});