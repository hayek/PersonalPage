#!/usr/bin/env python3
"""A page for every region the app serves: bus-times/<slug>/ in English, and bus-times/<slug>/<lang>/
in the region's own languages (regions.json "langs").

Each page is put together from three sources:
  i18n/regions.json         the region's facts and its English texts (title, h1, coverage…)
  i18n/regions/<lang>.json  the sentences every region page shares ({in_region}, {source} filled in),
                            and under "regions" each region's own texts in that language
  i18n/<lang>.json          sentences the landing page already has (setup steps, wall mode, devices,
                            buttons, footer), looked up by their English text, so they stay in step

  python3 i18n/regions.py check   every region language has its shared strings and region texts
  python3 i18n/regions.py build   writes the pages

Run from MyBusStop/. build.py links the landing page's "Where it runs" list to these pages, so
run `python3 i18n/build.py build` after adding a region.
"""
import html, json, os, re, sys

sys.dont_write_bytecode = True   # no __pycache__ in the published folder
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build as landing   # noqa: E402

ROOT, I18N = landing.ROOT, landing.I18N
BASE = '/MyBusStop/'
ORIGIN = 'https://amirhayek.dev'
DATA = json.load(open(os.path.join(I18N, 'regions.json')))['regions']
SHARED_KEYS = list(json.load(open(os.path.join(I18N, 'regions', 'en.json'))).keys())


def url(region, lang='en'):
    return f"{BASE}bus-times/{region['slug']}/" + (f'{lang}/' if lang != 'en' and lang in region['langs'] else '')


def region_langs(region):
    return ['en'] + region['langs']


def code(lang):
    return 'en' if lang == 'en' else landing.LANGS[lang]


class Landing:
    """The landing page's sentences in one language, looked up by their English text."""

    def __init__(self, lang):
        self.en = json.load(open(os.path.join(I18N, 'en.json')))
        self.tr = self.en if lang == 'en' else json.load(open(os.path.join(I18N, lang + '.json')))
        self.by_text = {v: k for k, v in self.en.items()}

    def __call__(self, english):
        return self.tr[self.by_text[english]]

    def region_names(self):
        """The 'Where it runs' list items, in order, without their footnote marks."""
        src = landing.normalize(open(os.path.join(ROOT, 'index.html')).read())
        block = re.search(r'<div class="network">(.*?)\n                </div>', src, re.S).group(1)
        items = re.findall(r'<li>(.*?)</li>', block)
        return [re.sub(r'<span.*', '', self.tr[landing.key(i)]).strip() for i in items]


