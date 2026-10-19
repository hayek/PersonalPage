#!/usr/bin/env python3
"""Translated copies of the landing page.

index.html (English) is the source. This script cuts its visible text into units (a block's run of
text and inline markup, plus alt / aria-label / meta text), keyed by a hash of the English, and:

  python3 i18n/build.py extract   writes i18n/en.json (every unit) and i18n/todo/<lang>.json
                                  (units a language has no translation for yet)
  python3 i18n/build.py check xx  checks i18n/xx.json: every key present, tags identical to the English
  python3 i18n/build.py build     writes <lang>/index.html for every i18n/<lang>.json, and puts the
                                  hreflang links into index.html

Run both from ClaudeUsage/ after changing the English page. A changed sentence gets a new key, so it
shows up in todo/ and falls back to English until it is translated. `build` refuses a translation
whose tags differ from the English (a translator must keep <span class="only-mac"> and friends).
"""
import hashlib, html, json, os, re, sys
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N = os.path.join(ROOT, 'i18n')
SITE = 'https://amirhayek.dev/ClaudeUsage/'

# folder name -> hreflang / html lang
LANGS = {
    'ar': 'ar', 'de': 'de', 'es': 'es', 'fr': 'fr', 'he': 'he', 'hi': 'hi', 'it': 'it', 'ja': 'ja',
    'ko': 'ko', 'nl': 'nl', 'pt-br': 'pt-BR', 'pt-pt': 'pt-PT', 'ru': 'ru', 'tr': 'tr',
    'zh-hans': 'zh-Hans', 'zh-hant': 'zh-Hant',
}
RTL = {'ar', 'he'}
OG_LOCALE = {'ar': 'ar_AR', 'de': 'de_DE', 'es': 'es_ES', 'fr': 'fr_FR', 'he': 'he_IL', 'hi': 'hi_IN', 'it': 'it_IT',
             'ja': 'ja_JP', 'ko': 'ko_KR', 'nl': 'nl_NL', 'pt-br': 'pt_BR', 'pt-pt': 'pt_PT', 'ru': 'ru_RU',
             'tr': 'tr_TR', 'zh-hans': 'zh_CN', 'zh-hant': 'zh_TW'}

INLINE = {'a', 'b', 'strong', 'em', 'i', 'span', 'br', 'code', 'small', 'time', 'sup', 'sub', 'abbr', 'kbd', 'wbr', 'u', 's', 'mark'}
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}
OPAQUE = {'script', 'style', 'svg', 'canvas', 'noscript', 'template'}
ATOMS = {'img', 'svg', 'canvas', 'input', 'button', 'video', 'picture'}   # never inside a text unit
SKIP_IDS = {'latestPosts', 'faqData'}   # blog cards are English (baked from posts.js); FAQ JSON-LD is rebuilt
TEXT_ATTRS = ('alt', 'aria-label', 'title', 'placeholder')
META_KEYS = {'description', 'og:title', 'og:description', 'og:image:alt', 'twitter:title', 'twitter:description'}


class Node:
    def __init__(self, tag, attrs, start, open_end):
        self.tag, self.attrs, self.start, self.open_end = tag, dict(attrs), start, open_end
        self.end = None
        self.children = []


class Text:
    tag = None

    def __init__(self, start, end):
        self.start, self.end = start, end


class Tree(HTMLParser):
    def __init__(self, src):
        super().__init__(convert_charrefs=False)
        self.src = src
        self.lines = [0]
        for m in re.finditer('\n', src):
            self.lines.append(m.end())
        self.root = Node('#root', [], 0, 0)
        self.stack = [self.root]
        self.feed(src)
        self.close()
        self.root.end = len(src)

    def off(self):
        line, col = self.getpos()
        return self.lines[line - 1] + col

    def handle_starttag(self, tag, attrs):
        start = self.off()
        open_end = start + len(self.get_starttag_text())
        node = Node(tag, attrs, start, open_end)
        self.stack[-1].children.append(node)
        if tag in VOID:
            node.end = open_end
        else:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        start = self.off()
        node = Node(tag, attrs, start, start + len(self.get_starttag_text()))
        node.end = node.open_end
        self.stack[-1].children.append(node)

    def handle_endtag(self, tag):
        start = self.off()
        end = self.src.index('>', start) + 1
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                for n in self.stack[i:]:
                    n.end = end if n is self.stack[i] else start
                del self.stack[i:]
                return

    def _text(self, n):
        start = self.off()
        self.stack[-1].children.append(Text(start, start + n))

    def handle_data(self, data):
        self._text(len(data))

    def handle_comment(self, data):
        start = self.off()
        node = Node('#comment', [], start, start + len(data) + 7)
        node.end = node.open_end
        self.stack[-1].children.append(node)

    def handle_entityref(self, name):
        self._text(len(name) + 2)

    def handle_charref(self, name):
        self._text(len(name) + 3)


