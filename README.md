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

## Consolidated view

Big searches spread the few private listings across many pages, and paging
through them one at a time is the whole tedium the extension is trying to
solve. There's a second button, **"Δείξε όλες"**, that appears next to "Μόνο
Ιδιώτες" once the filter is on. Click it and the extension fetches the whole
current search from the site's own JSON API, keeps the private listings, and
**puts them in the results column in place of the site's own** — same cards,
same paginator, re-paginated over the listings that are actually left.

A worked example. This search:

```
/enoikiaseis-katoikies/patra/timi_eos-350/emvado_apo-35
```

is 961 listings across 32 pages, of which 58 are private. With the
consolidated view on it becomes **2 pages of 30**, and page 1 of the site's
own — which happens to be 30 agency listings and nothing else — stops being
something you have to page past.

### How it looks native

The cards are built by the extension, not cloned from the page, but they
carry the site's own class names *and* its Vue scoped-CSS attributes
(`data-v-…`), which the extension reads off a live card at runtime. The
site's stylesheet then draws them: same 320×240 thumbnail, same title,
location, description, room icons, date and price, and the same layout in
list view and gallery view. Nothing about the look is hardcoded, so a site
restyle carries over on its own.

The same trick covers the text the API doesn't carry. `subtype` comes back
as a number and `floorNumber` as an enum (`3` → ΙΣ, `4` → ΗΜ, `6` → 1ος), so
the extension pairs the ~30 cards the site has already rendered against
their own API records and reads the labels off the page, remembering them in
`chrome.storage.local`. That works in Greek and English alike, and doesn't
rot when the site changes wording.

The site's own paginator is hidden and replaced with one of ours, in the
same markup and style. It doesn't touch the URL — paging is instant and
doesn't make the site re-fetch anything.

### Practical details worth knowing

- It's opt-in and off by default. The v1 hide-agency-cards filter is
  unchanged, and turning either one off puts the results column straight
  back to the site's own.
- Two endpoints back this, both taking the same query string as the search
  itself and both returning the `enquirerId` field that marks a private
  seller:
  - `/n_api/v1/properties/search-results` — 30 per request, the one behind
    the card grid. Includes each listing's description text.
  - `/n_api/v1/properties/search-results-map` — 300 per request, the one
    behind the map's pins. No descriptions.

  A search that fits in 40 card-endpoint requests (~1200 listings, i.e.
  anything you've actually narrowed down) uses the card endpoint, because
  the descriptions are most of what makes the cards look right. Anything
  wider switches to the map endpoint: unfiltered Πάτρα rentals is 34
  requests that way instead of 347, measured live at ~13 seconds of
  "Φόρτωση…" versus 5m51s.

  The two were checked for equivalence rather than assumed equal: on Ν.
  Άρτας both return the same 60 listings and the *same* 45 private ids, and
  on Πάτρα both find 589 private listings. On big searches the map endpoint
  reports a smaller grand total (10,091 vs 10,390) because the ranked card
  list repeats boosted placements that the map shows once — the private set
  is unaffected.

  Requests go out in chunks of 6 with 200 ms between chunks, and the button
  shows a live "N/33" counter so you can watch it work instead of staring at
  a frozen spinner. Clicking the toggle again mid-fetch aborts. Results are
  deduplicated by listing id, because offset paging over a list that is
  still being edited can hand you the same listing twice.
- The API answers in English unless asked otherwise, even on the Greek site,
  so requests carry an `Accept-Language` header taken from `<html lang>`.
- Fetching everything for a large city really does pay off. Πάτρα rentals
  returned 589 private listings, essentially all of them past page 20 (the
  site's default `sortBy=rankingscore` bubbles agency-boosted ads to the
  front, so a naïve first-page-only view misses the entire private tail).
- Cache is per search URL and per sort — changing area, category or sort
  drops the cache and re-fetches.
- If a fetch fails you get a "Δοκιμάστε ξανά" retry button where the results
  would be. The extension does not auto-retry — a rate-limited loop is how
  you get your IP blocked.

## Install

There's no Chrome Web Store listing. To install from source:

1. Clone or download this repository.
2. Open `chrome://extensions/` and turn on Developer mode (top-right).
3. Click **Load unpacked** and select the folder.
4. Visit any search on spitogatos.gr, for example
   [this rentals search in Ν. Άρτας](https://www.spitogatos.gr/enoikiaseis-katoikies/nomos-artas),
   and the toggle appears in the bottom-right.

The extension only requests access to `https://www.spitogatos.gr/*`. It
stores two booleans (the two toggles) in `chrome.storage.sync` and the
label vocabulary it learns from the page in `chrome.storage.local`. No
telemetry, no background worker; the only network requests are the
consolidated view's calls to spitogatos.gr's own API, and only when you
turn it on.

## What it does NOT do

- **Filter the map view's pins.** Only the list of cards is filtered.
  The map on the right still drops a pin for every listing regardless of
  poster type, including while the consolidated view is on. If you rely on
  the map to find neighborhoods, you'll still see agency locations there.
- **Reproduce every part of a site card.** The consolidated view's cards
  have no photo carousel and no favourite / hide / compare buttons — those
  are Vue components with their own state, and a dead-looking copy of them
  would be worse than leaving them out. Clicking a card opens the listing as
  usual.
- **Anything server-side of its own.** Filtering is a pure DOM operation
  in your browser. The consolidated view calls spitogatos.gr's own public
  search API (the same one the site's Vue app uses), but nothing about your
  search is sent anywhere else and there's no telemetry.

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
src/consolidate.js    v0.3: API fetch, results-column takeover, "Δείξε όλες" toggle
src/consolidate.css   v0.3: secondary toggle + takeover rules + notice states
icons/                16 / 48 / 128 px placeholder icons
PLAN.md               v1 build plan and site research notes
PLAN_V02.md           v0.2 milestones, API research, non-goals
```

`PLAN.md` and `PLAN_V02.md` are worth reading if you want to modify the
extension. `PLAN.md` documents which selectors were validated against how
many real listings and why the DOM icon approach was chosen; `PLAN_V02.md`
carries the API response shape, the private-listing signal (`enquirerId`),
and the rate-limit observations behind the current chunk size and delay.

## Development

Edit the source files, then click the reload arrow on the extension's card
in `chrome://extensions/`. A page refresh alone doesn't pick up code
changes — Chrome caches the loaded extension until you tell it to reload.

There are no build steps, no dependencies, no bundler. v1 is about 130
lines of JS + 50 lines of CSS; the consolidated view adds `src/consolidate.js`
on top, which is roughly half comments — the site research behind each
decision is written where the code that depends on it lives.

## Contributing

Issues and pull requests welcome. Two things worth flagging:

1. If the site changes its markup, please include the URL you tested on and
   the console output from `[SG-FILTER]` so the selector fix can be
   validated.
2. Please add a commit message that explains _why_ the change is needed, not
   just what it does. The PLAN.md file has the site-verification notes and
   should be updated alongside any selector change.
