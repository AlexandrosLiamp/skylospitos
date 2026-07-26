// Spitogatos v0.4 — consolidated view.
//
// Runs alongside src/content.js in the same content-script isolated world.
// See PLAN_V02.md at the repo root for the original feature plan.
//
// What this does: fetches every page of the current search, keeps only the
// private-seller listings, and takes over the site's own results column with
// them — the site's cards and paginator are hidden, ours stand in their place
// re-paginated at the site's own 30-per-page. A search with 960 listings of
// which 58 are private stops being 32 mostly-empty pages and becomes 2 full ones.
//
// There's no toggle of its own here. content.js owns the one button and the
// `filterEnabled` state behind it; this file reads that state and reports fetch
// progress back through setToggleProgress(). Both are top-level declarations in
// a script the manifest loads first, which is what makes that legal.
//
// M0 research findings (2026-07-20), used by everything below:
//
//   Endpoints — same query string (the search itself), only the pathname differs:
//     /n_api/v1/properties/search-results      → 30/request, { data: [...],
//         pagination: { totalResults, perPage, lastPage }, meta }. What the
//         card grid itself uses. Includes each listing's description text.
//     /n_api/v1/properties/search-results-map  → 300/request, { data: {
//         "<geohash>_exact": { properties: [...] }, … }, count, total }. The
//         map's pin data: same property objects, 10x the page size, but the
//         description field comes back empty.
//     Both are JSON and need no auth. offset paging is disjoint and stable,
//     and limit/perPage are ignored — the page sizes above are hard caps.
//
//   Which one we use is chosen per search (see planFetch): the card endpoint
//   while its request count stays inside LIST_REQUEST_BUDGET, because its
//   descriptions are what make our cards look like the site's; the map
//   endpoint beyond that, because a wide search is otherwise hundreds of
//   requests. Πάτρα rentals unfiltered is 347 card requests vs 34 map ones,
//   and sustained concurrency at 347 drew HTTP 405 soft throttling from the
//   server (2026-07-25); the map version does not.
//
//   Response locale is set by the Accept-Language header, not a query param.
//     Without it the API answers in English ("Skagiopouleio (Patra)") even on
//     the Greek site, so we send one derived from <html lang>.
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
//     - We grab that URL, keep the query string, and swap the pathname/offset.
//
//   Deriving the /aggelia/... link for a card:
//     - DOM aggelia URLs have a 2-char category prefix + the numeric item id
//       (e.g. /aggelia/2120192368 for item id 20192368 on rentals+residential).
//     - Prefix varies by listing type / category, so we derive it at runtime
//       from a DOM card that's already on the page.
//
// v0.3 research findings (2026-07-25), which the takeover rendering rests on:
//
//   The site's card styles are Vue scoped CSS — every rule is qualified by a
//   build-specific attribute (`.tile__img .img__wrap[data-v-e2848626]`). Class
//   names alone inherit nothing. So we harvest the attribute names off a live
//   DOM card and stamp them onto ours; the site's own stylesheet then does all
//   the visual work and our cards track its redesigns for free. The attribute
//   values change every deploy, which is exactly why nothing here is hardcoded.
//
//   Same reasoning for the label text the API doesn't carry: `subtype` is a
//   numeric code, `floorNumber` is an enum (3 → "ΙΣ", 4 → "ΗΜ", 6 → "1ος"),
//   and the units next to the room counts are localised strings. Rather than
//   hardcode a table that would be wrong in English and stale after a site
//   change, we pair the ~30 DOM cards against their API records on every run
//   and read the mapping straight off the page (learnFromDom), persisting what
//   we learn so a rarely-seen subtype stays known.
//
//   Our cards go in with no wrapper at all — see the comment above
//   CARD_SELECTOR for why `display: contents` isn't an option.
//
// v0.4 research findings (2026-07-25):
//
//   Card-hover-highlights-the-pin is one CSS class, `focused`, that the site
//   puts on the marker; see the map section below for how we pair a listing to
//   a marker and what to do when the map has no pin for it.

const API_LIST_PATH = '/n_api/v1/properties/search-results';
const API_MAP_PATH = '/n_api/v1/properties/search-results-map';
const LIST_PAGE_SIZE = 30; // the card endpoint's own cap; limit/perPage are ignored
const MAP_PAGE_SIZE = 300; // the map endpoint's own cap, same story
// Past this many card-endpoint requests a search is wide enough that the
// descriptions aren't worth the traffic, and we switch to the map endpoint.
// 40 covers ~1200 listings, which is any search a person has actually narrowed.
const LIST_REQUEST_BUDGET = 40;
const CHUNK_SIZE = 6;
const CHUNK_DELAY_MS = 200;
const BACKOFF_BASE_DELAY_MS = 200; // starting delay for the one-shot 429/405 backoff, not inter-request pacing

const RESULTS_PER_PAGE = 30; // matches the site's own pagination.perPage

const cache = new Map(); // canonicalUrl -> { fetchedAt, canonical, listings, totalListings, privateCount, requests }

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

function apiHeaders() {
  // The API answers in English unless asked otherwise, regardless of which
  // locale of the site the user is on, so mirror <html lang> explicitly.
  const lang = document.documentElement.lang || 'el';
  const base = lang.split('-')[0];
  return { 'Accept-Language': base === lang ? lang : `${lang},${base};q=0.9` };
}

function findObservedSearchUrl() {
  // Return whichever of the two search endpoints the site fired, exactly as it
  // fired it. The value we're after is the query string — that's the search —
  // and callers pick the pathname they want with withPath(). A fresh page load
  // only fires the map one (the card data is server-rendered into the Nuxt
  // payload), so accepting either is what makes this work on a cold load.
  const entries = performance.getEntriesByType('resource');
  const byPath = (path) =>
    entries.filter((e) => {
      try {
        const url = new URL(e.name);
        // Origin as well as path. This URL ends up in a credentialed fetch,
        // and the resource timeline is not ours — anything else running in the
        // page can put an entry in it.
        return url.origin === location.origin && url.pathname === path;
      } catch {
        return false;
      }
    });

  const hit = byPath(API_LIST_PATH).pop() || byPath(API_MAP_PATH).pop();
  return hit ? hit.name : null;
}

async function waitForApiCall(timeoutMs = 5000, pollMs = 150, signal) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = findObservedSearchUrl();
    if (url) return url;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

function withPath(url, pathname) {
  const u = new URL(url);
  u.pathname = pathname;
  return u.toString();
}

function parseSearchResponse(json) {
  // Card endpoint: a plain array plus a pagination block.
  if (Array.isArray(json?.data)) {
    return {
      items: json.data,
      total: json.pagination?.totalResults ?? json.data.length,
    };
  }
  // Map endpoint: listings grouped into geohash buckets keyed by location.
  // Bucket identity only says where to drop a pin, which we never render, so
  // flatten straight back to a plain listing array.
  const items = [];
  for (const bucket of Object.values(json?.data || {})) {
    if (Array.isArray(bucket?.properties)) items.push(...bucket.properties);
  }
  return { items, total: json?.total ?? items.length };
}

