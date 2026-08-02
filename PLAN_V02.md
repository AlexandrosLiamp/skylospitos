# Spitogatos v0.2 — "Show All Private Listings" (consolidated view)

> **Superseded in part by v0.3.** The research, endpoint facts and fetch
> strategy below still hold and are still what the code does. The *rendering*
> decision does not: this plan called for a separate labelled section appended
> below the site's grid, with deliberately distinct styling. v0.3 replaced that
> with an in-place takeover — the site's cards and paginator are hidden and the
> private listings are rendered in their place, in the site's own markup,
> re-paginated at 30 per page. Milestone 2's "do NOT clone the site's card
> component" still stands, and v0.3 keeps it: nothing is cloned. What changed is
> that the built cards now carry the site's class names and its Vue scoped-CSS
> attributes, both read off a live card at runtime, so the site's own stylesheet
> draws them. See the header comment in `src/consolidate.js` and the README's
> "Consolidated view" section for how that works. The 20-page cap in Milestone 5
> is also gone — the endpoint choice in `planFetch` is what bounds the traffic now.
>
> **And further by v0.4.** The "second, opt-in mode" framing below is gone with
> the second button. Hiding agency cards and fetching the rest of the search
> were never really two decisions, so there is one toggle now — "Μόνο Ιδιώτες",
> owned by `src/content.js` — and consolidation rides on its `filterEnabled`
> state, reporting fetch progress back through `setToggleProgress()`. That makes
> consolidation on by default, where the old `consolidateEnabled` key defaulted
> off; the key is removed from sync storage on first run. v0.4 also gives the
> takeover back the site's card-hover-highlights-the-pin behaviour, which the
> takeover had silently dropped — see the map section of `src/consolidate.js`.

## What this adds

With v1 the filter hides agency cards but leaves the site's pagination in
place. On big-city sales searches, that means the user pages through 5, 10,
20 nearly-empty pages to see maybe 3 private listings. This feature
consolidates all private listings from every page of the current search
into a single, appended section on page 1 — one scroll, no clicking.

Explicitly a second, opt-in mode. The v1 hide-agency-cards filter stays as
the default. Consolidation adds network traffic (multiple API calls per
search) and the user should be aware they're triggering it.

**Read "Verified facts" first.** They cost real research in v1 and unlock a
much simpler v0.2 than you'd otherwise design.

---

## Verified facts (carried over from v1, not re-derived)

1. **The site has a JSON API for search results.** Confirmed live during
   the v1 M3 network capture: `GET /n_api/v1/properties/search-results?listingType=rent&category=residential&areaIDs[]=153&sortBy=rankingscore&sortOrder=desc&offset=0`.
   No auth cookies required for anonymous browsing — the site's own Vue app
   calls it unauthenticated. The v1 M3 automation captured this exact call
   fired during client-side pagination.

2. **Private vs. agency is a single boolean in the API response.** Per
   `PLAN.md` fact #1 and the site's own minified JS (`isFSBO = !!enquirerId`),
   the API returns each listing with an `enquirerId` field, truthy for
   private and null/absent for agency. This was cross-validated against the
   DOM icon across 60 real listings with 100% agreement. **Use `!!enquirerId`
   as the source of truth for this feature**, not DOM inspection — we're
   working from JSON, so this is the direct signal.

3. **URL → API params mapping already exists on the site.** The v1 M3
   network capture also observed `/n_api/v1/utils/searchPath?listingType=rent&category=residential&areaIDs[]=153&…&defaults=searchResults`.
   That endpoint appears to be the site's own URL-to-params translator.
   **Try it before writing a custom parser** (see Milestone 0).

4. **Small regions like Arta rentals only have ~2 pages (~60 listings) at
   30/page.** Big-city sales can go beyond 200 listings, i.e. 7+ pages.
   Cap the fetch at 20 pages (600 listings) as a safety valve — the user
   who genuinely wants more can raise the cap in code.

5. **Existing v1 code lives at `src/content.js`** and already runs a
   `MutationObserver` on the results section, an on-page toggle button
   persisted in `chrome.storage.sync`, and applies `display:none` to
   agency cards. Reuse `getCards()`, `isPrivateListing()`, and the storage
   plumbing — don't build parallel infrastructure.

---

## Chosen approach (opinionated)

- **Fetch strategy**: sequential `fetch()` from the content script, 200ms
  between requests, hard cap at 20 pages. Cache keyed by canonical search
  URL (URL without the `/selida_N` segment). Invalidate on real URL change
  or sort change.
- **Rendering**: append a labeled section
  (`<section id="sg-v02-consolidated">`) below the current page's results
  grid, containing built-from-scratch minimal cards. Do NOT try to clone
  the site's card component and swap data in — that couples the extension
  to Vue's internal DOM structure and breaks on the next redesign.
- **UI**: a second, smaller button below the v1 toggle labeled "Δείξε
  όλες" (Show all), only visible when the v1 filter is on. Click loads +
  renders; second click removes and reverts.
