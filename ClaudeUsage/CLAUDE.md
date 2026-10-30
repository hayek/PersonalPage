# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a static landing page for "Usage for Claude", a macOS menu bar application that tracks Claude subscription usage. The page is built with plain HTML and CSS, with no build tools or JavaScript frameworks.

## Architecture

**Static Site Structure:**
- `index.html` - The landing page, redesigned for 4.0 (2026-10-17) in the App Store screenshots' "Frameless Stack" look (Archivo 900 wide uppercase headlines, terracotta / night / mint fields, real app captures) and laid out like an App Store product page: product header, screenshot strip, the in-app What's New story, an Information table, blog, FAQ. It loads `landing.css`, not `styles.css`.
- `landing.css` - All styling for `index.html` only
- `build.js` - The opening (GSAP from cdnjs): a fixed "Mac screen" (`#desk`) wearing the hero's wallpaper and menu bar; the pointer clicks the app's status item, the popover opens on three accounts with ChatGPT selected, the pointer picks the Claude account, then the screen morphs into the hero's `.mac-stage` and the header, hero copy and stage extras fade and move in. Plays on EVERY load for now (user request 2026-10-17), ≥ 900 px wide, never with Reduce Motion or a `#hash`; `?build=1` forces, `?build=0` skips; Skip / click / Esc end it. Hand-off: `body.site-in` + `site:in`.
- `site.js` - Shared behaviour for index.html and whats-new.html (FAQ, reveals, activity grid, view styles, bento, sticky header); each block checks its elements exist.
- `whats-new.html` - The 4.0 story (activity-grid "4", view styles, ChatGPT, bento), moved off the main page, which keeps one teaser section.
- Mac screen: the hero has one `.mac-stage` with the real menu bar drawn at full width (never cropped): bar = 3.0556% of the stage width, status item centred 28.767% from the right, popover `--pw: min(326px, 54%)` with its arrow (53%) under the item. build.js uses the same constants.
- Layout: the user picked layout 1 ("Fields") on 2026-10-17 and the other nine were removed: one hero (clay field = the Mac screen), alternating feature rows, small titled features, the What's New link card, facts strip, blog, FAQ, footer.
- No duplicates (user, 2026-10-17): the app name, a headline and the download button appear ONCE, inside the hero (no separate product header, no hero "What's new" button, no closing block that repeats the headline/buttons). The sticky header's "Get the Mac app" shows only after the hero is scrolled past; the What's New page header has no button (its closing has the download).
- iPhone-first view (user, 2026-10-17): iPhones, iPads (incl. iPadOS's "Mac" user agent with touch) and windows ≤ 900 px get `html.ios-view` (set in the page head before paint; site.js toggles it on resize for desktops). Every Mac-only piece has an iPhone twin: `.only-mac` / `.only-ios` (hero = iPhone + widget instead of the menu bar popover, the iPhone download button first, iPhone panels `.panel-ios` for all five features, iOS wording, Lock Screen / Watch / No-Mac-needed small features, "Get the app" header button). No Mac opening in that view; it gets its own CSS build-in instead (`html.ios-build`: clay field, the phone rises, the widget lands, then the words; site.js runs it). Keep both twins in step when copy changes.
- Builds skip when a reload or back/forward will land mid-page: site.js saves `scrollY` to sessionStorage on pagehide, and the head gate skips both builds if the navigation type is reload/back_forward and the saved position is > 40 px (also on any #hash).
- Live menu bar clock (user, 2026-10-17): the Mac bars on the main page are `mac-menubar-*-live.png` (the screenshot's "Fri Oct 9 9:41" painted out); `.bar-clock` is laid out at the screenshot's 2880 px and scaled by `--bar-k` (site.js) to show the visitor's day and time. The originals without `-live` keep the clock and are used on whats-new.html.
- Copy rule (user, 2026-10-17): Apple-landing-page density — each feature is a short declarative headline (4–6 words, ends with a period) plus ONE paragraph of 2–3 sentences, about 30–45 words. No section intros (no "What it does"), no bullet lists, no eyebrows. ("Way too much text" was the old long version; a single line each was then "too little".)
- Bump the `?v=` on landing.css / build.js / site.js in BOTH pages after the last edit of a round (browsers cache them; Safari cached a half-edited landing.css once).
- `styles.css` - Styling for the blog, version history and privacy pages (unchanged by the redesign)
- `Assets/` - Image assets; `Assets/v4/` holds the real app captures copied from the app repo's `marketing/*/assets/captures/en/` (re-copy from there after re-capturing)

**Key Design Patterns:**

1. **Two-Column Feature Layout**: Feature sections use CSS Grid with `grid-template-columns: 1fr 1fr` for desktop, collapsing to single column on mobile (768px breakpoint)

2. **Absolute Positioned Menu View**: The menu screenshot (`.menu-column`) is absolutely positioned in the top-right of the tracking section on desktop, repositioned relatively on mobile

3. **Responsive Breakpoints**:
   - 1400px - Reduce padding, adjust menu view size
   - 1024px - Smaller typography, constrain widgets grid
   - 768px - Single column layout, reorder widgets section
   - 480px - Mobile-optimized sizing

4. **Brand Colors**: Primary brand color is `#c15f3c` (used for badges, stars, borders)

## Development

This is a static site with no build process. Simply open `index.html` in a browser to preview changes.

**Viewing the site:**
```bash
open index.html
```

Or use a local server:
```bash
python3 -m http.server 8000
# Then visit http://localhost:8000
```

## CSS Architecture Notes

- All animations use `cubic-bezier(0.16, 1, 0.3, 1)` easing for Apple-like polish
- Star decorations are SVG elements positioned absolutely with low opacity
- Drop shadows use `filter: drop-shadow()` for images to preserve transparency
- Typography uses SF Pro Display/Text with system font fallbacks

## SEO and translations

- **Search basics (live since 2026-10-18):** every page has a title, meta description, canonical, Open Graph and JSON-LD (`SoftwareApplication` on the landing page, `FAQPage` with the FAQ, `BlogPosting` on posts). `/robots.txt` and `/sitemap.xml` live at the site root and are hand-maintained: add a `<url>` (and the translated pages) when you add a page. Screenshots ship as WebP with real alt text (say what the screenshot shows); pure decoration keeps `alt=""`.
- **Crawlable without JS:** the FAQ accordion is static HTML (site.js only renders it from the JSON-LD if the list is empty; keep the two in step). Blog cards are baked into `index.html` and `blog/index.html` by `node blog/bake.js` (run it after editing `blog/posts.js`), between the `<!-- baked from blog/posts.js … -->` / `<!-- /baked -->` markers; the pages still re-render them from posts.js. Bump `posts.js?v=` when it changes.
- **Guides go out one a week** (user, 2026-10-18: not several on one day). Queued posts wait in `blog/_queue/` (Jekyll doesn't publish `_` folders) with `{{DATE}}` / `{{DATE_LONG}}` placeholders, in the order of `_queue/queue.json`. The GitHub Action `.github/workflows/claudeusage-weekly-post.yml` runs `node blog/publish-next.js` every Monday 06:00 UTC (or by hand from the Actions tab): it dates the next post, adds it to posts.js and the sitemap, re-renders earlier queue posts so a link to a post still waiting is plain text until it goes out, bakes, commits and pushes. To queue a post, put its page in `_queue/` and append it to queue.json; never link to a queued post from a live page (`node blog/publish-next.js --check` lists such links; run it before publishing the redesign). Facts in the limit guides were checked against Anthropic's / OpenAI's help centers on 2026-10-18; re-check them when the plans change.
- **Translated landing pages:** `i18n/build.py` cuts `index.html` into text units (`i18n/en.json`) and builds `<lang>/index.html` for each `i18n/<lang>.json` (16 languages, the app's 15 + Hebrew), with `hreflang` links on every page, `lang`/`dir`, `data-root="../"` and `../` paths. After changing the English page: `python3 i18n/build.py extract` (new/changed sentences land in `i18n/todo/<lang>.json`), translate those keys into `i18n/<lang>.json`, `python3 i18n/build.py check <lang>`, then `python3 i18n/build.py build`. Never edit `<lang>/index.html` by hand. Arabic and Hebrew are RTL: only the words flip; the Mac screens stay LTR (rules at the end of landing.css). Blog posts and whats-new.html are English only.

## Analytics

- `/assets/analytics.js` (repo root) is included in every page's `<head>`. New pages must include `<script src="/assets/analytics.js" defer></script>`.
- GA4 property "amirhayek.dev" (ID 554201997, account "Usage for Claude"), Measurement ID `G-HZ3GFFE99W`.
- Blog events: `blog_index_view { blog_tag }` and `blog_post_view { post_slug, post_title }`. `post_slug` comes from the HTML filename, `post_title` from the page's first `<h1>`. These params are registered in GA as event-scoped custom dimensions.
- Only fires on amirhayek.dev (and subdomains), so local previews don't track.

## App config files served from here

This directory also hosts JSON consumed by the ClaudeUsage app:

- `remote-config.json` — drives the app's **in-app news banners / alerts** (macOS menu bar + dashboard, iOS badge stack). Edit + commit + push to publish news; no App Store release needed. Schema is `{ "alerts": [...] }`.
- `api-schema.json` — API schema served to the app.

Full news-publishing runbook (alert schema, conventions, timezone gotchas, verify steps) lives in the **app repo** at `/Users/amir/Developer/ClaudeUsage/docs/NEWS-RELEASES.md`.

Before committing `remote-config.json`, lint it: `python3 -I /Users/amir/Developer/ClaudeUsage/scripts/lint-remote-config.py /Users/amir/Developer/PersonalPage/ClaudeUsage/remote-config.json` (exit 1 = don't publish). It checks the `audience` / `minAppVersion` / `maxAppVersion` targeting rules and the JSON type of every field shipped builds decode; the schema is in the runbook above.

Changes go live on push to `main` (GitHub Pages, ~½–2 min).