async function fetchPageByOffset(baseUrl, offset, signal) {
  const url = new URL(baseUrl);
  url.searchParams.set('offset', String(offset));
  const res = await fetch(url.toString(), {
    credentials: 'include',
    headers: apiHeaders(),
    signal,
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} at offset ${offset}`);
    err.status = res.status;
    err.offset = offset;
    throw err;
  }
  return parseSearchResponse(await res.json());
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

async function planFetch(signal, backoffState) {
  // Decide which endpoint this particular search gets, and hand back its first
  // page so the decision costs nothing extra on the common path.
  const observed = await waitForApiCall(5000, 150, signal);
  if (!observed) return null;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const listUrl = withPath(observed, API_LIST_PATH);
  const first = await fetchWithBackoff(listUrl, 0, signal, backoffState);
  const listRequests = Math.max(1, Math.ceil(first.total / LIST_PAGE_SIZE));
  if (listRequests <= LIST_REQUEST_BUDGET) {
    return { apiUrl: listUrl, pageSize: LIST_PAGE_SIZE, first, requests: listRequests };
  }

  // Too wide for the card endpoint. The one request we just spent is the price
  // of finding that out; from here the map endpoint does it in a tenth of the calls.
  const mapUrl = withPath(observed, API_MAP_PATH);
  const mapFirst = await fetchWithBackoff(mapUrl, 0, signal, backoffState);
  const mapRequests = Math.max(1, Math.ceil(mapFirst.total / MAP_PAGE_SIZE));
  console.log(
    `[SG-V02] ${first.total} listings — too wide for the card endpoint (${listRequests} requests), using the map endpoint (${mapRequests})`
  );
  return { apiUrl: mapUrl, pageSize: MAP_PAGE_SIZE, first: mapFirst, requests: mapRequests };
}

async function fetchAllPagesForCurrentSearch(signal, onProgress = () => {}) {
  const canonical = canonicalizeUrl(location.href);
  if (cache.has(canonical)) {
    console.log('[SG-V02] cache hit for', canonical);
    return cache.get(canonical);
  }

  const backoffState = { tries: 0, delayMs: BACKOFF_BASE_DELAY_MS };
  const plan = await planFetch(signal, backoffState);
  if (!plan) {
    console.warn(
      '[SG-V02] never observed a /n_api/v1/properties/search-results[-map] call in 5s — page may not be a search results page'
    );
    return null;
  }

  console.log('[SG-V02] fetching all pages for', canonical);
  const { apiUrl, pageSize, first, requests } = plan;
  const total = first.total;

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
  for (let o = pageSize; o < total; o += pageSize) remainingOffsets.push(o);

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
  learnFromDom(allListings);

  const result = {
    fetchedAt: Date.now(),
    canonical,
    totalListings: allListings.length,
    privateCount: privateOnly.length,
    listings: privateOnly,
    requests,
  };
  cache.set(canonical, result);

  console.log(
    `[SG-V02] fetched ${requests} request${requests !== 1 ? 's' : ''} — ${allListings.length} listings total, ${privateOnly.length} private`
  );
  return result;
}

// ---- learning the site's presentation from the page itself ----

// Everything the API leaves as a code or omits entirely, read off the DOM by
// pairing the cards the site rendered against their own API records. Persisted
// per locale so a subtype seen once stays known on later searches.
const labels = {
  subs: {}, // "house|1"        -> "Διαμέρισμα"
  floors: {}, // floorNumber 6    -> { lead: "1", tail: "ος" }, 3 -> { lead: "ΙΣ", tail: "" }
  units: {}, // "i-icon-bedroom" -> "υ/δ"
  prefixes: {}, // "house|1"     -> "21"  (the /aggelia/ id prefix)
  updatedPrefix: '', // "Ανανεώθηκε: "
  perMonth: '', // "/ μήνα"
  pointHeader: '', // "%d ακίνητα βρέθηκαν σε αυτό το σημείο"
};
const LABELS_KEY = `sgLabels_${(document.documentElement.lang || 'el').split('-')[0]}`;
let labelsDirty = false;

function loadLabels() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [LABELS_KEY]: null }, (stored) => {
      // Losing the store is survivable — the next search relearns everything
      // from the page — but silence here would look like the site changed its
      // markup, so say which it was.
      if (chrome.runtime.lastError) {
        console.warn('[SG-V02] could not read learned labels:', chrome.runtime.lastError.message);
      } else if (stored[LABELS_KEY]) {
        Object.assign(labels, stored[LABELS_KEY]);
      }
      resolve();
    });
  });
}

function saveLabels() {
  if (!labelsDirty) return;
  labelsDirty = false;
  chrome.storage.local.set({ [LABELS_KEY]: labels }, () => {
    if (!chrome.runtime.lastError) return;
    console.warn('[SG-V02] could not persist learned labels:', chrome.runtime.lastError.message);
    labelsDirty = true; // let the next learning pass try again
  });
}

function formatPrice(value) {
  return value.toLocaleString(document.documentElement.lang || 'el-GR');
}

// The two things a listing needs before it can be drawn as anything — a card
// or a map pin — and both come out of what we learned off the page.
function aggeliaHref(item) {
  const prefix = labels.prefixes[`${item.category}|${item.buy_or_rent}`];
  return prefix ? `/aggelia/${prefix}${item.id}` : null;
}

function listingTitle(item) {
  // Falls back to a bare "40τ.μ." for a subtype we've never seen rendered,
  // rather than printing a raw numeric code at the user.
  return [
    labels.subs[`${item.category}|${item.subtype}`],
    item.sq_meters ? `${item.sq_meters}τ.μ.` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

// Floor, bedrooms, bathrooms, in the site's own icons and wording. The results
// card and the map popup are different Vue components with different scope
// attributes and icon sizes, but the list inside them is the same list, built
// the same way.
function buildInfoList(item, { listClass, scope, sprite, iconClass, iconSize }) {
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (scope) node.setAttribute(scope, '');
    return node;
  };

  const info = el('ul', listClass);
  const addInfo = (iconName, entry) => {
    if (!entry?.lead) return;
    const li = el('li', '');
    if (sprite) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', iconClass);
      svg.setAttribute('width', iconSize);
      svg.setAttribute('height', iconSize);
      if (scope) svg.setAttribute(scope, '');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `${sprite}#${iconName}`);
      svg.appendChild(use);
      li.appendChild(svg);
    }
    const outer = el('span', '');
    const inner = el('span', '');
    inner.textContent = entry.lead;
    outer.appendChild(inner);
    if (entry.tail) outer.appendChild(document.createTextNode(` ${entry.tail} `));
    li.appendChild(outer);
    info.appendChild(li);
  };
  const counted = (iconName, count) =>
    count ? { lead: String(count), tail: labels.units[iconName] || '' } : null;

  addInfo('i-icon-floor', labels.floors[String(item.floorNumber)]);
  addInfo('i-icon-bedroom', counted('i-icon-bedroom', item.rooms));
  addInfo('i-icon-bathroom', counted('i-icon-bathroom', item.no_of_bathrooms));
  return info;
}

function domCards() {
  return Array.from(
    document.querySelectorAll('article.ordered-element:not([data-sg-v02])')
  );
}

function aggeliaIdOf(card) {
  const href = card.querySelector('a[href*="/aggelia/"]')?.getAttribute('href') || '';
  return href.match(/\/aggelia\/(\d+)/)?.[1] || null;
}

// A card's /aggelia/ link is a short category prefix followed by the listing's
// own numeric id. Reading the prefix off a single card by suffix-matching is
// tempting and wrong: across a thousand listings some other id is eventually a
// suffix of this one's full id, and the match silently lands on the wrong
// listing. The prefix is the same for every card in a search, so take the
// answer the whole page agrees on.
function matchCardToItem(fullId, byId) {
  // The prefix runs 1–3 characters, so try each length and see which leaves an
  // id we actually fetched.
  for (let length = 1; length <= 3; length++) {
    const item = byId.get(fullId.slice(length));
    if (item) return { item, prefix: fullId.slice(0, length) };
  }
  return null;
}

function derivePrefixes(cards, byId) {
  // Tallied per category and listing type rather than once for the page: a
  // search mixing two property types would otherwise hand the minority type
  // the majority's prefix, and every card of that type would link somewhere
  // wrong.
  const tallies = new Map(); // "house|1" -> Map(prefix -> count)
  for (const card of cards) {
    const fullId = aggeliaIdOf(card);
    if (!fullId) continue;
    const match = matchCardToItem(fullId, byId);
    if (!match) continue;
    const key = `${match.item.category}|${match.item.buy_or_rent}`;
    const counts = tallies.get(key) || new Map();
    counts.set(match.prefix, (counts.get(match.prefix) || 0) + 1);
    tallies.set(key, counts);
  }

  const winners = new Map();
  for (const [key, counts] of tallies) {
    let best = null;
    let bestCount = 0;
    for (const [prefix, count] of counts) {
      if (count > bestCount) {
        best = prefix;
        bestCount = count;
      }
    }
    if (best) winners.set(key, best);
  }
  return winners;
}

function learnFromDom(items) {
  const byId = new Map(items.map((i) => [String(i.id), i]));
  const set = (bag, key, value) => {
    if (!value || bag[key] === value) return;
    bag[key] = value;
    labelsDirty = true;
  };
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

  const cards = domCards();
  const prefixes = derivePrefixes(cards, byId);

  for (const card of cards) {
    const fullId = aggeliaIdOf(card);
    if (!fullId) continue;
    // A card the fetch didn't return (a boosted placement, say) simply has
    // nothing to teach us.
    const match = matchCardToItem(fullId, byId);
    if (!match) continue;
    const { item, prefix } = match;

    const key = `${item.category}|${item.buy_or_rent}`;
    // Drop a match the rest of its category disagrees with: that's a false
    // suffix hit on some other listing's id, not this card's own.
    if (prefixes.get(key) !== prefix) continue;

    const kind = `${item.category}|${item.subtype}`;
    set(labels.prefixes, key, prefix);
    // "Διαμέρισμα, 40τ.μ." — the part before the comma is the subtype label.
    set(labels.subs, kind, text(card.querySelector('.tile__title')).split(',')[0].trim());

    // "€350 / μήνα" minus the formatted price leaves the per-month wording.
    // Sale cards have no suffix and simply teach us nothing here.
    const priceText = text(card.querySelector('.price__text'));
    if (priceText && typeof item.price === 'number') {
      const formatted = formatPrice(item.price);
      const at = priceText.indexOf(formatted);
      if (at >= 0) set(labels, 'perMonth', priceText.slice(at + formatted.length).trim());
    }

    const updated = card.querySelector('.tile__updated');
    if (updated) {
      // "Ανανεώθηκε: 25/07/2026" minus the <time> leaves the label.
      const stamp = text(updated.querySelector('time'));
      const whole = text(updated);
      if (stamp && whole.endsWith(stamp)) {
        set(labels, 'updatedPrefix', whole.slice(0, whole.length - stamp.length));
      }
    }

    for (const li of card.querySelectorAll('.tile__info > li')) {
      const icon = (li.querySelector('use')?.getAttribute('href') || '').split('#')[1];
      if (!icon) continue;
      // Each entry is <span><span>1</span> υ/δ</span> — the value in an inner
      // span, the unit as a bare text node beside it, and the site's CSS puts
      // them on separate lines. Keep the two apart or the unit reflows badly.
      const outer = li.querySelector('span');
      const lead = text(outer?.querySelector('span'));
      if (!lead) continue;
      const tail = text(outer).slice(lead.length).trim();

      if (icon === 'i-icon-floor') {
        // A pure enum: 3 → "ΙΣ", 4 → "ΗΜ", 6 → "1" + "ος".
        if (item.floorNumber == null) continue;
        const key = String(item.floorNumber);
        if (labels.floors[key]?.lead !== lead || labels.floors[key]?.tail !== tail) {
          labels.floors[key] = { lead, tail };
          labelsDirty = true;
        }
        continue;
      }
      // The lead here is the listing's own count, so it teaches us nothing —
      // but it does confirm we're reading the entry we think we are before
      // taking the unit off the end.
      const count = icon === 'i-icon-bedroom' ? item.rooms : item.no_of_bathrooms;
      if (count && lead === String(count)) set(labels.units, icon, tail);
    }
  }
  saveLabels();
}