- **Persisted state**: a new `chrome.storage.sync` key `consolidateEnabled`,
  default `false`.
- **No third state on the main toggle.** Two buttons is easier to explain
  than a tri-state cycle.

---

## Milestone 0 — API research (BEFORE writing any code)

**Goal**: enough certainty about the endpoint that Milestone 1 doesn't stall.

Tasks:

1. In DevTools Network tab on a fresh search (recommend
   `https://www.spitogatos.gr/enoikiaseis-katoikies/nomos-artas`), capture
   the raw request and response for `/n_api/v1/properties/search-results?…&offset=0`.
2. Confirm response shape. Document (as a comment block or `docs/api-notes.md`):
   - Where the array of listings lives (likely `.properties` or `.results`).
   - Whether each item has `enquirerId`.
   - Whether the response includes `totalCount`, `total`, `hasMore`, or
     similar so we know when to stop paginating.
   - Page size (likely 30, matching the DOM).
3. Test `offset=30`, `offset=60` — confirm they return the next slice.
4. Test `/n_api/v1/utils/searchPath?…&defaults=searchResults` with the
   query string from a real search URL — does it echo back the same params
   the browser used? If yes, reuse it in Milestone 1 for URL→params
   conversion instead of building a parser.
5. Fire 5 quick requests in a row (e.g. via a small script in the console).
   Watch for rate-limit responses (429, or noticeably slower). If any,
   document the observed throttle and note that Milestone 1's 200ms delay
   might need to grow.

**Definition of Done**: an `docs/api-notes.md` (or a comment header at the
top of the new v02 module) with:
- exact JSON path to the listings array
- exact field name for `enquirerId` (or whatever the private flag turns out
  to be — the site's minified JS calls it that, but the API response might
  name it differently)
- pagination size and total-count field
- any observed rate-limit behavior

---

## Milestone 1 — Silent background fetch

**Goal**: prove we can pull every page of a search and correctly count
private listings, with zero UI change.

New module: `src/consolidate.js` (loaded alongside `src/content.js` from
manifest). Keep the v1 file untouched to avoid churn.

Tasks:

1. Parse `location.href` to a canonical form (strip trailing `/selida_N`)
   and use it as the cache key.
2. Derive the API params (via `/n_api/v1/utils/searchPath` if M0 confirmed
   it works, else custom parser).
3. Fetch page 1, read `totalCount` (or whatever field M0 identified), compute
   max page count, cap at 20.
4. Fetch pages 2..N sequentially with `await new Promise(r =>
   setTimeout(r, 200))` between calls.
5. Filter each response by `!!item.enquirerId`. Accumulate to a flat array.
6. Cache the accumulated array in a module-level `Map` keyed by canonical
   URL.
7. Log `[SG-V02] fetched N pages, K private listings total, cached under
   <canonicalUrl>`.

**Definition of Done**: on the Arta rentals URL, opening the extension
console (isolated world) and running `window.__sgv02_debug_fetchAll()`
(temporary debug hook — remove before shipping) logs the correct count.
Cross-check: it should roughly match `sum of private counts across pages`
from v1's log lines when you paginate through manually.

---

## Milestone 2 — Rendering the consolidated section

**Goal**: display the merged listings on the page as an appended, clearly
labeled section.

Tasks:

1. Define a card template (in `src/consolidate.js`) with only essentials:
   thumbnail image, price, size in m², location, link to
   `/aggelia/<id>`. Use `font-family: inherit` and neutral card border so
   it visually matches the site without pixel-perfect mimicry.
2. Inject a `<section id="sg-v02-consolidated">` element after the
   `section.search-results__results` grid (or before the pagination
   footer, whichever renders cleaner).
3. Header of the section: "Επιπλέον ιδιωτικές αγγελίες από όλες τις
   σελίδες (X αποτελέσματα)" so the user knows this is extension-added
   content, not site-native.
4. Skip rendering listings that are already on the current page (dedupe
   by `id` or the aggelia link URL).
5. Empty state: "Δεν βρέθηκαν επιπλέον ιδιωτικές αγγελίες σε άλλες
   σελίδες."

**Definition of Done**: on `pwliseis-katoikies/nomos-artas` (which is
~100% agency, per v1 M4 finding), the consolidated section renders any
private listings across pages (likely zero, so empty state shows). On
`enoikiaseis-katoikies/nomos-artas`, the consolidated section shows
page 2's ~30 private listings appended to page 1's ~17. Total visible
privates = full-search count.

---

## Milestone 3 — Toggle UI

**Goal**: user opts into consolidation with a clear affordance.

Tasks:

1. Second button below the v1 `#sg-filter-toggle`, id `#sg-v02-toggle`,
   label "Δείξε όλες", only visible when `filterEnabled` is `true`.
2. Style it smaller and less prominent than the main toggle — this is
   a secondary action.
