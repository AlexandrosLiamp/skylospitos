// Spitogatos v0.2 — consolidated view.
//
// Runs alongside src/content.js in the same content-script isolated world.
// See PLAN_V02.md at the repo root for the full feature plan and rationale.
//
// M0 research findings (2026-07-20), used by everything below:
//
//   Endpoint: /n_api/v1/properties/search-results-map?…&offset={0,300,600,…}
//     - 300 listings per request, JSON, no auth required. Same query string as
//       the card endpoint, same property objects, 10x the page size.
//     - Response: { data: { "<geohash>_exact": { properties: [...] }, … },
//                   count, total }
//     - The obvious-looking /search-results endpoint returns the same listings
//       30 at a time and is what the card grid uses; we deliberately do not.
//       On Πάτρα rentals that's 347 requests vs 34 for identical output
//       (589 private listings either way, verified 2026-07-25). Sustained
//       concurrency against the 347-request version drew HTTP 405 soft
//       throttling from the server; the 34-request version does not.
//     - offset paging is disjoint and stable (0 overlap across offsets
//       0/300/600), and limit/perPage are ignored — 300 is a hard cap.
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
const MAP_PAGE_SIZE = 300; // the -map endpoint's own cap; limit/perPage are ignored, same as the card endpoint's 30
const CHUNK_SIZE = 6;
const CHUNK_DELAY_MS = 200;
const BACKOFF_BASE_DELAY_MS = 200; // starting delay for the one-shot 429/405 backoff, not inter-request pacing

const cache = new Map(); // canonicalUrl -> { fetchedAt, canonical, listings, totalListings, privateCount, requests, prefix }