function harvestSkin() {
  // The site's card and paginator styles are Vue scoped CSS, keyed on a
  // build-specific attribute. Copy the attribute names (and the icon sprite
  // URL, which is also build-specific) off whatever the site rendered.
  const card = domCards()[0] || null;
  const tile = card?.querySelector('.tile') || null;
  const nav = document.querySelector('nav.pagination:not([data-sg-v02])');
  const icon = card?.querySelector('.tile__info svg');
  const scopeOf = (el) =>
    el ? Array.from(el.attributes).map((a) => a.name).find((n) => n.startsWith('data-v-')) || null : null;

  return {
    cardScope: scopeOf(card),
    tileScope: scopeOf(tile),
    pagScope: scopeOf(nav),
    // Verbatim, because the modifier classes carry the geometry: in list view
    // `tile--vip` is what sizes the thumbnail box, and gallery view swaps the
    // whole set. Copying it is how one builder serves both views.
    tileClass: tile?.className || 'tile tile--horizontal',
    sprite: (icon?.querySelector('use')?.getAttribute('href') || '').split('#')[0] || '',
    iconClass: icon?.getAttribute('class') || 'icon sprite-icons',
    iconSize: icon?.getAttribute('width') || '23',
  };
}

// ---- taking over the map's pins ----

// The list is only half of a search. The map beside it draws a pin for every
// listing no matter who posted it, so filtering the column and leaving the map
// alone doesn't remove the agencies — it moves them to the right-hand side.
//
// Hiding the agency pins is not enough on its own, and the numbers are why.
// The site's map is one request of the map endpoint: 300 listings, in the
// ranking order that floats boosted agency ads to the front. On
// patra/timi_eos-350/emvado_apo-35 (2026-07-26) that's 300 of the search's 937
// listings, and exactly 2 of them are private — while the search has 58. So
// hiding what isn't private trades a map full of the wrong pins for a map with
// two pins and 56 listings missing.
//
// The map therefore gets the same treatment as the results column: hide the
// site's pins wholesale, draw our own for every private listing we fetched,
// hand it all back on toggle-off. All 58 of them rather than 2 — 54 markers,
// once the four that share a cell with another are grouped — and the map
// finally agrees with the list beside it.
//
// Three things learned doing that against someone else's Leaflet:
//
//   Grouping. The map endpoint buckets listings by 8-character geohash
//   ("sqz3werh_exact") and draws one marker per bucket, a bucket of more than
//   one becoming a count bubble rather than a pin. Verified exactly: 250
//   buckets against 250 markers, the 30 multi-buckets against the 30
//   `.multiple` markers, their sizes summing to the counts drawn. We group the
//   same way, bubbles included. A bubble carries no link and clicking one does
//   nothing on the site's map either — no zoom, no re-centre, no popup — but
//   hovering it lists every listing at that point, which is where the listings
//   a bubble stands for are reachable from. Ours does the same.
//
//   Panning is free, zooming isn't. Leaflet pans by translating the whole map
//   pane, so every layer point stays valid and our pins ride along untouched;
//   a zoom resets that pane and rewrites all 250 marker transforms, and ours
//   aren't Leaflet layers so nothing rewrites them. Hence watchMapPane().
//
//   Hide by stylesheet rule, not per node. A marker Leaflet adds after we've
//   run is then hidden the moment it lands, rather than on our next pass.

const MARKER_PANE = '.leaflet-marker-pane';
const MAP_PANE = '.leaflet-map-pane';
const TILE_PANE = '.leaflet-tile-pane';
// The site's own caption under the map — "Βλέπεις 300 απο 960 ακίνητα με pin
// στο χάρτη". True of its map, false of ours, so it gets the same treatment as
// the results heading: rewritten while we hold the map, put back afterwards.
const MAP_CAPTION = '.map__pagination__inner';
const MAP_TAKEOVER_ATTR = 'data-sg-v02-map'; // on <html>; consolidate.css hides the site's pins
const PIN_ATTR = 'data-sg-v02-pin'; // one of ours, one per cell, for as long as the view is up
const PIN_ID_ATTR = 'data-sg-v02-id'; // the listing ids it stands for, space-separated
const HOVER_ATTR = 'data-sg-v02-hover'; // the transient hover pin, for when we own no map
const BORROWED_ATTR = 'data-sg-v02-focus'; // one of the site's, focused by us
const POPUP_PANE = '.leaflet-popup-pane';
const POPUP_ATTR = 'data-sg-v02-popup'; // the one popup of ours that can be open
const MAP_SETTLE_MS = 80;
// Styling the site reserves for boosted ads. Ours are never boosted.
const BOOSTED_CLASSES = ['topVip', 'vip', 'price-dropped'];

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const GEOHASH_PRECISION = 8; // what the map endpoint's own bucket keys use
// A listing the API marks `geocodeType: "offset"` has a location it isn't
// willing to be precise about, and the site draws it 100 metres due north of
// the coordinates it reports. Measured against the 11 offset markers on the
// Πάτρα map: 99.9m at the median, 99.6 to 100.5 across all of them. It's a
// distance on the ground rather than a nudge on the screen — the pixel gap
// doubles with every zoom level (3.3px at z12 through 53.3px at z16, ratios
// 2.01 / 2.02 / 1.98 / 1.99) — which is why it's expressed in metres here.
const OFFSET_METRES_NORTH = 100;
const METRES_PER_DEGREE_LAT = 111320;

let mapPins = []; // [{ el, items, lat, lng, shape }] — one entry per cell, while the takeover is up
let mapPinsFor = null; // the result object they were built from
let mapPaneObserver = null;
let observedMapPane = null; // which map pane that observer is attached to
let mapPlaceTimer = null;
let originalMapCaption = null;

function setMapCaption(text) {
  const caption = document.querySelector(MAP_CAPTION);
  if (!caption) return;
  if (originalMapCaption === null) originalMapCaption = caption.textContent;
  const next = text !== null ? text : originalMapCaption;
  // Same rule as setResultsTotal: only write on a real change, because this
  // node is Vue's and our own mutation wakes the observer that would write it
  // again.
  if (caption.textContent !== next) caption.textContent = next;
}

function syncMapCaption() {
  if (!mapPins.length) return;
  const listings = mapPins.reduce((total, pin) => total + pin.items.length, 0);
  setMapCaption(`Βλέπεις ${listings} ακίνητα ιδιωτών με pin στο χάρτη`);
}

function geohashCell(lat, lng) {
  // Which bucket a listing falls in, and where its marker goes. The site draws
  // a marker at the middle of the bucket's cell, not at any one listing's own
  // coordinates: measured against 220 of its markers at zoom 14, the cell
  // centre is 0.28px out at the median and 0.49px at the 95th, the listing's
  // own coordinates 1.37px and 2.49px — and that gap doubles with every zoom
  // level, so by street zoom it's the difference between the right building and
  // the one over the road. Encoding checked against the endpoint's own keys:
  // 300 of 300.
  const latRange = [-90, 90];
  const lngRange = [-180, 180];
  let hash = '';
  let evenBit = true;
  let index = 0;
  let bit = 0;
  while (hash.length < GEOHASH_PRECISION) {
    const range = evenBit ? lngRange : latRange;
    const middle = (range[0] + range[1]) / 2;
    if ((evenBit ? lng : lat) > middle) {
      index = index * 2 + 1;
      range[0] = middle;
    } else {
      index = index * 2;
      range[1] = middle;
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      hash += GEOHASH_BASE32[index];
      index = 0;
      bit = 0;
    }
  }
  return {
    hash,
    lat: (latRange[0] + latRange[1]) / 2,
    lng: (lngRange[0] + lngRange[1]) / 2,
  };
}

function markerPoint(item) {
  // Which marker a listing belongs to, and where on the map that marker goes.
  const offset = item.geocodeType === 'offset';
  const cell = geohashCell(item.latitude, item.longitude);
  return {
    key: `${cell.hash}_${offset ? 'offset' : 'exact'}`, // the endpoint's own bucket key
    lat: cell.lat + (offset ? OFFSET_METRES_NORTH / METRES_PER_DEGREE_LAT : 0),
    lng: cell.lng,
  };
}

function translateOf(el) {
  // Leaflet positions with translate3d and only adds a scale() during a zoom
  // animation, while every coordinate on the map is momentarily a lie.
  const transform = el?.style.transform || '';
  if (/scale\((?!1\))/.test(transform)) return null;
  const at = transform.match(/translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/);
  return at ? { x: Number(at[1]), y: Number(at[2]) } : { x: 0, y: 0 };
}

function mapProjection() {
  // Everything in the map's panes sits at a "layer point": the Web Mercator
  // position of a coordinate at the current zoom, minus a fixed origin. A
  // loaded tile hands us both — its URL ends in /{z}/{x}/{y}, which is where it
  // belongs in the world, and its transform is where it actually landed. So
  // this calibrates itself off the map's own state and needs no bookkeeping
  // from us when the user pans or zooms.
  //
  // Every tile is polled rather than the first one, and the answer they mostly
  // agree on wins. Through a zoom Leaflet keeps the outgoing level's tiles
  // around next to the incoming one's, and a tile from the level being retired
  // describes a projection that is about to stop being true.
  const tally = new Map();
  for (const tile of document.querySelectorAll(`${TILE_PANE} img.leaflet-tile`)) {
    const zxy = (tile.currentSrc || tile.src || '')
      .split('?')[0]
      .match(/\/(\d+)\/(\d+)\/(\d+)\.[a-z0-9]+$/i);
    const at = translateOf(tile);
    // Tiles sit in a container of their own that the marker pane has no
    // equivalent of, so its offset has to come back out.
    const container = translateOf(tile.parentElement);
    if (!zxy || !at || !container) continue;

    const tileSize = parseFloat(tile.style.width) || 256;
    const candidate = [
      tileSize * 2 ** Number(zxy[1]),
      Number(zxy[2]) * tileSize - at.x - container.x,
      Number(zxy[3]) * tileSize - at.y - container.y,
    ].join(' ');
    tally.set(candidate, (tally.get(candidate) || 0) + 1);
  }

  let best = null;
  let bestCount = 0;
  for (const [candidate, count] of tally) {
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  if (!best) return null;

  const [world, originX, originY] = best.split(' ').map(Number);
  return (lat, lng) => ({
    x: world * (0.5 + lng / 360) - originX,
    y:
      world * (0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)) -
      originY,
  });
}

