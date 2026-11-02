// Progressive enhancement only: every page works without JS (desktop dropdowns open on hover via CSS).
const root = document.documentElement;
const nav = document.getElementById('site-nav');
const btn = document.getElementById('menu-btn');
const header = document.getElementById('site-header');
const dropdowns = [...document.querySelectorAll('.dd')];

// Phone/tablet drawer: opens from the menu button; closes with ✕, Escape, the backdrop, a link,
// or when the window grows to the desktop layout. Focus stays inside while it is open.
const drawer = matchMedia('(max-width: 63.99rem)');
const setDrawer = (open) => {
  nav.toggleAttribute('data-open', open);
  root.classList.toggle('nav-open', open);
  btn?.setAttribute('aria-expanded', open);
  if (open) document.getElementById('nav-close').focus();
  else if (drawer.matches && nav.contains(document.activeElement)) btn?.focus();
};
btn?.addEventListener('click', () => setDrawer(true));
document.getElementById('nav-close')?.addEventListener('click', () => setDrawer(false));
document.querySelector('.nav-backdrop')?.addEventListener('click', () => setDrawer(false));
nav.addEventListener('click', (e) => e.target.closest('a') && setDrawer(false));
drawer.addEventListener('change', () => setDrawer(false));
document.addEventListener('keydown', (e) => {
  if (!nav.hasAttribute('data-open')) return;
  if (e.key === 'Escape') setDrawer(false);
  if (e.key === 'Tab') {
    const items = [...nav.querySelectorAll('a, button')].filter((el) => el.offsetParent !== null);
    const [first, last] = [items[0], items.at(-1)];
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  }
});

// Dropdowns: tap/click toggles (touch screens and the mobile menu); one open at a time.
const setOpen = (dd, open) => {
  dd.toggleAttribute('data-open', open);
  dd.querySelector('.dd-btn').setAttribute('aria-expanded', open);
};
dropdowns.forEach((dd) =>
  dd.querySelector('.dd-btn').addEventListener('click', () => {
    const open = !dd.hasAttribute('data-open');
    dropdowns.forEach((o) => setOpen(o, o === dd && open));
  }),
);
document.addEventListener('click', (e) => dropdowns.forEach((dd) => !dd.contains(e.target) && setOpen(dd, false)));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || drawer.matches) return; // in the drawer, Escape closes the drawer itself
  const open = dropdowns.find((dd) => dd.hasAttribute('data-open') || dd.contains(document.activeElement));
  if (open) {
    setOpen(open, false);
    open.querySelector('.dd-btn').focus();
  }
});

// Header gets a soft shadow once the page scrolls.
const onScroll = () => header?.toggleAttribute('data-scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Events: the build splits upcoming/recent by its own date; move events that have ended since.
const upcoming = document.querySelector('[data-events="upcoming"]');
const recent = document.querySelector('[data-events="recent"]');
if (upcoming && recent) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (const card of [...upcoming.querySelectorAll('[data-event-date]')]) {
    if (card.dataset.eventDate < today) recent.prepend(card); // ascending upcoming -> newest ends up first
  }
}

