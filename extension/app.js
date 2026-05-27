/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * clearArchivedTabs()
 *
 * Sweeps every completed-but-not-yet-dismissed saved tab into 'dismissed'.
 * Returns the number of items cleared so callers can show a toast.
 */
async function clearArchivedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  let cleared = 0;
  for (const t of deferred) {
    if (t.completed && !t.dismissed) {
      t.dismissed = true;
      cleared++;
    }
  }
  if (cleared > 0) {
    await chrome.storage.local.set({ deferred });
  }
  return cleared;
}


/* ----------------------------------------------------------------
   PINNED SITES — chrome.storage.local

   Up to PINNED_LIMIT entries; clicking a tile opens the URL in a
   new tab (chrome.tabs.create). Storage shape:
     pinnedSites = [{ id, url, title, addedAt }, ...]
   ---------------------------------------------------------------- */

const PINNED_LIMIT = 10;

async function getPinnedSites() {
  const { pinnedSites = [] } = await chrome.storage.local.get('pinnedSites');
  return pinnedSites;
}

async function addPinnedSite({ url, title }) {
  const pinnedSites = await getPinnedSites();
  if (pinnedSites.length >= PINNED_LIMIT) {
    throw new Error(`Pinned limit is ${PINNED_LIMIT}`);
  }
  pinnedSites.push({
    id: Date.now().toString(),
    url, title,
    addedAt: new Date().toISOString(),
  });
  await chrome.storage.local.set({ pinnedSites });
}

async function updatePinnedSite(id, { url, title }) {
  const pinnedSites = await getPinnedSites();
  const item = pinnedSites.find(p => p.id === id);
  if (!item) return;
  item.url = url;
  item.title = title;
  await chrome.storage.local.set({ pinnedSites });
}

async function removePinnedSite(id) {
  const pinnedSites = (await getPinnedSites()).filter(p => p.id !== id);
  await chrome.storage.local.set({ pinnedSites });
}

/**
 * reorderPinnedSites(idOrder)
 *
 * Persists a new order for the pinned tiles based on the given
 * array of ids. Any ids missing from `idOrder` are appended at the
 * end (defensive: should not happen but keeps state consistent).
 */
async function reorderPinnedSites(idOrder) {
  const pinnedSites = await getPinnedSites();
  const byId = new Map(pinnedSites.map(p => [p.id, p]));
  const seen = new Set();
  const reordered = [];
  for (const id of idOrder) {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      reordered.push(item);
      seen.add(id);
    }
  }
  for (const p of pinnedSites) {
    if (!seen.has(p.id)) reordered.push(p);
  }
  await chrome.storage.local.set({ pinnedSites: reordered });
}


/* ----------------------------------------------------------------
   SEARCH TEMPLATES — chrome.storage.local

   Each template is { id, label, urlTemplate } where urlTemplate
   must contain at least one `{}` placeholder. Filling a parameter
   replaces every `{}` with encodeURIComponent(param).

   Storage:
     searchTemplates       = [{ id, label, urlTemplate, addedAt }, ...]
     activeSearchTemplateId = "<id>"   // remembered across reloads
   ---------------------------------------------------------------- */

const TEMPLATE_LABEL_LIMIT = 12;

async function getSearchTemplates() {
  const { searchTemplates = [], activeSearchTemplateId = null } =
    await chrome.storage.local.get(['searchTemplates', 'activeSearchTemplateId']);
  return { templates: searchTemplates, activeId: activeSearchTemplateId };
}

async function addSearchTemplate({ label, urlTemplate }) {
  validateTemplate({ label, urlTemplate });
  const { templates } = await getSearchTemplates();
  templates.push({
    id: Date.now().toString(),
    label: label.trim(),
    urlTemplate: urlTemplate.trim(),
    addedAt: new Date().toISOString(),
  });
  await chrome.storage.local.set({ searchTemplates: templates });
}

async function updateSearchTemplate(id, { label, urlTemplate }) {
  validateTemplate({ label, urlTemplate });
  const { templates } = await getSearchTemplates();
  const item = templates.find(t => t.id === id);
  if (!item) return;
  item.label = label.trim();
  item.urlTemplate = urlTemplate.trim();
  await chrome.storage.local.set({ searchTemplates: templates });
}

async function removeSearchTemplate(id) {
  const { templates, activeId } = await getSearchTemplates();
  const filtered = templates.filter(t => t.id !== id);
  const updates = { searchTemplates: filtered };
  if (activeId === id) updates.activeSearchTemplateId = null;
  // Drop the deleted template's parameter history too, so storage
  // doesn't accumulate stale entries.
  const { templateHistory = {} } = await chrome.storage.local.get('templateHistory');
  if (templateHistory[id]) {
    delete templateHistory[id];
    updates.templateHistory = templateHistory;
  }
  await chrome.storage.local.set(updates);
}


/* ----------------------------------------------------------------
   TEMPLATE PARAMETER HISTORY — chrome.storage.local

   Per-template MRU of the last HISTORY_LIMIT parameters used.
   Storage shape:
     templateHistory = { "<templateId>": ["param1", "param2", ...] }
   (Most recent first.)
   ---------------------------------------------------------------- */

const HISTORY_LIMIT = 3;

async function getTemplateHistory(templateId) {
  if (!templateId) return [];
  const { templateHistory = {} } = await chrome.storage.local.get('templateHistory');
  return Array.isArray(templateHistory[templateId]) ? templateHistory[templateId] : [];
}

async function addToTemplateHistory(templateId, param) {
  if (!templateId || !param) return;
  const { templateHistory = {} } = await chrome.storage.local.get('templateHistory');
  const existing = Array.isArray(templateHistory[templateId]) ? templateHistory[templateId] : [];
  // Dedupe + MRU bump + cap at HISTORY_LIMIT.
  const updated = [param, ...existing.filter(p => p !== param)].slice(0, HISTORY_LIMIT);
  templateHistory[templateId] = updated;
  await chrome.storage.local.set({ templateHistory });
}

async function removeFromTemplateHistory(templateId, param) {
  if (!templateId) return;
  const { templateHistory = {} } = await chrome.storage.local.get('templateHistory');
  const existing = Array.isArray(templateHistory[templateId]) ? templateHistory[templateId] : [];
  const filtered = existing.filter(p => p !== param);
  if (filtered.length === existing.length) return;
  if (filtered.length === 0) delete templateHistory[templateId];
  else templateHistory[templateId] = filtered;
  await chrome.storage.local.set({ templateHistory });
}