function isBoosted(className) {
  return className.split(/\s+/).some((cls) => BOOSTED_CLASSES.includes(cls));
}

function markerKind(items) {
  return `${items.length > 1 ? 'multiple' : 'single'}|${
    items[0].geocodeType === 'offset' ? 'offset' : 'exact'
  }`;
}

function markerPrototypes() {
  // Clone rather than build: marker markup carries a build-specific Vue scope
  // attribute exactly like the cards do, and cloning inherits it for free.
  // Which marker to clone is the question "what would the site have drawn for
  // an ordinary private listing?" — and the answer depends on three things at
  // once, so there's one per kind rather than one for the map.
  //
  // Whether it stands for one listing or several, and whether the listing is
  // exactly geocoded, each change what's inside the marker and not just its
  // classes: at `medium` an exact pin is a 22×28 SVG teardrop, an offset one is
  // a bare dot with no SVG in it at all, and a group carries a count span where
  // a single pin carries a link. The third is the size class the site swaps as
  // you zoom, which is why this is re-read on every placement rather than once.
  //
  // Within a kind, prefer the shape the site drew most often among the
  // unboosted markers, and settle for a boosted one only if the whole map
  // happens to be ads.
  const kinds = new Map(); // kind -> Map(class string -> [markers])
  for (const marker of document.querySelectorAll(`${MARKER_PANE} .marker`)) {
    if (marker.closest(`[${PIN_ATTR}], [${HOVER_ATTR}]`)) continue; // never clone our own
    const kind = `${marker.classList.contains('multiple') ? 'multiple' : 'single'}|${
      marker.classList.contains('offset') ? 'offset' : 'exact'
    }`;
    const shape = marker.className.replace(/\bfocused\b/g, '').replace(/\s+/g, ' ').trim();
    if (!kinds.has(kind)) kinds.set(kind, new Map());
    const shapes = kinds.get(kind);
    if (!shapes.has(shape)) shapes.set(shape, []);
    shapes.get(shape).push(marker);
  }

  const best = new Map();
  for (const [kind, shapes] of kinds) {
    let winner = null;
    for (const [shape, group] of shapes) {
      const better =
        !winner ||
        (isBoosted(winner.shape) && !isBoosted(shape)) ||
        (isBoosted(winner.shape) === isBoosted(shape) && group.length > winner.group.length);
      if (better) winner = { shape, group };
    }
    const el = winner?.group[0].closest('.leaflet-marker-icon');
    if (el) best.set(kind, { el, shape: winner.shape });
  }
  return best;
}

function prototypeFor(kind, prototypes) {
  const [group, geocode] = kind.split('|');
  const otherGroup = group === 'single' ? 'multiple' : 'single';
  const otherGeocode = geocode === 'exact' ? 'offset' : 'exact';
  // Relax the geocode type before the multiplicity. A bubble cloned from a
  // single pin has no count in it, which is the whole of what a bubble says;
  // a pin cloned from the other geocode type differs only in how the site
  // draws a location it isn't sure of. Both are last resorts — they need the
  // map to be showing no marker of the right kind at all.
  for (const candidate of [
    `${group}|${geocode}`,
    `${group}|${otherGeocode}`,
    `${otherGroup}|${geocode}`,
    `${otherGroup}|${otherGeocode}`,
  ]) {
    const found = prototypes.get(candidate);
    if (found) return found;
  }
  return null;
}

function normalisePinClasses(marker, item) {
  // Everything about a marker's shape is the site's to decide except these:
  // ours are never boosted ads, and exact / offset is the site's own wording
  // for how precisely a listing is geocoded, which it draws differently.
  marker.classList.remove('focused', 'exact', 'offset', ...BOOSTED_CLASSES);
  marker.classList.add(item.geocodeType === 'offset' ? 'offset' : 'exact');
}

function syncPinShapes() {
  // The site redraws its markers as you zoom — `compact` low down, `medium`
  // further in — so a pin cloned at one zoom is the wrong pin at the next.
  //
  // Rebuilt from the marker the site is drawing now, rather than relabelled.
  // Moving the class string across was the first thing tried and it is not
  // enough: `.marker.medium` is written for a marker with a 22×28 SVG inside
  // it, a compact clone has no SVG to give it, and the result computes to a
  // 12×0 box with no background — every pin on the map silently disappearing
  // one zoom level in.
  const prototypes = markerPrototypes();
  if (!prototypes.size) return;

  for (const entry of mapPins) {
    const found = prototypeFor(markerKind(entry.items), prototypes);
    if (!found || found.shape === entry.shape) continue;
    const pin = buildPin(entry.items, found.el);
    // The pin is being replaced mid-flight, so it keeps where it was put and
    // whether a card is currently hovering it.
    pin.style.transform = entry.el.style.transform;
    pin.style.zIndex = entry.el.style.zIndex;
    if (entry.el.querySelector('.marker.focused')) {
      pin.querySelector('.marker')?.classList.add('focused');
    }
    entry.el.replaceWith(pin);
    entry.el = pin;
    entry.shape = found.shape;
    bindPinPopup(entry);
  }
}

function buildPin(items, prototype) {
  const [item] = items;
  const pin = prototype.cloneNode(true);
  pin.setAttribute(PIN_ATTR, '');
  pin.setAttribute(PIN_ID_ATTR, items.map((listing) => listing.id).join(' '));
  // The icon div is a Leaflet click target with a role and a tabstop of its
  // own, and neither survives the clone usefully — nothing listens on them any
  // more. On a single pin the link inside is focusable and does the navigating,
  // so let that be the only stop; a count bubble has nothing to navigate to, so
  // it ends up with no tabstop at all, which is the honest answer for something
  // that doesn't respond to being activated.
  pin.removeAttribute('tabindex');
  pin.removeAttribute('role');

  const marker = pin.querySelector('.marker');
  if (marker) normalisePinClasses(marker, item);
  // Only the boosted markers carry a price bubble, and ours aren't boosted, so
  // if the clone brought one along it goes with the classes that justified it.
  pin.querySelector('.marker__price')?.remove();

  const count = pin.querySelector('.marker__count');
  if (count) count.textContent = String(items.length);

  const link = pin.querySelector('.marker__link');
  if (link) {
    // A real count bubble has no link element to find, so this only runs for a
    // group when we had no bubble to clone and fell back to the pin shape.
    // Neither the link nor the label can be honest about several listings at
    // once, so a group gets neither.
    if (items.length === 1) {
      const href = aggeliaHref(item);
      if (href) link.setAttribute('href', href);
      else link.removeAttribute('href');
      // The site labels its own pins the same way ("Διαμέρισμα, 47 τ.μ.") —
      // it's all a screen reader gets, since the pin itself is a coloured dot.
      link.setAttribute('aria-label', listingTitle(item));
    } else {
      link.removeAttribute('href');
      link.removeAttribute('aria-label');
    }
  }
  return pin;
}

function placeMapPins() {
  if (!mapPins.length) return false;
  syncPinShapes();
  const project = mapProjection();
  // Null through a zoom animation, when every coordinate on the map is
  // momentarily a lie, and before the first tile loads. Both resolve on their
  // own, and the style changes that end them bring us back here.
  if (!project) return false;

  for (const { el, lat, lng } of mapPins) {
    const point = project(lat, lng);
    el.style.transform = `translate3d(${point.x}px, ${point.y}px, 0px)`;
    // Leaflet stacks markers by how far south they are, so a pin overlaps the
    // one behind it consistently rather than at random. Same rule for ours.
    el.style.zIndex = String(Math.round(point.y));
  }
  placePopup();
  return true;
}

function watchMapPane() {
  const mapPane = document.querySelector(MAP_PANE);
  if (!mapPane) return;
  // Re-observe when the map on the page is no longer the one we attached to.
  // renderMapPins already expects the site to build a new map underneath us on
  // a big enough view change (see ensureMapPins), and an observer left watching
  // the pane that got thrown away never fires again — the pins would land once
  // and then sit there through every later zoom.
  if (mapPaneObserver && observedMapPane === mapPane) return;
  mapPaneObserver?.disconnect();
  observedMapPane = mapPane;

  // Panning writes a translate onto the map pane and leaves every layer point
  // alone; zooming resets it to zero and rewrites them all. Both arrive here as
  // a style change, and re-placing a few dozen pins after a pan is cheap enough
  // that telling the two apart isn't worth the code.
  //
  // The tile pane is watched as well, and it's the load-bearing half: right
  // after a zoom the tiles for the new level are still arriving, so the first
  // pass or two can read a projection that's still settling. Each tile that
  // lands brings us back for another look, and the passes stop when the map
  // does. Neither target contains our pins, so our own writes below don't
  // retrigger this.
  mapPaneObserver = new MutationObserver(() => {
    if (mapPlaceTimer) clearTimeout(mapPlaceTimer);
    mapPlaceTimer = setTimeout(() => {
      mapPlaceTimer = null;
      // Holding no pins means the last render declined for want of a
      // projection, so there's nothing to re-place — rebuild instead. Until
      // that succeeds the map is showing neither the site's pins nor ours.
      if (mapPins.length) placeMapPins();
      else ensureMapPins();
    }, MAP_SETTLE_MS);
  });
  mapPaneObserver.observe(mapPane, { attributes: true, attributeFilter: ['style'] });
  const tilePane = document.querySelector(TILE_PANE);
  if (tilePane) {
    mapPaneObserver.observe(tilePane, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'src'],
    });
  }
}

