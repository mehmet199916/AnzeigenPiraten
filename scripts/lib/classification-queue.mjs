/** Give unclassified current results priority while reserving capacity for backlog. */
export function selectClassificationItems(items, limit, fetchedIds, previousById) {
  const cap = Math.max(1, Math.floor(Number(limit) || 200));
  const fresh = [], backlog = [];
  for (const item of items) {
    const previous = previousById.get(String(item.listing.id));
    const currentUnknown = fetchedIds.has(String(item.listing.id))
      && (!previous?.product?.key || previous.product.key === 'unknown');
    (currentUnknown ? fresh : backlog).push(item);
  }
  const stamp = item => Date.parse(item.listing.firstSeenAt || item.listing.postedAt || '') || 0;
  fresh.sort((a,b) => stamp(b) - stamp(a));
  backlog.sort((a,b) => stamp(a) - stamp(b));
  const reserve = backlog.length && fresh.length && cap > 1 ? Math.max(1, Math.floor(cap * 0.2)) : 0;
  const selected = fresh.slice(0, cap - reserve);
  selected.push(...backlog.slice(0, cap - selected.length));
  if (selected.length < cap) selected.push(...fresh.slice(cap - reserve, cap - reserve + cap - selected.length));
  return selected;
}
