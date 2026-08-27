# Any Countdown — hosted files

Served by GitHub Pages at `https://amirhayek.dev/AnyCountdown/`. Changes go live on push to `main`
(~½–2 min), the same as `ClaudeUsage/`.

The folder is named for the app's App Store name (`CFBundleDisplayName = "Any Countdown"`), not for
its Xcode target, which is still `AnyTimers`. It holds three unrelated things:

| Path | What it is |
|---|---|
| `index.html` + `styles.css` + `assets/` | The marketing landing page — see below. |
| `remote-config.json` | The app's own remote config — see below. |
| `privacy/` | The privacy policy. This is the URL in App Store Connect's Privacy Policy field **and** the one the app's posting-terms sheet links to (`PublishTermsContent.privacyURL`), so moving it breaks a link inside shipped binaries. The in-app copy of the URL is pinned by `PublishTermsTests`; the App Store Connect one is set by hand and nothing checks it. |

## The landing page

No build step — plain HTML and CSS, the same shape as `ClaudeUsage/`.

The layout is a port of the Claude Design canvas
[`Landing Page.dc.html`](https://claude.ai/design/p/79b7496e-fc70-4619-a0a3-91311fbabb56?file=Landing+Page.dc.html),
a fixed 1440px artboard. The port keeps the artboard's pixel values as ratios, so the copy, the
widget scatter and the device composition all scale instead of breaking at one width. If the canvas
changes, that file is the source of truth for copy and proportions.

**The one deliberate difference from the canvas:** the hero copy block is not marked up at
all. The product reel plays once, stops on its last frame, and that frame *is* the canvas's
hero — eyebrow, "Every wait, worth watching.", App Store button, phone. Marking the copy up
as well would put it on screen twice.

Because the headline is pixels in a video, the `<h1>` and its description still exist in the
markup as `.sr-only` text. Delete them and the page has no heading for a screen reader or a
crawler to find.

### Three cuts, one per shape

| Width | File | Aspect | End card |
|---|---|---|---|
| ≥ 861px | `hero-wide.mp4` | 16:9 | headline + App Store button, phone right |
| 641–860px | `hero-tablet.mp4` | 4:3 | headline left, iPad right — **no button** |
| ≤ 640px | `hero-portrait.mp4` | 886:1680 | headline over phone, centred — **no button** |

Each is a different render from the app's video project, composed for its own shape, so
none of them is a crop of another. `media` on `<source>` picks one — widest first, so a
browser that ignores the attribute falls back to the wide cut rather than serving the
portrait one to everyone; the script re-checks and swaps if it has to.

`.hero__video video` has a matching `aspect-ratio` per breakpoint. **Keep those in step with
the table above** — a mismatch letterboxes or crops an end card that was composed to fit.

The portrait cut is 1680 tall, not the 1920 it was rendered at. That render composes its
content centred in a full phone screen, which leaves roughly 500px of empty cream above it;
sitting under the site header, that read as the video hanging low with padding on top. 240px
is cropped off the top of the file to close the gap. **Do not crop more** — the end card has
only 306px of clearance above its headline, so past ~250px the headline loses its margin.
Re-render the reel and this crop needs re-deriving, along with the `aspect-ratio`.

Two consequences worth knowing:

- **The App Store button is painted into the wide cut only.** `.hero__hotspot` is a
  transparent link positioned on top of it (percentages measured off the 1920×1080 frame,
  pill at x 150–558, y 616–704), unhidden when the reel stops. Re-render the reel and those
  percentages need re-measuring.
- **The other two cuts have no button**, so `.hero__cta` puts a real one under the video
  below 861px and hides it above.

The page background is `#f1efe6` — the reels' own background, not the canvas's `#f2eee8` —
which is why the video needs no frame, border or rounded corners to sit in the page.

The reel is muted and never loops. If a browser refuses to autoplay it, or the reader has
asked for reduced motion, the script parks it on the last frame rather than leaving an empty
band where the hero should be. A quiet Replay control sits in the bottom-right corner.

## `remote-config.json`

Read by the app at launch (`AnyTimers/HostedConfig.swift` in the app repo — the target kept its old
name) to decide whether monetization is on and which RevenueCat store to talk to.

```json
{
  "version": 1,
  "revenueCat": {
    "enabled": true,
    "publicAPIKey": "appl_XXXXXXXXXXXX"
  }
}
```

| Field | Meaning |
|---|---|
| `version` | Schema version. The app ignores a payload whose version it doesn't know rather than guessing. |
| `revenueCat.enabled` | The **kill switch**. `false` makes the app clear its cached key and run unmetered — no paywall, no credit balance, no gate — on the next launch. |
| `revenueCat.publicAPIKey` | The RevenueCat **public** SDK key (`appl_…`). Empty string = not provisioned = unmetered. |

### Only public values belong in this file

This is a world-readable file on a public GitHub repo. The RevenueCat `appl_…` key is a *public*
SDK key — RevenueCat's own guidance is that it is safe to embed in client code — so it belongs here.

**The OpenRouter API key does not, and must never be added.** That one is a real secret that bills a
real account; it lives in Firebase Remote Config or a gitignored local `Secrets.plist`. The same goes
for any RevenueCat **secret** key (`sk_…`), which is what the metering backend will use server-side.

### Test Store keys don't go here either

A `test_…` key routes purchases to RevenueCat's synthetic Test Store. It must never reach a shipping
build, so it lives only in the app repo's gitignored `Config/Secrets.plist`.

### Turning monetization off in a hurry

Set `enabled` to `false` (or blank the key) and push. Every app launch after the next fetch runs
unmetered. It cannot un-configure a session that has already started — an app already running keeps
its current state until relaunch.