function removeMapPins() {
  closePinPopup();
  for (const { el } of mapPins) el.remove();
  mapPins = [];
  mapPinsFor = null;
  // Belt and braces: a pin orphaned by a re-render is still ours to clear up.
  document.querySelectorAll(`[${PIN_ATTR}]`).forEach((pin) => pin.remove());
}

function renderMapPins() {
  const pane = document.querySelector(MARKER_PANE);
  if (!pane || !currentResult) return false;

  // No prototypes means the site drew no pins of its own — a map that hasn't
  // loaded, or a search with nothing in it. Either way there's nothing to clone
  // and nothing to improve on, and hiding a map we can't redraw is strictly
  // worse than leaving it alone.
  const prototypes = markerPrototypes();
  if (!prototypes.size) return false;

  const pinned = currentResult.listings.filter(
    (item) => typeof item.latitude === 'number' && typeof item.longitude === 'number'
  );
  if (!pinned.length) return false;

  // One marker per bucket, the way the endpoint hands them to the site.
  const cells = new Map();
  for (const item of pinned) {
    const { key, lat, lng } = markerPoint(item);
    if (!cells.has(key)) cells.set(key, { items: [], lat, lng });
    cells.get(key).items.push(item);
  }

  removeMapPins();
  // Watch this pane before the first placement rather than after it succeeds.
  // The placement below can decline — a map still loading its tiles has no
  // projection to read yet — and it drops the pins when it does. The tiles
  // arriving on this pane are exactly the signal that it's worth another go,
  // and an observer still attached to the pane a rebuild replaced is an
  // observer that never fires again.
  watchMapPane();
  const batch = document.createDocumentFragment();
  mapPins = Array.from(cells.values(), ({ items, lat, lng }) => {
    // Always answers: there are four kinds, prototypeFor tries all four, and
    // the map has at least one marker on it or we'd have given up above.
    const { el: prototype, shape } = prototypeFor(markerKind(items), prototypes);
    const entry = { el: buildPin(items, prototype), items, lat, lng, shape };
    bindPinPopup(entry);
    batch.appendChild(entry.el);
    return entry;
  });
  if (!placeMapPins()) {
    // No projection yet, so we don't know where any of them go. Drop them and
    // let the next pass rebuild rather than piling 58 pins on the map's corner.
    mapPins = [];
    return false;
  }

  pane.appendChild(batch);
  mapPinsFor = currentResult;
  document.documentElement.setAttribute(MAP_TAKEOVER_ATTR, '');
  syncMapCaption();
  harvestPopupSkin();
  return true;
}

function ensureMapPins() {
  if (!filterEnabled || !currentResult) return;
  const pane = document.querySelector(MARKER_PANE);
  if (!pane) return;
  // Pins cover the whole result, not the page being shown, so paging through
  // the column doesn't touch them. Rebuild only for a new result, or when
  // something took ours off the map — checked against the pane that's on the
  // page now rather than with isConnected, because a big enough view change
  // has the site build a new map underneath us, and pins still attached to the
  // old one are just as gone.
  if (mapPinsFor === currentResult && mapPins.length && mapPins[0].el.parentElement === pane) {
    return;
  }
  renderMapPins();
}

function teardownMapPins() {
  removeMapPins();
  // A harvest that came back with nothing gets another go on the next takeover
  // — the map may simply not have finished drawing its own markers yet.
  if (!popupSkin) popupHarvests = 0;
  if (originalMapCaption !== null) {
    setMapCaption(null);
    originalMapCaption = null;
  }
  document.documentElement.removeAttribute(MAP_TAKEOVER_ATTR);
  mapPaneObserver?.disconnect();
  mapPaneObserver = null;
  observedMapPane = null;
  if (mapPlaceTimer) {
    clearTimeout(mapPlaceTimer);
    mapPlaceTimer = null;
  }
}

// Hovering a card on the site highlights that listing's pin. The mechanism is
// a single class: the site puts `focused` on the marker and its own stylesheet
// draws the highlight. Our cards aren't Vue components, so nothing ever bound
// that behaviour to them and the takeover silently lost it.
//
// Normally the pin to light up is now one of ours. The two paths under that are
// for when the map takeover didn't happen — no marker to clone, no projection
// yet — where the site's own pins are still the ones on screen.

function unfocusMap() {
  document.querySelectorAll(`[${HOVER_ATTR}]`).forEach((pin) => pin.remove());
  document
    .querySelectorAll(`[${PIN_ATTR}] .marker.focused`)
    .forEach((marker) => marker.classList.remove('focused'));
  // Only ever un-focus a marker of the site's that we focused ourselves.
  document.querySelectorAll(`[${BORROWED_ATTR}]`).forEach((marker) => {
    marker.classList.remove('focused');
    marker.removeAttribute(BORROWED_ATTR);
  });
}

function focusOnMap(item, href) {
  unfocusMap();
  const pane = document.querySelector(MARKER_PANE);
  if (!pane) return; // gallery view, or a page with no map at all

  // Ours, which is the normal case. A card whose listing shares a cell with
  // another lights up the bubble the two of them are drawn as.
  const mine = mapPins
    .find((pin) => pin.items.some((listing) => listing.id === item.id))
    ?.el.querySelector('.marker');
  if (mine) {
    mine.classList.add('focused');
    return;
  }

  // The href is the only identifier one of the site's markers carries, and it's
  // the same one we put on the card, so it's what pairs the two.
  const own = href
    ? Array.from(pane.querySelectorAll('a.marker__link'))
        .find((link) => link.getAttribute('href') === href)
        ?.closest('.marker')
    : null;
  if (own) {
    own.classList.add('focused');
    own.setAttribute(BORROWED_ATTR, '');
    return;
  }

  const project = mapProjection();
  const prototype = prototypeFor(markerKind([item]), markerPrototypes())?.el;
  if (!project || !prototype || typeof item.latitude !== 'number') return;

  const where = markerPoint(item);
  const point = project(where.lat, where.lng);
  const pin = buildPin([item], prototype);
  pin.removeAttribute(PIN_ATTR);
  pin.setAttribute(HOVER_ATTR, '');
  // This one is a highlight rather than a target — it lasts as long as the
  // pointer is on the card — so nothing of ours should swallow a click meant
  // for the map underneath.
  pin.classList.remove('leaflet-interactive');
  pin.style.pointerEvents = 'none';
  pin.querySelector('.marker__link')?.removeAttribute('href');
  pin.querySelector('.marker')?.classList.add('focused');
  pin.style.transform = `translate3d(${point.x}px, ${point.y}px, 0px)`;
  // Above every marker Leaflet has placed. It stacks them by latitude, so
  // there's no fixed number to beat.
  pin.style.zIndex = String(
    Math.max(0, ...Array.from(pane.children, (child) => Number(child.style.zIndex) || 0)) + 1
  );
  pane.appendChild(pin);
}

// ---- the popup a pin opens when you hover it ----
//
// Hovering one of the site's markers opens a small card over the map: photo,
// title, area, the same three icons a results card carries, price, and a link
// through to the listing. Our pins are clones of its markers but not its
// Leaflet layers, so nothing was ever bound to them and hovering one did
// nothing at all — the map went quiet exactly where the column had got louder.
//
// The popup is a component of its own, with a Vue scope attribute neither the
// marker nor the results card shares, and it exists in the page only while one
// of the site's own markers is hovered. So we ask for one: the site's markers
// are hidden while we hold the map, but they are still there and still bound,
// and a synthetic mouseover runs their listeners whether or not the node has a
// box to hover. Read the attribute names off what comes back, drop it, and
// from then on the site's stylesheet draws a popup we build ourselves — the
// same bargain the cards are built on.

// The site opens its popup 18px clear of the marker's point, below it where
// there's room and above it where there isn't. Measured off its own.
const POPUP_GAP = 18;
const POPUP_CLOSE_MS = 120; // grace period for crossing that gap onto the popup
const POPUP_HARVEST_MS = 300; // long enough for Vue to render the one we asked for
const POPUP_HARVEST_TRIES = 3;

let popupSkin = null; // { scope, cardScope, iconClass, iconSize, sprite } off one of the site's
let popupHarvests = 0;
let openPopup = null; // { el, entry } while one of ours is up
let popupCloseTimer = null;

function scopeAttrs(el) {
  return el ? Array.from(el.attributes, (attr) => attr.name).filter((n) => n.startsWith('data-v-')) : [];
}

function learnPointHeader(marker, popup) {
  // "5 ακίνητα βρέθηκαν σε αυτό το σημείο" — the line the site writes over a
  // group of listings shot from one point. Read off the page and kept per
  // locale, the same way every other piece of its wording is.
  if (labels.pointHeader) return;
  const count = marker.querySelector('.marker__count')?.textContent.trim();
  const header = popup.querySelector('.mapPopup__header')?.textContent.replace(/\s+/g, ' ').trim();
  if (!count || !header || !new RegExp(`\\b${count}\\b`).test(header)) return;
  labels.pointHeader = header.replace(new RegExp(`\\b${count}\\b`), '%d');
  labelsDirty = true;
  saveLabels();
}

