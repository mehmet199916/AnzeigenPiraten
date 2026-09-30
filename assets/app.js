/* AnzeigenPiraten – static deal finder frontend (no build step, no deps). */

(() => {
  'use strict';

  const DATA_URL = 'data/deals.json';
  const META_URL = 'data/meta.json';
  const LAST_VISIT_KEY = 'anzeigenpiraten:lastVisit:v1';

  const VERDICT_LABELS = {
    top: 'Top-Deal',
    good: 'Guter Deal',
    fair: 'Marktüblich',
    overpriced: 'Zu teuer',
    unknown: 'Unbewertet',
  };

  const state = {
    deals: [],
    queries: [],
    generatedAt: null,
    lastVisit: null,
    search: '',
    queryId: '',
    minScore: 0,
    sort: 'score',
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
    minScore: document.getElementById('minScore'),
    minScoreOut: document.getElementById('minScoreOut'),
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

  function scoreTier(score) {
    if (!Number.isFinite(score)) return 'unknown';
    if (score >= 85) return 'top';
    if (score >= 70) return 'good';
    if (score >= 50) return 'fair';
    return 'overpriced';
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

  function currentDeals() {
    const needle = state.search.trim().toLowerCase();

    const filtered = state.deals.filter((deal) => {
      if (state.queryId && deal.queryId !== state.queryId) return false;
      if (state.onlyNew && !isNew(deal)) return false;
      if (state.minScore > 0 && !(Number(deal.ai?.dealScore) >= state.minScore)) return false;
      if (!needle) return true;

      const haystack = [
        deal.title,
        deal.description,
        deal.location,
        deal.queryLabel,
        deal.priceRaw,
      ].join(' ').toLowerCase();

      return haystack.includes(needle);
    });

    const priceOf = (deal) => (Number.isFinite(deal.price) ? deal.price : Number.POSITIVE_INFINITY);
    const scoreOf = (deal) => (Number.isFinite(deal.ai?.dealScore) ? deal.ai.dealScore : -1);
    const savingsOf = (deal) => (Number.isFinite(deal.ai?.savingsPct) ? deal.ai.savingsPct : -999);
    const seenOf = (deal) => new Date(deal.firstSeenAt ?? 0).getTime();

    const sorters = {
      score: (a, b) => scoreOf(b) - scoreOf(a) || seenOf(b) - seenOf(a),
      new: (a, b) => seenOf(b) - seenOf(a),
      savings: (a, b) => savingsOf(b) - savingsOf(a),
      price_asc: (a, b) => priceOf(a) - priceOf(b),
      price_desc: (a, b) => priceOf(b) - priceOf(a),
    };

    return filtered.sort(sorters[state.sort] ?? sorters.score);
  }

  function renderStats() {
    const scored = state.deals.filter((deal) => Number.isFinite(deal.ai?.dealScore));
    const top = scored.filter((deal) => deal.ai.verdict === 'top').length;
    const fresh = state.deals.filter(isNew).length;
    const avg = scored.length
      ? Math.round(scored.reduce((sum, deal) => sum + deal.ai.dealScore, 0) / scored.length)
      : null;

    const cards = [
      ['Anzeigen im Feed', String(state.deals.length)],
      ['Top-Deals', String(top)],
      ['Ø Deal-Score', avg == null ? '–' : String(avg)],
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
    const ai = deal.ai ?? {};
    const tier = scoreTier(ai.dealScore);
    const badges = [];

    if (isNew(deal)) badges.push('<span class="chip chip--new">Neu</span>');
    if (deal.price === 0) badges.push('<span class="chip chip--free">Zu verschenken</span>');
    if (deal.priceTags?.negotiable) badges.push('<span class="chip">VB</span>');
    if (deal.stale) badges.push('<span class="chip chip--muted">nicht mehr gefunden</span>');

    const savings = Number.isFinite(ai.savingsPct) && ai.savingsPct > 0
      ? `<span class="savings">−${ai.savingsPct}% ggü. Marktwert</span>`
      : '';

    const fair = Number.isFinite(ai.fairPrice) && ai.fairPrice > 0
      ? `<span class="fair">Fair: ${escapeHtml(formatPrice(ai.fairPrice))}</span>`
      : '';

    const image = deal.image
      ? `<img src="${escapeHtml(deal.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : '<div class="card__placeholder" aria-hidden="true">🏴‍☠️</div>';

    return `
      <article class="card" data-id="${escapeHtml(deal.id)}" tabindex="0" role="button"
               aria-label="${escapeHtml(deal.title)} – Deal-Score ${escapeHtml(String(ai.dealScore ?? '?'))}">
        <div class="card__media">
          ${image}
          <span class="score score--${tier}" title="Deal-Score">
            <strong>${escapeHtml(ai.dealScore == null ? '?' : String(ai.dealScore))}</strong>
            <small>Score</small>
          </span>
          <span class="verdict verdict--${tier}">${escapeHtml(VERDICT_LABELS[ai.verdict] ?? VERDICT_LABELS.unknown)}</span>
        </div>

        <div class="card__body">
          <div class="card__badges">${badges.join('')}</div>
          <h2 class="card__title">${escapeHtml(deal.title || 'Ohne Titel')}</h2>

          <p class="card__price">
            <strong>${escapeHtml(deal.priceRaw || formatPrice(deal.price))}</strong>
            ${savings}
          </p>
          <p class="card__sub">${fair}</p>

          <p class="card__meta">
            <span>📍 ${escapeHtml(deal.location || 'Ort unbekannt')}</span>
            <span>🕒 ${escapeHtml(formatRelative(deal.postedAt || deal.firstSeenAt))}</span>
          </p>

          ${ai.reasoning ? `<p class="card__reasoning">🤖 ${escapeHtml(ai.reasoning)}</p>` : ''}

          <div class="card__footer">
            <span class="tag">${escapeHtml(deal.queryLabel || '')}</span>
            <span class="engine">${escapeHtml(ai.engine ?? '')}</span>
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
        ? 'Keine Anzeige passt zu deinen Filtern. Setze die Filter zurück oder senke den Mindest-Score.'
        : 'Noch keine Daten vorhanden. Der erste Scan-Lauf füllt data/deals.json automatisch.';
    } else {
      el.empty.hidden = true;
    }

    renderStats();
  }

  function openDetail(deal) {
    const ai = deal.ai ?? {};
    const tier = scoreTier(ai.dealScore);
    const attributes = Object.entries(deal.attributes ?? {});

    const redFlags = (ai.redFlags ?? []).length
      ? `<ul class="detail__flags">${ai.redFlags.map((flag) => `<li>${escapeHtml(flag)}</li>`).join('')}</ul>`
      : '<p class="detail__muted">Keine Warnsignale erkannt.</p>';

    const highlights = (ai.highlights ?? []).length
      ? `Auffälligkeiten: ${escapeHtml(ai.highlights.join(', '))}.`
      : '';

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
                  onerror="this.onerror=null;this.src='${escapeHtml(deal.image || '')}'">`
          : '<div class="card__placeholder" aria-hidden="true">🏴‍☠️</div>'}
      </div>

      <div class="detail__content">
        <div class="detail__head">
          <span class="score score--${tier}">
            <strong>${escapeHtml(ai.dealScore == null ? '?' : String(ai.dealScore))}</strong>
            <small>Score</small>
          </span>
          <div>
            <span class="verdict verdict--${tier}">${escapeHtml(VERDICT_LABELS[ai.verdict] ?? VERDICT_LABELS.unknown)}</span>
            <h3 id="detailTitle">${escapeHtml(deal.title || 'Ohne Titel')}</h3>
          </div>
        </div>

        <p class="detail__price">${escapeHtml(deal.priceRaw || formatPrice(deal.price))}</p>

        <dl class="detail__facts">
          <div><dt>Fairer Marktwert</dt><dd>${escapeHtml(formatPrice(ai.fairPrice))}</dd></div>
          <div><dt>Ersparnis</dt><dd>${Number.isFinite(ai.savingsPct) ? `${ai.savingsPct} %` : '–'}</dd></div>
          <div><dt>Ort</dt><dd>${escapeHtml(deal.location || '–')}</dd></div>
          <div><dt>Inseriert</dt><dd>${escapeHtml(formatDateTime(deal.postedAt))}</dd></div>
          <div><dt>Gefunden</dt><dd>${escapeHtml(formatDateTime(deal.firstSeenAt))}</dd></div>
          <div><dt>Bewertung</dt><dd>${escapeHtml(ai.engine ?? '–')}</dd></div>
        </dl>

        <h4>KI-Bewertung</h4>
        <p>${escapeHtml(ai.reasoning || 'Keine Begründung verfügbar.')}</p>
        ${highlights ? `<p class="detail__muted">${highlights}</p>` : ''}

        <h4>Warnsignale</h4>
        ${redFlags}

        ${attributesHtml}
        ${historyHtml}

        <h4>Beschreibung</h4>
        <p class="detail__description">${escapeHtml(deal.description || 'Keine Beschreibung vorhanden.')}</p>

        <a class="btn btn--primary" href="${escapeHtml(deal.url)}" target="_blank" rel="noopener noreferrer">
          Anzeige auf Kleinanzeigen öffnen ↗
        </a>
      </div>`;

    if (typeof el.detail.showModal === 'function') {
      el.detail.showModal();
    } else {
      el.detail.setAttribute('open', '');
    }
  }

  function setStatus(meta) {
    const engine = meta?.engine ?? '–';
    const friendly = engine.startsWith('ai:')
      ? `KI (${engine.slice(3)})`
      : (meta?.aiConfigured
        ? 'Heuristik (KI nicht verfügbar)'
        : 'Heuristik (kein KI-Schlüssel hinterlegt)');

    el.status.innerHTML = `Letzter Scan: <strong>${escapeHtml(formatDateTime(meta?.generatedAt ?? state.generatedAt))}</strong>`;
    el.statusSub.textContent = [
      `Bewertung: ${friendly}`,
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

    el.minScore.addEventListener('input', () => {
      state.minScore = Number(el.minScore.value);
      el.minScoreOut.textContent = el.minScore.value;
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
      state.minScore = 0;
      state.sort = 'score';
      state.onlyNew = false;

      el.search.value = '';
      el.query.value = '';
      el.minScore.value = '0';
      el.minScoreOut.textContent = '0';
      el.sort.value = 'score';
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
      setStatus(meta ?? { generatedAt: state.generatedAt, engine: data.engine });
      render();

      writeLastVisit(state.generatedAt);
    } catch (error) {
      el.feed.setAttribute('aria-busy', 'false');
      el.status.textContent = 'Daten konnten nicht geladen werden.';
      el.statusSub.textContent = String(error.message ?? error);
      el.empty.hidden = false;
      el.empty.innerHTML = `Die Datei <code>data/deals.json</code> ist nicht erreichbar.<br>`
        + `Starte den Workflow <em>„AnzeigenPiraten Scan“</em> in GitHub Actions oder führe `
        + `<code>npm run scan</code> in <code>scripts/</code> lokal aus.`;
    }
  }

  init();
})();