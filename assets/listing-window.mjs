export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export function isRecentListing(listing, now = Date.now()) {
  const stamp = Date.parse(listing?.postedAt || '');
  return Number.isFinite(stamp) && stamp >= now - WINDOW_MS && stamp <= now;
}
export function isAffordableListing(listing) {
  return listing?.referencePriceCheck?.status !== 'above_reference_price';
}