function harvestPopupSkin() {
  if (popupSkin || popupHarvests >= POPUP_HARVEST_TRIES) return;
  const markers = Array.from(
    document.querySelectorAll(`${MARKER_PANE} .leaflet-marker-icon:not([${PIN_ATTR}]):not([${HOVER_ATTR}])`)
  );
  // A bubble's popup is worth more than a pin's. It carries the header the site
  // writes over a group, which is wording we would otherwise have to invent,
  // and the cards inside are the same component either way.
  const marker = markers.find((node) => node.querySelector('.marker.multiple')) || markers[0];
  if (!marker) return;
  popupHarvests += 1;

  const before = new Set(document.querySelectorAll(`${POPUP_PANE} .leaflet-popup`));
  for (const type of ['pointerover', 'mouseover', 'mouseenter']) {
    marker.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }

  setTimeout(() => {
    for (const type of ['pointerout', 'mouseout', 'mouseleave']) {
      marker.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    const popup = Array.from(document.querySelectorAll(`${POPUP_PANE} .leaflet-popup`)).find(
      (node) => !before.has(node)
    );
    const box = popup?.querySelector('.mapPopup');
    const card = popup?.querySelector('.card');
    const scope = scopeAttrs(box)[0] || null;
    // The card inside carries the popup's scope attribute as well as its own,
    // and its own is the one that isn't the popup's.
    const cardScope = card ? scopeAttrs(card).find((name) => name !== scope) : null;
    // Both or neither: these two attributes are the whole reason for asking, and
    // a popup built without them is an unstyled block of text over the map.
    // Better to leave the pins as pins than to draw that.
    if (scope && cardScope) {
      const icon = card.querySelector('.card__info svg');
      popupSkin = {
        scope,
        cardScope,
        iconClass: icon?.getAttribute('class') || 'icon sprite-icons',
        // Smaller here than on a results card, so read rather than shared.
        iconSize: icon?.getAttribute('width') || '15',
        // One sprite file per build, so a card's will do when the listing this
        // popup happens to stand for has nothing to put icons beside.
        sprite:
          (icon?.querySelector('use')?.getAttribute('href') || '').split('#')[0] ||
          harvestSkin().sprite,
      };
      learnPointHeader(marker, popup);
    }
    // Ours to clear up: nobody asked for this popup but us, and leaving it
    // behind would put an agency's listing back over the map the moment the
    // toggle goes off and the rule that hides it stops applying.
    popup?.remove();
  }, POPUP_HARVEST_MS);
}

function buildPopupCard(item, horizontal) {
  const S = popupSkin.cardScope;
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (S) node.setAttribute(S, '');
    return node;
  };
  const href = aggeliaHref(item);
  const title = listingTitle(item);

  const article = el('article', `card has--shadow is--link${horizontal ? ' card--horizontal' : ''}`);
  // The site's own popup card carries the popup's scope attribute as well as
  // the card's — Vue marks a child component's root element with its parent's
  // id too, and that's the hook a parent uses to style what it embeds.
  if (popupSkin.scope) article.setAttribute(popupSkin.scope, '');

  const texts = el('div', 'card__texts');
  const header = el('header', 'card__title');
  const line = el('div', 'title--ellipsis');
  const subtype = el('span', 'ellipsis');
  subtype.textContent = labels.subs[`${item.category}|${item.subtype}`] || '';
  const size = el('span', '');
  size.textContent = item.sq_meters ? `${item.sq_meters}τ.μ.` : '';
  line.append(subtype, size);
  header.appendChild(line);
  texts.appendChild(header);

  const where = el('div', 'card__description ellipsis');
  where.textContent = item.geography || '';
  texts.appendChild(where);

  const extras = el('div', 'card__extras');
  extras.appendChild(
    buildInfoList(item, {
      listClass: 'card__info',
      scope: S,
      sprite: popupSkin.sprite,
      iconClass: popupSkin.iconClass,
      iconSize: popupSkin.iconSize,
    })
  );
  texts.appendChild(extras);

  const footer = el('footer', 'card__footer');
  const price = el('div', 'card__price');
  const main = el('p', 'price__main');
  if (typeof item.price === 'number') {
    main.textContent = `€ ${formatPrice(item.price)}`;
    if (item.buy_or_rent === '1' && labels.perMonth) {
      const per = el('small', '');
      per.textContent = ` ${labels.perMonth}`;
      main.appendChild(per);
    }
  }
  price.appendChild(main);
  footer.appendChild(price);
  texts.appendChild(footer);
  article.appendChild(texts);

  if (item.mainImageURL) {
    const img = el('img', '');
    img.src = item.mainImageURL;
    img.loading = 'lazy';
    img.alt = title;
    if (horizontal) {
      const figure = el('figure', 'card__figure');
      figure.appendChild(img);
      article.appendChild(figure);
    } else {
      // The site's own is a carousel with the listing's whole gallery in it.
      // One slide is all a single photo needs, and the geometry is on the
      // classes rather than in the component's script — the inner two elements
      // are the carousel library's and carry no scope attribute, so neither do
      // ours.
      const slider = el('section', 'hooper');
      const list = document.createElement('div');
      list.className = 'hooper-list';
      const track = document.createElement('ul');
      track.className = 'hooper-track';
      const slide = el('li', 'slider__item hooper-slide is-active is-current');
      slide.appendChild(img);
      track.appendChild(slide);
      list.appendChild(track);
      slider.appendChild(list);
      article.appendChild(slider);
    }
  }

  // The site's own popup is a link that opens in a new tab, which is the one
  // thing a popup has to do that hovering a pin can't.
  const link = el('a', 'card__link');
  if (href) {
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
  }
  link.title = title;
  link.setAttribute('aria-label', title);
  article.appendChild(link);

  return article;
}

function buildPopup(entry) {
  const { items } = entry;
  const group = items.length > 1;
  const S = popupSkin.scope;
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (S) node.setAttribute(S, '');
    return node;
  };

  const popup = document.createElement('div');
  popup.setAttribute(POPUP_ATTR, '');
  // The site keys some of the popup's own geometry on the marker's size and
  // geocode classes, so the popup wears whatever the pin under it is wearing.
  const marker = entry.el.querySelector('.marker');
  const oursToSay = ['marker', 'multiple', 'focused', ...BOOSTED_CLASSES];
  const worn = (marker?.className || '').split(/\s+/).filter((cls) => cls && !oursToSay.includes(cls));
  popup.className = [
    'leaflet-popup',
    group ? 'multi' : 'single',
    ...worn,
    'leaflet-zoom-animated',
    'leaflet-rrose-custom',
  ].join(' ');

  // Leaflet's own two wrappers, which its stylesheet strips to nothing for a
  // custom popup — no scope attribute on either, they aren't Vue's.
  const wrapper = document.createElement('div');
  wrapper.className = 'leaflet-popup-content-wrapper';
  const content = document.createElement('div');
  content.className = 'leaflet-popup-content';

  const box = el('div', `mapPopup${group ? ' mapPopup--multiple' : ''}`);
  const inner = el('div', 'mapPopup__inner');
  if (group) {
    if (labels.pointHeader) {
      const header = el('div', 'mapPopup__header');
      header.textContent = labels.pointHeader.replace('%d', String(items.length));
      inner.appendChild(header);
    }
    const main = el('div', 'mapPopup__main');
    for (const item of items) main.appendChild(buildPopupCard(item, true));
    inner.appendChild(main);
  } else {
    inner.appendChild(buildPopupCard(items[0], false));
  }

  box.appendChild(inner);
  content.appendChild(box);
  wrapper.appendChild(content);
  popup.appendChild(wrapper);
  return popup;
}

function placePopup() {
  if (!openPopup) return;
  const { el, entry } = openPopup;
  const project = mapProjection();
  // Null mid-zoom, when every coordinate on the map is briefly a lie. The pass
  // that ends the zoom brings us back here.
  if (!project) return;

  const point = project(entry.lat, entry.lng);
  const height = el.offsetHeight;
  const container = document.querySelector('.leaflet-container');
  const room = container
    ? container.getBoundingClientRect().bottom - entry.el.getBoundingClientRect().bottom
    : Infinity;
  // The popup pane is laid out from the map's own origin, so a layer point
  // reaches it the same way it reaches a marker: translate to the point, then
  // offset by half the popup's width to centre it and by the gap to clear the
  // pin. Below it by default, above it when the map's bottom edge is nearer
  // than the popup is tall.
  el.style.transform = `translate3d(${point.x}px, ${point.y}px, 0px)`;
  el.style.left = `${-Math.round(el.offsetWidth / 2)}px`;
  el.style.top = `${room > height + POPUP_GAP ? POPUP_GAP : -(height + POPUP_GAP)}px`;
}

function closePinPopup() {
  if (popupCloseTimer) {
    clearTimeout(popupCloseTimer);
    popupCloseTimer = null;
  }
  openPopup?.el.remove();
  openPopup = null;
}

function schedulePopupClose() {
  if (popupCloseTimer) clearTimeout(popupCloseTimer);
  popupCloseTimer = setTimeout(() => {
    popupCloseTimer = null;
    closePinPopup();
  }, POPUP_CLOSE_MS);
}

