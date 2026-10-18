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
    // the cards sit between two markers, so a re-bake replaces exactly what the last one wrote
    const B = '<!-- baked from blog/posts.js by blog/bake.js -->', E = '<!-- /baked -->';
    const a = html.indexOf(B), b = html.indexOf(E, a);
    if (a < 0 || b < 0) { console.error(`${file}: the ${B} … ${E} markers inside #${id} are missing`); process.exitCode = 1; continue; }
    const cards = posts.map((post) => renderPostCard(post, base)).join('');
    html = html.slice(0, a + B.length) + cards + '\n                ' + html.slice(b);
    fs.writeFileSync(p, html);
    console.log(`${file}: ${posts.length} cards`);
}
