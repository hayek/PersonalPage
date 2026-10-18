/* Publishes the next post waiting in blog/_queue/ (one a week; see .github/workflows/claudeusage-weekly-post.yml).
   Jekyll doesn't publish folders that start with "_", so queued posts aren't on the site until this moves them.

   node blog/publish-next.js           publish the next post (dated today, or PUBLISH_DATE=YYYY-MM-DD)
   node blog/publish-next.js --check   list links anywhere on the site to posts that are still queued

   Publishing: dates the post, adds it to posts.js and the sitemap, re-renders every published queue post
   (a link to a post that's still waiting is plain text until that post goes out), then runs bake.js.
   Run from ClaudeUsage/ or the repo root. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const blog = __dirname;
const site = path.join(blog, '..');
const repo = path.join(site, '..');
const queueDir = path.join(blog, '_queue');
const queueFile = path.join(queueDir, 'queue.json');
const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const waiting = () => queue.posts.filter((p) => !p.published).map((p) => p.slug);

function longDate(iso) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function check() {
    const slugs = waiting();
    const hits = [];
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            if (name.startsWith('_') || name.startsWith('.')) continue;
            const p = path.join(dir, name);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (name.endsWith('.html') || name.endsWith('.js')) {
                const text = fs.readFileSync(p, 'utf8');
                for (const s of slugs) if (text.includes(s + '.html')) hits.push(`${path.relative(site, p)} → ${s}`);
            }
        }
    };
    walk(site);
    console.log(hits.length ? hits.join('\n') : 'No links to queued posts.');
    process.exitCode = hits.length ? 1 : 0;
}

function render(post, unpublished) {
    let html = fs.readFileSync(path.join(queueDir, post.slug + '.html'), 'utf8')
        .replaceAll('{{DATE_LONG}}', longDate(post.published))
        .replaceAll('{{DATE}}', post.published);
    for (const s of unpublished) {
        html = html.replace(new RegExp(`<a href="${s}\\.html">([\\s\\S]*?)</a>`, 'g'), '$1');
    }
    return html;
}

function publish() {
    const next = queue.posts.find((p) => !p.published);
    if (!next) { console.log('Queue is empty: nothing to publish.'); return; }
    const today = process.env.PUBLISH_DATE || new Date().toISOString().slice(0, 10);
    next.published = today;
    const unpublished = waiting();

    // every published queue post, re-rendered so a link to a post that just went out comes back
    const changed = [];
    for (const post of queue.posts.filter((p) => p.published)) {
        const out = path.join(blog, post.slug + '.html');
        const html = render(post, unpublished);
        if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== html) {
            fs.writeFileSync(out, html);
            changed.push(post.slug);
        }
    }

    // posts.js: the new post at the top of BLOG_POSTS
    const postsFile = path.join(blog, 'posts.js');
    let posts = fs.readFileSync(postsFile, 'utf8');
    const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    const entry = `    {\n        slug: ${q(next.slug)},\n        title: ${q(next.title)},\n        date: '${today}',\n        tags: [${next.tags.map(q).join(', ')}],\n        excerpt: ${q(next.excerpt)},\n    },\n`;
    if (!posts.includes('const BLOG_POSTS = [\n')) throw new Error('posts.js: BLOG_POSTS not found');
    posts = posts.replace('const BLOG_POSTS = [\n', 'const BLOG_POSTS = [\n' + entry);
    fs.writeFileSync(postsFile, posts);

    // sitemap: the new post, plus a fresh lastmod for the blog, the landing page and re-rendered posts
    const sitemapFile = path.join(repo, 'sitemap.xml');
    let sitemap = fs.readFileSync(sitemapFile, 'utf8');
    const base = 'https://amirhayek.dev/ClaudeUsage/';
    const touch = (loc) => {
        sitemap = sitemap.replace(new RegExp(`(<loc>${loc.replace(/[.?*+^$()[\]{}|\\/]/g, '\\$&')}</loc>\\s*<lastmod>)[^<]*(</lastmod>)`), `$1${today}$2`);
    };
    const blogLoc = `    <url>\n        <loc>${base}blog/</loc>`;
    if (!sitemap.includes(blogLoc)) throw new Error('sitemap.xml: the blog entry is missing');
    const newLoc = `${base}blog/${next.slug}.html`;
    if (!sitemap.includes(`<loc>${newLoc}</loc>`)) {
        const at = sitemap.indexOf('</url>', sitemap.indexOf(blogLoc)) + '</url>\n'.length;
        sitemap = sitemap.slice(0, at) + `    <url>\n        <loc>${newLoc}</loc>\n        <lastmod>${today}</lastmod>\n    </url>\n` + sitemap.slice(at);
    }
    [base, `${base}blog/`, ...changed.map((s) => `${base}blog/${s}.html`)].forEach(touch);
    fs.writeFileSync(sitemapFile, sitemap);

    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2) + '\n');
    execFileSync(process.execPath, [path.join(blog, 'bake.js')], { stdio: 'inherit' });

    console.log(`Published ${next.slug} (${today}); re-rendered: ${changed.join(', ')}; still queued: ${unpublished.join(', ') || 'none'}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `slug=${next.slug}\ntitle=${next.title}\n`);
}

if (process.argv.includes('--check')) check();
else publish();
