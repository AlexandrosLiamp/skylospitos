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

On any search-results page you get one button, **"Μόνο Ιδιώτες"**, sitting
in the site's own filter toolbar right after "Αποθήκευση" — orange when it's
on, white when it's off. Pages that don't render that toolbar get the same
button as a floating pill in the bottom-right corner instead.

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
solve. So "Μόνο Ιδιώτες" doesn't just hide the agency cards on the page
you're looking at: it fetches the whole current search from the site's own
JSON API, keeps the private listings, and **puts them in the results column
in place of the site's own** — same cards, same paginator, re-paginated over
the listings that are actually left. As of v0.5 the map beside them is taken
over the same way, so the agencies are gone from both halves of the page.

That used to be a second button, "Δείξε όλες". Two buttons turned out to be
one decision — nobody wants the private listings on this page but not the
next one — so as of v0.4 there is one, and it shows its progress ("Μόνο
Ιδιώτες 5/33") while the fetch runs.

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

### The map shows the private listings too

Filtering the column and leaving the map alone doesn't get rid of the
agencies — it moves them to the right-hand side of the screen. So the map gets
the same treatment as the column: the site's pins are hidden, and the extension
draws its own, one for every private listing in the consolidated result.

Just hiding the agency pins wouldn't have been enough, and the numbers are why.
The site's map is a single request of the map endpoint: 300 listings, in the
ranking order that floats boosted agency ads to the front. On the Πάτρα search
above that's 300 of 937 listings, of which exactly **two** are private — while
the search has 58. Hiding what isn't private would have traded a map full of
the wrong pins for a map with two pins on it.

The pins are clones of the site's own markers, so they inherit its scoped-CSS
attribute and its styling for free. They group the way the site groups: the map
endpoint buckets listings by 8-character geohash and draws one marker per
bucket, a bucket of more than one becoming a count bubble instead of a pin. So
58 private listings become 54 markers, four of them bubbles of two. Hovering a
card still lights up its pin, and a pin links through to its listing.

A marker isn't one shape, though — it's four, and the site swaps between them as
you zoom. Zoomed out it's a coloured dot drawn in CSS; zoomed in, an exact
location becomes a 22×28 teardrop with an SVG inside it while an approximate one
stays a dot; a bubble carries a count where a pin carries a link. So a pin is
re-cloned from whatever the site is drawing now rather than relabelled — moving
the class across was the first thing tried and it makes every pin on the map
vanish one zoom level in, because `.marker.medium` is written for a marker with
an SVG in it and a dot relabelled `medium` has none.

### Hovering a pin shows the listing

The same as hovering one of the site's: a small card over the map with the photo,
title, area, floor / rooms / baths and price, and a link through to the listing.
A count bubble shows one card per listing at that point, under the same heading
the site writes ("2 ακίνητα βρέθηκαν σε αυτό το σημείο").

The popup is a Vue component of its own, and unlike a card or a marker there is
never one in the page to copy from — it exists only while a marker is hovered.
So the extension asks for one: the site's markers are hidden while the takeover
is up, but they're still there and still bound, and a synthetic mouseover runs
their handlers whether or not the node has a box to hover. Its two scope
attributes get read off the result, which is then thrown away, and from there
the site's stylesheet draws a popup the extension builds itself — the same
bargain the cards are built on. The heading over a group is learned the same
way, and remembered per locale like the rest of the wording.

Two things about where a marker goes took measuring:

- **Not the listing's coordinates — the middle of its geohash cell.** Checked
  against 220 of the site's own markers, the cell centre is 0.28px out at the
  median where the coordinates themselves are 1.37px, and that gap doubles with
  every zoom level.
- **A listing marked `offset` is drawn 100 metres due north.** That's the site's
  flag for a location it isn't willing to be precise about, and it displaces the
  pin rather than the data. Measured at 99.9m median across the 11 such markers
  on that map, and it's a distance on the ground rather than a nudge on the
  screen — the pixel gap doubles per zoom level, 3.3px at z12 through 53.3px at
  z16.

With both applied the pins land within 0.7px of where the site would have put
them, at every zoom from 11 to 18.

Placing a pin at a coordinate means doing the map's own Web Mercator arithmetic,
which the extension calibrates off the map rather than hardcoding: a loaded
tile's URL says where in the world it belongs, its `transform` says where it
actually landed, and the difference is the origin every pin is measured from.
Panning is free — Leaflet moves the whole pane and every layer point stays
valid — but a zoom rewrites all of them, so the pins re-place themselves
whenever the map pane or its tiles change. Those three numbers are also how
the extension knows when *not* to bother: they're unchanged by a pan, so a
drag, which fires the same notifications on every frame, does no work at all.

Turning the toggle off puts the site's own pins back.

### Practical details worth knowing

- **It starts off.** Turning it on fetches every page of the search, which is
  real traffic and a real wait, and doing that uninvited to every spitogatos
  page you happen to open is not a reasonable thing for an extension to do.
  So you press the button when you want it. Your choice is remembered for the
  rest of that tab — the site's own navigations, paging and map moves won't
  undo it — and a new tab starts off again. Turning it off hands the results
  column straight back to the site, mid-fetch included.
- **Searches you've already loaded are kept**, for ten minutes and up to
  twenty of them, so going back to one costs nothing. This matters most with
  «αυτόματη ανανέωση χάρτη» on, where every map move is a new search as far as
  the site is concerned: the extension waits for the map to stop before
  fetching, so one drag is one fetch rather than one per frame, and panning
  back somewhere you've been is free. The cache lives as long as the tab does,
  so a full page reload doesn't throw the wait away.
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
  requests that way instead of 347, measured live at ~13 seconds of waiting
  versus 5m51s.

  The two were checked for equivalence rather than assumed equal: on Ν.
  Άρτας both return the same 60 listings and the *same* 45 private ids, and
  on Πάτρα both find 589 private listings. On big searches the map endpoint
  reports a smaller grand total (10,091 vs 10,390) because the ranked card
  list repeats boosted placements that the map shows once — the private set
  is unaffected.

  Requests go out in chunks of 6 with 200 ms between chunks, and the button
  counts them off — "Μόνο Ιδιώτες 5/33" — so you can watch it work instead
  of staring at a frozen spinner. Clicking it off mid-fetch aborts. Results are
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
   and the toggle appears in the filter toolbar above the results.

The extension only requests access to `https://www.spitogatos.gr/*`. It
stores one boolean (the toggle) in `chrome.storage.sync` and the label
vocabulary it learns from the page in `chrome.storage.local`. No telemetry,
no background worker; the only network requests are the consolidated view's
calls to spitogatos.gr's own API, and only while the toggle is on.

## What it does NOT do

- **Give a count bubble anything to click.** Where two private listings share a
  geohash cell the map draws one bubble with a "2" on it, and clicking it does
  nothing — no zoom, no re-centre. That's not a shortcut; the site's own bubbles
  don't respond to a click either, verified by clicking one. Hovering it lists
  both listings, and both are in the column regardless.
- **Reproduce every part of a site card.** The consolidated view's cards, and
  the card inside a map popup, have no photo carousel and no favourite / hide /
  compare buttons — those are Vue components with their own state, and a
  dead-looking copy of them would be worse than leaving them out. Clicking
  either opens the listing as usual.
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
src/content.js        detection, hiding, observer, and the one toggle
src/styles.css        toggle button styling
src/consolidate.js    API fetch, results-column takeover, map-pin takeover
src/consolidate.css   takeover rules + notice states
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
