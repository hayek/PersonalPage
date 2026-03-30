# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a static landing page for **Json2Toon**, a native Apple app (iOS, iPad, macOS, visionOS) that converts between JSON and TOON format. The page is hosted on GitHub Pages and consists of a single HTML file with inline CSS.

**TOON (Token-Oriented Object Notation)** is a compact, human-readable encoding of the JSON data model designed for LLM input, achieving better accuracy with fewer tokens than JSON or YAML.

## Architecture

### Single-File Structure

The entire website is contained in `index.html` with:
- All CSS inline in a `<style>` tag (no external stylesheets)
- All JavaScript inline (minimal, mainly for video autoplay)
- All assets referenced from `Assets/` directory with relative paths

This architecture is intentional for GitHub Pages simplicity and portability.

### Design System

**Strict Font Policy:**
- **Bebas Neue**: Used exclusively for titles (h1, h2, h3)
- **Archivo Semi Expanded** (width: 105): Used for all body text, buttons, and UI elements
- Never use any other fonts (including Arial, SF Mono, system fonts)

**Color Palette (CSS Variables):**
```css
--bg-color: #00140F       /* Dark background */
--primary-color: #FEEFE5  /* Light text */
--accent-color: #EE6123   /* Orange accent */
--card-bg: rgba(255, 255, 255, 0.05)  /* Translucent cards */
```

**Visual Style:**
- Apple-inspired design with rounded corners (20px border-radius)
- Cards with 5% white transparency background
- Big rounded corners on images and videos
- Responsive layout with CSS Grid and Flexbox
- No emojis unless explicitly requested

### Page Sections

1. **Hero Section** (`<section class="hero">`)
   - Two-column grid: left (text/CTA), right (video demo)
   - Platform badges (iOS, iPadOS, macOS, visionOS) as outlined capsules
   - App Store download button (SVG-based)
   - macOS app demo video (autoplay, loop, muted)
   - Left section aligns to bottom (`align-items: end`)

2. **What is TOON Section**
   - Two-column layout: text explanation + 2x2 benchmark graphs
   - Benchmarks show: Token Count, Accuracy, Efficiency, Structure Awareness
   - Link to official TOON specification (opens in new tab)

3. **Features Section** (`#features`)
   - Zero top padding (directly follows What is TOON section)
   - Four feature cards showing different integration points:
     - Standalone App (with showcase.png)
     - Apple Shortcuts (with platform badge, shortcutsFeatureMac.png)
     - Spotlight Integration (macOS only, spotlightFeature.png)
     - Services Menu (macOS only, rightclickMenuServices.png)

4. **FAQ Section**
   - Two-column grid on desktop, single column on mobile
   - Category titles (h3) are hidden via CSS
   - Questions (h4) are visible
   - Covers: TOON format, conversion methods, mixed content, shortcuts, platform availability

### Assets Directory

All media files are in `Assets/` with relative paths:
- `macOsMainAppRecording.mov` - Hero section video (1450×1260px)
- `showcase.png` - Main app interface screenshot
- `shortcutsFeatureMac.png` - Apple Shortcuts integration (450px height)
- `spotlightFeature.png` - Spotlight search feature
- `rightclickMenuServices.png` - Right-click Services menu
- `j2nIcon.png` - App icon (not currently used in page)

### Key CSS Patterns

**Platform Badges:**
```css
.macos-badge {
    display: inline-block;
    background-color: transparent;
    color: var(--accent-color);
    border: 1px solid var(--accent-color);
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 400;
}
```

**Images:**
- All use `object-fit: contain` (never crop images)
- Standard height: 300px for feature images
- Rounded corners: 20px border-radius
- Full width within cards

**Video:**
- Maintains aspect ratio (width: 100%, height: auto)
- Rounded corners via container overflow and border-radius
- Autoplay, loop, muted, playsinline attributes

## Development Guidelines

### Making Changes

1. **Font Usage**: Only use Bebas Neue (titles) and Archivo Semi Expanded width 105 (body)
2. **Image Handling**: Never crop images - always use `object-fit: contain`
3. **No External Files**: Keep all CSS/JS inline in index.html
4. **Asset Paths**: Always use relative paths to `Assets/` directory
5. **Tone**: Professional Apple-style marketing language, not bombastic
6. **Links**: External links should open in new tab (`target="_blank" rel="noopener noreferrer"`)

### Text Content Rules

- Use professional, understated marketing language (Apple style)
- Avoid overly promotional phrases like "professional-grade" for simple utilities
- No arrows (→) in body text - write out explanations
- Bold important phrases using `<span style="font-weight: 800;">`
- Use `>` instead of `→` in technical contexts (FAQ)

### Responsive Design

- Desktop: Two-column layouts for hero, benchmarks, FAQ
- Mobile: Single-column stacking
- Breakpoint: 768px for most layouts
- Max container width: 1200px

## Hosting

This site is designed for **GitHub Pages** hosting:
- No build step required
- All assets must be committed to the repository
- Relative paths ensure portability
- Single HTML file is the entry point (index.html)
