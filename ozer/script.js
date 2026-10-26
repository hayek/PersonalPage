// Ozer welcome page: draws the marker once when the example comes into view,
// fills the prices from the app's public pricing endpoint, and sends the contact form to the app's server.
(function () {
    'use strict';

    // Runs in <head> before first paint. The stylesheet hides the marker only under html.js,
    // so if this file never loads the quote is shown highlighted.
    var root = document.documentElement;
    root.classList.add('js');

    var PRICING_URL = 'https://me-west1-pet-gallery.cloudfunctions.net/api/pricing';
    var TIMEOUT_MS = 5000;
    var ON_REQUEST = 'המחיר יימסר בהצעה';
    var CONTACT_URL = 'https://me-west1-pet-gallery.cloudfunctions.net/api/contact';
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    // As the server checks it: digits with the usual separators, at least 9 digits.
    var PHONE_RE = /^\+?[\d\s()-]+$/;

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

    function formatIls(value) {
        return numberFormat.format(value) + ' ₪';
    }

    // One billing period: the price for the first 5 seats, and under it the price of each 5 added.
    function priceRow(label, base, block) {
        var row = el('div', 'price-row');
        var dt = el('dt', null, label);
        if (isPrice(base) && isPrice(block)) {
            dt.appendChild(el('span', 'price-extra', 'כל 5 מושבים נוספים: ' + formatIls(block)));
        }
        row.appendChild(dt);
        row.appendChild(isPrice(base)
            ? el('dd', 'price-amount', formatIls(base))
            : el('dd', 'price-amount is-on-request', ON_REQUEST));
        return row;
    }

    function showPrices(pricing) {
        var box = document.getElementById('prices');
        if (!box || !pricing) return;
        var monthly = pricing.monthlyBaseIls;
        var year = pricing.yearBaseIls;
        if (!isPrice(monthly) && !isPrice(year)) return; // the fallback in the markup stays

        var list = el('dl', 'price-list');
        list.appendChild(priceRow('שנת לימודים, עד 5 מושבים', year, pricing.yearBlockIls));
        list.appendChild(priceRow('חודשי, עד 5 מושבים', monthly, pricing.monthlyBlockIls));

        box.textContent = '';
        box.appendChild(list);
        if (isPrice(monthly) && isPrice(year) && Math.round(year / monthly) < 12) {
            box.appendChild(el('p', 'price-deal', 'שנת לימודים שלמה במחיר של כ-' + Math.round(year / monthly) + ' חודשים.'));
        }
        box.appendChild(el('p', 'price-note', 'שנת הלימודים מסתיימת ב-31 באוגוסט. בית ספר שמצטרף באמצע השנה משלם רק על החודשים שנותרו.'));
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

    // --- Contact form: a dialog; without dialog support the links just scroll to the contact section ---
    function setUpContact() {
        var dialog = document.getElementById('contact-dialog');
        var form = document.getElementById('contact-form');
        var sent = document.getElementById('contact-sent');
        var error = document.getElementById('contact-error');
        if (!dialog || !form || !sent || !error || typeof dialog.showModal !== 'function' || !window.fetch) return;
        var submit = form.querySelector('[type="submit"]');
        var submitLabel = submit.textContent;
        var openedAt = 0;
        var required = ['name', 'email', 'phone', 'message'];

        function open(event) {
            event.preventDefault();
            if (dialog.open) return;
            form.hidden = false;
            sent.hidden = true;
            error.textContent = '';
            openedAt = Date.now();
            dialog.showModal();
            form.elements.name.focus();
        }

        function value(name) {
            return form.elements[name].value.trim();
        }

        function markInvalid() {
            var firstBad = null;
            required.forEach(function (name) {
                var field = form.elements[name];
                var v = value(name);
                var bad = !v
                    || (name === 'email' && !EMAIL_RE.test(v))
                    || (name === 'phone' && (!PHONE_RE.test(v) || v.replace(/\D/g, '').length < 9));
                field.setAttribute('aria-invalid', bad ? 'true' : 'false');
                if (bad && !firstBad) firstBad = field;
            });
            return firstBad;
        }

        function busy(on) {
            submit.disabled = on;
            submit.textContent = on ? 'שולחים…' : submitLabel;
        }

        form.addEventListener('submit', function (event) {
            event.preventDefault();
            error.textContent = '';
            var firstBad = markInvalid();
            if (firstBad) {
                error.textContent = 'נא למלא שם, אימייל תקין, מספר טלפון והודעה.';
                firstBad.focus();
                return;
            }
            busy(true);
            fetch(CONTACT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: value('name'),
                    email: value('email'),
                    school: value('school'),
                    phone: value('phone'),
                    message: value('message'),
                    website: form.elements.website.value,
                    elapsedMs: Date.now() - openedAt
                })
            })
                .then(function (response) {
                    if (response.ok) {
                        form.reset();
                        form.hidden = true;
                        sent.hidden = false;
                        sent.querySelector('[data-close]').focus();
                    } else if (response.status === 429) {
                        error.textContent = 'נשלחו היום יותר מדי הודעות מהחיבור הזה. אפשר לנסות שוב מחר.';
                    } else if (response.status === 400) {
                        error.textContent = 'משהו בפרטים לא תקין. בדקו את השדות ונסו שוב.';
                    } else {
                        throw new Error('contact ' + response.status);
                    }
                })
                .catch(function () {
                    error.textContent = 'ההודעה לא נשלחה. בדקו את החיבור לאינטרנט ונסו שוב.';
                })
                .then(function () {
                    busy(false);
                });
        });

        required.forEach(function (name) {
            form.elements[name].addEventListener('input', function () {
                this.removeAttribute('aria-invalid');
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-contact]'), function (el) {
            el.addEventListener('click', open);
        });
        Array.prototype.forEach.call(dialog.querySelectorAll('[data-close]'), function (el) {
            el.addEventListener('click', function () { dialog.close(); });
        });
        // A click on the backdrop lands on the dialog element itself.
        dialog.addEventListener('click', function (event) {
            if (event.target === dialog) dialog.close();
        });
    }

    function start() {
        try {
            drawMarkerWhenSeen();
        } catch (error) {
            root.classList.remove('js'); // never leave the quote unhighlighted
        }
        loadPrices();
        setUpContact();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
