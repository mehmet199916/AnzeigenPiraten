/* AnzeigenPiraten – static deal finder frontend (no build step, no deps). */

(() => {
  'use strict';

  const DATA_URL = 'data/deals.json';
  const META_URL = 'data/meta.json';
  const LAST_VISIT_KEY = 'anzeigenpiraten:lastVisit:v1';
  const state = {
    deals: [],
    queries: [],
    generatedAt: null,
    lastVisit: null,
    search: '',
    queryId: '',
    productKey: '',
    priceStatus: '',
    sort: 'new',
    onlyNew: false,
  };

  const el = {
    status: document.getElementById('status'),
    statusSub: document.getElementById('statusSub'),
    stats: document.getElementById('stats'),
    feed: document.getElementById('feed'),
    empty: document.getElementById('empty'),
    search: document.getElementById('q'),
    query: document.getElementById('query'),
    product: document.getElementById('product'),
    priceStatus: document.getElementById('priceStatus'),
    sort: document.getElementById('sort'),
    onlyNew: document.getElementById('onlyNew'),
    reset: document.getElementById('reset'),
    footerMeta: document.getElementById('footerMeta'),
    detail: document.getElementById('detail'),
    detailBody: document.getElementById('detailBody'),
    detailClose: document.getElementById('detailClose'),
  };

  const euro = new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });

  const dateTime = new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const relative = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const formatPrice = (value) => (Number.isFinite(value) ? euro.format(value) : 'Preis unbekannt');

  function comparisonSummary(comparison) {
    if (!comparison) return '';
    if (comparison.status === 'insufficient_data') {
      const count = comparison.comparableCount ?? 0;
      return `<p class="card__comparison">${count} vergleichbare Anzeige${count === 1 ? '' : 'n'} in der Preisdatenbank; mindestens ${comparison.minComparables ?? 3} für einen Vergleich nötig.</p>`;
    }
    const labels = {
      below_observed_range: 'Unter dem beobachteten Preisbereich',
      within_observed_range: 'Im beobachteten Preisbereich',
      above_observed_range: 'Über dem beobachteten Preisbereich',
    };
    const delta = Number.isFinite(comparison.differencePct)
      ? ` (${comparison.differencePct > 0 ? '+' : ''}${comparison.differencePct}% zum Median)`
      : '';
    const range = Number.isFinite(comparison.p25) && Number.isFinite(comparison.p75)
      ? ` · mittlere Spanne ${formatPrice(comparison.p25)}–${formatPrice(comparison.p75)}`
      : '';
    return `<p class="card__comparison">${escapeHtml(labels[comparison.status] ?? 'Preisvergleich')}${delta} · Median ${escapeHtml(formatPrice(comparison.median))}${escapeHtml(range)} aus ${comparison.comparableCount} anderen Anzeigen</p>`;
  }

  function referencePriceSummary(check) {
    if (!check) return '<p class="card__reference card__reference--muted">Noch kein Produkt-Referenzpreis eingetragen.</p>';
    if (check.status === 'reference_price_missing') {
      return '<p class="card__reference card__reference--muted">Für dieses Produkt fehlt noch ein Referenzpreis – der Durchschnitt erscheint, sobald Preise gesammelt wurden.</p>';
    }

    const isAverage = check.referenceSource === 'average';
    const samples = Number(check.observedCount) || 0;
    const reference = escapeHtml(formatPrice(check.referencePrice));

    if (check.status === 'asking_price_missing') {
      const note = isAverage ? ` (Durchschnitt aus ${samples} beobachteten Preisen)` : '';
      return `<p class="card__reference card__reference--muted">Referenzpreis: ${reference}${note}; Anzeige ohne gültigen Preis.</p>`;
    }

    const amount = escapeHtml(formatPrice(Math.abs(check.difference)));
    const percent = `${Math.abs(check.differencePct).toLocaleString('de-DE')}%`;
    if (check.status === 'good_price') {
      return isAverage
        ? `<p class="card__reference card__reference--good">Guter Preis: ${amount} (${percent}) unter dem Durchschnittspreis von ${reference} aus ${samples} beobachteten Preisen.</p>`
        : `<p class="card__reference card__reference--good">Guter Preis: ${amount} (${percent}) unter deinem Produktpreis von ${reference}.</p>`;
    }
    if (check.status === 'at_reference_price') {
      return isAverage
        ? `<p class="card__reference card__reference--target">Exakt im Durchschnittspreis: ${reference} (aus ${samples} beobachteten Preisen).</p>`
        : `<p class="card__reference card__reference--target">Genau dein Produktpreis: ${reference}.</p>`;
    }
    if (check.status === 'above_reference_price') {
      return isAverage
        ? `<p class="card__reference card__reference--over">${amount} (${percent}) über dem Durchschnittspreis von ${reference} aus ${samples} beobachteten Preisen.</p>`
        : `<p class="card__reference card__reference--over">${amount} (${percent}) über deinem Produktpreis von ${reference}.</p>`;
    }
    return '<p class="card__reference card__reference--muted">Produkt noch nicht zugeordnet; kein Preisabgleich möglich.</p>';
  }

  const formatDateTime = (iso) => {
    const date = iso ? new Date(iso) : null;
    return date && !Number.isNaN(date.getTime()) ? dateTime.format(date) : '–';
  };

  function formatRelative(iso) {
    const date = iso ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) return 'unbekannt';
    const diffMs = date.getTime() - Date.now();
    const minutes = Math.round(diffMs / 60000);
    if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 30) return relative.format(days, 'day');
    return relative.format(Math.round(days / 30), 'month');
  }

  function isNew(deal) {
    if (!state.lastVisit || !deal.firstSeenAt) return false;
    return new Date(deal.firstSeenAt).getTime() > state.lastVisit;
  }

  async function loadJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
    return response.json();
  }

  function readLastVisit() {
    try {
      const stored = window.localStorage.getItem(LAST_VISIT_KEY);
      return stored ? new Date(stored).getTime() : null;
    } catch {
      return null;
    }
  }

  function writeLastVisit(iso) {
    try {
      if (iso) window.localStorage.setItem(LAST_VISIT_KEY, iso);
    } catch {
      /* storage disabled – not critical */
    }
  }

  function populateQueryFilter() {
    const options = state.queries
      .map((query) => `<option value="${escapeHtml(query.id)}">${escapeHtml(query.label)} (${query.count})</option>`)
      .join('');
    el.query.innerHTML = `<option value="">Alle Kategorien</option>${options}`;
  }

  function populateProductFilter() {
    const products = new Map();
    for (const deal of state.deals) {
      const product = deal.product;
      if (!product?.key || product.key === 'unknown') continue;
      const current = products.get(product.key) ?? { name: String(product.name ?? 'Unbekannt'), count: 0 };
      current.count += 1;
      products.set(product.key, current);
    }
    const options = [...products.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name, 'de'))
      .map(([key, product]) => `<option value="${escapeHtml(key)}">${escapeHtml(product.name)} (${product.count})</option>`)
      .join('');
    el.product.innerHTML = `<option value="">Alle Produkte</option>${options}`;
  }

  function currentDeals() {
    const needle = state.search.trim().toLowerCase();

    const filtered = state.deals.filter((deal) => {
      if (state.queryId && deal.queryId !== state.queryId) return false;
      if (state.productKey && deal.product?.key !== state.productKey) return false;
      if (state.priceStatus && deal.referencePriceCheck?.status !== state.priceStatus) return false;
      if (state.onlyNew && !isNew(deal)) return false;
      if (!needle) return true;

      const haystack = [
        deal.title,
        deal.description,
        deal.location,
        deal.queryLabel,
        deal.product?.name,
        deal.product?.category,
        deal.product?.variant,
        deal.priceRaw,
      ].join(' ').toLowerCase();

      return haystack.includes(needle);
    });

    const priceOf = (deal) => (Number.isFinite(deal.price) ? deal.price : Number.POSITIVE_INFINITY);
    const seenOf = (deal) => new Date(deal.firstSeenAt ?? 0).getTime();

    const sorters = {
      new: (a, b) => seenOf(b) - seenOf(a),
      price_asc: (a, b) => priceOf(a) - priceOf(b),
      price_desc: (a, b) => priceOf(b) - priceOf(a),
    };

    return filtered.sort(sorters[state.sort] ?? sorters.new);
  }

  function renderStats() {
    const fresh = state.deals.filter(isNew).length;
    const products = new Set(state.deals.map((deal) => deal.product?.key).filter((key) => key && key !== 'unknown'));
    const classified = state.deals.filter((deal) => deal.product?.key && deal.product.key !== 'unknown').length;
    const goodPrices = state.deals.filter((deal) => deal.referencePriceCheck?.status === 'good_price').length;

    const cards = [
      ['Anzeigen im Feed', String(state.deals.length)],
      ['Erkannte Produkte', String(products.size)],
      ['Zugeordnet', `${classified} / ${state.deals.length}`],
      ['Gute Preise', String(goodPrices)],
      ['Neu seit letztem Besuch', String(fresh)],
    ];

    el.stats.innerHTML = cards
      .map(([label, value]) => `
        <div class="stat">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>`)
      .join('');
  }

  function renderCard(deal) {
    const badges = [];

    if (isNew(deal)) badges.push('<span class="chip chip--new">Neu</span>');
    if (deal.price === 0) badges.push('<span class="chip chip--free">Zu verschenken</span>');
    if (deal.priceTags?.negotiable) badges.push('<span class="chip">VB</span>');
    if (deal.stale) badges.push('<span class="chip chip--muted">nicht mehr gefunden</span>');

    const product = deal.product ?? {};
    const referenceStatus = deal.referencePriceCheck?.status;
    if (referenceStatus === 'good_price') badges.push('<span class="chip chip--good">Guter Preis</span>');
    if (referenceStatus === 'at_reference_price') badges.push('<span class="chip chip--target">Zum Referenzpreis</span>');
    if (referenceStatus === 'above_reference_price') badges.push('<span class="chip chip--over">Über Referenzpreis</span>');

    const image = deal.image
      ? `<img src="${escapeHtml(deal.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : '<div class="card__placeholder" aria-hidden="true">🏴‍☠️</div>';

    return `
      <article class="card" data-id="${escapeHtml(deal.id)}" tabindex="0" role="button"
               aria-label="${escapeHtml(deal.title)} – Produkt: ${escapeHtml(product.name ?? 'unbekannt')}">
        <div class="card__media">
          ${image}
          <span class="verdict verdict--fair">${escapeHtml(product.category ?? 'Produkt offen')}</span>
        </div>

        <div class="card__body">
          <div class="card__badges">${badges.join('')}</div>
          <h2 class="card__title">${escapeHtml(deal.title || 'Ohne Titel')}</h2>

          <p class="card__product">${escapeHtml(product.name ?? 'Produkt noch nicht erkannt')}${product.variant ? ` · ${escapeHtml(product.variant)}` : ''}</p>

          <p class="card__price">
            <strong>${escapeHtml(deal.priceRaw || formatPrice(deal.price))}</strong>
          </p>
          ${referencePriceSummary(deal.referencePriceCheck)}
          ${comparisonSummary(deal.priceComparison)}

          <p class="card__meta">
            <span>📍 ${escapeHtml(deal.location || 'Ort unbekannt')}</span>
            <span>🕒 ${escapeHtml(formatRelative(deal.postedAt || deal.firstSeenAt))}</span>
          </p>

          <div class="card__footer">
            <span class="tag">${escapeHtml(deal.queryLabel || '')}</span>
            <span class="engine">${product.confidence ? `${Math.round(product.confidence * 100)}% sicher` : ''}</span>
          </div>
        </div>
      </article>`;
  }

  function render() {
    const deals = currentDeals();

    el.feed.setAttribute('aria-busy', 'false');
    el.feed.innerHTML = deals.map(renderCard).join('');

    if (!deals.length) {
      el.empty.hidden = false;
      el.empty.textContent = state.deals.length
        ? 'Keine Anzeige passt zu deinen Filtern. Setze die Filter zurück.'
        : 'Noch keine Daten vorhanden. Der erste Scan-Lauf füllt data/deals.json automatisch.';
    } else {
      el.empty.hidden = true;
    }

    renderStats();
  }

  function openDetail(deal) {
    const attributes = Object.entries(deal.attributes ?? {});
    const product = deal.product ?? {};

    const history = (deal.priceHistory ?? []);
    const historyHtml = history.length > 1
      ? `<h4>Preisverlauf</h4><ul class="detail__history">${
        history.map((entry) => `<li>${escapeHtml(formatPrice(entry.price))} – ${escapeHtml(formatDateTime(entry.at))}</li>`).join('')
      }</ul>`
      : '';

    const attributesHtml = attributes.length
      ? `<h4>Details der Anzeige</h4><dl class="detail__attrs">${
        attributes.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')
      }</dl>`
      : '';

    el.detailBody.innerHTML = `
      <div class="detail__media">
        ${deal.imageLarge || deal.image
          ? `<img src="${escapeHtml(deal.imageLarge || deal.image)}" alt="" referrerpolicy="no-referrer"
                  data-fallback="${escapeHtml(deal.image || '')}">`
          : '<div class="card__placeholder" aria-hidden="true">🏴‍☠️</div>'}
      </div>

      <div class="detail__content">
        <div class="detail__head">
          <div>
            <span class="verdict verdict--fair">${escapeHtml(product.category ?? 'Produkt offen')}</span>
            <h3 id="detailTitle">${escapeHtml(deal.title || 'Ohne Titel')}</h3>
          </div>
        </div>

        <p class="detail__price">${escapeHtml(deal.priceRaw || formatPrice(deal.price))}</p>

        <h4>Produktzuordnung</h4>
        <p><strong>${escapeHtml(product.name ?? 'Produkt noch nicht erkannt')}</strong></p>
        ${product.variant ? `<p>Ausführung: ${escapeHtml(product.variant)}</p>` : ''}
        <p class="detail__muted">${product.confidence ? `${Math.round(product.confidence * 100)} % Zuordnungssicherheit` : 'Keine sichere Zuordnung'}</p>
        <h4>Referenzpreis-Abgleich</h4>
        ${referencePriceSummary(deal.referencePriceCheck)}
        <h4>Vergleich mit anderen Anzeigen</h4>
        ${comparisonSummary(deal.priceComparison) || '<p class="detail__muted">Noch keine Preisdaten vorhanden.</p>'}

        <dl class="detail__facts">
          <div><dt>Suchauftrag</dt><dd>${escapeHtml(deal.queryLabel || '–')}</dd></div>
          <div><dt>Ort</dt><dd>${escapeHtml(deal.location || '–')}</dd></div>
          <div><dt>Inseriert</dt><dd>${escapeHtml(formatDateTime(deal.postedAt))}</dd></div>
          <div><dt>Gefunden</dt><dd>${escapeHtml(formatDateTime(deal.firstSeenAt))}</dd></div>
        </dl>

        ${attributesHtml}
        ${historyHtml}

        <h4>Beschreibung</h4>
        <p class="detail__description">${escapeHtml(deal.description || 'Keine Beschreibung vorhanden.')}</p>

        <a class="btn btn--primary" href="${escapeHtml(deal.url)}" target="_blank" rel="noopener noreferrer">
          Anzeige auf Kleinanzeigen öffnen ↗
        </a>
      </div>`;

    // Fall back to the (smaller) thumbnail if the high-resolution variant fails.
    for (const img of el.detailBody.querySelectorAll('img[data-fallback]')) {
      img.addEventListener('error', () => {
        const fallback = img.dataset.fallback;
        if (!fallback || fallback === img.currentSrc || fallback === img.src) return;
        img.removeAttribute('data-fallback');
        img.src = fallback;
      });
    }

    if (typeof el.detail.showModal === 'function') {
      el.detail.showModal();
    } else {
      el.detail.setAttribute('open', '');
    }
  }

  function setStatus(meta) {
    const engine = meta?.engine ?? '–';
    const friendly = engine.startsWith('ai:')
      ? `Produkt-KI (${engine.slice(3)})`
      : 'Produkte nicht automatisch zugeordnet';

    el.status.innerHTML = `Letzter Scan: <strong>${escapeHtml(formatDateTime(meta?.generatedAt ?? state.generatedAt))}</strong>`;
    el.statusSub.textContent = [
      `Produktzuordnung: ${friendly}`,
      Number.isFinite(meta?.fetchedListings) ? `${meta.fetchedListings} Anzeigen geprüft` : null,
      Number.isFinite(meta?.newDeals) ? `${meta.newDeals} neu` : null,
      Number.isFinite(meta?.durationMs) ? `in ${(meta.durationMs / 1000).toFixed(1)}s` : null,
    ].filter(Boolean).join(' · ');

    if (el.footerMeta) {
      el.footerMeta.textContent = `Datenstand: ${formatDateTime(meta?.generatedAt ?? state.generatedAt)}`
        + (meta?.searches?.length ? ` · Suchaufträge: ${meta.searches.join(', ')}` : '');
    }
  }

  function wireEvents() {
    el.search.addEventListener('input', () => {
      state.search = el.search.value;
      render();
    });

    el.query.addEventListener('change', () => {
      state.queryId = el.query.value;
      render();
    });

    el.product.addEventListener('change', () => {
      state.productKey = el.product.value;
      render();
    });

    el.priceStatus.addEventListener('change', () => {
      state.priceStatus = el.priceStatus.value;
      render();
    });

    el.sort.addEventListener('change', () => {
      state.sort = el.sort.value;
      render();
    });

    el.onlyNew.addEventListener('change', () => {
      state.onlyNew = el.onlyNew.checked;
      render();
    });

    el.reset.addEventListener('click', () => {
      state.search = '';
      state.queryId = '';
      state.productKey = '';
      state.priceStatus = '';
      state.sort = 'new';
      state.onlyNew = false;

      el.search.value = '';
      el.query.value = '';
      el.product.value = '';
      el.priceStatus.value = '';
      el.sort.value = 'new';
      el.onlyNew.checked = false;

      render();
    });

    el.feed.addEventListener('click', (event) => {
      const card = event.target.closest('.card');
      if (!card) return;
      const deal = state.deals.find((item) => item.id === card.dataset.id);
      if (deal) openDetail(deal);
    });

    el.feed.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('.card');
      if (!card) return;
      event.preventDefault();
      const deal = state.deals.find((item) => item.id === card.dataset.id);
      if (deal) openDetail(deal);
    });

    el.detailClose.addEventListener('click', () => el.detail.close());
    el.detail.addEventListener('click', (event) => {
      if (event.target === el.detail) el.detail.close();
    });
  }

  async function init() {
    state.lastVisit = readLastVisit();
    wireEvents();

    try {
      const [data, meta] = await Promise.all([
        loadJson(DATA_URL),
        loadJson(META_URL).catch(() => null),
      ]);

      state.deals = Array.isArray(data.deals) ? data.deals : [];
      state.queries = Array.isArray(data.queries) ? data.queries : [];
      state.generatedAt = data.generatedAt ?? null;

      populateQueryFilter();
      populateProductFilter();
      setStatus(meta ?? { generatedAt: state.generatedAt, engine: data.engine });
      render();

      writeLastVisit(state.generatedAt);
    } catch (error) {
      el.feed.setAttribute('aria-busy', 'false');
      el.status.textContent = 'Daten konnten nicht geladen werden.';
      el.statusSub.textContent = String(error.message ?? error);
      el.empty.hidden = false;
      el.empty.innerHTML = `Die Datei <code>data/deals.json</code> ist nicht erreichbar.<br>`
        + `Der gemeinsame Deal-Feed ist gerade nicht verfügbar. Bitte versuche es später erneut.`;
    }
  }

  init();
})();
