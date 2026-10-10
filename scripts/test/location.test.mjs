import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  normaliseLocation,
  normaliseRadius,
  normaliseSearch,
} from '../lib/config.mjs';
import {
  applyLocation,
  buildSearchUrl,
  isNearbyDeal,
  parseLocationSuggestions,
  pickLocation,
} from '../lib/kleinanzeigen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(here, '../../config/dealfinder.config.json');

test('parseLocationSuggestions strips the underscore prefix from ids', () => {
  const suggestions = parseLocationSuggestions({
    _0: 'Deutschland',
    _9668: '10115 Mitte',
    _3504: '10115 Wedding',
  });

  assert.deepEqual(suggestions, [
    { id: '0', label: 'Deutschland' },
    { id: '9668', label: '10115 Mitte' },
    { id: '3504', label: '10115 Wedding' },
  ]);
});

test('parseLocationSuggestions ignores payloads that are not an object', () => {
  assert.deepEqual(parseLocationSuggestions(null), []);
  assert.deepEqual(parseLocationSuggestions('nope'), []);
  assert.deepEqual(parseLocationSuggestions([1, 2]), []);
});

test('pickLocation prefers an exact label prefix over the country-wide entry', () => {
  const suggestions = parseLocationSuggestions({
    _0: 'Deutschland',
    _9668: '10115 Mitte',
    _3504: '10115 Wedding',
  });

  assert.deepEqual(pickLocation(suggestions, '10115'), { id: '9668', label: '10115 Mitte' });
});

test('pickLocation matches place names by prefix regardless of case', () => {
  const suggestions = parseLocationSuggestions({
    _0: 'Deutschland',
    _3331: 'Berlin',
    _3464: 'Pankow - Berlin',
  });

  assert.deepEqual(pickLocation(suggestions, 'berlin'), { id: '3331', label: 'Berlin' });
});

test('pickLocation falls back to a label containing the query', () => {
  const suggestions = parseLocationSuggestions({
    _0: 'Deutschland',
    _9668: '10115 Mitte',
  });

  assert.deepEqual(pickLocation(suggestions, 'Mitte'), { id: '9668', label: '10115 Mitte' });
});

test('pickLocation returns null when nothing but Deutschland matches', () => {
  const suggestions = parseLocationSuggestions({ _0: 'Deutschland' });

  assert.equal(pickLocation(suggestions, '10115'), null);
  assert.equal(pickLocation([], '10115'), null);
  assert.equal(pickLocation(suggestions, ''), null);
});

test('normaliseRadius snaps to the steps offered by the site', () => {
  assert.equal(normaliseRadius('50'), '50');
  assert.equal(normaliseRadius(50), '50');
  assert.equal(normaliseRadius('30'), '30');
  assert.equal(normaliseRadius('45'), '50');
  assert.equal(normaliseRadius('7'), '5');
  assert.equal(normaliseRadius('1000'), '200');
  assert.equal(normaliseRadius(''), '');
  assert.equal(normaliseRadius('0'), '');
  assert.equal(normaliseRadius('-10'), '');
  assert.equal(normaliseRadius('keiner'), '');
});

test('normaliseLocation trims the PLZ and normalises the radius', () => {
  assert.deepEqual(normaliseLocation({ plz: ' 50667 ', radius: '45' }), {
    plz: '50667',
    radius: '50',
  });
  assert.deepEqual(normaliseLocation(undefined), { plz: '', radius: '' });
});

test('normaliseSearch applies the radius steps to per-search radius values', () => {
  assert.equal(normaliseSearch({ keywords: 'iphone', radius: '45' }, 0).radius, '50');
  assert.equal(normaliseSearch({ keywords: 'iphone' }, 0).radius, '');
});

test('applyLocation only fills fields the search does not pin itself', () => {
  const location = { id: '9668', label: '10115 Mitte', plz: '10115', radius: '50' };

  const filled = applyLocation({ keywords: 'iphone', locationId: '', radius: '' }, location);
  assert.equal(filled.locationId, '9668');
  assert.equal(filled.radius, '50');

  const pinned = applyLocation({ keywords: 'iphone', locationId: '3331', radius: '20' }, location);
  assert.equal(pinned.locationId, '3331');
  assert.equal(pinned.radius, '20');

  const untouched = applyLocation({ keywords: 'iphone', locationId: '', radius: '' }, null);
  assert.equal(untouched.locationId, '');
  assert.equal(untouched.radius, '');
});

test('buildSearchUrl carries locationId and radius', () => {
  const search = normaliseSearch({ keywords: 'iphone', locationId: '9668', radius: '50' }, 0);
  const url = new URL(buildSearchUrl(search, 2));

  assert.equal(url.searchParams.get('locationId'), '9668');
  assert.equal(url.searchParams.get('radius'), '50');
  assert.equal(url.searchParams.get('pageNum'), '2');
});

test('isNearbyDeal keeps everything when no location filter is active', () => {
  assert.equal(isNearbyDeal({ locationScope: '', distanceKm: 0 }, null), true);
  assert.equal(isNearbyDeal({ distanceKm: 900 }, null), true);
});

test('isNearbyDeal drops nationwide rows once a location filter is active', () => {
  const location = { id: '9668', plz: '10115', radius: '50' };

  assert.equal(isNearbyDeal({ locationScope: '', distanceKm: 0 }, location), false);
  assert.equal(isNearbyDeal({ distanceKm: 12 }, location), false);
});

test('isNearbyDeal keeps matching rows inside the radius and drops those beyond it', () => {
  const location = { id: '9668', plz: '10115', radius: '50' };

  assert.equal(isNearbyDeal({ locationScope: '9668', distanceKm: 12 }, location), true);
  assert.equal(isNearbyDeal({ locationScope: '9668', distanceKm: 50 }, location), true);
  assert.equal(isNearbyDeal({ locationScope: '9668', distanceKm: 51 }, location), false);
  // Rows without a reported distance were still filtered server-side.
  assert.equal(isNearbyDeal({ locationScope: '9668', distanceKm: 0 }, location), true);
});

test('isNearbyDeal keeps matching rows when no radius is set ("ganzer Ort")', () => {
  const location = { id: '9668', plz: '10115', radius: '' };

  assert.equal(isNearbyDeal({ locationScope: '9668', distanceKm: 0 }, location), true);
  assert.equal(isNearbyDeal({ locationScope: '9668', distanceKm: 400 }, location), true);
  assert.equal(isNearbyDeal({ locationScope: '', distanceKm: 0 }, location), false);
});

test('isNearbyDeal follows a PLZ change to another location id', () => {
  const location = { id: '983', plz: '50667', radius: '50' };

  assert.equal(isNearbyDeal({ locationScope: '9668', distanceKm: 3 }, location), false);
  assert.equal(isNearbyDeal({ locationScope: '983', distanceKm: 3 }, location), true);
});

test('the shipped config exposes the location block with a 50 km default radius', async () => {
  const config = await loadConfig(configPath, {});

  assert.equal(config.location.plz, '');
  assert.equal(config.location.radius, '50');
});
