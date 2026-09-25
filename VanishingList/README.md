# Vanishing List Landing Page

The landing page for Vanishing List, a checklist app for iPhone, iPad and Mac whose lists vanish on their own. It is a sibling of `../VanishingNotes/` and reuses its layout, `styles.css` and `script.js` (the import card styles are appended at the end of `styles.css`).

## Assets

The images are rendered from the app repo (`Vanishing-List/MarketingAssets`) with headless Chrome:

- `Hero*.png`, `ecosystem*.png`: the raw app captures from `MarketingAssets/Screenshots/<platform>/<light|dark>/01-lists.png` inside the device frames from `MarketingAssets/AppStore/assets` and `templates/shared.css`.
- `widget-*.png`: HTML mockups of the small and medium widgets (`VanishingListWidget/WidgetViews.swift`).
- `iconVL.png`, `favicon/`: exported from `VanishingList.icon` with Icon Composer's `ictool`.
- `og-image.png`: 1200×630, same layout as the Vanishing Notes one.
- `actionButton.png`, `icloud-icon.png`, `shortcuts-icon.png`, `siri-icon.png`: copied from Vanishing Notes.

## Before launch

Replace the two `href="#"` App Store links in `index.html` with the app's App Store URL.
