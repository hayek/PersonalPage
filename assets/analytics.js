/* Google Analytics 4 for amirhayek.dev — included in every page's <head> with defer.
   Sends the standard page_view on every page, plus blog events on /ClaudeUsage/blog/:
     blog_index_view  { blog_tag }               — the blog list was opened (tag = active ?tag= filter, or "all")
     blog_post_view   { post_slug, post_title }  — an article was opened
   Only runs on the live domain (or a subdomain like www), so local previews don't pollute the reports. */
(function () {
    const MEASUREMENT_ID = 'G-HZ3GFFE99W'; // web stream of the "amirhayek.dev" GA4 property (account "Usage for Claude")

    if (!/(^|\.)amirhayek\.dev$/.test(location.hostname)) return;

    const tag = document.createElement('script');
    tag.async = true;
    tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
    document.head.appendChild(tag);

    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', MEASUREMENT_ID);

    // index, index.html and the bare folder are the list; anything else is a post (slug = filename, with or without .html)
    const blog = location.pathname.match(/^\/ClaudeUsage\/blog\/(?:index(?:\.html)?|([^/]*?)(?:\.html)?)$/);
    if (!blog) return;

    const slug = blog[1];
    if (!slug) {
        gtag('event', 'blog_index_view', { blog_tag: new URLSearchParams(location.search).get('tag') || 'all' });
    } else {
        const h1 = document.querySelector('h1');
        gtag('event', 'blog_post_view', { post_slug: slug, post_title: h1 ? h1.textContent.trim() : document.title });
    }
})();
