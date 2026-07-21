# Spitogatos — Μόνο Ιδιώτες

A small Chrome extension that hides real-estate-agency listings on
[spitogatos.gr](https://www.spitogatos.gr/), leaving only the ones posted by
private individuals (ιδιώτες).

## Why this exists

Spitogatos has no "private sellers only" filter. Its search results mix
agency ads with private posts, and if you're trying to find a place without
going through an agency, you have to skip past most of the results by hand.
This extension does that skipping for you.

The idea sounds simple, and it is, but only because the site itself already
knows which listings are private. Every card in the results grid renders a
different SVG icon depending on the poster type: `#i-private-person` for
individuals, `#i-crown` for boosted agency ads, plus a small agency-logo
image for the rest. All the extension does is read those signals and hide
what you don't want.

## What it does

On any search-results page you get a small pill button in the bottom-right
corner:

- Teal when the filter is on.
- Grey when it's off.

Click it to toggle. Your choice is remembered across page reloads, across
the site's rentals / sales / other search categories, and (if you're signed
into Chrome) across your devices via `chrome.storage.sync`.

Under the hood the extension classifies each visible card, hides the
non-private ones with `display: none`, and re-runs itself whenever the site
navigates to a new page (spitogatos.gr is a Nuxt SPA, so pagination doesn't
reload the document). It also hides the "Χρειάζεσαι τη βοήθεια ενός
ειδικού;" expert-banner card that agencies pay to place inside the results
grid.

## Consolidated view (v0.2)

Big searches spread the few private listings across many pages, and paging
through them one at a time is the whole tedium the extension is trying to
solve. As of v0.2 there's a second button, **"Δείξε όλες"**, that appears
next to "Μόνο Ιδιώτες" once the filter is on. Click it and the extension
fetches the remaining pages of the current search directly from the site's
own JSON API (`/n_api/v1/properties/search-results`) and appends every
private listing from every page in a single section below the results grid.
No pagination clicking, no reload.

Practical details worth knowing before you turn it on:

- It's opt-in and off by default. The v1 hide-agency-cards filter is
  unchanged.
- Each search triggers up to N extra API calls, one per page of results,
  spaced 200 ms apart. On a 3-page rentals search that's 3 calls; on a
  20-page sales search in a big city that's 20. This is the same endpoint
  the site's own Vue app already calls unauthenticated.
- Hard cap: 20 pages / 600 listings. Anything past that is silently
  truncated with a note. The cap exists so an ambitious search
  ("Πάτρα ενοικίαση") doesn't spawn 50 requests in a row; if the cap
  hits you a lot, `MAX_PAGES` in `src/consolidate.js` is one line to
  change.
- Cache is per search URL and per sort — changing area, category or sort
  drops the cache and re-fetches; clicking a plain paginator number
  (/selida_2, /selida_3) reuses it.
- If a fetch fails, you get a "Δοκιμάστε ξανά" retry button in the
  section header. The extension does not auto-retry — a rate-limited
  loop is how you get your IP blocked.
- Cards in the consolidated section have a softer border than the site's
  own so you can tell it's extension-added content, not part of
  spitogatos.gr's own grid.

## Install

There's no Chrome Web Store listing. To install from source:

1. Clone or download this repository.
2. Open `chrome://extensions/` and turn on Developer mode (top-right).
3. Click **Load unpacked** and select the folder.
4. Visit any search on spitogatos.gr, for example
   [this rentals search in Ν. Άρτας](https://www.spitogatos.gr/enoikiaseis-katoikies/nomos-artas),
   and the toggle appears in the bottom-right.

The extension only requests access to `https://www.spitogatos.gr/*` and
stores one boolean. No network requests of its own, no telemetry, no
background worker.

## What it does NOT do

- **Filter the map view's pins.** Only the list of cards is filtered.
  The map on the right still drops a pin for every listing regardless of
  poster type. If you rely on the map to find neighborhoods, you'll still
  see agency locations there.
- **Anything server-side of its own.** Filtering is a pure DOM operation
  in your browser. The v0.2 consolidated view calls spitogatos.gr's own
  public search-results API (the same one the site's Vue app uses), but
  nothing about your search is sent anywhere else and there's no
  telemetry.

## Expected results by region

Numbers move over time, but as a sanity check:

| Search | Private / Total (roughly) |
|---|---|
| Ν. Άρτας rentals | ~18 / 30 on page 1 |
| Ν. Άρτας sales | ~0 / 30 (almost all agency) |
| Athens Center rentals or sales | ~0 / 30 (essentially all agency) |

If you turn the filter on in Athens Center sales and see zero cards, that
isn't a bug. The listings aren't there. Use a smaller region to sanity-check
that the filter itself is running (the console will log
`[SG-FILTER] filter=on — N cards, K hidden` on every page).

## Repo layout

```
manifest.json         MV3 manifest
src/content.js        v1: detection, hiding, observer, "Μόνο Ιδιώτες" toggle
src/styles.css        v1: toggle button styling
src/consolidate.js    v0.2: API fetch, consolidated section, "Δείξε όλες" toggle
src/consolidate.css   v0.2: secondary toggle + consolidated section + card grid
icons/                16 / 48 / 128 px placeholder icons
PLAN.md               v1 build plan and site research notes
PLAN_V02.md           v0.2 milestones, API research, non-goals
```

`PLAN.md` and `PLAN_V02.md` are worth reading if you want to modify the
extension. `PLAN.md` documents which selectors were validated against how
many real listings and why the DOM icon approach was chosen; `PLAN_V02.md`
carries the API response shape, the private-listing signal (`enquirerId`),
and the rate-limit observations under which the 200 ms per-request delay
was picked.

## Development

Edit the source files, then click the reload arrow on the extension's card
in `chrome://extensions/`. A page refresh alone doesn't pick up code
changes — Chrome caches the loaded extension until you tell it to reload.

There are no build steps, no dependencies, no bundler. v1 is about 130
lines of JS + 50 lines of CSS; v0.2 adds another ~450 lines of JS + ~160
lines of CSS on top.

## Contributing

Issues and pull requests welcome. Two things worth flagging:

1. If the site changes its markup, please include the URL you tested on and
   the console output from `[SG-FILTER]` so the selector fix can be
   validated.
2. Please add a commit message that explains _why_ the change is needed, not
   just what it does. The PLAN.md file has the site-verification notes and
   should be updated alongside any selector change.