async function setActiveTemplate(id) {
  await chrome.storage.local.set({ activeSearchTemplateId: id });
}

/**
 * reorderSearchTemplates(idOrder)
 *
 * Persists a new order for the chips based on the given array of
 * template ids. Any ids missing from `idOrder` are appended (same
 * defensive pattern as reorderPinnedSites). Affects the meaning of
 * Cmd+1..5 since shortcut index follows array order.
 */
async function reorderSearchTemplates(idOrder) {
  const { templates } = await getSearchTemplates();
  const byId = new Map(templates.map(t => [t.id, t]));
  const seen = new Set();
  const reordered = [];
  for (const id of idOrder) {
    const item = byId.get(id);
    if (item && !seen.has(id)) {
      reordered.push(item);
      seen.add(id);
    }
  }
  for (const t of templates) {
    if (!seen.has(t.id)) reordered.push(t);
  }
  await chrome.storage.local.set({ searchTemplates: reordered });
}

function validateTemplate({ label, urlTemplate }) {
  const lab = (label || '').trim();
  const tpl = (urlTemplate || '').trim();
  if (!lab) throw new Error('Label is required');
  if (lab.length > TEMPLATE_LABEL_LIMIT) {
    throw new Error(`Label must be at most ${TEMPLATE_LABEL_LIMIT} chars`);
  }
  if (!tpl.includes('{}')) {
    throw new Error('URL template must contain {} as the parameter placeholder');
  }
  try {
    new URL(tpl.replace(/\{\}/g, 'x'));
  } catch {
    throw new Error('URL template is not a valid URL');
  }
}

function expandTemplate(urlTemplate, param) {
  const encoded = encodeURIComponent(param.trim());
  return urlTemplate.replace(/\{\}/g, encoded);
}


/* ----------------------------------------------------------------
   FIRST-RUN SEED from config.local.js

   If chrome.storage.local has no pinnedSites / searchTemplates yet,
   seed from LOCAL_PINNED_SITES / LOCAL_SEARCH_TEMPLATES if defined
   in extension/config.local.js. Never overwrites existing user data.
   ---------------------------------------------------------------- */
