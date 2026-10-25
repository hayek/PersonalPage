// Ozer welcome page: draws the marker once when the example comes into view,
// and fills the prices from the app's public pricing endpoint.
(function () {
    'use strict';

    // Runs in <head> before first paint. The stylesheet hides the marker only under html.js,
    // so if this file never loads the quote is shown highlighted.
    var root = document.documentElement;
    root.classList.add('js');

    var PRICING_URL = 'https://me-west1-pet-gallery.cloudfunctions.net/api/pricing';
    var TIMEOUT_MS = 5000;
    var ON_REQUEST = 'המחיר יימסר בהצעה';

    // --- The marker: one moment, the first time the quote itself is on screen ---
    // Watches the quote (a few lines), not the whole example, so it fires on short viewports too:
    // any part of the quote inside the viewport, a little above the bottom edge.
    function drawMarkerWhenSeen() {
        var screen = document.getElementById('example-screen');
        var quote = screen && screen.querySelector('.source-quote');
        if (!screen || !quote) {
            root.classList.remove('js');
            return;
        }
        if (!('IntersectionObserver' in window)) {
            screen.classList.add('is-drawn');
            return;
        }
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    screen.classList.add('is-drawn');
                    observer.disconnect();
                }
            });
        }, { threshold: 0, rootMargin: '0px 0px -15% 0px' });
        observer.observe(quote);
    }

    // --- Prices ---
    var numberFormat = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });

    function isPrice(value) {
        return typeof value === 'number' && isFinite(value) && value > 0;
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function priceRow(label, value) {
        var row = el('div', 'price-row');
        row.appendChild(el('dt', null, label));
        var dd = isPrice(value)
            ? el('dd', 'price-amount', numberFormat.format(value) + ' ₪')
            : el('dd', 'price-amount is-on-request', ON_REQUEST);
        row.appendChild(dd);
        return row;
    }

    function showPrices(pricing) {
        var box = document.getElementById('prices');
        if (!box) return;
        var monthly = pricing && pricing.monthlyPerSeatIls;
        var year = pricing && pricing.yearPerSeatIls;
        if (!isPrice(monthly) && !isPrice(year)) return; // the fallback in the markup stays

        var list = el('dl', 'price-list');
        list.appendChild(priceRow('למושב לחודש', monthly));
        list.appendChild(priceRow('למושב לשנת הלימודים', year));

        box.textContent = '';
        box.appendChild(list);
        box.appendChild(el('p', 'price-note', 'המחירים לפני מע״מ'));
    }

    function loadPrices() {
        if (!window.fetch) return;
        var controller = 'AbortController' in window ? new AbortController() : null;
        var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;

        fetch(PRICING_URL, {
            headers: { Accept: 'application/json' },
            signal: controller ? controller.signal : undefined
        })
            .then(function (response) {
                if (!response.ok) throw new Error('pricing ' + response.status);
                return response.json();
            })
            .then(showPrices)
            .catch(function () {
                // Unreachable, slow or unset: the page keeps "המחיר יימסר בהצעה".
            })
            .then(function () {
                if (timer) clearTimeout(timer);
            });
    }

    function start() {
        try {
            drawMarkerWhenSeen();
        } catch (error) {
            root.classList.remove('js'); // never leave the quote unhighlighted
        }
        loadPrices();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