def pure_inline(n):
    if isinstance(n, Text):
        return True
    if n.tag not in INLINE or n.tag in ATOMS:
        return False
    return all(pure_inline(c) for c in n.children)


def visible(s):
    t = html.unescape(re.sub(r'<[^>]+>', '', s)).strip()
    return bool(re.search(r'[A-Za-z]{2}', t))


def key(text):
    return hashlib.sha1(text.encode()).hexdigest()[:10]


def units(src):
    """[(start, end, text, kind)] for every translatable piece, in document order."""
    out = []
    tree = Tree(src)

    def attr_units(n):
        for name in TEXT_ATTRS:
            if n.attrs.get(name):
                m = re.search(r'\s%s="([^"]*)"' % re.escape(name), src[n.start:n.open_end])
                if m and visible(m.group(1)):
                    out.append((n.start + m.start(1), n.start + m.end(1), m.group(1), 'attr'))
        if n.tag == 'meta' and (n.attrs.get('name') in META_KEYS or n.attrs.get('property') in META_KEYS):
            m = re.search(r'\scontent="([^"]*)"', src[n.start:n.open_end])
            out.append((n.start + m.start(1), n.start + m.end(1), m.group(1), 'attr'))

    def walk(node):
        if isinstance(node, Text):
            return
        attr_units(node)
        if node.tag in OPAQUE or node.attrs.get('id') in SKIP_IDS:
            return
        run = []

        def flush():
            if not run:
                return
            a, b = run[0].start, run[-1].end
            seg = src[a:b]
            lead = len(seg) - len(seg.lstrip())
            trail = len(seg) - len(seg.rstrip())
            a, b = a + lead, b - trail
            # a unit that is one element wrapped round everything is translated inside it
            only = [c for c in run if not (isinstance(c, Text) and not src[c.start:c.end].strip())]
            while len(only) == 1 and not isinstance(only[0], Text) and only[0].tag != 'br' and only[0].start == a and only[0].end == b:
                el = only[0]
                close = src.rindex('</', el.open_end, el.end)
                a, b = el.open_end, close
                seg = src[a:b]
                a, b = a + len(seg) - len(seg.lstrip()), b - (len(seg) - len(seg.rstrip()))
                only = [c for c in el.children if not (isinstance(c, Text) and not src[c.start:c.end].strip())]
                if any(isinstance(c, Text) for c in only) or len(only) != 1:
                    break
            if visible(src[a:b]):
                out.append((a, b, src[a:b], 'text'))
            run.clear()

        for c in node.children:
            # elements on their own lines (nav links, side-by-side buttons) are separate units
            if isinstance(c, Text) and '\n' in src[c.start:c.end] and not src[c.start:c.end].strip():
                flush()
                continue
            if pure_inline(c):
                run.append(c)
                if not isinstance(c, Text):
                    for d in iter_nodes(c):
                        attr_units(d)
            else:
                flush()
                walk(c)
        flush()

    walk(tree.root)
    out.sort()
    return out


def iter_nodes(n):
    for c in n.children:
        if not isinstance(c, Text):
            yield c
            yield from iter_nodes(c)


def tags(s):
    return sorted(re.findall(r'<[^>]+>', s))


def localize_paths(src):
    def fix(m):
        attr, val = m.group(1), m.group(2)
        if re.match(r'(https?:|/|#|mailto:|data:|\.\./)', val) or not val:
            return m.group(0)
        return f'{attr}="../{val}"'
    return re.sub(r'\b(src|href|srcset)="([^"]*)"', fix, src)


def hreflang_block(indent='    '):
    lines = [f'{indent}<link rel="alternate" hreflang="en" href="{SITE}">']
    for folder, code in LANGS.items():
        lines.append(f'{indent}<link rel="alternate" hreflang="{code}" href="{SITE}{folder}/">')
    lines.append(f'{indent}<link rel="alternate" hreflang="x-default" href="{SITE}">')
    return '\n'.join(lines) + '\n'


HREF_START, HREF_END = '    <!-- hreflang (i18n/build.py) -->\n', '    <!-- /hreflang -->\n'


def set_hreflang(src, available):
    block = HREF_START + '\n'.join(l for l in hreflang_block().splitlines()
                                   if 'hreflang="en"' in l or 'x-default' in l or any(f'/{f}/"' in l for f in available)) + '\n' + HREF_END
    if HREF_START in src:
        a = src.index(HREF_START)
        b = src.index(HREF_END) + len(HREF_END)
        return src[:a] + block + src[b:]
    anchor = re.search(r'    <link rel="canonical"[^>]*>\n', src)
    return src[:anchor.end()] + block + src[anchor.end():]


