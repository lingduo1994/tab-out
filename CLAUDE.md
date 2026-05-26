# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**Tab Out** is a pure Chrome extension (Manifest V3) that overrides the new tab page with a dashboard of all currently open tabs, grouped by domain. **There is no server, no Node.js, no npm, no build step, no bundler, no test suite.** All source lives under `extension/` and is loaded directly by Chrome via "Load unpacked".

Storage is `chrome.storage.local`. Data never leaves the machine.

## Dev loop

```bash
# 1. Open Chrome → chrome://extensions
# 2. Enable Developer mode
# 3. Load unpacked → select the extension/ folder

# After editing any file under extension/:
#   - Click the reload icon on the Tab Out card in chrome://extensions
#   - Then open a new tab to see the updated UI
```

There are no lint, build, or test commands. The only "verification" is loading the extension and clicking through it.

## Architecture

The dashboard **is** the new tab page (`chrome_url_overrides.newtab = index.html` in `manifest.json`). This means `app.js` runs in extension context and calls `chrome.tabs.*` / `chrome.storage.*` directly — there is no content script, no message passing, no iframe bridge. Don't reintroduce one without good reason.

### File map
- `extension/manifest.json` — MV3, permissions: `tabs`, `activeTab`, `storage`.
- `extension/index.html` — Static layout. Two-column shell: `#openTabsSection` (left, domain cards) + `#deferredColumn` (right, "Saved for Later" checklist). Loads `config.local.js` (optional, gitignored) **before** `app.js`.
- `extension/app.js` — ~1500 LOC, single file, all dashboard logic.
- `extension/background.js` — Service worker. Sole job: keep the toolbar badge count in sync with open tabs (green ≤10, amber ≤20, red >20). Nothing else lives here.
- `extension/style.css` — All styling. Bento/masonry layout via CSS `columns`, not grid. Theme is "paper": Newsreader serif for headings/numbers, DM Sans for body, beige background.
- `extension/config.local.js` — **gitignored**. Optional user-supplied file that may define `LOCAL_LANDING_PAGE_PATTERNS` and `LOCAL_CUSTOM_GROUPS` (see "Personal config" below).

### app.js layout
Code is organized as labeled sections, top to bottom:
1. **Chrome tabs wrappers** — `fetchOpenTabs`, `closeTabsByUrls` (hostname match), `closeTabsExact` (URL match), `focusTab`, `closeDuplicateTabs`, `closeTabOutDupes`.
2. **Saved for Later** — `saveTabForLater`, `getSavedTabs`, `checkOffSavedTab`, `dismissSavedTab`. The list is stored under the `deferred` key as an array of `{ id, url, title, savedAt, completed, dismissed, completedAt? }`.
3. **Pinned sites** — `getPinnedSites`/`add`/`update`/`removePinnedSite`. Up to `PINNED_LIMIT` (10) entries under the `pinnedSites` key. Click a tile → `chrome.tabs.create({ url })` (always new tab).
4. **Search templates** — `getSearchTemplates`/`add`/`update`/`remove`/`setActiveTemplate`, plus `validateTemplate` and `expandTemplate`. Each template = `{ id, label, urlTemplate }`, `urlTemplate` must contain at least one `{}` placeholder. `expandTemplate` does `replace(/\{\}/g, encodeURIComponent(param))`. `activeSearchTemplateId` tracks the last-used chip so the highlight is stable across reloads.
5. **First-run seed** — `maybeSeedFromConfig()` copies `LOCAL_PINNED_SITES` / `LOCAL_SEARCH_TEMPLATES` from `config.local.js` into `chrome.storage.local` **only when the storage key is empty**. After seeding, users edit via the UI gear; this file is not re-read.
6. **UI helpers** — `playCloseSound` (Web Audio synthesizes the swoosh, no audio files), `shootConfetti` (DOM particles + JS physics, no library), `animateCardOut`, `showToast`, `timeAgo`, greeting/date, `escAttr`/`escText`.
7. **Domain & title cleanup** — `FRIENDLY_DOMAINS` map, `friendlyDomain`, `stripTitleNoise`, `cleanTitle`, `smartTitle` (special-cases GitHub PRs/issues, X status pages, Reddit threads, etc.).
8. **Renderers** — `renderDomainCard`, `renderDeferredColumn`, `renderPinnedRow`, `renderQuickJumpBar`, `renderPinnedDrawer`/`renderTemplatesDrawer` + their row builders, `renderStaticDashboard` (paints header + pinned + jump + tab grid + saved sidebar in that order).
9. **Manage drawer** — `openManageDrawer(mode)` / `closeManageDrawer` / `refreshDrawer`. Single `#manageDrawer` element, two modes via `dataset.mode = 'pinned' | 'templates'`. Right-slide-in with backdrop click + Escape to close.
10. **Event delegation** — A single `document.addEventListener('click', ...)` reads `data-action` from the nearest ancestor and dispatches. All buttons/chips wire actions via `data-action="…"` + `data-*` payload. **Add new interactions by extending this delegated handler, not by attaching new listeners per element.**
11. **Keyboard shortcuts** — A separate `keydown` listener handles: Enter in `#qjInput` → trigger jump; Escape → close drawer; `⌘K`/`Ctrl+K` → focus + flash `#qjInput`; `⌘1`–`⌘5` → pick the Nth chip.