// Events calendar: a month grid with each event on its date (built from the JSON the build embeds).
const cal = document.querySelector('[data-calendar]');
if (cal) {
  const events = JSON.parse(cal.querySelector('.cal-data').textContent);
  const grid = cal.querySelector('.cal-grid');
  const agenda = cal.querySelector('.cal-agenda');
  const label = cal.querySelector('.cal-month');
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const today = iso(new Date());
  const byDate = Object.groupBy ? Object.groupBy(events, (e) => e.date) : events.reduce((m, e) => ((m[e.date] ||= []).push(e), m), {});
  let view = new Date();
  view.setDate(1);

  const render = () => {
    const year = view.getFullYear();
    const month = view.getMonth();
    label.textContent = view.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
    const start = new Date(year, month, 1 - new Date(year, month, 1).getDay()); // Sunday on/before the 1st
    const weeks = Math.ceil((new Date(year, month + 1, 0).getDate() + new Date(year, month, 1).getDay()) / 7);
    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = iso(d);
      const list = byDate[key] || [];
      const cls = ['cal-day', d.getMonth() !== month && 'is-other', key === today && 'is-today', list.length && 'has-events'].filter(Boolean).join(' ');
      const name = d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
      const items = list
        .map((e) => `<li><a class="cal-event${key < today ? ' is-past' : ''}" href="${esc(e.href)}" title="${esc(e.title)}">${e.time ? `<span class="cal-time">${esc(e.time.split(/\s*[–-]\s*/)[0])}</span>` : ''}${esc(e.title)}</a></li>`)
        .join('');
      cells += `<div class="${cls}" aria-label="${esc(name)}${list.length ? `, ${list.length} event${list.length > 1 ? 's' : ''}` : ''}"><span class="cal-num">${d.getDate()}</span>${items ? `<ul>${items}</ul>` : ''}</div>`;
    }
    grid.innerHTML = cells;
    // Phone view: the month's events as a list under the grid.
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    const inMonth = events.filter((e) => e.date.startsWith(prefix)).sort((a, b) => a.date.localeCompare(b.date));
    agenda.innerHTML = inMonth.length
      ? inMonth
          .map((e) => {
            const d = new Date(`${e.date}T12:00`);
            const meta = [e.time, e.location].filter(Boolean).map(esc).join(' · ');
            return `<li><a href="${esc(e.href)}"><span class="cal-agenda-date">${d.toLocaleDateString('en-CA', { weekday: 'short', day: 'numeric' })}</span><span><strong>${esc(e.title)}</strong>${meta ? `<small>${meta}</small>` : ''}</span></a></li>`;
          })
          .join('')
      : '<li class="cal-agenda-empty">No events this month.</li>';
  };

  cal.addEventListener('click', (e) => {
    const action = e.target.closest('[data-cal]')?.dataset.cal;
    if (!action) return;
    if (action === 'today') view = new Date();
    else view.setMonth(view.getMonth() + (action === 'next' ? 1 : -1));
    view.setDate(1);
    render();
  });
  render();
  cal.hidden = false;
}

// Gallery viewer: click a photo to see it large; arrows, swipe and Escape work. Without JS the
// photo links simply open the image file.
const galleries = document.querySelectorAll('[data-gallery]');
if (galleries.length) {
  const box = document.createElement('dialog');
  box.className = 'lightbox';
  box.setAttribute('aria-label', 'Photo viewer');
  const btn = (cls, label, d) =>
    `<button type="button" class="lb-btn ${cls}" aria-label="${label}"><svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg></button>`;
  box.innerHTML = `<figure><img alt=""><figcaption></figcaption></figure>${btn('lb-close', 'Close', 'M18 6 6 18M6 6l12 12')}${btn('lb-prev', 'Previous photo', 'm15 18-6-6 6-6')}${btn('lb-next', 'Next photo', 'm9 18 6-6-6-6')}`;
  document.body.append(box);
  const view = box.querySelector('img');
  const caption = box.querySelector('figcaption');
  let photos = [];
  let index = 0;
  const show = (i) => {
    index = (i + photos.length) % photos.length;
    const img = photos[index];
    view.src = img.closest('a')?.href || img.src;
    view.alt = img.alt;
    caption.textContent = `${index + 1} / ${photos.length}`;
  };
  galleries.forEach((g) =>
    g.addEventListener('click', (e) => {
      const img = e.target.closest('img');
      if (!img) return;
      e.preventDefault();
      photos = [...g.querySelectorAll('img')];
      show(photos.indexOf(img));
      box.showModal();
    }),
  );
  box.querySelector('.lb-close').addEventListener('click', () => box.close());
  box.querySelector('.lb-prev').addEventListener('click', () => show(index - 1));
  box.querySelector('.lb-next').addEventListener('click', () => show(index + 1));
  box.addEventListener('click', (e) => e.target === box && box.close());
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(index - 1);
    if (e.key === 'ArrowRight') show(index + 1);
  });
  let startX = null;
  box.addEventListener('pointerdown', (e) => (startX = e.clientX));
  box.addEventListener('pointerup', (e) => {
    if (startX !== null && Math.abs(e.clientX - startX) > 50) show(index + (e.clientX < startX ? 1 : -1));
    startX = null;
  });
}

// Theme toggle: flips between light and dark and remembers the choice (the inline script in
// <head> applies it before first paint). With no saved choice the device setting is used.
const themeBtn = document.getElementById('theme-btn');
const isDark = () => (root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
const syncTheme = () => {
  const label = `Switch to ${isDark() ? 'light' : 'dark'} theme`;
  themeBtn?.setAttribute('aria-label', label);
  themeBtn?.setAttribute('title', label);
  if (!root.dataset.theme) return; // no choice made: the media-based theme-color tags apply
  const bg = getComputedStyle(document.body).backgroundColor;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', bg));
};
themeBtn?.addEventListener('click', () => {
  root.dataset.theme = isDark() ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', root.dataset.theme);
  } catch {}
  syncTheme();
});
syncTheme();
