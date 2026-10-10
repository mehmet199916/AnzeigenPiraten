// Regenerate with: node scripts/build-postal-data.mjs /path/to/GeoNames/DE.txt
import { readFile, writeFile } from 'node:fs/promises';
const source = process.argv[2];
if (!source) throw new Error('Provide the path to GeoNames DE.txt');
const groups = new Map();
for (const row of (await readFile(source, 'utf8')).split(/\r?\n/)) {
  const fields = row.split('\t');
  const postalCode = fields[1];
  const latitude = Number(fields[9]);
  const longitude = Number(fields[10]);
  if (!/^\d{5}$/.test(postalCode || '') || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
  const places = groups.get(postalCode) || [];
  places.push([latitude, longitude]); groups.set(postalCode, places);
}
const postalCodes = {};
for (const [postalCode, places] of [...groups].sort()) {
  postalCodes[postalCode] = [0, 1].map((axis) => Number((places.reduce((sum, place) => sum + place[axis], 0) / places.length).toFixed(5)));
}
await writeFile(new URL('../data/postal-centres.json', import.meta.url), JSON.stringify({
  source: 'https://download.geonames.org/export/zip/DE.zip', attribution: 'GeoNames',
  license: 'CC BY 4.0', derived: 'Mean coordinates of places sharing each postal code', postalCodes,
}) + '\n');
console.log(`Generated ${Object.keys(postalCodes).length} German postal-code centres`);