function canonicalizeUrl(href) {
  // Group all /selida_N variants of the same search under one cache key,
  // but keep the query string — sort/price/filter params live there and
  // a different sort is a different result set.
  try {
    const u = new URL(href);
    u.pathname = u.pathname.replace(/\/selida_\d+(?=\/|$)/, '');
    u.hash = '';
    return u.toString();
  } catch {
    return href.replace(/\/selida_\d+(?=\/|$|\?)/, '').replace(/#.*$/, '');
  }
}

function findApiCallUrl() {
  // Two related endpoints exist, both driven by the identical query string
  // (the search itself); only the pathname differs:
  //   /search-results       — paginated card data, { data: [...], pagination, meta }
  //   /search-results-map   — the map's pin data, { data: {bucket:...}, count, total }
  //
  // We want the -map one. It returns the same property objects as the card
  // endpoint (same fields, including the enquirerId private flag) but 300 at
  // a time instead of 30, which is the difference between 34 requests and 347
  // on a city-sized search. Verified equivalent, not assumed: on Ν. Άρτας
  // rentals both endpoints yield the same 60 listings and the exact same 45
  // private ids; on Πάτρα rentals both yield the same 589 private listings.
  //
  // So whichever of the two the site happened to fire, take its params and
  // force the pathname to -map.
  const entries = performance.getEntriesByType('resource');
  const byPath = (path) =>
    entries.filter((e) => {
      try {
        return new URL(e.name).pathname === path;
      } catch {
        return false;
      }
    });

  const hit = byPath(API_MAP_PATH).pop() || byPath(API_LIST_PATH).pop();
  if (!hit) return null;
  const u = new URL(hit.name);
  u.pathname = API_MAP_PATH;
  return u.toString();
}

async function waitForApiCall(timeoutMs = 5000, pollMs = 150, signal) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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

async function fetchPageByOffset(baseUrl, offset, signal) {
  const url = new URL(baseUrl);
  url.searchParams.set('offset', String(offset));
  const res = await fetch(url.toString(), { credentials: 'include', signal });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} at offset ${offset}`);
    err.status = res.status;
    err.offset = offset;
    throw err;
  }
  const json = await res.json();

  // The map endpoint groups listings into geohash buckets keyed by location
  // ({ data: { "sqz3wd1p_exact": { properties: [...] }, … }, count, total }).
  // Bucket identity only says where to drop a pin, which we never render, so
  // flatten straight back to a plain listing array.
  const items = [];
  for (const bucket of Object.values(json.data || {})) {
    if (Array.isArray(bucket?.properties)) items.push(...bucket.properties);
  }
  return { items, total: json.total ?? items.length };
}

async function fetchWithBackoff(apiUrl, offset, signal, backoffState) {
  // One retry on 429/405 per session, with a growing delay. Anything else
  // bubbles up to renderConsolidationError so the user can decide. 405 shows
  // up alongside 429 when the server is throttling (see fetchChunkWithBackoff)
  // — the opening request needs the same protection, since a throttled first
  // request would otherwise fail the whole run instantly with no retry at all.
  try {
    return await fetchPageByOffset(apiUrl, offset, signal);
  } catch (err) {
    if ((err.status === 429 || err.status === 405) && backoffState.tries < 1) {
      backoffState.tries++;
      backoffState.delayMs = Math.min(backoffState.delayMs * 4, 2000);
      console.warn(
        `[SG-V02] ${err.status} at offset ${offset} — backing off to ${backoffState.delayMs}ms`
      );
      await new Promise((r) => setTimeout(r, backoffState.delayMs));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return await fetchPageByOffset(apiUrl, offset, signal);
    }
    throw err;
  }
}

async function fetchChunkWithBackoff(apiUrl, offsets, signal, backoffState) {
  // Concurrency means several offsets can 429 at once, so settle the whole
  // batch before deciding anything. Abort is checked before classifying so an
  // AbortError (which has no .status) never gets mistaken for a real failure.
  const settled = await Promise.allSettled(
    offsets.map((offset) => fetchPageByOffset(apiUrl, offset, signal))
  );
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === 'rejected') failures.push({ offset: offsets[i], err: r.reason });
  });
  if (failures.length === 0) return settled.map((r) => r.value);

  // Lowest offset first so renderConsolidationError's page-number math points at
  // the earliest failing page, matching how the old serial loop always died.
  const lowest = (list) => list.reduce((a, b) => (a.offset <= b.offset ? a : b));

  // 405 shows up alongside 429 when the live site throttles (confirmed
  // empirically — a lone retry of a 405'd offset succeeds instantly, so it's a
  // soft burst-throttle, not a real client error). Treat it the same as 429.
  // This mattered a lot back when a city search meant 347 requests; at 34 it
  // has not fired once, but it stays as cheap insurance.
  const isThrottle = (status) => status === 429 || status === 405;
  const realErrors = failures.filter((f) => !isThrottle(f.err?.status));
  if (realErrors.length > 0) throw lowest(realErrors).err;

  // Every failure is a throttle: one retry episode for the whole session, not per request.
  if (backoffState.tries >= 1) throw lowest(failures).err;
  backoffState.tries++;
  backoffState.delayMs = Math.min(backoffState.delayMs * 4, 2000);
  console.warn(
    `[SG-V02] ${failures.length} × 429/405 in chunk — backing off to ${backoffState.delayMs}ms and retrying`
  );
  await new Promise((r) => setTimeout(r, backoffState.delayMs));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const retryOffsets = failures.map((f) => f.offset);
  const retried = await Promise.allSettled(
    retryOffsets.map((offset) => fetchPageByOffset(apiUrl, offset, signal))
  );
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const retryFailures = [];
  const retryValueByOffset = new Map();
  retried.forEach((r, i) => {
    if (r.status === 'rejected') retryFailures.push({ offset: retryOffsets[i], err: r.reason });
    else retryValueByOffset.set(retryOffsets[i], r.value);
  });
  if (retryFailures.length > 0) throw lowest(retryFailures).err;

  return settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : retryValueByOffset.get(offsets[i])
  );
}

async function fetchAllPagesForCurrentSearch(signal, onProgress = () => {}) {
  const canonical = canonicalizeUrl(location.href);
  if (cache.has(canonical)) {
    console.log('[SG-V02] cache hit for', canonical);
    return cache.get(canonical);
  }

  const apiUrl = await waitForApiCall(5000, 150, signal);
  if (!apiUrl) {
    console.warn(
      '[SG-V02] never observed a /n_api/v1/properties/search-results[-map] call in 5s — page may not be a search results page'
    );
    return null;
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  console.log('[SG-V02] fetching all pages for', canonical);

  const backoffState = { tries: 0, delayMs: BACKOFF_BASE_DELAY_MS };
  const first = await fetchWithBackoff(apiUrl, 0, signal, backoffState);
  const total = first.total;
  const requests = Math.max(1, Math.ceil(total / MAP_PAGE_SIZE));

  // Dedupe by id while collecting. Offset paging is a snapshot of a live list:
  // if a listing is inserted between two requests every later offset shifts by
  // one and the boundary listing comes back twice.
  const seen = new Set();
  const allListings = [];
  const collect = (items) => {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      allListings.push(item);
    }
  };

  collect(first.items);
  onProgress(1, requests);

  const remainingOffsets = [];
  for (let o = MAP_PAGE_SIZE; o < total; o += MAP_PAGE_SIZE) remainingOffsets.push(o);

  for (let i = 0; i < remainingOffsets.length; i += CHUNK_SIZE) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const chunkOffsets = remainingOffsets.slice(i, i + CHUNK_SIZE);
    const chunkPages = await fetchChunkWithBackoff(apiUrl, chunkOffsets, signal, backoffState);
    for (const page of chunkPages) collect(page.items);

    onProgress(1 + Math.min(i + CHUNK_SIZE, remainingOffsets.length), requests);
  }

  const privateOnly = allListings.filter((i) => !!i.enquirerId);
  const prefix = derivePrefix(allListings.map((i) => i.id));

  const result = {
    fetchedAt: Date.now(),
    canonical,
    totalListings: allListings.length,
    privateCount: privateOnly.length,
    listings: privateOnly,
    requests,
    prefix,
  };
  cache.set(canonical, result);

  console.log(
    `[SG-V02] fetched ${requests} request${requests !== 1 ? 's' : ''} — ${allListings.length} listings total, ${privateOnly.length} private (prefix="${prefix ?? '?'}")`
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
let v02Progress = null; // { fetched, total } during a fetch, else null
let lastFullHref = location.href;
let activeController = null;

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
  // aria-busy + a data attribute for the loading state, not `disabled`:
  // a disabled button ignores clicks, but we want the user to be able to
  // cancel a running fetch by clicking off mid-load.
  btn.setAttribute('aria-busy', v02Loading ? 'true' : 'false');
  btn.toggleAttribute('data-loading', v02Loading);
  const label = btn.querySelector('.sg-v02-toggle__label');
  if (label) {
    label.textContent = v02Loading
      ? (v02Progress ? `${V02_TOGGLE_LOADING} ${v02Progress.fetched}/${v02Progress.total}` : V02_TOGGLE_LOADING)
      : V02_TOGGLE_LABEL;
  }
  btn.title = consolidateEnabled
    ? 'Ενεργό — κλικ για να αφαιρέσεις τη συγκεντρωτική προβολή'
    : 'Δείξε όλες τις ιδιωτικές αγγελίες από όλες τις σελίδες της αναζήτησης';
}

async function onV02Click() {
  // If loading and the click is turning consolidation ON again, ignore.
  // Turning OFF mid-load is allowed and aborts the in-flight fetch.
  if (v02Loading && !consolidateEnabled) return;
  consolidateEnabled = !consolidateEnabled;
  chrome.storage.sync.set({ [V02_STORAGE_KEY]: consolidateEnabled });
  if (consolidateEnabled) {
    await runConsolidation();
  } else {
    if (activeController) activeController.abort();
    removeConsolidatedSection();
    v02Loading = false;
    updateV02ToggleUI();
  }
}

function removeConsolidatedSection() {
  const existing = document.getElementById(SECTION_ID);
  if (existing) existing.remove();
}

function renderConsolidationError(pageNumber, message, canonical) {
  const existing = document.getElementById(SECTION_ID);
  if (existing) existing.remove();

  const section = document.createElement('section');
  section.id = SECTION_ID;
  section.className = 'sg-v02-consolidated sg-v02-consolidated--error';

  const header = document.createElement('div');
  header.className = 'sg-v02-consolidated__header';
  header.textContent = 'Απέτυχε η συγκεντρωτική προβολή';
  section.appendChild(header);

  const note = document.createElement('div');
  note.className = 'sg-v02-consolidated__note';
  note.textContent =
    pageNumber != null
      ? `Σφάλμα στη σελίδα ${pageNumber}: ${message}`
      : `Σφάλμα: ${message}`;
  section.appendChild(note);

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'sg-v02-consolidated__retry';
  retry.textContent = 'Δοκιμάστε ξανά';
  retry.addEventListener('click', () => {
    cache.delete(canonical);
    runConsolidation();
  });
  section.appendChild(retry);

  const resultsSection = document.querySelector('section.search-results__results');
  if (resultsSection) resultsSection.after(section);
  else document.body.appendChild(section);
}

async function runConsolidation() {
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const controller = activeController;

  v02Loading = true;
  v02Progress = null;
  updateV02ToggleUI();
  try {
    const result = await fetchAllPagesForCurrentSearch(controller.signal, (fetched, total) => {
      if (controller !== activeController) return;
      v02Progress = { fetched, total };
      updateV02ToggleUI();
    });
    if (controller.signal.aborted) return;
    renderConsolidatedSection(result);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error('[SG-V02] fetch pipeline failed:', err);
    // Report the failure in the site's own 30-per-page terms even though we
    // fetch 300 at a time — "σελίδα 11" is something the user can locate.
    const pageNumber = err?.offset != null ? Math.floor(err.offset / 30) + 1 : null;
    renderConsolidationError(pageNumber, err?.message || String(err), canonicalizeUrl(location.href));
  } finally {
    if (controller === activeController) {
      v02Loading = false;
      v02Progress = null;
      updateV02ToggleUI();
    }
  }
}

console.log('[SG-V02] consolidate.js loaded');

// Watch the DOM so we can (a) attach the v0.2 toggle once the v1 button
// appears in the site's toolbar, (b) re-render if the v1 button state
// flips (its button lives outside the search-results section but its
// data-on attribute changes via v1's click handler — we listen to storage
// events for that separately), and (c) detect Vue-driven navigation so
// we invalidate the cache on a real search change or re-dedupe against
// the newly visible page on a plain paginator click. Debounced at 250ms
// so we run once after Vue's re-render settles, not on every mutation.
let v02DomTimer = null;
new MutationObserver(() => {
  if (v02DomTimer) clearTimeout(v02DomTimer);
  v02DomTimer = setTimeout(() => {
    v02DomTimer = null;
    ensureV02Toggle();
    handlePossibleNav();
  }, 250);
}).observe(document.body, { childList: true, subtree: true });

function handlePossibleNav() {
  const currentHref = location.href;
  if (currentHref === lastFullHref) return;
  const prevCanonical = canonicalizeUrl(lastFullHref);
  const nowCanonical = canonicalizeUrl(currentHref);
  lastFullHref = currentHref;

  if (!consolidateEnabled) return;

  if (nowCanonical !== prevCanonical) {
    // Different search (base path or sort/filter param): drop the stale
    // section, invalidate the previous canonical's cache entry so retrying
    // that URL later re-fetches fresh data, cancel any in-flight fetch
    // that was still targeting the old search, and re-run for the new URL.
    cache.delete(prevCanonical);
    if (activeController) activeController.abort();
    removeConsolidatedSection();
    runConsolidation();
  } else {
    // Same search, different /selida_N — the site re-rendered the grid,
    // so re-run render for a fresh dedupe against the newly visible ids.
    const cached = cache.get(nowCanonical);
    if (cached) renderConsolidatedSection(cached);
  }
}

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
