// Spitogatos "Μόνο Ιδιώτες" — content script.
// Milestone 5: unified detector (works in both List and Gallery view) plus
// hiding of the "expert-banner" agency ad card. Still driven by a
// MutationObserver + trailing debounce so it survives client-side pagination
// and sort changes, and an on-page toggle button persisted in chrome.storage.

const HIDDEN_ATTR = 'data-sg-hidden';
const DEBOUNCE_MS = 150;
const TOGGLE_ID = 'sg-filter-toggle';
const TOGGLE_LABEL = 'Μόνο Ιδιώτες';
const PROMO_SELECTOR = '.expert-banner';
// The site's own "Αποθήκευση" save-search button lives inside
// .listing-filters__inner; we sit right after it so the toolbar reads
// as one row of related controls.
const TOOLBAR_SELECTOR = '.listing-filters__inner';
const SAVE_BTN_SELECTOR = '.listing-filters__save-btn';

let filterEnabled = true;
let debounceTimer = null;

function getCards() {
  // [data-sg-v02] cards are the consolidated view's own (src/consolidate.js).
  // They're private listings by construction and their visibility belongs to
  // that module, so this filter leaves them alone.
  return Array.from(
    document.querySelectorAll('article.ordered-element:not([data-sg-v02])')
  );
}

function isPrivateListing(card) {
  // List view: the positive private-person icon is definitive (validated
  // across 60 real listings with 100% agreement — see PLAN.md fact #1).
  if (card.querySelector('svg use[href$="#i-private-person"]')) return true;
  // Gallery view drops the private icon entirely (verified live), so fall
  // back to positive AGENCY signals: the #i-crown VIP-boost badge (only
  // agencies get it) or a 100×50 agency-logo <img>. On the Arta rentals
  // list-view fixture the fallback classifies every non-private card
  // correctly (0 cards had neither signal), so it's safe to use in both
  // views and it fails open — an unknown card type stays visible rather
  // than being wrongly hidden.
  const hasAgencyMarker =
    !!card.querySelector('svg use[href$="#i-crown"]') ||
    !!card.querySelector('img[src*="_100x50"]');
  return !hasAgencyMarker;
}

function applyFilter() {
  const cards = getCards();
  let hiddenCards = 0;
  for (const card of cards) {
    const shouldHide = filterEnabled && !isPrivateListing(card);
    card.style.display = shouldHide ? 'none' : '';
    card.toggleAttribute(HIDDEN_ATTR, shouldHide);
    if (shouldHide) hiddenCards++;
  }
  // Site promo banners ("Χρειάζεσαι τη βοήθεια…") don't match
  // article.ordered-element but ARE agency ads, so hide them alongside
  // agency cards when the filter is on.
  const promos = document.querySelectorAll(PROMO_SELECTOR);
  for (const promo of promos) {
    const shouldHide = filterEnabled;
    promo.style.display = shouldHide ? 'none' : '';
    promo.toggleAttribute(HIDDEN_ATTR, shouldHide);
  }
  console.log(
    `[SG-FILTER] filter=${filterEnabled ? 'on' : 'off'} — ${cards.length} cards, ${hiddenCards} hidden, ${cards.length - hiddenCards} visible; ${promos.length} promo banner${promos.length !== 1 ? 's' : ''}`
  );
}

function ensureToggleButton() {
  const toolbar = document.querySelector(TOOLBAR_SELECTOR);
  const saveBtn = toolbar ? toolbar.querySelector(SAVE_BTN_SELECTOR) : null;
  const existing = document.getElementById(TOGGLE_ID);

  // Preferred slot: immediately after the site's save-search button, inside
  // the same flex row. If Vue re-rendered the toolbar and orphaned our
  // button elsewhere, move it back into place rather than duplicating.
  if (toolbar && saveBtn) {
    if (existing && existing.previousElementSibling === saveBtn) return;
    const btn = existing || buildToggleButton();
    saveBtn.insertAdjacentElement('afterend', btn);
    updateToggleUI(btn);
    return;
  }

  // Fallback for pages that don't render the filter toolbar (defensive —
  // v1 only ran on search results, but a floating button beats no button).
  if (existing) return;
  const btn = buildToggleButton();
  btn.classList.add('sg-filter-toggle--floating');
  updateToggleUI(btn);
  (document.body || document.documentElement).appendChild(btn);
}

function buildToggleButton() {
  const btn = document.createElement('button');
  btn.id = TOGGLE_ID;
  btn.className = 'sg-filter-toggle';
  btn.type = 'button';
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML =
    '<span class="sg-filter-toggle__dot"></span>' +
    '<span class="sg-filter-toggle__label"></span>';
  btn.querySelector('.sg-filter-toggle__label').textContent = TOGGLE_LABEL;
  btn.addEventListener('click', toggleFilter);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleFilter();
    }
  });
  return btn;
}

function updateToggleUI(btn) {
  btn = btn || document.getElementById(TOGGLE_ID);
  if (!btn) return;
  btn.setAttribute('data-on', filterEnabled ? 'true' : 'false');
  btn.setAttribute('aria-pressed', filterEnabled ? 'true' : 'false');
  btn.title = filterEnabled
    ? 'Φίλτρο ενεργό — κλικ για να δεις όλες τις αγγελίες'
    : 'Φίλτρο ανενεργό — κλικ για μόνο ιδιώτες';
}

function toggleFilter() {
  filterEnabled = !filterEnabled;
  chrome.storage.sync.set({ filterEnabled });
  applyFilter();
  updateToggleUI();
}

// Vue re-renders fire many small DOM mutations per nav; trailing debounce
// coalesces them into one applyFilter() call once the burst quiets.
function scheduleApply() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    ensureToggleButton();
    applyFilter();
  }, DEBOUNCE_MS);
}

function startObserver() {
  const target =
    document.querySelector('section.search-results__results') || document.body;
  new MutationObserver(scheduleApply).observe(target, {
    childList: true,
    subtree: true,
  });
}

console.log('[SG-FILTER] content script loaded');

chrome.storage.sync.get({ filterEnabled: true }, ({ filterEnabled: stored }) => {
  filterEnabled = stored;
  ensureToggleButton();
  applyFilter();
  startObserver();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.filterEnabled) return;
  filterEnabled = changes.filterEnabled.newValue;
  applyFilter();
  updateToggleUI();
});