### Grouping rules (the core logic)
`renderStaticDashboard` decides which "card" each tab lands in, in this priority order:
1. **Landing pages** (Gmail inbox, x.com `/home`, linkedin.com `/`, github.com `/`, youtube.com `/`, plus anything from `LOCAL_LANDING_PAGE_PATTERNS`) → pulled into a synthetic `__landing-pages__` group rendered as the "Homepages" card.
2. **Custom groups** from `LOCAL_CUSTOM_GROUPS` (matched by hostname/`hostnameEndsWith` + optional `pathPrefix`) → grouped under the rule's `groupKey` / `groupLabel`.
3. **Default**: group by `URL.hostname`. `file://` URLs collapse into a single `local-files` group.

Sorting: landing-pages card first, then domains that *are* landing-page hosts, then by tab count descending.

**Closing tabs** has two modes and they must match the grouping mode:
- `closeTabsByUrls` (hostname match) for hostname-based groups.
- `closeTabsExact` (exact URL match) for `__landing-pages__` and any custom group (anything with a `label`). This prevents closing unrelated tabs on the same hostname (e.g. closing the Gmail "inbox" card should not close individual email threads).

If you add a new kind of group, decide deliberately which closing mode it uses.

### Duplicate detection
Per-card: count occurrences of identical `url` strings. Any URL with count > 1 gets a `(Nx)` amber badge on its chip and a "Close N duplicates" action button on the card. `dedup-keep-one` calls `closeDuplicateTabs(urls, true)`.

Separately, multiple Tab Out new tab pages trigger the `#tabOutDupeBanner` ("Close extras") banner via `checkTabOutDupes`.

## Personal config

Users can add `extension/config.local.js` (gitignored) to customize behavior without touching tracked code. It is `<script src="config.local.js" onerror="...">` — missing file is fine. A starting template lives at `extension/config.local.example.js` (tracked). Four globals are read:

```js
// Grouping (re-evaluated on every render)
const LOCAL_LANDING_PAGE_PATTERNS = [
  { hostname: 'mail.example.com', pathExact: ['/'] },
  { hostnameEndsWith: '.notion.so', pathPrefix: '/' },
  { hostname: 'foo.com', test: (path, url) => path === '/home' },
];

const LOCAL_CUSTOM_GROUPS = [
  { hostnameEndsWith: '.bytedance.net', groupKey: 'bytedance', groupLabel: 'ByteDance' },
  { hostname: 'github.com', pathPrefix: '/owner/repo', groupKey: 'my-repo', groupLabel: 'My Repo' },
];

// Seed-only (used once on first run when chrome.storage.local is empty)
const LOCAL_PINNED_SITES = [
  { title: 'GitHub', url: 'https://github.com' },
];
const LOCAL_SEARCH_TEMPLATES = [
  { label: 'RDS', urlTemplate: 'https://cloud.bytedance.net/rds/detail/db/cn/{}/autoSQL' },
];
```

When iterating on grouping logic, do not assume `config.local.js` exists — code paths use `typeof LOCAL_… !== 'undefined'` guards. **Grouping vs seed semantics differ**: grouping globals are read on every render, but pinned/search-template globals are only used to seed `chrome.storage.local` once. After seeding, editing those globals does nothing — the user edits via the UI gear.

## Conventions worth knowing

- **No frameworks, no JSX, no TypeScript, no modules.** Plain script tag, IIFE-free, top-level `let`/`function`. Don't introduce a bundler without an explicit ask.
- **HTML is generated by string templates inside `app.js`.** Quote-safe interpolation uses `.replace(/"/g, '&quot;')` — keep that for any user-provided string (titles, URLs).
- **Event handlers use `data-action`**. New buttons → add `data-action="..."` + needed `data-*` payload, then a branch in the delegated handler. Don't `addEventListener` on individual elements.
- **No external icons/audio files, no external network calls.** SVGs are inline strings in the `ICONS` map and in templates. Sounds are synthesized via Web Audio. Favicons are read from Chrome's own cache via `chrome.runtime.getURL('/_favicon/?pageUrl=…&size=32')` (helper: `getFaviconUrl` in `app.js`); this needs the `"favicon"` permission and `_favicon/*` in `web_accessible_resources` (both in `manifest.json`). Works for any URL Chrome has ever loaded, including internal hosts.
- **`console.log` is fine for warnings only** (e.g. `console.warn('[tab-out] ...')`). The codebase uses the `[tab-out]` prefix.
- **Animations are CSS classes (`closing`, `removing`, `checked`) + setTimeout chains.** Match existing timings (200–400ms) so visual rhythm stays consistent.

## Tab Out's own pages

`isTabOut` flags both `chrome-extension://<id>/index.html` and `chrome://newtab/` because Chrome may report either depending on whether the new tab is the focused one. Anything that filters out Tab Out tabs must check both.

## README / AGENTS.md

`README.md` is end-user documentation. `AGENTS.md` is a coding-agent install script that walks a new user through loading the unpacked extension. Update both if onboarding steps change.
