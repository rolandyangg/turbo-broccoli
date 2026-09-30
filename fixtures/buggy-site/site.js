// Shared behavior for the buggy fixture site.
if (/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent)) {
  document.documentElement.classList.add('is-webkit');
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  if (a === 'toggle-menu') document.querySelector('.mobile-menu').classList.toggle('open');
  if (a === 'open-modal') document.querySelector('.modal-backdrop').classList.add('open');
  if (a === 'close-modal') document.querySelector('.modal-backdrop').classList.remove('open');
  if (a === 'add-to-cart') {
    const c = document.querySelector('.cart-count');
    c.textContent = String(Number(c.textContent) + 1);
  }
  if (a === 'delete-account') { document.body.dataset.deleted = 'yes'; document.body.innerHTML = '<h1>Account deleted</h1>'; }
});
// Late promo banner (layout shift).
if (document.querySelector('[data-late-promo]')) {
  setTimeout(() => {
    const b = document.createElement('div');
    b.className = 'promo';
    b.textContent = 'Limited offer: 30% off all annual plans this week only!';
    document.querySelector('[data-late-promo]').prepend(b);
  }, 1200);
}
// Live greeting preview.
const nameInput = document.querySelector('#name');
if (nameInput) nameInput.addEventListener('input', () => {
  document.querySelector('.greeting').textContent = 'Welcome aboard, ' + (nameInput.value || 'friend') + '!';
});
