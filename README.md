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
- **Consolidate results across pages.** If a search returns 5 private
  listings scattered across 8 pages, you still page through 8 pages. This is
  a candidate for a future version (see `PLAN.md`, "Optional: the data-layer
  approach").
- **Anything server-side.** This is 100% a DOM filter running in your
  browser. Nothing about your search is sent anywhere; if the site changes
  its markup, the filter can break until the selectors are updated.

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
manifest.json     MV3 manifest
src/content.js    Everything: detection, hiding, observer, toggle button
src/styles.css    Toggle button styling
icons/            16 / 48 / 128 px placeholder icons
PLAN.md           Full build plan and site research notes
```

`PLAN.md` is worth reading if you want to modify the extension. It documents
which selectors were validated against how many real listings, and why the
DOM icon approach was chosen over reading Nuxt's internal store.

## Development

Edit the source files, then click the reload arrow on the extension's card
in `chrome://extensions/`. A page refresh alone doesn't pick up code
changes — Chrome caches the loaded extension until you tell it to reload.

There are no build steps, no dependencies, no bundler. The whole thing is
about 100 lines of vanilla JS and 50 lines of CSS.

## Contributing

Issues and pull requests welcome. Two things worth flagging:

1. If the site changes its markup, please include the URL you tested on and
   the console output from `[SG-FILTER]` so the selector fix can be
   validated.
2. Please add a commit message that explains _why_ the change is needed, not
   just what it does. The PLAN.md file has the site-verification notes and
   should be updated alongside any selector change.
