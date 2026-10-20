// What the stop card and the line card share as modal sheets. One can open over another — a line's
// card from a stop's, that line's stops' cards from it — so Escape and a tap on the backdrop close
// only the top one, Tab stays inside it, the page under them all holds still until the last one
// closes, and each hands focus back to whatever opened it.

const stack = [];
let savedOverflow = '';

/**
 * Puts `backdrop` (holding `card`) on screen above everything open.
 * @param {HTMLElement} backdrop
 * @param {HTMLElement} card
 * @param {{initialFocus?: HTMLElement, onClose?: () => void}} [options]
 * @returns {{dismiss: () => void, isTop: () => boolean}}
 */
export function presentSheet(backdrop, card, { initialFocus, onClose } = {}) {
    const returnFocus = document.activeElement;
    const sheet = { dismiss, isTop: () => stack.at(-1) === sheet };

    // Ahead of every other listener, so Escape here closes the sheet and not the view under it.
    const onKey = (event) => {
        if (!sheet.isTop()) return;
        if (event.key === 'Escape') {
            event.stopImmediatePropagation();
            event.preventDefault();
            dismiss();
        } else if (event.key === 'Tab') {
            trapFocus(event, card);
        }
    };
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) dismiss(); });
    document.addEventListener('keydown', onKey, true);
    if (!stack.length) {
        savedOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
    }
    stack.push(sheet);
    document.body.append(backdrop);
    initialFocus?.focus({ preventScroll: true });

    function dismiss() {
        const index = stack.indexOf(sheet);
        if (index < 0) return;
        stack.splice(index, 1);
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (!stack.length) document.body.style.overflow = savedOverflow;
        onClose?.();
        if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
    }
    return sheet;
}

/** Tab stays inside the sheet while it is open, as a modal's focus must. */
function trapFocus(event, container) {
    const focusable = [...container.querySelectorAll('a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])')]
        .filter((node) => node.offsetParent !== null || node === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!container.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}