function openPinPopup(entry) {
  if (popupCloseTimer) {
    clearTimeout(popupCloseTimer);
    popupCloseTimer = null;
  }
  if (openPopup?.entry === entry) return; // already up, the pointer just re-entered
  closePinPopup();
  // Before the skin has been read there's nothing to draw a popup with. It
  // arrives a frame or two after the pins do, well before anyone has crossed
  // the page to hover one.
  if (!popupSkin) return;
  const pane = document.querySelector(POPUP_PANE);
  if (!pane) return;

  const el = buildPopup(entry);
  // The popup has to be hoverable in its own right, or the listing it shows
  // couldn't be clicked: crossing the gap between pin and popup would close it.
  el.addEventListener('mouseenter', () => {
    if (popupCloseTimer) {
      clearTimeout(popupCloseTimer);
      popupCloseTimer = null;
    }
  });
  el.addEventListener('mouseleave', schedulePopupClose);
  pane.appendChild(el);
  openPopup = { el, entry };
  placePopup();

  // Placing reads the popup's own height, and the site's stylesheet gives the
  // photo a box of a fixed size, so that height is final the moment the popup
  // is in the document. That's the stylesheet's decision though, not ours: were
  // a photo ever to size its own box, a popup sitting above a pin would stay
  // where it was measured — too low by however much the photo added — and
  // nothing would correct it, because the passes that re-place pins are driven
  // by the map moving and an image loading isn't that. Re-place when they land.
  for (const img of el.querySelectorAll('img')) {
    if (img.complete) continue;
    const settle = () => {
      if (openPopup?.el === el) placePopup();
    };
    img.addEventListener('load', settle, { once: true });
    img.addEventListener('error', settle, { once: true });
  }
}

function bindPinPopup(entry) {
  entry.el.addEventListener('mouseenter', () => openPinPopup(entry));
  entry.el.addEventListener('mouseleave', schedulePopupClose);
}

// ---- rendering the takeover ----

// Our cards go into the site's card container as plain siblings of its own,
// with no wrapper element. A wrapper would be tidier to remove, but the site
// sizes its cards through direct-child selectors
// (`.search-results__tile-row > article[data-v-…]`), and any element in
// between silently drops the card to full width in gallery view. So the
// marker attribute is what identifies ours, and removal sweeps by selector.
const CARD_SELECTOR = 'article[data-sg-v02]';
const PAGER_ID = 'sg-v02-pager';
const NOTICE_ID = 'sg-v02-notice';
const TAKEOVER_CLASS = 'sg-v02-takeover';
const RESULTS_COLUMN = '.search-results__wrap-left';

let currentResult = null;
let currentPage = 1;
let originalTotalText = null;

function resultsColumn() {
  return document.querySelector(RESULTS_COLUMN);
}

// List view and gallery view put the cards in different places — straight into
// the results column, or into a `search-results__tile-row` flex container a
// couple of levels down. Rather than special-case the two, take the site's own
// first card as the anchor: whatever holds it is where ours belong too.
function cardHostAnchors() {
  const cards = domCards();
  if (cards.length === 0) return null;
  return { host: cards[0].parentElement, first: cards[0], last: cards[cards.length - 1] };
}

function pagerAnchor(host, lastCard) {
  // Slot our paginator where the site's sits, but never inside its wrapper —
  // the takeover CSS hides that wrapper, and it would take ours down with it.
  // Climb to the wrapper's outermost node that's still a child of the host.
  const siteNav = document.querySelector('nav.pagination:not([data-sg-v02])');
  if (siteNav && host.contains(siteNav)) {
    let node = siteNav;
    while (node.parentElement && node.parentElement !== host) node = node.parentElement;
    if (node.parentElement === host) return node;
  }
  return lastCard;
}

function buildCard(item, skin) {
  const T = skin.tileScope;
  const el = (tag, cls, scope = T) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (scope) node.setAttribute(scope, '');
    return node;
  };
  const href = aggeliaHref(item);

  const article = el('article', 'ordered-element', skin.cardScope);
  article.setAttribute('data-sg-v02', '');
  const tile = el('div', skin.tileClass);

  const figure = el('figure', 'tile__img');
  const imgWrap = el('div', 'img__wrap');
  const imgLink = el('a', 'tile__link');
  if (href) imgLink.href = href;
  const img = el('img', '');
  img.loading = 'lazy';
  img.alt = '';
  if (item.mainImageURL) img.src = item.mainImageURL;
  imgLink.appendChild(img);
  imgWrap.appendChild(imgLink);
  figure.appendChild(imgWrap);
  tile.appendChild(figure);

  const content = el('div', 'tile__content');
  const wrap = el('div', 'content__wrap');
  const top = el('div', 'content__top');

  const title = el('h3', 'tile__title');
  title.textContent = listingTitle(item);
  top.appendChild(title);

  const location = el('h3', 'tile__location');
  location.textContent = item.geography || '';
  top.appendChild(location);

  // Only the card endpoint carries descriptions; on a wide search this is
  // absent for every card alike, so the column stays internally consistent.
  if (item.description) {
    const description = el('p', 'tile__description');
    description.textContent = item.description;
    top.appendChild(description);
  }

  const extras = el('div', 'tile__extras');
  extras.appendChild(
    buildInfoList(item, {
      listClass: 'tile__info',
      scope: T,
      sprite: skin.sprite,
      iconClass: skin.iconClass,
      iconSize: skin.iconSize,
    })
  );

  const updated = el('p', 'tile__updated');
  const stamp = new Date((item.modified || '').replace(' ', 'T'));
  if (!isNaN(stamp)) {
    if (labels.updatedPrefix) updated.appendChild(document.createTextNode(labels.updatedPrefix));
    const time = el('time', '');
    const pad = (n) => String(n).padStart(2, '0');
    time.textContent = `${pad(stamp.getDate())}/${pad(stamp.getMonth() + 1)}/${stamp.getFullYear()}`;
    updated.appendChild(time);
  }
  extras.appendChild(updated);
  top.appendChild(extras);
  wrap.appendChild(top);

  const bottom = el('div', 'content__bottom');
  const price = el('div', 'tile__price');
  const priceText = el('p', 'price__text');
  if (typeof item.price === 'number') {
    // buy_or_rent "1" is rent, and only rent gets a per-month suffix — which
    // the site words in the current locale, so reuse whatever it used.
    const suffix = item.buy_or_rent === '1' && labels.perMonth ? ` ${labels.perMonth}` : '';
    priceText.textContent = `€${formatPrice(item.price)}${suffix}`;
  }
  price.appendChild(priceText);
  bottom.appendChild(price);
  wrap.appendChild(bottom);
  content.appendChild(wrap);

  // Full-card click target, same as the site's own overlay link.
  const overlay = el('a', 'tile__link');
  if (href) overlay.href = href;
  content.appendChild(overlay);

  tile.appendChild(content);
  article.appendChild(tile);

  // Hovering a card shows where the listing is, the way the site's own cards
  // do. Bound here rather than delegated from the column because renderTakeover
  // rebuilds these on every page turn, so they carry their own listeners.
  article.addEventListener('mouseenter', () => focusOnMap(item, href));
  article.addEventListener('mouseleave', unfocusMap);

  return article;
}

function buildPager(pageCount, skin) {
  const S = skin.pagScope;
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (S) node.setAttribute(S, '');
    return node;
  };

  const nav = el('nav', 'pagination');
  nav.id = PAGER_ID;
  nav.setAttribute('data-sg-v02', '');
  nav.setAttribute('aria-label', 'Pagination');
  const list = el('ul', 'pagination b-pagination');

  const addItem = (label, page, { disabled = false, active = false, arrow = false } = {}) => {
    const li = el(
      'li',
      ['page-item', arrow ? 'page-arrow' : '', disabled ? 'disabled' : '', active ? 'active' : '']
        .filter(Boolean)
        .join(' ')
    );
    const link = el(disabled ? 'span' : 'a', 'page-link');
    link.textContent = label;
    if (!disabled) {
      link.href = '#';
      if (active) link.setAttribute('aria-current', 'page');
      link.addEventListener('click', (event) => {
        event.preventDefault();
        goToPage(page);
      });
    }
    li.appendChild(link);
    list.appendChild(li);
  };

  addItem('‹', currentPage - 1, { arrow: true, disabled: currentPage === 1 });
  // First, last, and a window around the current page — the same shape the
  // site's own paginator uses, ellipsis and all.
  const wanted = [1, pageCount, currentPage - 1, currentPage, currentPage + 1]
    .filter((n) => n >= 1 && n <= pageCount)
    .sort((a, b) => a - b);
  let previous = 0;
  for (const page of wanted) {
    if (page === previous) continue;
    if (page - previous > 1) addItem('…', 0, { disabled: true });
    addItem(String(page), page, { active: page === currentPage });
    previous = page;
  }
  addItem('›', currentPage + 1, { arrow: true, disabled: currentPage === pageCount });

  nav.appendChild(list);
  return nav;
}

function setResultsTotal(text) {
  const heading = document.querySelector('.ordering__total h2');
  if (!heading) return;
  if (originalTotalText === null) originalTotalText = heading.textContent;
  const next = text !== null ? text : originalTotalText;
  // Only write on a real change: this heading is Vue's, and our own mutation
  // wakes the observer that would otherwise write it again.
  if (heading.textContent !== next) heading.textContent = next;
}

function removeInjectedNodes() {
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => card.remove());
  document.getElementById(PAGER_ID)?.remove();
  document.getElementById(NOTICE_ID)?.remove();
  // A card removed under the pointer never gets its mouseleave.
  unfocusMap();
}

function buildNotice(message, retry) {
  const notice = document.createElement('div');
  notice.id = NOTICE_ID;
  notice.className = 'sg-v02-notice';
  const text = document.createElement('p');
  text.className = 'sg-v02-notice__text';
  text.textContent = message;
  notice.appendChild(text);
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sg-v02-notice__retry';
    button.textContent = 'Δοκιμάστε ξανά';
    button.addEventListener('click', retry);
    notice.appendChild(button);
  }
  return notice;
}

function placeWithoutCards(column, node) {
  const anchor =
    column.querySelector('.search-results__tile-row') ||
    column.querySelector('.ordering') ||
    column.querySelector('h1');
  // .after() rather than insertAdjacentElement: this also takes the document
  // fragment the card batch arrives in.
  if (anchor) anchor.after(node);
  else column.appendChild(node);
}

