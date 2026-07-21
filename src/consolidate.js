// Spitogatos v0.2 — consolidated view.
//
// Runs alongside src/content.js in the same content-script isolated world.
// See PLAN_V02.md at the repo root for the full feature plan and rationale.
//
// M0 research findings (2026-07-20), used by everything below:
//
//   Endpoint: /n_api/v1/properties/search-results?…&offset={0,30,60,…}
//     - 30 listings per page, JSON, no auth required.
//     - Response: { data: [...], pagination: {currentPage, lastPage, offset,
//                                             perPage, totalResults}, meta: {...} }
//     - Rate: 6 rapid sequential calls succeeded in 1.8s with no throttling,
//       ~300ms latency each. Using 200ms delay between calls as a good citizen.
//
//   Per-item private flag: !!item.enquirerId
//     - Matches DOM detection exactly: 17/30 on Arta rentals page 1 (matches
//       the v1 M1 count), 30/30 on Arta rentals page 2 (matches v1 M3 finding).
//     - item.reAgent === null gives the same answer — either signal works.
//
//   Deriving the API URL:
//     - The site's Vue app calls the endpoint for the current search before
//       we run. Its entry lives in performance.getEntriesByType('resource')
//       (Performance API is shared between MAIN and isolated worlds).
//     - We grab that URL, keep the query string, and only swap `offset`.
//
//   Deriving the /aggelia/... link for a card:
//     - DOM aggelia URLs have a 2-char category prefix + the numeric item id
//       (e.g. /aggelia/2120192368 for item id 20192368 on rentals+residential).
//     - Prefix varies by listing type / category, so we derive it at runtime
//       from a DOM card that's already on the page.

const API_LIST_PATH = '/n_api/v1/properties/search-results';
const API_MAP_PATH = '/n_api/v1/properties/search-results-map';
const PAGE_DELAY_MS = 200;
const MAX_PAGES = 20;

const cache = new Map(); // canonicalUrl -> { fetchedAt, canonical, listings, totalListings, privateCount, lastPage }

function canonicalizeUrl(href) {
  // Group all /selida_N variants of the same search under one cache key.
  return href.replace(/\/selida_\d+(?=\/|$|\?)/, '').replace(/[?#].*$/, '');
}

function findApiCallUrl() {
  // Two related endpoints exist and both match a naive substring filter:
  //   /search-results       — paginated card data, { data: [...], pagination, meta }
  //   /search-results-map   — geo-bucketed pin data for the map, { data: {bucket:...}, count, total }
  // We want the plain one. On some cold loads only the -map call has fired,
  // so we fall back to it and rewrite its pathname (params are identical).
  const entries = performance.getEntriesByType('resource');
  const byPath = (path) =>
    entries.filter((e) => {
      try {
        return new URL(e.name).pathname === path;
      } catch {
        return false;
      }
    });

  const list = byPath(API_LIST_PATH).pop();
  if (list) return list.name;

  const map = byPath(API_MAP_PATH).pop();
  if (map) {
    const u = new URL(map.name);
    u.pathname = API_LIST_PATH;
    return u.toString();
  }
  return null;
}

async function waitForApiCall(timeoutMs = 5000, pollMs = 150) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const url = findApiCallUrl();
    if (url) return url;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

function derivePrefix(knownIds) {
  // Match a DOM aggelia link's numeric suffix against any known API item id
  // and return the leading chars — the category prefix (e.g. "21" for rent+home).
  const links = document.querySelectorAll(
    'article.ordered-element a[href*="/aggelia/"]'
  );
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/aggelia\/(\d+)/);
    if (!match) continue;
    const fullId = match[1];
    for (const knownId of knownIds) {
      const s = String(knownId);
      if (fullId.length > s.length && fullId.endsWith(s)) {
        return fullId.slice(0, fullId.length - s.length);
      }
    }
  }
  return null;
}

