# Spitogatos "Private Sellers Only" Filter — Build Plan

## What this extension does

A Chrome (Manifest V3) extension for `https://www.spitogatos.gr/*` that hides
listing cards posted by real-estate agencies (μεσιτικά γραφεία) on
search-results pages, leaving only listings posted by private individuals
(ιδιώτης). A small on-page toggle button turns the filter on/off, and the
state persists across page loads.

This document is written for an autonomous coding agent (Opus 4.7) to execute
step by step. Each milestone has a goal, concrete implementation notes
(including ground-truth selectors already verified against the live site,
across 60 real listings in two categories), and a "Definition of Done" test
the agent must actually perform before moving on — not just write code and
assume it works.

**Read "Verified facts about the site" before starting.** It saves you from
re-discovering things by trial and error, and hands you the one non-obvious
fact (a dedicated "private person" icon the site itself renders) that makes
this whole extension far simpler than it first looks.

---

## Verified facts about the site (confirmed live, 2026-07-20)

1. **The site itself marks private listings with a dedicated icon — use
   this.** Every result card contains an inline SVG using a sprite sheet
   (`/_nuxt/<hash>.svg`). Private-individual listings render:
   ```html
   <svg><use href="/_nuxt/<hash>.svg#i-private-person" ...></use></svg>
   ```
   Agency listings instead render a `#i-crown` icon (for boosted/VIP tiers)
   and/or a second small `<img>` (the agency's logo, ~100×50px) inside the
   card, and **never** render `#i-private-person`.

   This was cross-checked against the site's own underlying data (the Nuxt
   store's per-listing `reAgent` field — a non-null object with
   `agencyName`/`agencyLogo` for agency posters, `null` for private ones) across
   **60 real listings** (30 rentals + 30 sales in Ν. Άρτας, a region with a
   healthy mix of both): **100% agreement, zero mismatches.** Presence of the
   `#i-private-person` icon in a card is both necessary and sufficient to
   identify a private listing.

   Third, independent confirmation: the site's own minified JS (fetched and
   grepped directly, ~2.2MB across 23 bundles) defines this exact concept in
   its source — a component computes `this.isFSBO = !!t.enquirerId` (FSBO =
   "for sale by owner") and branches on it to decide whether to render the
   agency logo (`reAgent.agencyLogo`) or the private-seller icon. So there are
   now three independent ways to derive the same boolean (DOM icon, `reAgent`
   nullness, `enquirerId` truthiness) and all three agree perfectly — use
   whichever is most convenient, the DOM icon remains the recommended one for
   v1 since it needs no access to page-internal JS state at all.

   **This means the entire extension can be a single, ordinary content
   script** — no need to read the page's internal JS state, no isolated/MAIN
   world split, no message-passing bridge. Just inspect the rendered DOM.
   (An earlier draft of this plan was built around reading
   `window.__NUXT__.state.searchResults.properties[].reAgent` instead, which
   works too but requires a MAIN-world script + a storage bridge since
   MAIN-world scripts can't call `chrome.storage`. That's now optional
   advanced/stretch material — see the very end of this doc under "Optional:
   the data-layer approach" — not required for a correct, robust v1.)

2. **No native filter exists, and there's no dormant one to silently
   re-enable either — this was checked, not assumed.** The site's own
   "Φίλτρα" (more filters) modal was opened and inspected end-to-end (floor,
   bedrooms, year built, energy class, heating, suitability, interior
   features, "listings with only photos/reduced price", date filters) — no
   owner-type / agency vs. private control anywhere in the UI. Beyond the UI,
   three further checks came up empty too, in case an old filter had been
   hidden rather than actually removed:
   - The real internal search API the map view calls
     (`/n_api/v1/properties/search-results-map`) was queried directly with
     ~19 plausible parameter names (`ownerType`, `dealerType`,
     `advertiserType`, `isPrivate`, `noAgency`, `excludeAgents`, etc.) — every
     one returned an identical result count to the baseline, i.e. the backend
     silently ignores all of them.
   - All 23 of the site's JS bundles were downloaded and grepped for leftover
     filter code. The `isFSBO`/`enquirerId` concept (see fact #1) does exist,
     but only in tile-rendering code — nothing like `onlyFSBO`, `excludeFSBO`,
     or any filter/search-criteria code path referencing it was found
     anywhere.
   - The site's GrowthBook feature-flag config (it runs A/B tests through
     GrowthBook) was fetched directly — only one flag is being served to a
     normal session, unrelated to this.

   Conclusion: this genuinely has to be done client-side by the extension —
   it is not recoverable via a hidden query param, a leftover dead code path,
   or a feature flag.

3. **Card DOM structure (List view, default)**:
   ```
   article.ordered-element              <- one card, this is what you hide/show
     └── div.tile.tile--horizontal...
           ├── a.tile__link[href^="/aggelia/"]
           └── ...svg use[href$="#i-private-person"]   <- present only if private
   ```
   The card's tile modifier class also varies (`tile--simple`, `tile--up`,
   `tile--vip`, `tile--horizontal`) reflecting the listing's paid boost tier —
   **do not use these tier classes as your private/agency signal**, they're
   about ad promotion level, not poster type, and weren't validated the way
   the icon was. Stick to the icon.