function renderTakeover() {
  const column = resultsColumn();
  if (!column || !currentResult) return;

  removeInjectedNodes();
  column.classList.add(TAKEOVER_CLASS);

  const skin = harvestSkin();
  const listings = currentResult.listings;
  const pageCount = Math.max(1, Math.ceil(listings.length / RESULTS_PER_PAGE));
  if (currentPage > pageCount) currentPage = pageCount;

  // Ours go in ahead of the site's own (hidden) cards, so the column reads
  // top-down as our results followed by our paginator.
  const anchors = cardHostAnchors();

  if (listings.length === 0) {
    const notice = buildNotice('Δεν βρέθηκαν ιδιωτικές αγγελίες σε αυτή την αναζήτηση.');
    if (anchors) anchors.host.insertBefore(notice, anchors.first);
    else placeWithoutCards(column, notice);
    setResultsTotal('0 αποτελέσματα ιδιωτών');
    // Nothing to pin, so leave the map to the site rather than blanking it.
    // An empty map reads as broken; the notice already says there's nothing.
    teardownMapPins();
    return;
  }

  const batch = document.createDocumentFragment();
  const start = (currentPage - 1) * RESULTS_PER_PAGE;
  for (const item of listings.slice(start, start + RESULTS_PER_PAGE)) {
    batch.appendChild(buildCard(item, skin));
  }
  const lastCard = batch.lastElementChild;

  if (anchors) {
    anchors.host.insertBefore(batch, anchors.first);
    if (pageCount > 1) {
      const after = pagerAnchor(anchors.host, anchors.last);
      after.insertAdjacentElement('afterend', buildPager(pageCount, skin));
    }
  } else {
    // No site cards to anchor to (a search that returned nothing of its own).
    placeWithoutCards(column, batch);
    if (pageCount > 1) lastCard?.insertAdjacentElement('afterend', buildPager(pageCount, skin));
  }

  setResultsTotal(`${listings.length} αποτελέσματα ιδιωτών`);
  ensureMapPins();
}

function goToPage(page) {
  currentPage = page;
  renderTakeover();
  resultsColumn()?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function teardownTakeover() {
  removeInjectedNodes();
  teardownMapPins();
  resultsColumn()?.classList.remove(TAKEOVER_CLASS);
  if (originalTotalText !== null) {
    setResultsTotal(null);
    originalTotalText = null;
  }
  currentResult = null;
  currentPage = 1;
}

function renderConsolidationError(pageNumber, message, canonical) {
  const column = resultsColumn();
  if (!column) return;
  removeInjectedNodes();
  // Hand the column and the map back on the way out: a failed fetch should
  // leave the user the site's own results and a note, not an empty page and a
  // note.
  column.classList.remove(TAKEOVER_CLASS);
  teardownMapPins();
  const notice = buildNotice(
    pageNumber != null
      ? `Απέτυχε η συγκεντρωτική προβολή στη σελίδα ${pageNumber}: ${message}`
      : `Απέτυχε η συγκεντρωτική προβολή: ${message}`,
    () => {
      cache.delete(canonical);
      runConsolidation();
    }
  );
  notice.classList.add('sg-v02-notice--error');
  const anchors = cardHostAnchors();
  if (anchors) anchors.host.insertBefore(notice, anchors.first);
  else placeWithoutCards(column, notice);
}

// ---- running, and reporting progress on the shared toggle ----

// There is one button, src/content.js owns it, and `filterEnabled` — declared
// there — is the single on/off state for both halves of the extension. Content
// scripts in the same isolated world share one global scope and the manifest
// runs content.js first, so reading its state and calling setToggleProgress()
// here is safe; it does mean the manifest's script order is load-bearing.

let v02Loading = false;
let v02Progress = null; // { fetched, total } during a fetch, else null
let lastFullHref = location.href;
let activeController = null;

function syncToggleProgress() {
  setToggleProgress(
    v02Loading ? (v02Progress ? `${v02Progress.fetched}/${v02Progress.total}` : '…') : null
  );
}

// A page with no results column has nothing to take over. This matters more
// now that consolidation is on by default and runs on every navigation, not
// just when a button was pressed on a search page: `performance`'s resource
// timeline survives the site's client-side navigation, so on a listing page
// reached from a search, planFetch would find the search we came from and
// re-fetch all of it before renderTakeover threw the lot away. Polled rather
// than checked once, because on a client-side navigation Vue may not have
// rendered the column yet by the time the observer fires.
async function waitForResultsColumn(signal, timeoutMs = 3000, pollMs = 150) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (signal?.aborted) return false;
    if (resultsColumn()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

async function runConsolidation() {
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const controller = activeController;

  v02Loading = true;
  v02Progress = null;
  syncToggleProgress();
  try {
    if (!(await waitForResultsColumn(controller.signal))) return;
    const result = await fetchAllPagesForCurrentSearch(controller.signal, (fetched, total) => {
      if (controller !== activeController) return;
      v02Progress = { fetched, total };
      syncToggleProgress();
    });
    if (controller.signal.aborted) return;
    if (!result) return;
    currentResult = result;
    currentPage = 1;
    renderTakeover();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error('[SG-V02] fetch pipeline failed:', err);
    // Report the failure in the site's own 30-per-page terms even when we
    // fetch 300 at a time — "σελίδα 11" is something the user can locate.
    const pageNumber = err?.offset != null ? Math.floor(err.offset / 30) + 1 : null;
    renderConsolidationError(pageNumber, err?.message || String(err), canonicalizeUrl(location.href));
  } finally {
    if (controller === activeController) {
      v02Loading = false;
      v02Progress = null;
      syncToggleProgress();
    }
  }
}

console.log('[SG-V02] consolidate.js loaded');

// Watch the DOM so we can (a) re-assert the takeover if Vue re-renders the
// results column out from under it, and (b) detect Vue-driven navigation so we
// re-fetch on a real search change. Debounced at 250ms so we run once after
// Vue's re-render settles, not on every mutation.
let v02DomTimer = null;
new MutationObserver(() => {
  if (v02DomTimer) clearTimeout(v02DomTimer);
  v02DomTimer = setTimeout(() => {
    v02DomTimer = null;
    handlePossibleNav();
    reassertTakeover();
  }, 250);
}).observe(document.body, { childList: true, subtree: true });

function reassertTakeover() {
  // Vue owns the results column and will happily re-render our nodes away.
  // Cheap to check, cheap to rebuild — and the fetch is cached, so a rebuild
  // never costs network.
  // currentResult is null on every error path, which is what keeps this from
  // fighting the retry notice renderConsolidationError leaves behind.
  if (!filterEnabled || v02Loading || !currentResult) return;
  const column = resultsColumn();
  if (!column) return;

  const contentGone =
    !document.querySelector(CARD_SELECTOR) && !document.getElementById(NOTICE_ID);
  // The class is the half of the takeover that hides the site's own cards, so
  // losing it alone is just as broken as losing ours — both sets would show at
  // once. Treat either as a takeover to rebuild.
  if (contentGone || !column.classList.contains(TAKEOVER_CLASS)) {
    renderTakeover();
    return;
  }
  // Intact, but Vue may still have redrawn the result count on its own.
  setResultsTotal(`${currentResult.listings.length} αποτελέσματα ιδιωτών`);
  // The map loads on its own schedule and is usually still empty when the
  // column is first taken over, so this is the retry: no markers to clone yet
  // means renderMapPins declined, and it gets another go every time the DOM
  // settles until it works.
  ensureMapPins();
  syncMapCaption();
}

function handlePossibleNav() {
  const currentHref = location.href;
  if (currentHref === lastFullHref) return;
  const prevCanonical = canonicalizeUrl(lastFullHref);
  const nowCanonical = canonicalizeUrl(currentHref);
  lastFullHref = currentHref;

  if (!filterEnabled) return;
  if (nowCanonical === prevCanonical) return;

  // Different search (base path or sort/filter param): drop the stale view,
  // invalidate the previous canonical's cache entry so retrying that URL later
  // re-fetches fresh data, cancel any in-flight fetch that was still targeting
  // the old search, and re-run for the new URL.
  cache.delete(prevCanonical);
  if (activeController) activeController.abort();
  teardownTakeover();
  runConsolidation();
}

// The toggle lives in content.js, so its clicks reach us as storage changes.
// (chrome.storage.onChanged fires in the writing context too, which is what
// makes this work for the tab the user actually clicked in.)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.filterEnabled) return;
  if (changes.filterEnabled.newValue) {
    runConsolidation();
    return;
  }
  // Off hands the results column straight back to the site, and cancels an
  // in-flight fetch — runConsolidation's own `finally` clears the progress
  // readout once the abort lands.
  if (activeController) activeController.abort();
  teardownTakeover();
});

// Initial hydration: load persisted state and, if on, run consolidation once
// the site has settled.
chrome.storage.sync.get({ filterEnabled: true, consolidateEnabled: null }, async (stored) => {
  // On a failed read the callback gets nothing at all, so fall back to the same
  // defaults we asked for. Survivable, but log it: it would otherwise present
  // as the toggle having silently forgotten which way the user left it.
  if (chrome.runtime.lastError) {
    console.warn('[SG-V02] could not read the toggle state:', chrome.runtime.lastError.message);
  }
  const state = stored || { filterEnabled: true, consolidateEnabled: null };
  // v0.3 had a second toggle with a key of its own; one button now, so retire
  // it rather than leaving a dead value in sync storage forever.
  if (state.consolidateEnabled !== null) chrome.storage.sync.remove('consolidateEnabled');
  await loadLabels();
  await new Promise((r) => setTimeout(r, 1500));
  if (state.filterEnabled) await runConsolidation();
});
