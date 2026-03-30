# Vanishing Notes Landing Page

A landing page for Vanishing Notes - a minimalist note-taking app for Mac, iPhone, and iPad.

## Features Implemented

### Design
- **Paper & Ink Aesthetic**: Minimal, typography-focused design matching the app
- **Serif Titles**: Using system serif fonts for headings and dates
- **Sans-Serif Body**: Using system fonts for body text
- **Dark Mode Support**: Automatically adapts to system preferences
- **Color Palette**: Matches the app's ink/paper theme
- **Dashed Line with Date**: Gray dashed separator lines with current date display

### Content Sections
1. **Hero Section**: Rotating phrases with fade in/out animation (like onboarding screen)
2. **Features Grid**: Showcases 6 main features
   - Auto-expiring notes (24h, 7d, 30d)
   - iCloud sync
   - Siri & Shortcuts
   - In-place editing
   - Smart detection (phone numbers, links)
   - Safety net (30-day trash)
3. **Philosophy Section**: Paper & ink design principles
4. **Apple Ecosystem**: Device mockups for Mac, iPhone, iPad
5. **Privacy Section**: Local storage and iCloud privacy
6. **FAQ Section**: Common questions with accordion
7. **Final CTA**: Call-to-action with download button

### Animations
- Hero section phrases rotate with fade in/out (2-second intervals)
- Smooth scroll navigation
- Accordion FAQ interactions
- Scroll-triggered animations for feature cards

## Files Structure

```
VanishingNotesPage/
├── index.html      # Main HTML structure
├── styles.css      # Styling with dark mode support
├── script.js       # JavaScript for animations
└── README.md       # This file
```

## Customization

### Replace Placeholders

The page uses text placeholders for visual elements that should be replaced with actual images:

- `[Icon]` - App icon
- `[iPhone Mockup]` - iPhone screenshot
- `[Mac Mockup]` - macOS screenshot
- `[iPad Mockup]` - iPad screenshot
- `[Lock Icon]` - Privacy icon

### Update Download Links

In `script.js`, replace the placeholder App Store link:

```javascript
// Current:
alert('Download functionality would redirect to the App Store');

// Replace with:
window.location.href = 'https://apps.apple.com/app/vanishing-notes/id123456789';
```

### Modify Colors

To adjust colors, edit the CSS variables in `styles.css`:

```css
:root {
    --color-ink: #000000;              /* Primary text */
    --color-ink-secondary: rgba(0, 0, 0, 0.6);  /* Secondary text */
    --color-paper: #ffffff;            /* Background */
    /* ... */
}
```

Dark mode colors are defined in:
```css
@media (prefers-color-scheme: dark) {
    /* ... */
}
```

## Usage

Simply open `index.html` in a web browser. No build process required.

For deployment:
1. Replace placeholder images and icons
2. Update App Store download links
3. Add actual app screenshots
4. Upload to your web hosting

## Responsive Design

The page is fully responsive with breakpoints at:
- Desktop: 1200px+
- Tablet: 768px - 1199px
- Mobile: < 768px

## Browser Support

- Modern browsers with CSS Grid support
- Safari, Chrome, Firefox, Edge (latest versions)
- Automatic dark mode detection
- Respects user's reduced motion preferences

## Typography

- **Headings/Dates**: System serif font (New York on macOS, Georgia fallback)
- **Body Text**: System sans-serif font (-apple-system, SF Pro)

## Accessibility

- Semantic HTML structure
- Proper heading hierarchy
- ARIA-friendly accordion FAQ
- Respects `prefers-reduced-motion`
- High contrast in both light and dark modes