def faq_jsonld(page):
    items = re.findall(r'<summary>(.*?)<span class="q-mark"></span></summary>\s*<div class="faq-body">(.*?)</div>', page, re.S)
    data = {"@context": "https://schema.org", "@type": "FAQPage",
            "mainEntity": [{"@type": "Question", "name": html.unescape(q),
                            "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in items]}
    return json.dumps(data, ensure_ascii=False, indent=4)


def extract():
    src = open(os.path.join(ROOT, 'index.html')).read()
    en = {}
    for a, b, text, kind in units(src):
        en.setdefault(key(text), text)
    json.dump(en, open(os.path.join(I18N, 'en.json'), 'w'), ensure_ascii=False, indent=1)
    os.makedirs(os.path.join(I18N, 'todo'), exist_ok=True)
    for folder in LANGS:
        path = os.path.join(I18N, folder + '.json')
        have = json.load(open(path)) if os.path.exists(path) else {}
        todo = {k: v for k, v in en.items() if k not in have}
        tp = os.path.join(I18N, 'todo', folder + '.json')
        if todo:
            json.dump(todo, open(tp, 'w'), ensure_ascii=False, indent=1)
        elif os.path.exists(tp):
            os.remove(tp)
        print(f'{folder}: {len(todo)} to translate')
    print(f'{len(en)} units')


def build():
    src = open(os.path.join(ROOT, 'index.html')).read()
    us = units(src)
    available = [f for f in LANGS if os.path.exists(os.path.join(I18N, f + '.json'))]
    bad = 0
    for folder in available:
        tr = json.load(open(os.path.join(I18N, folder + '.json')))
        page, missing = src, 0
        for a, b, text, kind in reversed(us):
            t = tr.get(key(text))
            if t is None:
                missing += 1
                continue
            if tags(t) != tags(text):
                print(f'{folder}: tags differ in {key(text)}: {text[:60]!r}')
                bad += 1
                continue
            if kind == 'attr':
                t = t.replace('"', '&quot;')
            page = page[:a] + t + page[b:]
        code = LANGS[folder]
        page = page.replace('<html lang="en">', f'<html lang="{code}"' + (' dir="rtl"' if folder in RTL else '') + ' data-root="../">', 1)
        page = localize_paths(page)
        page = page.replace(f'<link rel="canonical" href="{SITE}">', f'<link rel="canonical" href="{SITE}{folder}/">', 1)
        page = page.replace(f'<meta property="og:url" content="{SITE}">', f'<meta property="og:url" content="{SITE}{folder}/">\n    <meta property="og:locale" content="{OG_LOCALE[folder]}">', 1)
        # the SoftwareApplication description follows the page's meta description
        desc = re.search(r'<meta name="description" content="([^"]*)">', page).group(1)
        page = re.sub(r'("@type": "SoftwareApplication",.*?"description": )"[^"]*"',
                      lambda m: m.group(1) + json.dumps(html.unescape(desc), ensure_ascii=False), page, count=1, flags=re.S)
        page = re.sub(r'(<script type="application/ld\+json" id="faqData">\n).*?(\n\s*</script>)',
                      lambda m: m.group(1) + '\n'.join('                ' + l for l in faq_jsonld(page).splitlines()) + m.group(2), page, count=1, flags=re.S)
        page = set_hreflang(page, available)
        os.makedirs(os.path.join(ROOT, folder), exist_ok=True)
        open(os.path.join(ROOT, folder, 'index.html'), 'w').write(
            page.replace('<head>\n', '<head>\n    <!-- Generated by i18n/build.py from ../index.html and i18n/%s.json. Do not edit. -->\n' % folder, 1))
        print(f'{folder}: built ({missing} untranslated)')
    open(os.path.join(ROOT, 'index.html'), 'w').write(set_hreflang(src, available))
    if bad:
        sys.exit(f'{bad} units kept in English because their tags changed')


def check(folder):
    en = json.load(open(os.path.join(I18N, 'en.json')))
    tr = json.load(open(os.path.join(I18N, folder + '.json')))
    problems = [f'missing {k}: {v[:60]!r}' for k, v in en.items() if k not in tr]
    problems += [f'unknown key {k}' for k in tr if k not in en]
    problems += [f'tags differ in {k}:\n  en: {tags(en[k])}\n  {folder}: {tags(t)}' for k, t in tr.items() if k in en and tags(t) != tags(en[k])]
    problems += [f'<br> count differs in {k}' for k, t in tr.items() if k in en and t.count('<br>') != en[k].count('<br>')]
    print('\n'.join(problems) or f'{folder}: OK ({len(tr)} units)')
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'check':
        check(sys.argv[2])
    else:
        {'extract': extract, 'build': build}[cmd]()