4. **A good, real test fixture**: `https://www.spitogatos.gr/enoikiaseis-katoikies/nomos-artas`
   (rentals in the Arta region) had **18 of 30** listings private on first
   page load at the time of writing — use this URL while developing so you
   can see real hide/show behavior on both sides, rather than a page that's
   100% one type. Contrast with big cities: Patra and Athens-Center rental/sale
   searches sampled at ~150 listings combined were **100% agency** — i.e. it's
   normal and expected for a big-city search with the filter on to show very
   few or zero results. Don't mistake that for a bug; use the Arta URL to
   confirm the toggle logic itself is correct, then spot-check a big city
   separately just for "does it still run cleanly with 0 matches."

5. **Pagination is real (numbered pages, e.g. `.../nomos-artas/selida_2`), not
   infinite scroll, and it's client-side routed** (Nuxt/Vue Router) — the URL
   changes but the page doesn't hard-reload. The extension **must** re-run its
   filtering logic after every client-side navigation, not just once on load.
   A `MutationObserver` on the results container is the reliable way to catch
   this (confirmed live: clicking to page 2 replaces the DOM subtree without a
   full navigation).

6. There is also a non-listing "promo" card sometimes mixed into results
   grids (seen live: a boxed ad reading "Χρειάζεσαι τη βοήθεια ενός ειδικού;
   — Tzeli Real Estate — Μήνυμα"). Its exact class name wasn't captured this
   session — a milestone below has you inspect and handle it explicitly.

7. Out of scope for v1, called out as known limitations: the map view's pins
   (separate rendering path) and the "Gallery" grid view (likely different
   card markup — verify below, fix if trivial, otherwise document as
   unsupported for v1).

---

## Milestone 0 — Project scaffold

**Goal**: an empty-but-loadable Chrome extension, one content script.

- Folder layout:
  ```
  /manifest.json
  /src/content.js       (all logic: detection, filtering, observer, toggle UI)
  /src/styles.css        (toggle button styling, injected via content_scripts css)
  /icons/icon16.png, icon48.png, icon128.png   (placeholder is fine, see below)
  ```
- `manifest.json` (Manifest V3):
  ```json
  {
    "manifest_version": 3,
    "name": "Spitogatos – Μόνο Ιδιώτες",
    "version": "0.1.0",
    "description": "Κρύβει τις αγγελίες μεσιτικών γραφείων στο spitogatos.gr και εμφανίζει μόνο αγγελίες ιδιωτών.",
    "permissions": ["storage"],
    "host_permissions": ["https://www.spitogatos.gr/*"],
    "icons": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    },
    "content_scripts": [
      {
        "matches": ["https://www.spitogatos.gr/*"],
        "js": ["src/content.js"],
        "css": ["src/styles.css"],
        "run_at": "document_idle"
      }
    ]
  }
  ```
  Note there is deliberately no `"world": "MAIN"` entry and no second script —
  this content script runs in the normal isolated world, which is exactly
  where you want to be to call `chrome.storage.local` directly.
- Generate 3 placeholder PNG icons (any simple colored square/house glyph is
  fine — visual polish isn't the point yet).

**Definition of Done**: Open `chrome://extensions`, enable Developer Mode,
"Load unpacked", select the folder. It loads with **no errors** shown on the
card. Navigate to `https://www.spitogatos.gr/enoikiaseis-katoikies/nomos-artas`
and confirm in DevTools that the content script injected with no console
errors (a simple `console.log('[SG-FILTER] content script loaded')` at the
top of `content.js` is enough to prove it for now).

---

## Milestone 1 — Detection logic (read-only, just log for now)

**Goal**: prove you can correctly classify every card on a real page before
you start hiding anything.

- Selectors:
  ```js
  function getCards() {
    return Array.from(document.querySelectorAll('article.ordered-element'));
  }
  function isPrivateListing(card) {
    return !!card.querySelector('svg use[href$="#i-private-person"]');
  }
  ```
- On load, log a count: how many cards found, how many classified private vs.
  agency.

**Definition of Done**: Load
`https://www.spitogatos.gr/enoikiaseis-katoikies/nomos-artas` and confirm the
logged counts look plausible (expect roughly a 40/60 to 60/40 private/agency
split on this URL, at the time of writing it was 18 private / 12 agency out of
30 — the exact numbers will drift over time as listings change, that's fine,
just confirm it's not 0 or 30 which would indicate your selector is wrong).
Cross check a couple of individual cards by eye: scroll to a card with no
agency logo badge, confirm your function returns `true` for it; scroll to one
with an agency logo, confirm `false`.

---

## Milestone 2 — Core filter logic (single pass, no reactivity yet)

**Goal**: given the current DOM, hide agency cards and show private ones,
once, on initial page load, gated by an on/off flag read from
`chrome.storage.local`.

```js
const HIDDEN_ATTR = 'data-sg-hidden';

function applyFilter(enabled) {
  for (const card of getCards()) {
    const shouldHide = enabled && !isPrivateListing(card);
    card.style.display = shouldHide ? 'none' : '';
    card.toggleAttribute(HIDDEN_ATTR, shouldHide);
  }
}

chrome.storage.local.get({ filterEnabled: true }, ({ filterEnabled }) => {
  applyFilter(filterEnabled);
});
```

Default the stored value to `true` (filter on by default) since that's the
entire point of the extension — a first-time user should see it working
immediately, not have to find a button first.

**Definition of Done**: Load the Arta rentals URL with the filter forced
`true` (it's the default, so just a fresh load). Confirm visually: cards
showing an agency logo badge in the corner are hidden; cards without one
(showing the generic silhouette icon) remain. Then manually flip the stored
value to `false` via the extension's console (`chrome.storage.local.set({filterEnabled:false})`)
and reload — confirm the full, unfiltered list returns. This proves both
directions work before you build a button for it.

---

## Milestone 3 — Reactivity: keep filtering after pagination/sort changes

**Goal**: the filter re-applies automatically whenever the results grid
changes, without a full page reload, since pagination is client-side routed.

- Locate the results container once:
  `document.querySelector('section.search-results__results')` — fall back to
  `document.body` if that selector isn't found (defensive, in case markup
  differs on some category pages — verify against at least one rentals page
  and one sale page).
- Attach a `MutationObserver` on that container with
  `{ childList: true, subtree: true }`.
- Debounce the callback (e.g. via `requestAnimationFrame` or a ~150ms
  `setTimeout` coalescing multiple mutations into one `applyFilter()` call) —
  Vue re-renders fire many small DOM mutations per navigation; don't re-scan
  the whole grid dozens of times per click.
- Re-read the current `filterEnabled` value from storage inside the debounced
  handler (or keep a module-level variable updated whenever the toggle
  changes — either is fine, just make sure a page that starts with the filter
  off and then gets toggled on mid-session keeps behaving correctly after
  subsequent pagination).

**Definition of Done**: On the Arta rentals URL, with the filter on, click
through to page 2 and page 3 using the site's own pagination UI (not a manual
URL reload) and confirm agency cards are hidden on each new page **without a
console error and without a full page navigation** (watch the Network tab —
there should be no full-document request). Also change the sort order
("Αυτόματη Ταξινόμηση" dropdown) and confirm the filter still applies to the
re-sorted results.

---

## Milestone 4 — On-page toggle button

**Goal**: a small, discreet, always-visible control that flips the filter on
and off and reflects current state, persisted across reloads.

- Inject a fixed-position pill button (bottom-right corner is a safe default
  that won't collide with the site's own sticky map/filter bar):
  ```html
  <div id="sg-filter-toggle" class="sg-filter-toggle" data-on="true">
    <span class="sg-filter-toggle__dot"></span>
    <span class="sg-filter-toggle__label">Μόνο Ιδιώτες</span>
  </div>
  ```
- Style it in `styles.css`: small, rounded, subtle shadow, a clearly different
  visual state for on (e.g. accent color) vs. off (greyed out) — should read
  as "unobtrusive but obviously clickable", not blend into invisibility.
- Click handler: flip local boolean → update button's `data-on`
  attribute/label → call `applyFilter(newValue)` immediately →
  `chrome.storage.local.set({ filterEnabled: newValue })`.
- On initial load, read storage before first render of the button so it
  starts in the correct visual state (don't flash "on" then jump to "off").
- Inject the button once per page and make sure the `MutationObserver` from
  Milestone 3 doesn't accidentally treat your own button as a "card" or strip
  it out on re-render (scope your card queries to `article.ordered-element`
  only, and append the button to `document.body` or a stable top-level
  container outside the results grid, not inside it).

**Definition of Done**: Click the button — cards visibly hide/show
immediately, with no page reload. Reload the page — the button starts in
whatever state you last left it in (test both: leave it off, reload, confirm
still off and full list showing; leave it on, reload, confirm still on and
filtered). Navigate between two different searches in the same session to
confirm the state is shared across the domain, not per-page. Paginate a few
pages after toggling to confirm the button itself survives (isn't removed by
a mutation observer false-positive).

---

## Milestone 5 — Edge cases and known-rough-edges

Work through each of these explicitly; don't skip any as "probably fine":

1. **Promo/expert-agent banner card**: inspect the live DOM for the boxed
   ad-style card (search for text containing "Χρειάζεσαι τη βοήθεια" or
   inspect elements that don't have a price/sqm but sit inside the results
   grid). Confirm whether it matches `article.ordered-element` at all — if it
   does, it will lack the private-person icon and get hidden automatically by
   the existing logic (verify this happens); if it uses different markup
   entirely, add explicit handling to hide it when the filter is on.
2. **Cards with ambiguous/missing markup**: if you find any card that isn't
   clearly classifiable (e.g. a "new development" project card with unusual
   structure), decide and document a default (recommended: leave visible, so
   an edge case fails open rather than hiding legitimate private listings),
   and log a `console.warn` when this happens so it's debuggable later.
3. **Gallery view**: click the "Gallery" toggle near the map control, inspect
   whether `article.ordered-element` / the private-person icon selector still
   match. If the markup differs, add a second selector path; if it's a large
   divergence, document it as unsupported in v1 rather than half-implementing
   it.
4. **Map view / map pins**: confirm (and document in the README) that v1 does
   not filter map pins — only the list. This is an accepted limitation, not a
   bug to fix now.
5. **Very fast repeated clicks on pagination/sort**: click through several
   pages quickly and confirm no error spam in console and no stale hidden
   cards left over from a previous page (the debounce from Milestone 3 should
   handle this, but verify under real clicking speed, not just single clicks).
6. **A page that ends up with 0 visible results after filtering** (expected
   on big-city searches, see fact #4): confirm the page doesn't look broken —
   you're only hiding DOM elements the site already rendered, not intercepting
   its own result count or triggering its "no results" empty-state, but do a
   visual check that an entirely-hidden results column next to the still
   populated map doesn't look glitchy. If it looks bad, consider (as an
   optional stretch) injecting a small "X αγγελίες μεσιτών κρύφτηκαν" (X
   agency listings hidden) notice when the visible count is 0.

**Definition of Done**: each item above has been manually checked against the
live site and either fixed or explicitly written down as a documented
limitation in the README (Milestone 7).

---

## Milestone 6 — Polish (do after 0–5 are solid, not before)

Optional, in priority order — stop at any point and ship:

1. Small counter badge on the toggle button showing how many cards are
   currently hidden (`"Μόνο Ιδιώτες (12 κρυμμένες)"`), updated on every
   `applyFilter()` call.
2. FOUC (flash-of-unfiltered-content) prevention: an early injected CSS rule
   hiding `article.ordered-element` by default until the first
   classification pass completes, with a hard safety timeout (e.g. 3s) that
   force-reveals everything if something goes wrong — never let a JS error
   permanently hide the page's content.
3. `chrome.storage.sync` instead of `local`, so the on/off preference follows
   the user across signed-in Chrome installs.
4. A drag-to-reposition toggle button (persist chosen corner/position).
5. A matching toolbar popup (`action` + `popup.html`) as a redundant control
   surface — only worth it if the in-page button alone feels insufficient
   once actually used.

---

## Milestone 7 — Manual QA pass + README

- Write a short README covering: what the extension does, how to load it
  unpacked, how the toggle works, and the documented limitations from
  Milestone 5 (map pins, Gallery view if unsupported, and the fact that
  big-city searches may show very few private results while smaller-region
  searches like Arta show a healthy mix).
- Run through this full QA checklist once, end to end, on a fresh Chrome
  profile with only this extension loaded:
  1. Fresh install, first page load on the Arta rentals URL — filter defaults
     to **on**, mixed private/agency cards visibly filtered correctly.
  2. Toggle off/on repeatedly — instant visual response, no console errors.
  3. Paginate 3+ pages with filter on — stays correctly applied each time.
  4. Change sort order with filter on — stays correctly applied.
  5. Reload the page — toggle state persisted correctly.
  6. Visit both a rentals URL and a sale URL (different slug prefixes:
     `enoikiaseis-katoikies` vs. `pwliseis-katoikies`) — both work.
  7. Visit a big-city search (e.g. Athens-Center or Patra) — no crashes even
     though most/all results may be hidden.
  8. Open DevTools console throughout — zero uncaught errors at any point
     above.

---

## Explicit non-goals for v1

- Filtering the map pins.
- Supporting the Gallery grid view, unless Milestone 5.3 finds it's a trivial
  selector tweak.
- Any server-side or account-level filtering — this is 100% a client-side,
  per-browser DOM filter with no network requests of its own.
- Any attempt to submit forms, log in, or interact with the site beyond
  reading already-rendered DOM and toggling `display` on existing elements.

---

## Optional: the data-layer approach (not required, background only)

For context/future reference, not something to build for v1: the site is a
Nuxt.js/Vue SPA, and every listing's underlying data (including a `reAgent`
field — a non-null object with `agencyName`/`agencyLogo`/`agentProfilePath`
for agency posters, `null` for private ones — and an `enquirerId` field,
nonzero only for private posters) is available at
`window.__NUXT__.state.searchResults.properties`, which stays live/reactive
across client-side pagination (also mirrored at
`window.$nuxt.$store.state.searchResults.properties`, same object reference).
This was the original basis for detection before the DOM icon was discovered,
and cross-validating it against the icon across 60 real listings (30 rentals
+ 30 sales) produced zero disagreements — so it's a proven-equivalent signal,
useful if a future feature wants richer data (e.g. showing the actual agency
name in a tooltip on hover for transparency, or a smarter counter). Notably,
`!!listing.enquirerId` is the exact formula the site's own frontend code uses
internally (as `isFSBO`) to decide which icon to render — so if this route is
ever taken, that's the more "canonical" field to key off, though `reAgent`
works identically.

If ever pursued: a normal content script **cannot** see `window.__NUXT__` (it
runs in an isolated JS world); Chrome 111+ supports declaring a second content
script with `"world": "MAIN"` in `manifest.json` to access it, but MAIN-world
scripts can't call `chrome.storage` — so persistence would need a small
`postMessage`-based bridge to an isolated-world script. That complexity is
exactly what the icon-based approach above lets you skip entirely for v1.
