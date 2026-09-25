// Theme Switcher
const themeButtons = document.querySelectorAll('.theme-button');
const themeSwitcher = document.querySelector('.theme-switcher');
const html = document.documentElement;

// Get saved theme or default to 'system'
const savedTheme = localStorage.getItem('theme') || 'system';

// Apply theme on load
function applyTheme(theme) {
    html.classList.remove('light-theme', 'dark-theme');

    if (theme === 'light') {
        html.classList.add('light-theme');
    } else if (theme === 'dark') {
        html.classList.add('dark-theme');
    }
    // 'system' has no class, uses CSS media query

    // Update active button
    themeButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === theme);
    });

    // Save preference
    localStorage.setItem('theme', theme);
}

// Apply saved theme
applyTheme(savedTheme);

// Theme button click handlers
themeButtons.forEach(button => {
    button.addEventListener('click', () => {
        applyTheme(button.dataset.theme);
    });
});

// Hide/show theme switcher on scroll
let lastScrollTop = 0;
window.addEventListener('scroll', () => {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

    if (scrollTop > 100) {
        themeSwitcher.classList.add('hidden');
    } else {
        themeSwitcher.classList.remove('hidden');
    }

    lastScrollTop = scrollTop;
});

// Rotating Phrases Animation
const phrases = document.querySelectorAll('.phrase');
if (phrases.length > 0) {
    let currentIndex = 0;

    function rotatePhrase() {
        // Fade out current
        phrases[currentIndex].classList.remove('active');

        // Move to next
        currentIndex = (currentIndex + 1) % phrases.length;

        // Fade in next after a brief pause
        setTimeout(() => {
            phrases[currentIndex].classList.add('active');
        }, 400);
    }

    // Rotate every 3 seconds
    setInterval(rotatePhrase, 3000);
}

// Update Current Date
const dateElements = document.querySelectorAll('.current-date');
if (dateElements.length > 0) {
    const now = new Date();
    const day = now.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[now.getMonth()];
    const formattedDate = `${day} ${month}`;

    dateElements.forEach(el => {
        el.textContent = formattedDate;
    });
}

// Marquee Speed - Adjust based on content width relative to viewport
function updateMarqueeSpeed() {
    const marqueeContents = document.querySelectorAll('.marquee-content');
    const viewportWidth = window.innerWidth;
    const pixelsPerSecond = 20; // Consistent speed across all screen sizes

    marqueeContents.forEach(content => {
        const contentWidth = content.scrollWidth;
        const duration = contentWidth / pixelsPerSecond;
        content.style.animationDuration = `${duration}s`;
    });
}

// Run on load and resize
updateMarqueeSpeed();
window.addEventListener('resize', updateMarqueeSpeed);

// FAQ Accordion Animation
const faqItems = document.querySelectorAll('.faq-item');
faqItems.forEach(item => {
    const summary = item.querySelector('summary');

    summary.addEventListener('click', (e) => {
        if (item.open) {
            e.preventDefault();
            item.classList.add('closing');

            setTimeout(() => {
                item.open = false;
                item.classList.remove('closing');
            }, 300);
        }
    });
});
