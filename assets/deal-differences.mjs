/** Price advantage relative to a listing's manual or observed reference price. */
export function dealDifference(deal, mode = 'eur') {
  const check = deal?.referencePriceCheck;
  if (!Number.isFinite(check?.difference) || !Number.isFinite(check?.referencePrice) || check.referencePrice <= 0) return null;
  if (mode === 'eur') return check.difference;
  if (mode === 'pct') return Number.isFinite(check.differencePct)
    ? check.differencePct
    : check.difference / check.referencePrice * 100;
  return null;
}

/** Sort largest savings first; listings without usable prices are always last. */
export function sortByDealDifference(deals, mode = 'eur') {
  return [...deals].sort((a, b) => {
    const left = dealDifference(a, mode);
    const right = dealDifference(b, mode);
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return right - left;
  });
}

export function meetsDealDifference(deal, mode, minimum = 0) {
  if (!['eur', 'pct'].includes(mode)) return true;
  const difference = dealDifference(deal, mode);
  return difference !== null && difference >= minimum;
}
