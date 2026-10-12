# Prototype

Two prototypes you can operate directly. They are **the basis for screens and behavior**, not product code: each is a single HTML file with everything crammed in, and the back end is entirely simulated. Build what they look like and how they behave, not the way they are written.

## How to view it

Open them directly in a browser:

| File | Contents |
| --- | --- |
| `platform/index.html` | The whole platform: sign in, registration, search, film page, downloads, library, workspace (subtitles, sync, export), storage, profile, and the seven admin pages |
| `workbench/index.html` | The subtitle sync workbench, standalone version |

Below the sign-in page there are "prototype shortcuts" (原型捷徑) that let you go straight in as an administrator or a member. The account menu in the top right can switch identities and reset the demo data.

In the prototypes:

- The films are 14 old public-domain films; users, subtitles and exports are all demo data
- Search, downloads, subtitle search, ranking and export are all simulated; download progress is an animation sped up 10 times
- **The sync workbench really works**, using a synthetic 92-second video (`fixtures/clip.mp4`, already embedded in the HTML). The menu at the top of the sync page switches between three "what's wrong with the subtitles" scenarios
- Fonts load from Google Fonts; without a network, system fonts are used, and the layout is the same

## Folders

```
platform/
  index.html          The built prototype
  src/                Source
    app1.js           Demo data, simulated back end (usage calculation, download scheduling, candidate subtitles)
    app2.js           Sign in, shell, search, film page, downloads, library, workspace, storage, profile
    app3.js           The seven admin pages
    app4.js           Routing, all actions, form validation, toast message text
    app.css           Platform styles (design tokens at the top)
    bench.html / bench.css / bench-ui.js    The workbench embedded in the platform
    core.js / scenarios.js / data.json      Sync core, three demo scenarios, demo clip data
    page.html         Template used for assembly
  screenshots/        30 screenshots, numbered to match docs/11-pages.md
  build.py            Assembles into a single HTML file
  e2e.cjs             Automated checks, 72 of them
workbench/
  index.html
  src/                core.js, scenarios.js, ui.js, style.css, template.html, data.json, test_core.js
  screenshots/        7 of them
  build.py
  e2e.cjs             Automated checks, 40 of them
```

To find a piece of copy or a behavior, search `src/` directly for that Chinese sentence.

`core.js` is the original version of the sync core; the version cleaned up into TypeScript with tests added is `packages/shared/src/sync-core/core.ts`, and that one is authoritative.

## Rebuilding and checking

```bash
cd platform                # or workbench
python3 build.py           # Generates index.html
python3 build.py --webm    # Generates preview_webm.html, for the automated checks
node e2e.cjs               # Needs the playwright package and its Chromium
```

The automated checks use the WebM video, because the Playwright Chromium at handover couldn't decode H.264 (Playwright 1.63's can; see `docs/15-testing.md`). Running them regenerates `screenshots/`.

## Differences between the prototype and production

Listed at the end of `docs/11-pages.md` (each page) and `docs/09-sync-workbench.md` (the workbench). The most important ones:

- Anything in the prototypes marked "prototype shortcut" (原型捷徑), "prototype toggle" (原型開關) or "demo data" (示範資料) must not be in production
- The incoming port in Download settings is read-only in production
- Auto-align is computed by the server in production
- The preview file reservation in production is larger than the prototype shows
- Interface copy uses full-width punctuation in production
- The prototype can search by Chinese title (the demo data comes with Chinese titles); the real YTS only recognizes English titles, and production doesn't do this
- Changing personal preferences (language, quality, second language) in the prototype doesn't affect other pages; production wires them up
- In a few places the prototype shows errors as toast messages in the bottom right; production puts errors in the page (the mapping is in "Shell" in `docs/11-pages.md`)
- Sizes in the prototype are hard-coded demo numbers; production calculates from bytes, so they won't match exactly
- The prototype has 5 checkpoints and its copy says "five" (五); production defaults to 8 and the copy doesn't state a number
