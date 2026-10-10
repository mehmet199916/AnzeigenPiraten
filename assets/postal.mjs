/** Distances between approximate German postal-code centres, not street addresses. */
export function postalCodeOf(value) {
  return String(value ?? '').match(/\b\d{5}\b/)?.[0] ?? null;
}

export function postalDistance(postalCodes, origin, destination) {
  const a = postalCodes?.[origin];
  const b = postalCodes?.[destination];
  if (!a || !b || ![...a, ...b].every(Number.isFinite)) return null;
  const radians = (n) => n * Math.PI / 180;
  const h = Math.sin(radians(b[0] - a[0]) / 2) ** 2
    + Math.cos(radians(a[0])) * Math.cos(radians(b[0])) * Math.sin(radians(b[1] - a[1]) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