def page(region, lang):
    L = Landing(lang)
    S = json.load(open(os.path.join(I18N, 'regions', lang + '.json')))
    T = region['text']['en'] if lang == 'en' else S.pop('regions')[region['slug']]
    fill = lambda s: s.replace('{in_region}', T['in_name']).replace('{region}', T['name']).replace('{source}', T['source']).replace('{web}', BASE + 'web/')
    S = {k: fill(v) for k, v in S.items()}
    esc = lambda s: html.escape(html.unescape(s), quote=True)
    app = L('My Bus Stop')
    here = url(region, lang)
    rtl = lang in landing.RTL
    group_key = {'Middle East': 'Middle East', 'Europe': 'Europe', 'North America': 'North America', 'Asia & Oceania': 'Asia &amp; Oceania'}

    faqs = [(S['faq_cover_q'], T['coverage']), (S['faq_official_q'], S['faq_official_a']),
            (L('Is My Bus Stop free?'), L("Yes. It's free on iPhone, iPad, Mac, Apple Watch and Apple TV, with no ads, no subscription and no account. On a computer without the app, you can also open it on the web."))]
    if region['web']:
        faqs.append((S['faq_web_q'], S['faq_web_a']))
    faqs.append((L("What's the difference between LIVE and SCHEDULED?"), L("LIVE means the time comes from the bus's real position and the agency's live predictions. SCHEDULED means there's no live data for that bus yet, so the board shows the timetable. If the feed goes quiet, the board marks its numbers as stale and tells you when the last data arrived.")))
    faq_html = '\n'.join(f'''                <details>
                    <summary>{q}</summary>
                    <p>{a}</p>
                </details>''' for q, a in faqs)
    faq_ld = {"@context": "https://schema.org", "@type": "FAQPage",
              "mainEntity": [{"@type": "Question", "name": html.unescape(re.sub('<[^>]+>', '', q)),
                              "acceptedAnswer": {"@type": "Answer", "text": html.unescape(re.sub('<[^>]+>', '', a))}} for q, a in faqs]}
    crumbs_ld = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": html.unescape(app), "item": ORIGIN + BASE + ('' if lang == 'en' else lang + '/')},
        {"@type": "ListItem", "position": 2, "name": html.unescape(T['name']), "item": ORIGIN + here}]}

    # the other regions, grouped like the landing page's list, each in this language where it has a page
    names = L.region_names()
    groups = {}
    for r, name in zip(DATA, names):
        if r is not region:
            groups.setdefault(r['group'], []).append(f'<li><a href="{url(r, lang)}">{name}</a></li>')
    lines = {'Middle East': '18', 'Europe': '41', 'North America': '7', 'Asia & Oceania': 'green'}
    others = '\n'.join(f'''                    <div class="route" data-line="{lines[g]}">
                        <h3>{L(group_key[g])}</h3>
                        <ul>{''.join(items)}</ul>
                    </div>''' for g, items in groups.items())

    alternates = ''.join(f'    <link rel="alternate" hreflang="{code(l)}" href="{ORIGIN}{url(region, l)}">\n' for l in region_langs(region))
    alternates += f'    <link rel="alternate" hreflang="x-default" href="{ORIGIN}{url(region)}">\n'
    lang_links = '\n'.join(f'                <a href="{url(region, l)}" hreflang="{code(l)}" lang="{code(l)}"' + (' aria-current="page"' if l == lang else '') + f'>{landing.NATIVE[l]}</a>'
                           for l in region_langs(region)) if region['langs'] else ''
    og_locale = f'\n    <meta property="og:locale" content="{landing.OG_LOCALE[lang]}">' if lang in landing.OG_LOCALE else ''
    web_button = f'''
                    <a class="store-button web-button" href="{BASE}web/">
                        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></svg>
                        {L('Open on web')}
                    </a>''' if region['web'] else ''
    web_note = f'\n                <p class="note">{S["web_p"]}</p>' if region['web'] else ''
    landing_home = BASE + ('' if lang == 'en' else lang + '/')

    return f'''<!DOCTYPE html>
<html lang="{code(lang)}"{' dir="rtl"' if rtl else ''}>
<head>
    <!-- Generated by i18n/regions.py from i18n/regions.json. Do not edit. -->
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{T['title']}</title>
    <meta name="description" content="{esc(T['description'])}">
    <link rel="canonical" href="{ORIGIN}{here}">
{alternates}    <meta name="theme-color" content="#08080B">
    <meta name="apple-itunes-app" content="app-id=6814983455">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="My Bus Stop">
    <meta property="og:url" content="{ORIGIN}{here}">{og_locale}
    <meta property="og:title" content="{esc(T['title'])}">
    <meta property="og:description" content="{esc(T['description'])}">
    <meta property="og:image" content="{ORIGIN}{BASE}Assets/og-image.jpg">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <script type="application/ld+json">
{json.dumps(crumbs_ld, ensure_ascii=False, indent=4)}
    </script>
    <script type="application/ld+json">
{json.dumps(faq_ld, ensure_ascii=False, indent=4)}
    </script>
    <link rel="icon" type="image/svg+xml" href="{BASE}favicon/favicon.svg">
    <link rel="icon" type="image/png" href="{BASE}favicon/favicon-96x96.png" sizes="96x96">
    <link rel="apple-touch-icon" sizes="180x180" href="{BASE}favicon/apple-touch-icon.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="{BASE}styles.css?v={STYLE_V}">
    <script src="/assets/analytics.js" defer></script>
</head>
<body>

    <header class="hero region-hero">
        <div class="container hero-grid">
            <div class="hero-text">
                <nav class="crumbs" aria-label="Breadcrumb"><a href="{landing_home}">{app}</a> <span aria-hidden="true">{'‹' if rtl else '›'}</span> <a href="{landing_home}#where">{S['cities']}</a></nav>
                <h1>{T['h1']}</h1>
                <p class="hero-body">{T['lede']}</p>
                <div class="cta-row">
                    <a class="store-button" href="https://apps.apple.com/app/id6814983455">
                        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M16.37 12.64c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.82-.81-2.99-.79-1.54.02-2.96.9-3.75 2.27-1.6 2.78-.41 6.89 1.15 9.14.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.01-1.12 2.76-2.23.87-1.28 1.23-2.51 1.25-2.58-.03-.01-2.39-.92-2.4-3.66ZM14.1 5.9c.63-.77 1.06-1.83.94-2.9-.91.04-2.02.61-2.67 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.06-.51 2.69-1.27Z"/></svg>
                        {L('Download on the App Store')}
                    </a>{web_button}
                </div>
                <p class="platforms">{L('iPhone, iPad, Mac, Apple Watch and Apple TV')}</p>
            </div>
            <figure class="region-phone">
                <img src="{BASE}Assets/iphone-board-dark.webp" alt="{esc(L('The board, with line 18 two minutes away and line 41 twelve minutes away'))}" class="phone" width="660" height="1434">
            </figure>
        </div>
    </header>

    <main>
        <section class="section">
            <div class="container region-facts">
                <h2>{S['what_h2']}</h2>
                <p class="section-lede">{S['fit_full'] if region['fit'] == 'full' else S['fit_arrivals']}</p>
                <div class="facts">
                    <div><h3>{S['coverage_h3']}</h3><p>{T['coverage']}</p></div>
                    <div><h3>{S['source_h3']}</h3><p>{S['source_p']}</p><p class="note"><a href="{region['source_url']}" rel="nofollow">{html.escape(region['source_url'].split('//')[1].rstrip('/'))}</a></p></div>
                </div>{web_note}
            </div>
        </section>

        <section class="section">
            <div class="container">
                <h2>{L('Set it up once')}</h2>
                <ol class="steps">
                    <li class="step">
                        <img src="{BASE}Assets/iphone-stops-dark.webp" alt="{esc(L('The stop screen, listing stops nearby'))}" class="phone" width="660" height="1434" loading="lazy">
                        <div class="step-text">
                            <span class="step-badge" data-line="18">1</span>
                            <h3>{L('Choose your stop')}</h3>
                            <p>{L('Stops nearby come first. You can also search by name, stop code, street or line, or move the map and search that area.')}</p>
                        </div>
                    </li>
                    <li class="step">
                        <img src="{BASE}Assets/iphone-lines-dark.webp" alt="{esc(L('Choosing two lines at the stop'))}" class="phone" width="660" height="1434" loading="lazy">
                        <div class="step-text">
                            <span class="step-badge" data-line="41">2</span>
                            <h3>{L('Pick up to three lines')}</h3>
                            <p>{L("Each line gets its own route on the board, so the one you're waiting for is never lost in a list.")}</p>
                        </div>
                    </li>
                    <li class="step">
                        <img src="{BASE}Assets/iphone-board-light.webp" alt="{esc(L('The board, with line 18 two minutes away and line 41 twelve minutes away'))}" class="phone" width="660" height="1434" loading="lazy">
                        <div class="step-text">
                            <span class="step-badge" data-line="7">3</span>
                            <h3>{L('Watch the buses come in')}</h3>
                            <p>{L('The next bus, how many stops it still has to go, and the one after it. Tap any bus on the route to see when it reaches you.')}</p>
                        </div>
                    </li>
                </ol>
            </div>
        </section>

        <section class="section wall">
            <div class="container">
                <div class="wall-text">
                    <h2>{L('A board for your front door')}</h2>
                    <p class="section-lede">{L("Wall mode turns a spare iPad, iPhone or Mac into an always-on bus board for the hallway. The next bus runs the screen's full height beside the route map, big enough to read from across the hall. Glance at it with your shoes on, and leave when the bus does.")}</p>
                </div>
                <img src="{BASE}Assets/entryway.webp" alt="{esc(L('An entryway with the front door closed and an iPad mounted on the wall beside it, showing the board in wall mode: line 18 in 2 minutes, in large numbers beside the route map'))}" class="wall-photo region-wall-photo" width="1600" height="1308" loading="lazy">
            </div>
        </section>

        <section class="section everywhere">
            <div class="container">
                <h2>{L('On every screen in the house')}</h2>
                <p class="section-lede">{L("iPhone, iPad, Mac, Apple Watch and Apple TV. Save a stop once and it's on all of them: your stops sync through iCloud, and Apple Watch follows your iPhone.")}</p>
            </div>
        </section>

        <section class="section">
            <div class="container faq">
                <h2>{L('Questions')}</h2>
{faq_html}
            </div>
        </section>

        <section class="section">
            <div class="container">
                <h2>{S['other_h2']}</h2>
                <div class="network">
{others}
                </div>
            </div>
        </section>
    </main>

    <footer class="footer">
        <div class="container">
            <p>{L('My Bus Stop © 2026, for iPhone, iPad, Mac, Apple Watch and Apple TV.')}</p>
            <p>{L('Made by <a href="https://amirhayek.dev/">Amir Hayek</a>. See <a href="/apps.html">more apps</a>.')}</p>
            <p><a href="{BASE}privacy/">{L('Privacy policy')}</a></p>{f"""
            <nav class="langs" aria-label="{L('Languages')}">
{lang_links}
            </nav>""" if lang_links else ''}
        </div>
    </footer>

    <script src="{BASE}script.js?v={SCRIPT_V}"></script>
</body>
</html>
'''


