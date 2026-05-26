/* ============================================================
   Tab Out — Personal config (example)

   Copy this file to `config.local.js` (gitignored) and edit
   the constants below to your taste. Anything declared here is
   read once by app.js:

   - LOCAL_LANDING_PAGE_PATTERNS / LOCAL_CUSTOM_GROUPS
       Extend the built-in domain-grouping rules (see app.js).

   - LOCAL_PINNED_SITES / LOCAL_SEARCH_TEMPLATES
       Seed values written into chrome.storage.local on FIRST RUN
       only (when the corresponding storage key is empty). Once
       seeded, edit them through the gear/⚙ UI — this file is
       NOT re-read on later loads.

   The whole file is optional; missing values are silently ignored.
   ============================================================ */


/* ---- Landing-page detection (gets pulled into the Homepages card) ---- */
const LOCAL_LANDING_PAGE_PATTERNS = [
  // { hostname: 'mail.example.com', pathExact: ['/'] },
  // { hostnameEndsWith: '.notion.so', pathPrefix: '/' },
];


/* ---- Custom group rules (merge subdomains, split by path) ---- */
const LOCAL_CUSTOM_GROUPS = [
  // {
  //   hostnameEndsWith: '.bytedance.net',
  //   groupKey:   'bytedance',
  //   groupLabel: 'ByteDance',
  // },
];


/* ---- Pinned sites (max 10 will be seeded) ---- */
const LOCAL_PINNED_SITES = [
  // { title: 'GitHub',      url: 'https://github.com'              },
  // { title: 'Gmail',       url: 'https://mail.google.com'         },
  // { title: 'Calendar',    url: 'https://calendar.google.com'     },
  // { title: 'Notion',      url: 'https://www.notion.so'           },
  // { title: 'YouTube',     url: 'https://www.youtube.com'         },
];


/* ---- Quick Jump search templates ----
   Each entry needs a short `label` (≤ 12 chars) and a `urlTemplate`
   containing at least one `{}` placeholder. The placeholder is
   URL-encoded at jump time. */
const LOCAL_SEARCH_TEMPLATES = [
  // {
  //   label:       'RDS',
  //   urlTemplate: 'https://cloud.bytedance.net/rds/detail/db/cn/{}/autoSQL',
  // },
  // {
  //   label:       'Coral',
  //   urlTemplate: 'https://data.bytedance.net/coral/datamap/result?groupName=default&query={}#group=default',
  // },
  // {
  //   label:       'Argos',
  //   urlTemplate: 'https://argos.bytedance.net/argos/streamlog/trace/{}',
  // },
  // {
  //   label:       'SCM',
  //   urlTemplate: 'https://scm.bytedance.net/repo/{}',
  // },
];