async function maybeSeedFromConfig() {
  const { pinnedSites, searchTemplates } =
    await chrome.storage.local.get(['pinnedSites', 'searchTemplates']);

  const updates = {};

  if ((!pinnedSites || pinnedSites.length === 0)
      && typeof LOCAL_PINNED_SITES !== 'undefined'
      && Array.isArray(LOCAL_PINNED_SITES)) {
    updates.pinnedSites = LOCAL_PINNED_SITES
      .filter(p => p && p.url && p.title)
      .slice(0, PINNED_LIMIT)
      .map((p, i) => ({
        id:      `seed-pin-${Date.now()}-${i}`,
        url:     p.url,
        title:   p.title,
        addedAt: new Date().toISOString(),
      }));
  }

  if ((!searchTemplates || searchTemplates.length === 0)
      && typeof LOCAL_SEARCH_TEMPLATES !== 'undefined'
      && Array.isArray(LOCAL_SEARCH_TEMPLATES)) {
    updates.searchTemplates = LOCAL_SEARCH_TEMPLATES
      .filter(t => t && t.label && t.urlTemplate && t.urlTemplate.includes('{}'))
      .map((t, i) => ({
        id:          `seed-tpl-${Date.now()}-${i}`,
        label:       t.label.slice(0, TEMPLATE_LABEL_LIMIT),
        urlTemplate: t.urlTemplate,
        addedAt:     new Date().toISOString(),
      }));
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}


/* ----------------------------------------------------------------
   CONFIG EXPORT / LOAD

   Two manual actions, exposed in both manage drawers:

   - exportConfig()  builds a config.local.js mirroring current
                     chrome.storage and triggers a browser download.
   - loadFromConfig() takes whatever LOCAL_* globals are in scope
                     (loaded from extension/config.local.js at
                     startup) and OVERWRITES pinnedSites +
                     searchTemplates in chrome.storage, then clears
                     templateHistory because template ids changed.
   ---------------------------------------------------------------- */

async function buildConfigFileContent() {
  const pinned          = await getPinnedSites();
  const { templates }   = await getSearchTemplates();
  const landingPatterns = (typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined'
                          && Array.isArray(LOCAL_LANDING_PAGE_PATTERNS))
                         ? LOCAL_LANDING_PAGE_PATTERNS : [];
  const customGroups    = (typeof LOCAL_CUSTOM_GROUPS !== 'undefined'
                          && Array.isArray(LOCAL_CUSTOM_GROUPS))
                         ? LOCAL_CUSTOM_GROUPS : [];

  // Strip internal fields so the file stays human-readable / diff-friendly
  const pinnedClean    = pinned.map(p   => ({ title: p.title, url: p.url }));
  const templatesClean = templates.map(t => ({ label: t.label, urlTemplate: t.urlTemplate }));

  const fmt = arr => arr.length === 0
    ? '[]'
    : '[\n' + arr.map(o => '  ' + JSON.stringify(o)).join(',\n') + '\n]';

  return `/* ============================================================
   Tab Out — Personal config (gitignored)
   Exported on ${new Date().toISOString()}

   On first run (storage empty), maybeSeedFromConfig copies the
   LOCAL_* values below into chrome.storage. After that, edits via
   the UI live in chrome.storage and this file becomes stale.
   Use "Load from config.local.js" in the manage drawer to apply
   this file on top of existing storage.
   ============================================================ */

const LOCAL_LANDING_PAGE_PATTERNS = ${fmt(landingPatterns)};

const LOCAL_CUSTOM_GROUPS = ${fmt(customGroups)};

const LOCAL_PINNED_SITES = ${fmt(pinnedClean)};

const LOCAL_SEARCH_TEMPLATES = ${fmt(templatesClean)};
`;
}

async function exportConfig() {
  const content = await buildConfigFileContent();
  const blob = new Blob([content], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'config.local.js';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function loadFromConfig() {
  const hasPinned    = typeof LOCAL_PINNED_SITES    !== 'undefined' && Array.isArray(LOCAL_PINNED_SITES);
  const hasTemplates = typeof LOCAL_SEARCH_TEMPLATES !== 'undefined' && Array.isArray(LOCAL_SEARCH_TEMPLATES);
  if (!hasPinned && !hasTemplates) return null;

  const updates = {};
  const stamp   = Date.now();

  if (hasPinned) {
    updates.pinnedSites = LOCAL_PINNED_SITES
      .filter(p => p && p.url && p.title)
      .slice(0, PINNED_LIMIT)
      .map((p, i) => ({
        id:      `load-pin-${stamp}-${i}`,
        url:     p.url,
        title:   p.title,
        addedAt: new Date().toISOString(),
      }));
  }

  if (hasTemplates) {
    updates.searchTemplates = LOCAL_SEARCH_TEMPLATES
      .filter(t => t && t.label && t.urlTemplate && t.urlTemplate.includes('{}'))
      .map((t, i) => ({
        id:          `load-tpl-${stamp}-${i}`,
        label:       t.label.slice(0, TEMPLATE_LABEL_LIMIT),
        urlTemplate: t.urlTemplate,
        addedAt:     new Date().toISOString(),
      }));
    // Template ids changed, so any per-template MRU history is orphaned
    updates.templateHistory = {};
  }

  await chrome.storage.local.set(updates);
  return {
    pinnedCount:   updates.pinnedSites?.length    ?? 0,
    templateCount: updates.searchTemplates?.length ?? 0,
  };
}


/* ----------------------------------------------------------------
   SMALL HTML ESCAPE HELPER — used for user-supplied strings that
   land inside template literals (labels, URLs, titles).
   ---------------------------------------------------------------- */
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


/* ----------------------------------------------------------------
   FAVICON URL — uses Chrome's own favicon cache via the MV3
   `_favicon/` resource. Works for any URL Chrome has visited,
   including private/internal hosts (e.g. *.bytedance.net) where
   public favicon services like Google's can't reach.

   Requires `"favicon"` permission + `_favicon/*` in
   web_accessible_resources (see manifest.json).
   ---------------------------------------------------------------- */
function getFaviconUrl(pageUrl, size = 32) {
  if (!pageUrl) return '';
  try {
    const u = new URL(chrome.runtime.getURL('/_favicon/'));
    u.searchParams.set('pageUrl', pageUrl);
    u.searchParams.set('size', String(size));
    return u.toString();
  } catch {
    return '';
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * recomputeOpenTabsCounts(ownerCard)
 *
 * After a single tab is closed (close-single-tab) or saved (defer-single-tab),
 * the badge text, "Close all N" button, "N duplicates" badge, "Close N
 * duplicates" button, section header, and footer all drift out of sync.
 *
 * Recomputes from the freshly-fetched openTabs and the live DOM:
 *   - Card tab count: number of openTabs whose URL matches a chip in this card
 *   - Card dupes: sum of (Nx) values on remaining chips
 *   - Section header: domain count from live (non-closing) cards, total from getRealTabs()
 *   - Footer: openTabs.length
 *
 * Counts on the card use openTabs URL match (not DOM chip count) so a chip
 * representing N duplicates that was just decremented still contributes its
 * remaining instances to the total.
 */
function recomputeOpenTabsCounts(ownerCard) {
  if (ownerCard) {
    const chipUrls = new Set();
    ownerCard.querySelectorAll('.page-chip[data-action="focus-tab"]').forEach(c => {
      if (c.dataset.tabUrl) chipUrls.add(c.dataset.tabUrl);
    });
    const cardTabCount = openTabs.filter(t => chipUrls.has(t.url)).length;

    let extras = 0;
    ownerCard.querySelectorAll('.chip-dupe-badge').forEach(b => {
      const m = b.textContent.match(/\((\d+)x\)/);
      if (m) extras += parseInt(m[1], 10) - 1;
    });

    const tabBadge = ownerCard.querySelector('.tabs-count-badge');
    if (tabBadge && cardTabCount > 0) {
      tabBadge.innerHTML = `${ICONS.tabs} ${cardTabCount} tab${cardTabCount !== 1 ? 's' : ''} open`;
    }

    const dupesBadge = ownerCard.querySelector('.dupes-count-badge');
    if (dupesBadge) {
      if (extras > 0) {
        dupesBadge.innerHTML = `${extras} duplicate${extras !== 1 ? 's' : ''}`;
      } else {
        dupesBadge.remove();
      }
    }

    const closeAllBtn = ownerCard.querySelector('.action-btn.close-tabs[data-action="close-domain-tabs"]');
    if (closeAllBtn && cardTabCount > 0) {
      closeAllBtn.innerHTML = `${ICONS.close} Close all ${cardTabCount} tab${cardTabCount !== 1 ? 's' : ''}`;
    }

    const dedupBtn = ownerCard.querySelector('.action-btn[data-action="dedup-keep-one"]');
    if (dedupBtn) {
      if (extras > 0) {
        dedupBtn.innerHTML = `Close ${extras} duplicate${extras !== 1 ? 's' : ''}`;
      } else {
        dedupBtn.remove();
      }
    }
  }

  const sectionCount = document.getElementById('openTabsSectionCount');
  if (sectionCount) {
    const realCount = getRealTabs().length;
    const liveCards = document.querySelectorAll('.mission-card:not(.closing)').length;
    sectionCount.innerHTML = `${liveCards} domain${liveCards !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realCount} tabs</button>`;
  }

  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = getFaviconUrl(tab.url, 32);
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge tabs-count-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge dupes-count-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = getFaviconUrl(tab.url, 32);
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = getFaviconUrl(item.url, 32);
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item" data-deferred-id="${escAttr(item.id)}">
      <a href="${escAttr(item.url)}" target="_blank" rel="noopener" class="archive-item-title" title="${escAttr(item.title)}">
        ${escText(item.title || item.url)}
      </a>
      <span class="archive-item-date">${escText(ago)}</span>
      <button class="archive-dismiss" data-action="dismiss-deferred" data-deferred-id="${escAttr(item.id)}" title="Remove from archive" aria-label="Remove from archive">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}


/* ----------------------------------------------------------------
   PINNED ROW — Render header-right tiles
   ---------------------------------------------------------------- */

async function renderPinnedRow() {
  const row = document.getElementById('pinnedRow');
  if (!row) return;

  const pinnedSites = await getPinnedSites();

  const tiles = pinnedSites.map(p => {
    let domain = '';
    try { domain = new URL(p.url).hostname; } catch {}
    const favicon  = getFaviconUrl(p.url, 32);
    const initial  = ((p.title || domain || '?').trim().charAt(0) || '?').toUpperCase();
    return `<button class="pinned-tile" draggable="true" data-action="open-pinned" data-pinned-id="${escAttr(p.id)}" data-pinned-url="${escAttr(p.url)}" title="${escAttr(p.title)}\n${escAttr(p.url)}">
      <span class="pinned-favicon">
        ${favicon ? `<img src="${escAttr(favicon)}" alt="" onerror="this.parentElement.classList.add('favicon-failed')">` : ''}
        <span class="pinned-fallback">${escText(initial)}</span>
      </span>
      <span class="pinned-label">${escText(p.title)}</span>
    </button>`;
  }).join('');

  const addBtn = pinnedSites.length < PINNED_LIMIT
    ? `<button class="pinned-tile pinned-tile-add" data-action="manage-pinned" title="Add pinned site">+</button>`
    : '';

  row.innerHTML = tiles + addBtn;
}


/* ----------------------------------------------------------------
   QUICK JUMP BAR — Render chips + input placeholder + enabled state
   ---------------------------------------------------------------- */

async function renderQuickJumpBar() {
  const chips = document.getElementById('qjChips');
  const input = document.getElementById('qjInput');
  const goBtn = document.querySelector('#quickJumpBar .qj-go');
  if (!chips || !input) return;

  const { templates, activeId } = await getSearchTemplates();

  // Pick the active template: stored choice, else first available.
  let active = templates.find(t => t.id === activeId) || templates[0] || null;
  if (active && active.id !== activeId) {
    // Persist the implicit choice so chip highlight is stable across reloads.
    setActiveTemplate(active.id);
  }

  const chipHtml = templates.map(t => {
    const isActive = active && t.id === active.id;
    return `<button class="qj-chip${isActive ? ' qj-chip-active' : ''}" draggable="true" data-action="select-template" data-template-id="${escAttr(t.id)}" title="${escAttr(t.urlTemplate)}">${escText(t.label)}</button>`;
  }).join('');

  const addChip = `<button class="qj-chip qj-chip-add" data-action="manage-templates" title="Add search template">+</button>`;
  chips.innerHTML = chipHtml + addChip;

  const hasTemplates = templates.length > 0;
  input.disabled    = !hasTemplates;
  input.placeholder = active ? `enter parameter for ${active.label}` : 'add a template to start';
  if (goBtn) goBtn.disabled = !hasTemplates;

  // If the input is currently focused, refresh the history dropdown
  // so chip switches reflect the new template's MRU immediately.
  if (document.activeElement === input) {
    showHistoryDropdown();
  } else {
    hideHistoryDropdown();
  }
}


/* ----------------------------------------------------------------
   QUICK JUMP TRIGGER — expands the active template and opens the
   resulting URL in a new tab.
   ---------------------------------------------------------------- */

async function triggerQuickJump() {
  const input = document.getElementById('qjInput');
  if (!input || input.disabled) return;

  const param = (input.value || '').trim();
  if (!param) {
    showToast('Enter a parameter first');
    input.focus();
    return;
  }

  const { templates, activeId } = await getSearchTemplates();
  const template = templates.find(t => t.id === activeId) || templates[0];
  if (!template) return;

  const url = expandTemplate(template.urlTemplate, param);
  try { new URL(url); }
  catch { showToast('Resulting URL is invalid'); return; }

  // Record the parameter in the per-template MRU history before
  // navigating, so it persists even if the user closes this tab.
  await addToTemplateHistory(template.id, param);

  await chrome.tabs.create({ url });
  input.value = '';
  hideHistoryDropdown();
}


/* ----------------------------------------------------------------
   QUICK JUMP HISTORY DROPDOWN

   Shows the per-template MRU parameters below #qjInput while it is
   focused. Filtered by the current input value (substring match).
   Clicking an item fills the input AND jumps immediately; keyboard
   nav is wired in the global keydown listener at the bottom.
   ---------------------------------------------------------------- */

async function showHistoryDropdown() {
  const input    = document.getElementById('qjInput');
  const dropdown = document.getElementById('qjHistory');
  if (!input || !dropdown) return;
  if (input.disabled) { dropdown.style.display = 'none'; return; }

  const { templates, activeId } = await getSearchTemplates();
  const template = templates.find(t => t.id === activeId) || templates[0];
  if (!template) { dropdown.style.display = 'none'; return; }

  const history = await getTemplateHistory(template.id);
  if (history.length === 0) { dropdown.style.display = 'none'; return; }

  const query = (input.value || '').trim().toLowerCase();
  const filtered = query
    ? history.filter(h => h.toLowerCase().includes(query))
    : history;

  if (filtered.length === 0) { dropdown.style.display = 'none'; return; }

  dropdown.innerHTML = filtered.map(h => `
    <button class="qj-history-item" data-action="use-history-item" data-history-value="${escAttr(h)}" data-template-id="${escAttr(template.id)}">
      <span class="qj-history-item-icon">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
      </span>
      <span class="qj-history-item-value">${escText(h)}</span>
      <span class="qj-history-clear" data-action="forget-history-item" data-history-value="${escAttr(h)}" data-template-id="${escAttr(template.id)}" title="Forget this entry">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </span>
    </button>
  `).join('');
  dropdown.style.display = 'block';
}

function hideHistoryDropdown() {
  const dropdown = document.getElementById('qjHistory');
  if (!dropdown) return;
  dropdown.style.display = 'none';
  dropdown.innerHTML = '';
}


/* ----------------------------------------------------------------
   MANAGE DRAWER — right-slide editor for pinned sites + templates
   ---------------------------------------------------------------- */

function openManageDrawer(mode) {
  const drawer = document.getElementById('manageDrawer');
  const title  = document.getElementById('drawerTitle');
  const body   = document.getElementById('drawerBody');
  if (!drawer || !title || !body) return;

  drawer.dataset.mode  = mode;
  drawer.style.display = 'flex';

  if (mode === 'pinned') {
    title.textContent = 'Pinned sites';
    renderPinnedDrawer(body);
  } else if (mode === 'templates') {
    title.textContent = 'Search templates';
    renderTemplatesDrawer(body);
  }

  // Focus the first input for fast typing
  setTimeout(() => {
    const firstInput = body.querySelector('input');
    if (firstInput) firstInput.focus();
  }, 60);
}

function closeManageDrawer() {
  const drawer = document.getElementById('manageDrawer');
  if (!drawer) return;
  drawer.style.display = 'none';
  drawer.dataset.mode  = '';
  const body = document.getElementById('drawerBody');
  if (body) body.innerHTML = '';
}

async function renderPinnedDrawer(body) {
  const pinnedSites = await getPinnedSites();

  const listHtml = pinnedSites.length === 0
    ? '<div class="drawer-empty">No pinned sites yet.</div>'
    : `<ul class="drawer-list">${pinnedSites.map(p => renderPinnedDrawerRow(p)).join('')}</ul>`;

  const canAdd = pinnedSites.length < PINNED_LIMIT;
  const addHtml = canAdd
    ? `<div class="drawer-add-form">
        <h5>Add pinned site</h5>
        <input type="text" id="newPinnedTitle" placeholder="Title (e.g. GitHub)" autocomplete="off" spellcheck="false" />
        <input type="text" id="newPinnedUrl" placeholder="https://github.com" autocomplete="off" spellcheck="false" />
        <div class="drawer-add-form-actions">
          <button class="drawer-add-submit" data-action="submit-add-pinned">Add</button>
        </div>
        <div class="drawer-add-error" id="addPinnedError"></div>
      </div>`
    : `<div class="drawer-help">Pinned limit (${PINNED_LIMIT}) reached. Remove one to add a new one.</div>`;

  body.innerHTML = `
    <div class="drawer-section">
      <h4>Pinned <span>(${pinnedSites.length}/${PINNED_LIMIT})</span></h4>
      ${listHtml}
      ${addHtml}
    </div>
    ${renderConfigFileSection()}
  `;
}

function renderConfigFileSection() {
  return `
    <div class="drawer-section drawer-config-section">
      <h4>Config file</h4>
      <p class="drawer-help">Back up pinned sites and search templates to <code>extension/config.local.js</code>, or reload that file into storage.</p>
      <div class="drawer-config-actions">
        <button class="drawer-config-btn" data-action="export-config" title="Download a config.local.js mirroring your current pinned sites and search templates">Export to config.local.js</button>
        <button class="drawer-config-btn drawer-config-btn-danger" data-action="load-from-config" title="Replace pinned sites and search templates with what is in config.local.js (clears template parameter history)">Load from config.local.js</button>
      </div>
    </div>
  `;
}

function renderPinnedDrawerRow(p) {
  let domain = '';
  try { domain = new URL(p.url).hostname; } catch {}
  const favicon = getFaviconUrl(p.url, 32);
  return `<li data-pinned-id="${escAttr(p.id)}">
    <div class="drawer-row-display">
      ${favicon ? `<img src="${escAttr(favicon)}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="drawer-row-title">${escText(p.title)}</span>
      <span class="drawer-row-meta">${escText(domain || p.url)}</span>
      <span class="drawer-row-actions">
        <button data-action="edit-pinned-row" data-pinned-id="${escAttr(p.id)}">Edit</button>
        <button class="delete-btn" data-action="delete-pinned-row" data-pinned-id="${escAttr(p.id)}">Delete</button>
      </span>
    </div>
  </li>`;
}

async function renderTemplatesDrawer(body) {
  const { templates } = await getSearchTemplates();

  const listHtml = templates.length === 0
    ? '<div class="drawer-empty">No templates yet.</div>'
    : `<ul class="drawer-list">${templates.map(t => renderTemplateDrawerRow(t)).join('')}</ul>`;

  body.innerHTML = `
    <div class="drawer-section">
      <h4>Templates <span>(${templates.length})</span></h4>
      ${listHtml}
      <div class="drawer-add-form">
        <h5>Add search template</h5>
        <input type="text" id="newTemplateLabel" placeholder="Label (e.g. RDS)" maxlength="${TEMPLATE_LABEL_LIMIT}" autocomplete="off" spellcheck="false" />
        <input type="text" id="newTemplateUrl" placeholder="https://example.com/{}/path" autocomplete="off" spellcheck="false" />
        <div class="drawer-add-form-actions">
          <button class="drawer-add-submit" data-action="submit-add-template">Add</button>
        </div>
        <div class="drawer-add-error" id="addTemplateError"></div>
        <div class="drawer-help">Use <code>{}</code> as the placeholder for your parameter (URL-encoded on jump).</div>
      </div>
    </div>
    ${renderConfigFileSection()}
  `;
}

function renderTemplateDrawerRow(t) {
  return `<li data-template-id="${escAttr(t.id)}">
    <div class="drawer-row-display">
      <span class="drawer-chip">${escText(t.label)}</span>
      <span class="drawer-row-meta" title="${escAttr(t.urlTemplate)}">${escText(t.urlTemplate)}</span>
      <span class="drawer-row-actions">
        <button data-action="edit-template-row" data-template-id="${escAttr(t.id)}">Edit</button>
        <button class="delete-btn" data-action="delete-template-row" data-template-id="${escAttr(t.id)}">Delete</button>
      </span>
    </div>
  </li>`;
}

function switchToEditMode(li, mode, item) {
  if (mode === 'pinned') {
    li.innerHTML = `
      <div class="drawer-row-edit">
        <input type="text" data-field="title" value="${escAttr(item.title)}" placeholder="Title" />
        <input type="text" data-field="url" value="${escAttr(item.url)}" placeholder="https://..." />
        <div class="drawer-row-edit-actions">
          <button class="save-btn" data-action="save-pinned-row" data-pinned-id="${escAttr(item.id)}">Save</button>
          <button data-action="cancel-edit-row">Cancel</button>
          <span class="inline-error"></span>
        </div>
      </div>
    `;
  } else {
    li.innerHTML = `
      <div class="drawer-row-edit">
        <input type="text" data-field="label" value="${escAttr(item.label)}" placeholder="Label" maxlength="${TEMPLATE_LABEL_LIMIT}" />
        <input type="text" data-field="urlTemplate" value="${escAttr(item.urlTemplate)}" placeholder="https://example.com/{}/path" />
        <div class="drawer-row-edit-actions">
          <button class="save-btn" data-action="save-template-row" data-template-id="${escAttr(item.id)}">Save</button>
          <button data-action="cancel-edit-row">Cancel</button>
          <span class="inline-error"></span>
        </div>
      </div>
    `;
  }
  const firstInput = li.querySelector('input');
  if (firstInput) firstInput.focus();
}

/* Re-render the drawer body for the currently open mode (after a
   storage update) without recreating the drawer chrome. */
async function refreshDrawer() {
  const drawer = document.getElementById('manageDrawer');
  const body   = document.getElementById('drawerBody');
  if (!drawer || !body) return;
  const mode = drawer.dataset.mode;
  if (mode === 'pinned')         await renderPinnedDrawer(body);
  else if (mode === 'templates') await renderTemplatesDrawer(body);
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Pinned + Quick Jump (independent of tab data) ---
  await renderPinnedRow();
  await renderQuickJumpBar();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await maybeSeedFromConfig();
  await renderStaticDashboard();
}

/* Show the platform-appropriate keyboard hint in the Quick Jump bar.
   Mac → ⌘K, others → Ctrl+K. Runs once at startup. */
function updateShortcutLabel() {
  const kbd = document.getElementById('qjShortcut');
  if (!kbd) return;
  const isMac = /Mac/i.test(navigator.platform);
  kbd.textContent = isMac ? '⌘K' : 'Ctrl+K';
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    const chip      = actionEl.closest('.page-chip');
    const ownerCard = chip ? chip.closest('.mission-card') : null;

    // Close one matching tab in Chrome (URL match)
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // If this URL still has remaining duplicates, keep the chip and just
    // decrement its (Nx) badge instead of removing it.
    const dupeBadge = chip?.querySelector('.chip-dupe-badge');
    if (dupeBadge) {
      const m = dupeBadge.textContent.match(/\((\d+)x\)/);
      if (m) {
        const next = parseInt(m[1], 10) - 1;
        if (next > 1) {
          dupeBadge.textContent = ` (${next}x)`;
        } else {
          dupeBadge.remove();
          chip.classList.remove('chip-has-dupes');
        }
        recomputeOpenTabsCounts(ownerCard);
        showToast('Tab closed');
        return;
      }
    }

    // No duplicates: fade the chip out, then refresh counts and possibly the
    // empty card.
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        recomputeOpenTabsCounts(ownerCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    } else {
      recomputeOpenTabsCounts(ownerCard);
    }

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    const chip      = actionEl.closest('.page-chip');
    const ownerCard = chip ? chip.closest('.mission-card') : null;

    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // If duplicates remain, keep the chip and decrement its badge
    const dupeBadge = chip?.querySelector('.chip-dupe-badge');
    if (dupeBadge) {
      const m = dupeBadge.textContent.match(/\((\d+)x\)/);
      if (m) {
        const next = parseInt(m[1], 10) - 1;
        if (next > 1) {
          dupeBadge.textContent = ` (${next}x)`;
        } else {
          dupeBadge.remove();
          chip.classList.remove('chip-has-dupes');
        }
        recomputeOpenTabsCounts(ownerCard);
        showToast('Saved for later');
        await renderDeferredColumn();
        return;
      }
    }

    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        recomputeOpenTabsCounts(ownerCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    } else {
      recomputeOpenTabsCounts(ownerCard);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (works for both active and archive) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item, .archive-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    } else {
      // Fallback: archive search results may live in a different
      // structure; just re-render the column.
      renderDeferredColumn();
    }
    return;
  }

  // ---- Clear all archived saved tabs ----
  if (action === 'clear-archive') {
    const { archived } = await getSavedTabs();
    if (archived.length === 0) return;
    const noun = archived.length === 1 ? 'tab' : 'tabs';
    if (!confirm(`Clear ${archived.length} archived ${noun}? This cannot be undone.`)) return;
    const cleared = await clearArchivedTabs();
    renderDeferredColumn();
    showToast(`Cleared ${cleared} archived ${cleared === 1 ? 'tab' : 'tabs'}`);
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }

  /* ============================================================
     PINNED SITES + SEARCH TEMPLATES — handlers
     ============================================================ */

  // ---- Open a pinned site in a new tab ----
  if (action === 'open-pinned') {
    const url = actionEl.dataset.pinnedUrl;
    if (url) await chrome.tabs.create({ url });
    return;
  }

  // ---- Open the manage drawer for pinned ----
  if (action === 'manage-pinned') {
    openManageDrawer('pinned');
    return;
  }

  // ---- Open the manage drawer for templates ----
  if (action === 'manage-templates') {
    openManageDrawer('templates');
    return;
  }

  // ---- Close the manage drawer ----
  if (action === 'close-drawer') {
    closeManageDrawer();
    return;
  }

  // ---- Export current config to a downloadable config.local.js ----
  if (action === 'export-config') {
    try {
      await exportConfig();
      showToast('Downloaded config.local.js — replace extension/config.local.js, then reload the extension');
    } catch (err) {
      console.warn('[tab-out] export failed:', err);
      showToast('Export failed');
    }
    return;
  }

  // ---- Load pinned + templates from config.local.js (overwrites storage) ----
  if (action === 'load-from-config') {
    const hasPinned    = typeof LOCAL_PINNED_SITES    !== 'undefined' && Array.isArray(LOCAL_PINNED_SITES);
    const hasTemplates = typeof LOCAL_SEARCH_TEMPLATES !== 'undefined' && Array.isArray(LOCAL_SEARCH_TEMPLATES);
    if (!hasPinned && !hasTemplates) {
      showToast('config.local.js not found or has no LOCAL_PINNED_SITES / LOCAL_SEARCH_TEMPLATES');
      return;
    }
    if (!confirm('Load from config.local.js? This will REPLACE your current pinned sites and search templates, and clear template parameter history. Continue?')) {
      return;
    }
    try {
      const result = await loadFromConfig();
      await refreshDrawer();
      await renderPinnedRow();
      await renderQuickJumpBar();
      showToast(`Loaded ${result.pinnedCount} pinned + ${result.templateCount} templates`);
    } catch (err) {
      console.warn('[tab-out] load failed:', err);
      showToast('Load failed');
    }
    return;
  }

  // ---- Submit the "add pinned" form ----
  if (action === 'submit-add-pinned') {
    const titleInput = document.getElementById('newPinnedTitle');
    const urlInput   = document.getElementById('newPinnedUrl');
    const errEl      = document.getElementById('addPinnedError');
    const title = (titleInput?.value || '').trim();
    const url   = (urlInput?.value   || '').trim();
    if (errEl) errEl.textContent = '';

    if (!title || !url) {
      if (errEl) errEl.textContent = 'Title and URL are both required';
      return;
    }
    try { new URL(url); }
    catch { if (errEl) errEl.textContent = 'URL is not valid'; return; }

    try {
      await addPinnedSite({ url, title });
      if (titleInput) titleInput.value = '';
      if (urlInput)   urlInput.value   = '';
      await renderPinnedRow();
      await refreshDrawer();
      showToast('Pinned added');
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
    return;
  }

  // ---- Switch a pinned row into inline edit mode ----
  if (action === 'edit-pinned-row') {
    const id = actionEl.dataset.pinnedId;
    const li = actionEl.closest('li');
    const pinnedSites = await getPinnedSites();
    const item = pinnedSites.find(p => p.id === id);
    if (li && item) switchToEditMode(li, 'pinned', item);
    return;
  }

  // ---- Cancel inline edit (re-render whole drawer body) ----
  if (action === 'cancel-edit-row') {
    await refreshDrawer();
    return;
  }

  // ---- Save inline-edited pinned row ----
  if (action === 'save-pinned-row') {
    const id = actionEl.dataset.pinnedId;
    const li = actionEl.closest('li');
    const titleInput = li.querySelector('input[data-field="title"]');
    const urlInput   = li.querySelector('input[data-field="url"]');
    const errEl      = li.querySelector('.inline-error');
    const title = (titleInput?.value || '').trim();
    const url   = (urlInput?.value   || '').trim();
    if (errEl) errEl.textContent = '';

    if (!title || !url) {
      if (errEl) errEl.textContent = 'Both fields required';
      return;
    }
    try { new URL(url); }
    catch { if (errEl) errEl.textContent = 'URL is not valid'; return; }

    try {
      await updatePinnedSite(id, { url, title });
      await renderPinnedRow();
      await refreshDrawer();
      showToast('Pinned updated');
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
    return;
  }

  // ---- Delete a pinned row ----
  if (action === 'delete-pinned-row') {
    if (!confirm('Remove this pinned site?')) return;
    const id = actionEl.dataset.pinnedId;
    await removePinnedSite(id);
    await renderPinnedRow();
    await refreshDrawer();
    showToast('Pinned removed');
    return;
  }

  // ---- Submit the "add template" form ----
  if (action === 'submit-add-template') {
    const labelInput = document.getElementById('newTemplateLabel');
    const urlInput   = document.getElementById('newTemplateUrl');
    const errEl      = document.getElementById('addTemplateError');
    const label       = (labelInput?.value || '').trim();
    const urlTemplate = (urlInput?.value   || '').trim();
    if (errEl) errEl.textContent = '';

    try {
      await addSearchTemplate({ label, urlTemplate });
      if (labelInput) labelInput.value = '';
      if (urlInput)   urlInput.value   = '';
      await renderQuickJumpBar();
      await refreshDrawer();
      showToast('Template added');
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
    return;
  }

  // ---- Switch a template row into inline edit mode ----
  if (action === 'edit-template-row') {
    const id = actionEl.dataset.templateId;
    const li = actionEl.closest('li');
    const { templates } = await getSearchTemplates();
    const item = templates.find(t => t.id === id);
    if (li && item) switchToEditMode(li, 'templates', item);
    return;
  }

  // ---- Save inline-edited template row ----
  if (action === 'save-template-row') {
    const id = actionEl.dataset.templateId;
    const li = actionEl.closest('li');
    const labelInput = li.querySelector('input[data-field="label"]');
    const urlInput   = li.querySelector('input[data-field="urlTemplate"]');
    const errEl      = li.querySelector('.inline-error');
    const label       = (labelInput?.value || '').trim();
    const urlTemplate = (urlInput?.value   || '').trim();
    if (errEl) errEl.textContent = '';

    try {
      await updateSearchTemplate(id, { label, urlTemplate });
      await renderQuickJumpBar();
      await refreshDrawer();
      showToast('Template updated');
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
    return;
  }

  // ---- Delete a template row ----
  if (action === 'delete-template-row') {
    if (!confirm('Remove this search template?')) return;
    const id = actionEl.dataset.templateId;
    await removeSearchTemplate(id);
    await renderQuickJumpBar();
    await refreshDrawer();
    showToast('Template removed');
    return;
  }

  // ---- Select a chip → make it the active Quick Jump template ----
  if (action === 'select-template') {
    const id = actionEl.dataset.templateId;
    if (!id) return;
    await setActiveTemplate(id);
    await renderQuickJumpBar();
    const input = document.getElementById('qjInput');
    if (input) input.focus();
    return;
  }

  // ---- Run the Quick Jump ----
  if (action === 'quick-jump-go') {
    await triggerQuickJump();
    return;
  }

  // ---- Pick a history item → fill input + jump immediately ----
  if (action === 'use-history-item') {
    const value = actionEl.dataset.historyValue;
    const input = document.getElementById('qjInput');
    if (input && value != null) {
      input.value = value;
      hideHistoryDropdown();
      await triggerQuickJump();
    }
    return;
  }

  // ---- Forget a single history entry ----
  if (action === 'forget-history-item') {
    e.stopPropagation();   // don't also trigger use-history-item on the parent
    const templateId = actionEl.dataset.templateId;
    const value      = actionEl.dataset.historyValue;
    if (templateId && value != null) {
      await removeFromTemplateHistory(templateId, value);
      await showHistoryDropdown();
    }
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   KEYBOARD SHORTCUTS

   - Enter inside Quick Jump input → trigger the jump
   - Escape inside the open drawer → close drawer
   - Cmd/Ctrl + K → focus + flash the Quick Jump input
   - Cmd/Ctrl + 1..5 → pick the Nth chip and focus the input
   ---------------------------------------------------------------- */
document.addEventListener('keydown', async (e) => {
  // Quick Jump input keys take precedence over the global Cmd+K
  // path when the input is focused.
  if (e.target && e.target.id === 'qjInput') {

    // Enter → if a history item is highlighted, use it; else jump
    // with the current input value.
    if (e.key === 'Enter') {
      e.preventDefault();
      const dropdown = document.getElementById('qjHistory');
      if (dropdown && dropdown.style.display !== 'none') {
        const highlighted = dropdown.querySelector('.qj-history-item.highlighted');
        if (highlighted) {
          e.target.value = highlighted.dataset.historyValue || '';
          hideHistoryDropdown();
        }
      }
      await triggerQuickJump();
      return;
    }

    // ↓/↑ → navigate history dropdown (open it if hidden on ↓)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const dropdown = document.getElementById('qjHistory');
      if (!dropdown) return;

      if (dropdown.style.display === 'none') {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          await showHistoryDropdown();
          const first = dropdown.querySelector('.qj-history-item');
          if (first) first.classList.add('highlighted');
        }
        return;
      }

      const items = Array.from(dropdown.querySelectorAll('.qj-history-item'));
      if (items.length === 0) return;
      e.preventDefault();
      let idx = items.findIndex(el => el.classList.contains('highlighted'));
      if (e.key === 'ArrowDown') {
        idx = idx < 0 ? 0 : (idx + 1) % items.length;
      } else {
        idx = idx <= 0 ? items.length - 1 : idx - 1;
      }
      items.forEach((el, i) => el.classList.toggle('highlighted', i === idx));
      items[idx].scrollIntoView({ block: 'nearest' });
      return;
    }

    // Escape inside qjInput → close history dropdown (if open),
    // otherwise fall through to the global Escape handler.
    if (e.key === 'Escape') {
      const dropdown = document.getElementById('qjHistory');
      if (dropdown && dropdown.style.display !== 'none') {
        e.preventDefault();
        hideHistoryDropdown();
        return;
      }
    }
  }

  // Escape → close drawer (if open)
  if (e.key === 'Escape') {
    const drawer = document.getElementById('manageDrawer');
    if (drawer && drawer.style.display !== 'none') {
      e.preventDefault();
      closeManageDrawer();
      return;
    }
  }

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  // Cmd/Ctrl + K → focus Quick Jump input
  if (e.key === 'k' || e.key === 'K') {
    const input = document.getElementById('qjInput');
    if (input && !input.disabled) {
      e.preventDefault();
      input.focus();
      input.select();
      const bar = document.getElementById('quickJumpBar');
      if (bar) {
        bar.classList.add('flash-focus');
        setTimeout(() => bar.classList.remove('flash-focus'), 400);
      }
    }
    return;
  }

  // Cmd/Ctrl + 1..5 → activate Nth template
  if (e.key >= '1' && e.key <= '5') {
    const n = parseInt(e.key, 10) - 1;
    const { templates } = await getSearchTemplates();
    if (templates[n]) {
      e.preventDefault();
      await setActiveTemplate(templates[n].id);
      await renderQuickJumpBar();
      const input = document.getElementById('qjInput');
      if (input) input.focus();
    }
  }
});


/* ----------------------------------------------------------------
   HTML5 DRAG-AND-DROP REORDER — generic horizontal list helper

   Used by the pinned row and the Quick Jump chip row, which share
   the same interaction model:
   - horizontal flex container
   - each item carries a stable id (dataset key)
   - a trailing "+" item must never be a drag source or target
   - drop indicator is a 2-3px amber bar at the left/right edge of
     the target, chosen by whether the cursor is on the left or
     right half of the target's bounding rect
   - reorder is persisted once on drop, then the row is re-rendered

   Listeners are attached to the static container element, so they
   survive child re-renders.
   ---------------------------------------------------------------- */
function wireHorizontalReorder({
  container,        // HTMLElement — static parent
  itemSelector,     // CSS selector for item elements (incl. the "+")
  isRealItem,       // (el) => boolean — false for the "+" / non-items
  getId,            // (el) => string  — read item id from dataset
  applyReorder,     // async (newIdOrder: string[]) => void
  onAfterReorder,   // async () => void — usually a re-render
}) {
  if (!container) return;
  let draggedId = null;

  const indicatorSel = `${itemSelector}.drop-before, ${itemSelector}.drop-after`;

  function clearIndicators() {
    container.querySelectorAll(indicatorSel)
      .forEach(el => el.classList.remove('drop-before', 'drop-after'));
  }

  function cleanup() {
    container.querySelectorAll(`${itemSelector}.dragging`)
      .forEach(el => el.classList.remove('dragging'));
    clearIndicators();
    draggedId = null;
  }

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSelector);
    if (!isRealItem(item)) { e.preventDefault(); return; }
    draggedId = getId(item);
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // setData is required for Firefox compatibility — Chrome works without it.
    try { e.dataTransfer.setData('text/plain', draggedId); } catch {}
  });

  container.addEventListener('dragover', (e) => {
    if (!draggedId) return;
    const item = e.target.closest(itemSelector);
    if (!isRealItem(item) || getId(item) === draggedId) {
      clearIndicators();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = item.getBoundingClientRect();
    const isLeftHalf = e.clientX < rect.left + rect.width / 2;
    clearIndicators();
    item.classList.add(isLeftHalf ? 'drop-before' : 'drop-after');
  });

  container.addEventListener('dragleave', (e) => {
    // Only clear if we've actually left the container; moving
    // between child items shouldn't blank the indicator.
    if (e.relatedTarget && container.contains(e.relatedTarget)) return;
    clearIndicators();
  });

  container.addEventListener('drop', async (e) => {
    if (!draggedId) return;
    const item = e.target.closest(itemSelector);
    if (!isRealItem(item) || getId(item) === draggedId) {
      cleanup();
      return;
    }
    e.preventDefault();
    const targetId    = getId(item);
    const insertAfter = item.classList.contains('drop-after');

    // Build the new order from the current DOM (resilient to any
    // shifts in storage between dragstart and drop).
    const items = Array.from(container.querySelectorAll(itemSelector)).filter(isRealItem);
    const ids   = items.map(getId);
    const withoutDragged = ids.filter(id => id !== draggedId);
    const targetIdx = withoutDragged.indexOf(targetId);
    if (targetIdx === -1) { cleanup(); return; }
    withoutDragged.splice(insertAfter ? targetIdx + 1 : targetIdx, 0, draggedId);

    await applyReorder(withoutDragged);
    cleanup();
    if (onAfterReorder) await onAfterReorder();
  });

  container.addEventListener('dragend', cleanup);
}

/* ---- Pinned tiles ---- */
wireHorizontalReorder({
  container:      document.getElementById('pinnedRow'),
  itemSelector:   '.pinned-tile',
  isRealItem:     el => !!el && el.classList.contains('pinned-tile') && !el.classList.contains('pinned-tile-add'),
  getId:          el => el.dataset.pinnedId,
  applyReorder:   reorderPinnedSites,
  onAfterReorder: renderPinnedRow,
});

/* ---- Quick Jump chips ---- */
wireHorizontalReorder({
  container:      document.getElementById('qjChips'),
  itemSelector:   '.qj-chip',
  isRealItem:     el => !!el && el.classList.contains('qj-chip') && !el.classList.contains('qj-chip-add'),
  getId:          el => el.dataset.templateId,
  applyReorder:   reorderSearchTemplates,
  onAfterReorder: renderQuickJumpBar,
});


/* ----------------------------------------------------------------
   QUICK JUMP INPUT — focus/blur/input wiring for history dropdown
   ---------------------------------------------------------------- */
(function wireQuickJumpHistory() {
  const input    = document.getElementById('qjInput');
  const dropdown = document.getElementById('qjHistory');
  if (!input || !dropdown) return;

  input.addEventListener('focus', showHistoryDropdown);
  input.addEventListener('input', showHistoryDropdown);
  // Delay so a click on a dropdown item can fire before we hide it.
  input.addEventListener('blur', () => setTimeout(hideHistoryDropdown, 150));

  // Prevent blur when clicking inside the dropdown — keeps the
  // input focused so the click handler receives the event cleanly.
  dropdown.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });
})();


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
updateShortcutLabel();
renderDashboard();