3. On click: flip a `consolidateEnabled` boolean, persist to
   `chrome.storage.sync`, and either kick off M1's fetch + M2's render
   or remove the injected section.
4. Loading state: while the fetch is running, disable the button and
   show "Φόρτωση…". Show progress if trivial ("σελίδα 3 από 8").

**Definition of Done**: toggle it on, section appears with correct
content. Toggle off, section removed. Reload page, `consolidateEnabled`
state persists and section is re-rendered automatically.

---

## Milestone 4 — Cache invalidation and reactivity

**Goal**: the consolidated view stays correct as the user navigates.

Tasks:

1. Reuse the v1 `MutationObserver` (or add a second observer on
   `document.head` for `<title>` changes as a crude nav-detection
   heuristic). On URL change beyond just `/selida_N`, invalidate the
   cache and re-fetch if `consolidateEnabled` is on.
2. Sort dropdown change: it's a custom Vue component (per v1 M5.3
   finding), so a plain `<select>` listener won't catch it. Watch for
   the URL to gain a `sort=` query param, or observe the results
   section's data (a fresh listing set means fresh sort). Whichever
   proves reliable in testing.
3. Ensure that clicking pagination while consolidation is on does NOT
   destroy the consolidated section — Vue re-renders the results grid,
   not our appended section, so it should survive, but verify.

**Definition of Done**: with consolidation on, navigate rentals → sales
→ rentals. Consolidated section refreshes each time with the correct
listings for the current search. Change sort order — refreshes. Click
page 2 → the consolidated section stays visible and correct.

---

## Milestone 5 — Error handling and rate limiting

**Goal**: fail gracefully; the user knows something's happening.

Tasks:

1. Wrap each fetch in try/catch; on failure, stop the loop and show a
   retry button in the section header: "Απέτυχε στη σελίδα X — δοκιμάστε
   ξανά". Don't auto-retry (that's how you get IP-blocked).
2. Handle 429 explicitly if M0 observed rate limiting: back off with a
   longer delay on retry.
3. If total pages exceed the 20-page cap, render the first 20 pages'
   worth and add a note: "Δείχνονται τα πρώτα 600 αποτελέσματα —
   περιορίστε την αναζήτηση για περισσότερα."
4. Cancel in-flight fetches when the user navigates to a different
   search (`AbortController`).

**Definition of Done**: manually disable Wi-Fi mid-fetch — the section
renders the retry state, not an infinite spinner. Re-enable Wi-Fi,
click retry, completes successfully.

---

## Milestone 6 — Polish (do only after 0–5 are solid)

Optional, in priority order:

1. **Progressive rendering**: show cards as each page's fetch completes
   instead of waiting for all. Removes the perceived latency.
2. **Prefetch on hover** of the "Δείξε όλες" button — starts the fetch
   ~500ms before the user clicks, making it feel instant.
3. **Sort options** for the consolidated view (price ascending/descending,
   date, size). The API supports these already; just expose them.
4. **Group by original page** with subtle dividers, for people who want
   context.

---

## Milestone 7 — README + manual QA

- Update `README.md` with a new section: "Consolidated view (v0.2)" —
  describe the feature honestly, mention it makes N extra API calls per
  search, and note the 600-listing cap.
- Manual QA checklist:
  1. Fresh install, consolidation off → v1 behavior identical.
  2. Turn on consolidation on Arta rentals — section shows all privates
     across both pages, deduplicating page 1's already-visible cards.
  3. Turn on consolidation on Athens Center sales — likely 0 results,
     empty state renders cleanly.
  4. Navigate between searches with consolidation on — refreshes.
  5. Console has zero uncaught errors throughout.
  6. Kill Wi-Fi mid-fetch — retry state, no infinite spinner.
  7. `chrome.storage.sync` shows `consolidateEnabled` persisted correctly.

---

## Explicit non-goals for v0.2

- **No custom search UI.** User still uses site's own filters (price,
  area, category). Consolidation only aggregates within a search the user
  already made.
- **No infinite scroll of the site's paginator.** We add a discrete
  section; we do not modify the site's own pagination.
- **No auth / wishlist / contact-form integration.** Read-only.
- **No exceeding the 20-page cap by default.** Anyone who needs more can
  edit `MAX_PAGES` in code, and if it becomes a real use case we lift the
  cap in v0.3.
- **No card-detail expansion or map integration inside the consolidated
  section.** Cards link to `/aggelia/<id>` and the user reads details on
  the site.

---

## Estimated size

- New `src/consolidate.js`: ~250–350 lines.
- Small CSS additions: ~40 lines.
- Manifest bump to load the second content script.
- No new permissions required — `host_permissions` for `spitogatos.gr` and
  `chrome.storage` already cover this.

For context: v1 is about 130 lines of JS + 50 lines of CSS. v0.2 roughly
triples the surface area, which is why it deserves a separate plan and
separate release.