def versions():
    src = open(os.path.join(ROOT, 'index.html')).read()
    return re.search(r'styles\.css\?v=(\d+)', src).group(1), re.search(r'script\.js\?v=(\d+)', src).group(1)


def check():
    problems = []
    for lang in sorted({l for r in DATA for l in r['langs']}):
        p = os.path.join(I18N, 'regions', lang + '.json')
        if not os.path.exists(p):
            problems.append(f'{lang}: no regions/{lang}.json')
            continue
        S = json.load(open(p))
        problems += [f'{lang}: missing shared {k}' for k in SHARED_KEYS if k not in S]
        en = json.load(open(os.path.join(I18N, 'regions', 'en.json')))
        problems += [f'{lang}: tags differ in shared {k}' for k in SHARED_KEYS if k in S and landing.tags(S[k]) != landing.tags(en[k])]
        problems += [f'{lang}: placeholders differ in shared {k}' for k in SHARED_KEYS if k in S and sorted(re.findall(r'\{\w+\}', S[k])) != sorted(re.findall(r'\{\w+\}', en[k]))]
    for r in DATA:
        for lang in r['langs']:
            p = os.path.join(I18N, 'regions', lang + '.json')
            t = json.load(open(p)).get('regions', {}).get(r['slug']) if os.path.exists(p) else None
            if not t:
                problems.append(f"{r['slug']}: no {lang} text")
                continue
            problems += [f"{r['slug']}/{lang}: missing {k}" for k in r['text']['en'] if not t.get(k)]
    print('\n'.join(problems) or f'OK: {len(DATA)} regions, {sum(len(r["langs"]) for r in DATA)} translated pages')
    return not problems


def build():
    global STYLE_V, SCRIPT_V
    STYLE_V, SCRIPT_V = versions()
    n = 0
    for r in DATA:
        for lang in region_langs(r):
            p = os.path.join(I18N, 'regions', lang + '.json')
            if lang != 'en' and not (os.path.exists(p) and r['slug'] in json.load(open(p)).get('regions', {})):
                print(f"{r['slug']}: no {lang} yet, skipped")
                continue
            out = os.path.join(ROOT, url(r, lang)[len(BASE):], 'index.html')
            os.makedirs(os.path.dirname(out), exist_ok=True)
            open(out, 'w').write(page(r, lang))
            n += 1
    print(f'{n} region pages')


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'check':
        sys.exit(0 if check() else 1)
    build()
