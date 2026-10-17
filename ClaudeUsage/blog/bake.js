/* Writes the blog cards into the pages as static HTML, so search engines see the posts without
   running a script; the pages' own scripts still re-render them from posts.js on load.
   Run from ClaudeUsage/ after editing posts.js:  node blog/bake.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(__dirname, 'posts.js'), 'utf8').replace(/^const /gm, 'var ').replace(/^function (\w+)/gm, 'var $1 = function'));
// formatPostDate uses toLocaleDateString, which Node also has

const targets = [
    // file, element id, posts, base path to blog/
    ['index.html', 'latestPosts', BLOG_POSTS.slice(0, 3), 'blog/'],
    ['blog/index.html', 'postList', BLOG_POSTS, ''],
];
for (const [file, id, posts, base] of targets) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    let html = fs.readFileSync(p, 'utf8');
    const open = new RegExp(`(<(div|section) class="post-grid" id="${id}">)[\\s\\S]*?(</\\2>)`);
    if (!open.test(html)) { console.error(`${file}: #${id} not found`); process.exitCode = 1; continue; }
    const cards = posts.map((post) => renderPostCard(post, base)).join('');
    html = html.replace(open, (m, start, tag, end) => `${start}${cards}\n            ${end}`);
    fs.writeFileSync(p, html);
    console.log(`${file}: ${posts.length} cards`);
}
