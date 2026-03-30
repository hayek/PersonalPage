// Theme Switcher
const root = document.documentElement;
const buttons = document.querySelectorAll('.theme-btn');
const stored = localStorage.getItem('theme') || 'system';

function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.theme === theme));
}

setTheme(stored);
buttons.forEach(btn => btn.addEventListener('click', () => setTheme(btn.dataset.theme)));