async function fetchPageByOffset(baseUrl, offset) {
  const url = new URL(baseUrl);
  url.searchParams.set('offset', String(offset));
  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} at offset ${offset}`);
  return res.json();
}

async function fetchAllPagesForCurrentSearch() {
  const canonical = canonicalizeUrl(location.href);
  if (cache.has(canonical)) {
    console.log('[SG-V02] cache hit for', canonical);
    return cache.get(canonical);
  }

  const apiUrl = await waitForApiCall();
  if (!apiUrl) {
    console.warn(
      '[SG-V02] never observed a /n_api/v1/properties/search-results call in 5s — page may not be a search results page'
    );
    return null;
  }

  console.log('[SG-V02] fetching all pages for', canonical);

  const page1 = await fetchPageByOffset(apiUrl, 0);
  const perPage = page1.pagination?.perPage ?? 30;
  const declaredLastPage = page1.pagination?.lastPage ?? 1;
  const lastPage = Math.min(declaredLastPage, MAX_PAGES);
  const truncated = declaredLastPage > MAX_PAGES;

  const allListings = [...page1.data];
  for (let p = 2; p <= lastPage; p++) {
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    const pageData = await fetchPageByOffset(apiUrl, (p - 1) * perPage);
    allListings.push(...pageData.data);
  }

  const privateOnly = allListings.filter((i) => !!i.enquirerId);
  const prefix = derivePrefix(allListings.map((i) => i.id));

  const result = {
    fetchedAt: Date.now(),
    canonical,
    totalListings: allListings.length,
    privateCount: privateOnly.length,
    listings: privateOnly,
    lastPage,
    truncated,
    prefix,
  };
  cache.set(canonical, result);

  console.log(
    `[SG-V02] fetched ${lastPage} page${lastPage !== 1 ? 's' : ''} — ${allListings.length} listings total, ${privateOnly.length} private (prefix="${prefix ?? '?'}")${truncated ? ` [truncated at ${MAX_PAGES}-page cap]` : ''}`
  );
  return result;
}

// ---- M2: rendering ----

const SECTION_ID = 'sg-v02-consolidated';

function buildCard(item, prefix) {
  const link = document.createElement('a');
  link.className = 'sg-v02-card';
  link.href = prefix ? `/aggelia/${prefix}${item.id}` : '#';
  link.target = '_blank';
  link.rel = 'noopener';

  const img = document.createElement('img');
  img.className = 'sg-v02-card__img';
  img.loading = 'lazy';
  img.src = item.mainImageURL || '';
  img.alt = '';
  link.appendChild(img);

  const body = document.createElement('div');
  body.className = 'sg-v02-card__body';

  const price = document.createElement('div');
  price.className = 'sg-v02-card__price';
  const priceStr =
    typeof item.price === 'number'
      ? `${item.price.toLocaleString('el-GR')}€${item.buy_or_rent === '1' ? ' / μήνα' : ''}`
      : '—';
  price.textContent = priceStr;
  body.appendChild(price);

  const meta = document.createElement('div');
  meta.className = 'sg-v02-card__meta';
  const bits = [];
  if (item.sq_meters) bits.push(`${item.sq_meters} τ.μ.`);
  if (item.floorNumber && item.floorNumber > 0) bits.push(`${item.floorNumber}ος ορ.`);
  if (item.no_of_bathrooms)
    bits.push(`${item.no_of_bathrooms} μπάνι${item.no_of_bathrooms > 1 ? 'α' : 'ο'}`);
  meta.textContent = bits.join(' · ');
  body.appendChild(meta);

  const geo = document.createElement('div');
  geo.className = 'sg-v02-card__geo';
  geo.textContent = item.geography || '';
  body.appendChild(geo);

  link.appendChild(body);
  return link;
}

function currentPageAggeliaIds() {
  const ids = new Set();
  document
    .querySelectorAll('article.ordered-element a[href*="/aggelia/"]')
    .forEach((a) => {
      const match = (a.getAttribute('href') || '').match(/\/aggelia\/(\d+)/);
      if (match) ids.add(match[1]);
    });
  return ids;
}

function renderConsolidatedSection(result) {
  if (!result) return;

  const existing = document.getElementById(SECTION_ID);
  if (existing) existing.remove();

  // Dedupe against listings already visible on the current page.
  const skip = currentPageAggeliaIds();
  const toRender = result.listings.filter((item) => {
    const fullId = result.prefix ? `${result.prefix}${item.id}` : String(item.id);
    return !skip.has(fullId);
  });

  const section = document.createElement('section');
  section.id = SECTION_ID;
  section.className = 'sg-v02-consolidated';

  const header = document.createElement('div');
  header.className = 'sg-v02-consolidated__header';
  header.textContent =
    toRender.length > 0
      ? `Επιπλέον ιδιωτικές αγγελίες από όλες τις σελίδες (${toRender.length})`
      : 'Επιπλέον ιδιωτικές αγγελίες';
  section.appendChild(header);

  if (toRender.length === 0) {
    const note = document.createElement('div');
    note.className = 'sg-v02-consolidated__note';
    note.textContent = result.privateCount === 0
      ? 'Δεν βρέθηκαν ιδιωτικές αγγελίες σε αυτή την αναζήτηση.'
      : 'Όλες οι ιδιωτικές αγγελίες φαίνονται ήδη σε αυτή τη σελίδα.';
    section.appendChild(note);
  } else {
    const grid = document.createElement('div');
    grid.className = 'sg-v02-consolidated__grid';
    for (const item of toRender) {
      grid.appendChild(buildCard(item, result.prefix));
    }
    section.appendChild(grid);
  }

  if (result.truncated) {
    const cap = document.createElement('div');
    cap.className = 'sg-v02-consolidated__note';
    cap.textContent = `Δείχνονται τα πρώτα ${MAX_PAGES * 30} αποτελέσματα. Περιορίστε την αναζήτηση για περισσότερα.`;
    section.appendChild(cap);
  }

  const resultsSection = document.querySelector('section.search-results__results');
  if (resultsSection) {
    resultsSection.after(section);
  } else {
    document.body.appendChild(section);
  }
}

// ---- M3: secondary toggle UI ----

const V02_TOGGLE_ID = 'sg-v02-toggle';
const V02_TOGGLE_LABEL = 'Δείξε όλες';
const V02_TOGGLE_LOADING = 'Φόρτωση…';
const V02_STORAGE_KEY = 'consolidateEnabled';
const V1_TOGGLE_ID = 'sg-filter-toggle';

let consolidateEnabled = false;
let v02Loading = false;

function ensureV02Toggle() {
  // v0.2 button lives immediately after the v1 "Μόνο Ιδιώτες" button so
  // both filter controls read as one toolbar group. Only shown when the
  // v1 filter is on (nothing to consolidate if we're showing all listings).
  const v1Btn = document.getElementById(V1_TOGGLE_ID);
  if (!v1Btn) return; // v1 button not injected yet; will retry via observer
  const v1On = v1Btn.getAttribute('data-on') === 'true';
  const existing = document.getElementById(V02_TOGGLE_ID);

  if (!v1On) {
    if (existing) existing.remove();
    return;
  }

  if (existing && existing.previousElementSibling === v1Btn) {
    updateV02ToggleUI(existing);
    return;
  }

  const btn = existing || buildV02Toggle();
  v1Btn.insertAdjacentElement('afterend', btn);
  updateV02ToggleUI(btn);
}

function buildV02Toggle() {
  const btn = document.createElement('button');
  btn.id = V02_TOGGLE_ID;
  btn.className = 'sg-v02-toggle';
  btn.type = 'button';
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML =
    '<span class="sg-v02-toggle__dot"></span>' +
    '<span class="sg-v02-toggle__label"></span>';
  btn.addEventListener('click', onV02Click);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onV02Click();
    }
  });
  return btn;
}

function updateV02ToggleUI(btn) {
  btn = btn || document.getElementById(V02_TOGGLE_ID);
  if (!btn) return;
  btn.setAttribute('data-on', consolidateEnabled ? 'true' : 'false');
  btn.setAttribute('aria-pressed', consolidateEnabled ? 'true' : 'false');
  btn.disabled = v02Loading;
  const label = btn.querySelector('.sg-v02-toggle__label');
  if (label) label.textContent = v02Loading ? V02_TOGGLE_LOADING : V02_TOGGLE_LABEL;
  btn.title = consolidateEnabled
    ? 'Ενεργό — κλικ για να αφαιρέσεις τη συγκεντρωτική προβολή'
    : 'Δείξε όλες τις ιδιωτικές αγγελίες από όλες τις σελίδες της αναζήτησης';
}

async function onV02Click() {
  if (v02Loading) return;
  consolidateEnabled = !consolidateEnabled;
  chrome.storage.sync.set({ [V02_STORAGE_KEY]: consolidateEnabled });
  if (consolidateEnabled) {
    await runConsolidation();
  } else {
    removeConsolidatedSection();
    updateV02ToggleUI();
  }
}

function removeConsolidatedSection() {
  const existing = document.getElementById(SECTION_ID);
  if (existing) existing.remove();
}

async function runConsolidation() {
  v02Loading = true;
  updateV02ToggleUI();
  try {
    const result = await fetchAllPagesForCurrentSearch();
    renderConsolidatedSection(result);
  } catch (err) {
    console.error('[SG-V02] fetch pipeline failed:', err);
  } finally {
    v02Loading = false;
    updateV02ToggleUI();
  }
}

console.log('[SG-V02] consolidate.js loaded');

// Watch the DOM so we can (a) attach the v0.2 toggle once the v1 button
// appears in the site's toolbar, and (b) re-render if the v1 button state
// flips (its button lives outside the search-results section but its
// data-on attribute changes via v1's click handler — we listen to storage
// events for that separately). A 250ms debounce is enough here; this
// isn't on any hot path.
let v02DomTimer = null;
new MutationObserver(() => {
  if (v02DomTimer) clearTimeout(v02DomTimer);
  v02DomTimer = setTimeout(() => {
    v02DomTimer = null;
    ensureV02Toggle();
  }, 250);
}).observe(document.body, { childList: true, subtree: true });

// Also listen for v1's toggle flipping via storage changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.filterEnabled) {
    ensureV02Toggle();
    // If v1 is turned off, drop the consolidated section too.
    if (!changes.filterEnabled.newValue) removeConsolidatedSection();
  }
  if (changes[V02_STORAGE_KEY]) {
    consolidateEnabled = !!changes[V02_STORAGE_KEY].newValue;
    updateV02ToggleUI();
  }
});

// Initial hydration: load persisted consolidateEnabled and, if on, run
// consolidation once the site has settled.
chrome.storage.sync.get({ [V02_STORAGE_KEY]: false }, async (stored) => {
  consolidateEnabled = !!stored[V02_STORAGE_KEY];
  await new Promise((r) => setTimeout(r, 1500));
  ensureV02Toggle();
  if (consolidateEnabled) await runConsolidation();
});
