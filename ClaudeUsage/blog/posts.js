/* Blog post index — shared by the homepage "From the blog" section and blog/index.html.
   To publish a post: add its HTML page to blog/ (copy an existing one) and add an
   entry at the TOP of this list (newest first). Use a category tag first —
   changelog, news, or pro-tip — then any extra topic tags. The new page must keep the
   /assets/analytics.js script tag, its first <h1> is what GA records as post_title,
   and `slug` must match the HTML filename. Then run `node blog/bake.js` (from ClaudeUsage/): it
   writes the cards into the pages as plain HTML too, so search engines see them without the script. */
const BLOG_POSTS = [
    {
        slug: 'how-to-check-claude-usage',
        title: 'How to check your Claude usage',
        date: '2026-10-18',
        tags: ['pro-tip', 'limits'],
        excerpt: 'The Usage page on claude.ai, the /usage command in Claude Code, and how to keep your session and weekly limits in the menu bar or on your iPhone.',
    },
    {
        slug: 'claude-usage-limits-reset',
        title: "When do Claude's usage limits reset?",
        date: '2026-10-18',
        tags: ['pro-tip', 'limits'],
        excerpt: "Claude's 5-hour session window and its weekly limit reset on very different clocks. How each one works, where to see your reset times, and what a limit reset is.",
    },
    {
        slug: 'claude-usage-limit-reached',
        title: 'Hit your Claude usage limit? What happens and what you can do',
        date: '2026-10-18',
        tags: ['pro-tip', 'limits'],
        excerpt: 'What happens at your Claude session or weekly limit, the options you have right now (a limit reset, usage credits, upgrading), and how to make your usage last longer.',
    },
    {
        slug: 'claude-pro-vs-max-usage',
        title: 'Claude Pro vs Max vs Team: how much usage each plan gets',
        date: '2026-10-18',
        tags: ['pro-tip', 'limits', 'plans'],
        excerpt: 'Free, Pro, Max 5x, Max 20x, Team and Enterprise side by side: what each plan\'s usage multiplier means and how to tell whether you need to upgrade.',
    },
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
