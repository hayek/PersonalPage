/* Blog post index — shared by the homepage "From the blog" section and blog/index.html.
   To publish a post: add its HTML page to blog/ (copy an existing one) and add an
   entry at the TOP of this list (newest first). Use a category tag first —
   changelog, news, or pro-tip — then any extra topic tags. */
const BLOG_POSTS = [
    {
        slug: 'limit-reset-command',
        title: 'Hit your session limit? Try /limit-reset',
        date: '2026-09-14',
        tags: ['pro-tip', 'claude-code'],
        excerpt: "Claude Code's new command clears your 5-hour session limit on the spot. How to use it, why it might not work for you yet, and why it still counts toward your weekly limit.",
    },
    {
        slug: 'usage-for-claude-3-1',
        title: 'Usage for Claude 3.1: multiple accounts, made solid',
        date: '2026-08-13',
        tags: ['changelog'],
        excerpt: 'Accounts that never blend together, sign-in that pairs correctly, named accounts, synced notification rules, and a weekly line on the chart.',
    },
];

/* Filter chips on the blog index, in display order. */
const BLOG_CATEGORIES = ['changelog', 'news', 'pro-tip'];

function formatPostDate(iso) {
    return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/* base: path from the current page to the blog/ folder ('' on blog pages, 'blog/' on the homepage) */
function renderPostCard(post, base) {
    const tags = post.tags.map((t) => `<span class="tag">#${t}</span>`).join('');
    return `
        <a class="post-card" href="${base}${post.slug}.html">
            <div class="tag-list">${tags}</div>
            <h3>${post.title}</h3>
            <p>${post.excerpt}</p>
            <time datetime="${post.date}">${formatPostDate(post.date)}</time>
        </a>`;
}
