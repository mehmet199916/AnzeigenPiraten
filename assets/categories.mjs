/** Fixed trading categories; models cannot expand this list. */
export const TRADING_CATEGORIES = [
  { id: 'iphone', label: 'iPhone', description: 'Apple iPhone smartphones, not accessories or repairs' },
  { id: 'macbook', label: 'MacBook', description: 'Apple MacBook laptops, not parts, accessories or repairs' },
  { id: 'gpu', label: 'Grafikkarten', description: 'Standalone computer graphics cards, not complete PCs or repairs' },
  { id: 'console', label: 'Konsolen', description: 'Video game consoles, not controllers, games, accessories or repairs' },
  { id: 'kamera', label: 'Kameras', description: 'Photo cameras and camcorders, not car or surveillance cameras, accessories or services' },
];
export function isExcludedListing(listing) {
  const text = [listing.queryId, listing.queryLabel, listing.title, listing.product?.category, listing.product?.name].join(' ');
  return /\b(?:e[\s-]?bikes?|pedelecs?|fahrr[aä]der|fahrrad|bicycles?)\b/i.test(text);
}
export function isVisibleListing(listing) {
  return !isExcludedListing(listing) && (!listing.product?.decision || listing.product.decision.accepted === true);
}
