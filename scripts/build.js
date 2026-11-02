// Builds the static site: app/**/*.md -> dist/**/index.html, with the navbar derived from the folder tree.
// Usage: node scripts/build.js   (CSS is compiled separately by the Tailwind CLI, see package.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked } from 'marked';
import site from './site.config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const CONTENTS = path.join(ROOT, 'contents');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const PAGE_FILE = 'page.md';
// `draft: true` pages are only built by the dev server (it sets GCSS_DRAFTS=1).
const DRAFTS = process.env.GCSS_DRAFTS === '1';
const isDraft = (node) => node.meta.draft === true && !DRAFTS;

export class BuildError extends Error {}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rel = (file) => path.relative(ROOT, file);
const titleCase = (slug) => slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const slugify = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&[#\w]+;/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
const safeDecode = (s) => {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
};
const isInside = (file, dir) => file === dir || file.startsWith(dir + path.sep);
const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

// ---------------------------------------------------------------------------
// Front matter: a simple "key: value" block between --- lines.
// ---------------------------------------------------------------------------
export function parseFrontMatter(src) {
  const m = src.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#.*$/, '').trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v !== '' && !Number.isNaN(Number(v))) v = Number(v);
    meta[kv[1]] = v;
  }
  return { meta, body: src.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// Scanning app/ into a tree. "x.md" and "x/page.md" are the same page.
// ---------------------------------------------------------------------------
function makeNode(segs, file) {
  const node = { segs, url: segs.length ? `/${segs.join('/')}/` : '/', file, meta: {}, body: '', children: [] };
  if (file) Object.assign(node, parseFrontMatter(fs.readFileSync(file, 'utf8')));
  const h1 = node.body.match(/^#[ \t]+(.+?)[ \t#]*$/m);
  node.title = String(node.meta.title || (h1 && h1[1]) || (segs.length ? titleCase(segs.at(-1)) : site.siteName));
  node.label = String(node.meta.nav || node.title);
  node.href = node.meta.link ? String(node.meta.link) : file ? node.url : null;
  return node;
}

function sortNodes(nodes) {
  const ord = (n) => (typeof n.meta.order === 'number' ? n.meta.order : Infinity);
  return nodes.sort((a, b) => ord(a) - ord(b) || a.label.localeCompare(b.label));
}

function scanDir(dir, segs, ctx) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
  const names = new Set(entries.map((e) => e.name));
  const nodes = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const inside = path.join(full, PAGE_FILE);
      const beside = path.join(dir, `${e.name}.md`);
      const hasInside = fs.existsSync(inside);
      const hasBeside = names.has(`${e.name}.md`);
      if (hasInside && hasBeside) ctx.errors.push(`${rel(beside)} and ${rel(inside)} are the same page; keep only one`);
      checkSlug(e.name, full, ctx);
      const node = makeNode([...segs, e.name], hasInside ? inside : hasBeside ? beside : null);
      if (isDraft(node)) continue;
      node.children = scanDir(full, node.segs, ctx);
      if (node.file || node.children.length) nodes.push(node);
    } else if (e.name.endsWith('.md')) {
      const name = e.name.slice(0, -3);
      if (e.name === PAGE_FILE || names.has(name)) continue; // handled as a folder page
      checkSlug(name, full, ctx);
      const node = makeNode([...segs, name], full);
      if (!isDraft(node)) nodes.push(node);
    } else {
      ctx.warn(`${rel(full)} is not a markdown page; put media in contents/`);
    }
  }
  return sortNodes(nodes);
}

function checkSlug(name, file, ctx) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) ctx.warn(`${rel(file)}: use lowercase-hyphenated names for clean URLs`);
}

function flatten(node, out = []) {
  out.push(node);
  node.children.forEach((c) => flatten(c, out));
  return out;
}

// ---------------------------------------------------------------------------
// Link and media resolution
// ---------------------------------------------------------------------------
function resolveRef(href, node, ctx, kind = 'link') {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href; // external, mailto:, tel:, #anchor
  const [, rawPath, suffix] = href.match(/^([^?#]*)(.*)$/);
  let p = safeDecode(rawPath);
  const where = node.file ? rel(node.file) : node.url;
  const baseDir = node.file ? path.dirname(node.file) : APP;

  // 1. Another page, referenced by its markdown file.
  if (p.endsWith('.md')) {
    const file = p.startsWith('/') ? path.join(APP, p) : path.resolve(baseDir, p);
    // "x.md" and "x/page.md" are interchangeable, so a link to either form finds the page.
    const alt = path.basename(file) === PAGE_FILE ? `${path.dirname(file)}.md` : path.join(file.slice(0, -3), PAGE_FILE);
    const target = ctx.byFile.get(file) || ctx.byFile.get(alt);
    if (!target) ctx.errors.push(`${where}: ${kind} points to a missing page "${href}"`);
    return target ? target.href + suffix : href;
  }

  // 2. A file in contents/.
  if (p.startsWith('contents/')) p = `/${p}`;
  const abs = p.startsWith('/') ? path.join(ROOT, p) : path.resolve(baseDir, p);
  if (isInside(abs, CONTENTS)) {
    if (!fs.existsSync(abs)) ctx.errors.push(`${where}: ${kind} points to a missing file "${href}"`);
    return encodeURI(`/${path.relative(ROOT, abs).split(path.sep).join('/')}`) + suffix;
  }

  // 3. A site URL such as /about/ (relative URLs resolve like in the browser).
  const urlPath = path.posix.resolve(node.url, p);
  const norm = /\.[a-z0-9]+$/i.test(urlPath) ? urlPath : urlPath.replace(/\/?$/, '/');
  if (!ctx.urls.has(norm)) ctx.errors.push(`${where}: ${kind} points to a missing page "${href}"`);
  return encodeURI(norm) + suffix;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------
// ":::name key=value …" opens a block, ":::" closes it; markdown flows through the HTML wrappers.
// Blocks with `parent` may only appear directly inside that block.
const BLOCKS = {
  intro: { open: () => '<div class="intro">', close: '</div>' },
  columns: { open: (a) => `<div class="cols cols-${Math.min(Math.max(Number(a._) || 2, 1), 4)}">`, close: '</div>' },
  col: { parent: 'columns', open: () => '<div class="col" data-reveal>', close: '</div>' },
  hero: {
    open: (a) => heroBlockOpen(a),
    close:
      '</div>HERO_ART<a class="hero-scroll" href="#after-hero" aria-label="Scroll to content"><svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></a></section><span id="after-hero"></span>',
  },
  features: { open: () => '<section class="features not-prose">', close: '</section>' },
  feature: { parent: 'features', open: (a, at) => `<div class="feature" data-reveal><span class="feature-icon">${blockIcon(a.icon || 'sparkles', at)}</span>`, close: '</div>' },
  cards: { open: () => '<section class="cards not-prose">', close: '</section>' },
  stats: { open: () => '<div class="stats not-prose" data-reveal>', close: '</div>' },
  people: { open: () => '<div class="people not-prose">', close: '</div>' },
  person: { parent: 'people', open: (a, at, resolve) => personOpen(a, at, resolve), close: '' },
  faq: { open: () => '<div class="faq">', close: '</div>' },
  note: { open: (a, at) => `<aside class="callout callout-note">${blockIcon(a.icon || 'info', at, 'callout-icon')}<div>`, close: '</div></aside>' },
  tip: { open: (a, at) => `<aside class="callout callout-tip">${blockIcon(a.icon || 'lightbulb', at, 'callout-icon')}<div>`, close: '</div></aside>' },
  cta: { open: () => '<section class="cta not-prose" data-reveal>', close: '</section>' },
  buttons: { open: () => '<div class="buttons not-prose">', close: '</div>' },
  chips: { open: () => '<nav class="chips not-prose" aria-label="On this page">', close: '</nav>' },
  // :::gallery folder=/contents/gallery/x  (photos from a folder; images written inside are added too)
  gallery: { open: (a, at, resolve, ctx) => galleryBlockOpen(a, at, ctx), close: '</div>' },
};

function galleryBlockOpen(a, at, ctx) {
  const photos = a.folder ? listPhotos(a.folder, at, ctx.errors) : [];
  return galleryGridHtml(photos, a.title || 'Gallery').replace(/<\/div>$/, '');
}

function parseAttrs(src) {
  const attrs = {};
  for (const [, key, quoted, bare] of src.matchAll(/(?:([a-z][\w-]*)=)?(?:"([^"]*)"|(\S+))/g)) {
    const value = quoted ?? bare;
    if (key) attrs[key] = value;
    else attrs._ ??= value;
  }
  return attrs;
}

function blockIcon(name, at, cls = 'size-6') {
  if (!BLOCK_ICONS.includes(name)) throw new BuildError(`${at}: unknown icon "${name}" (use ${BLOCK_ICONS.join(', ')})`);
  return icon(name, cls);
}

function heroBlockOpen(a) {
  const chips = (a.chips || '').split(',').map((c) => c.trim()).filter(Boolean);
  HERO_CHIPS.length = 0;
  HERO_CHIPS.push(...chips);
  return `<section class="hero not-prose"><div class="hero-copy"><p class="hero-eyebrow">${esc(site.shortName)} · University of Manitoba</p>`;
}
const HERO_CHIPS = [];
const heroArt = () =>
  `<div class="hero-art" aria-hidden="true"><div class="hero-ring"></div><div class="hero-ring hero-ring-2"></div>` +
  `<img class="hero-mark" src="${esc(site.logo.dark)}" alt="" width="200" height="200">` +
  HERO_CHIPS.map((c, i) => `<span class="hero-chip hero-chip-${i + 1}">${esc(c)}</span>`).join('') +
  '</div>';

// :::person name="…" role="…" photo=… — the body is the bio; a list of links becomes icon buttons.
function personOpen(a, at, resolve) {
  if (!a.name) throw new BuildError(`${at}: ":::person" needs name="…"`);
  const photo = a.photo
    ? `<img class="person-photo" src="${esc(resolve(a.photo))}" alt="Photo of ${esc(a.name)}" loading="lazy" decoding="async" width="480" height="560">`
    : `<div class="person-photo person-photo-empty" aria-hidden="true"><span>${esc(initials(a.name))}</span></div>`;
  const role = a.role ? `<p class="person-role">${esc(a.role)}</p>` : '';
  return `<article class="person" data-reveal>${photo}<div class="person-body"><h3 class="person-name">${esc(a.name)}</h3>${role}<div class="person-bio">`;
}

const LINK_LINE = /^\s*[-*+]\s+\[([^\]]+)\]\(<?([^)\s>]+)>?\)\s*$/;
function linkKind(url) {
  if (/^mailto:/i.test(url)) return 'mail';
  for (const k of ['linkedin', 'github', 'instagram']) if (url.includes(`${k}.com`)) return k;
  return 'globe';
}
function personLinks(links, name, resolve) {
  if (!links.length) return '';
  const items = links.map(([label, url]) => {
    const href = /^(https?:|mailto:)/i.test(url) ? url : resolve(url, 'link');
    return `<a class="person-link" href="${esc(href)}" rel="noopener" aria-label="${esc(`${name}: ${label}`)}" title="${esc(label)}">${icon(linkKind(url), 'size-[1.05rem]')}</a>`;
  });
  return `<div class="person-links">${items.join('')}</div>`;
}

function initials(name) {
  const words = name.replace(/[^\p{L}\s.-]/gu, '').split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '') + (words.length > 1 ? words.at(-1)[0] : '')).toUpperCase();
}

function expandContainers(body, where, resolve, ctx) {
  const out = [];
  const stack = [];
  let fence = null;
  body.split(/\r?\n/).forEach((line, i) => {
    const at = `${where}:${i + 1}`;
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (f && f[1].startsWith(fence)) fence = null;
      return out.push(line);
    }
    if (f) {
      fence = f[1];
      return out.push(line);
    }
    const top = stack.at(-1);
    // Inside :::faq every "### Question" starts a collapsible answer.
    const q = top?.name === 'faq' && line.match(/^###[ \t]+(.+?)[ \t#]*$/);
    if (q) {
      if (top.item) out.push('', '</div></details>', '');
      top.item = true;
      return out.push('', `<details class="faq-item" data-reveal><summary>${esc(q[1])}</summary><div class="faq-body">`, '');
    }
    const m = line.match(/^:::[ \t]*([a-z]*)(.*)$/);
    if (!m) return out.push(line);
    const [, name, rest] = m;
    if (!name) {
      const entry = stack.pop();
      if (!entry) throw new BuildError(`${at}: ":::" closes nothing`);
      if (entry.name === 'faq' && entry.item) out.push('', '</div></details>', '');
      if (entry.name === 'person') {
        const links = [];
        for (let j = entry.at + 1; j < out.length; j++) {
          const lm = out[j].match(LINK_LINE);
          if (lm) links.push([lm[1], lm[2]]), (out[j] = '');
        }
        return out.push('', `</div>${personLinks(links, entry.attrs.name, resolve)}</div></article>`, '');
      }
      return out.push('', BLOCKS[entry.name].close, '');
    }
    const block = BLOCKS[name];
    if (!block) throw new BuildError(`${at}: unknown block ":::${name}" (use ${Object.keys(BLOCKS).join(', ')})`);
    if (block.parent && top?.name !== block.parent) throw new BuildError(`${at}: ":::${name}" must be inside ":::${block.parent}"`);
    const attrs = parseAttrs(rest.trim());
    out.push('');
    stack.push({ name, attrs, at: out.length });
    out.push(block.open(attrs, at, resolve, ctx), '');
  });
  if (stack.length) throw new BuildError(`${where}: ":::${stack.at(-1).name}" is never closed`);
  return out.join('\n').replace('HERO_ART', heroArt());
}

function plainText(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max = 155) {
  if (text.length <= max) return text;
  return `${text.slice(0, text.lastIndexOf(' ', max - 1) > 0 ? text.lastIndexOf(' ', max - 1) : max - 1)}…`;
}

function renderPage(node, ctx) {
  const where = rel(node.file);
  const ids = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        let id = slugify(html) || 'section';
        const seen = ids.get(id) || 0;
        ids.set(id, seen + 1);
        if (seen) id += `-${seen}`;
        return `<h${depth} id="${id}">${html}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const external = /^https?:\/\//i.test(href);
        return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${external ? ' rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`;
      },
      image({ href, title, text }) {
        if (!text) ctx.warn(`${where}: image "${href}" has no alt text`);
        const img = `<img src="${esc(href)}" alt="${esc(text)}" loading="lazy" decoding="async">`;
        return title ? `<figure>${img}<figcaption>${esc(title)}</figcaption></figure>` : img;
      },
      paragraph({ tokens }) {
        // An image on its own line is not wrapped in <p>, so captioned <figure>s stay valid HTML.
        const parts = tokens.filter((t) => !(t.type === 'text' && !t.text.trim()));
        const inner = this.parser.parseInline(tokens);
        return parts.length === 1 && parts[0].type === 'image' ? `${inner}\n` : `<p>${inner}</p>\n`;
      },
    },
  });

  const body = expandContainers(node.body, where, (ref, kind = 'image') => resolveRef(ref, node, ctx, kind), ctx);
  const tokens = marked.lexer(body);
  marked.walkTokens(tokens, (t) => {
    if (t.type === 'link' || t.type === 'image') t.href = resolveRef(t.href, node, ctx, t.type);
  });
  // Normal pages show their title in the page hero, so the first "# Heading" moves there.
  // The home page keeps its H1 inside the :::hero block.
  let heroTitle = esc(node.title);
  if (node.meta.layout !== 'home') {
    const i = tokens.findIndex((t) => t.type !== 'space');
    if (tokens[i]?.type === 'heading' && tokens[i].depth === 1) heroTitle = marked.parseInline(tokens.splice(i, 1)[0].text);
  } else if (!tokens.some((t) => t.type === 'heading' && t.depth === 1) && !/<h1[\s>]/.test(body)) {
    ctx.warn(`${where}: the home page has no "# Heading" (put one in :::hero)`);
  }
  const firstParagraph = tokens.find((t) => t.type === 'paragraph' && plainText(t.text));
  const description = String(node.meta.description || (firstParagraph ? truncate(plainText(firstParagraph.text)) : site.description));
  return { html: marked.parser(tokens), description, heroTitle };
}

// "In this section" cards, added to every page that has child pages (unless `children: false`).
function childCardsHtml(node) {
  const kids = visible(node.children).filter((c) => c.href);
  if (!kids.length || node.meta.children === false || node.meta.layout === 'home') return '';
  const cards = kids
    .map((c) => {
      const text = c.meta.description ? `<span class="link-card-text">${esc(truncate(String(c.meta.description), 110))}</span>` : '';
      const pdf = /\.pdf$/i.test(c.href) ? ' <span class="link-card-tag">PDF</span>' : '';
      const cover = c.cover ? `<img class="link-card-cover" src="${esc(c.cover)}" alt="" loading="lazy" decoding="async" width="800" height="450">` : '';
      return `<a class="link-card${cover ? ' link-card-media' : ''}" href="${esc(c.href)}" data-reveal>${cover}<span class="link-card-title">${esc(c.title)}${pdf}</span>${text}<span class="link-card-arrow" aria-hidden="true">${icon('arrow', 'size-5')}</span></a>`;
    })
    .join('');
  return `<section class="mt-14" aria-labelledby="in-this-section"><h2 id="in-this-section" class="section-title">In this section</h2><div class="card-grid">${cards}</div></section>`;
}

function pageHeroHtml(title, lead, breadcrumb, width, extra = '') {
  return (
    `<section class="page-hero"><div class="page-hero-inner ${width}">${breadcrumb}` +
    `<h1 class="page-title">${title}</h1>${lead ? `<p class="page-lead">${esc(lead)}</p>` : ''}${extra}</div></section>`
  );
}

// `cover:` front matter: a large photo at the top of the page (e.g. the executive group photo).
function coverHtml(node) {
  if (!node.cover) return '';
  const alt = node.meta.cover_alt || `${node.title} photo`;
  return `<figure class="cover-photo not-prose"><img src="${esc(node.cover)}" alt="${esc(String(alt))}" width="1600" height="900" decoding="async" fetchpriority="high"></figure>`;
}

// ---------------------------------------------------------------------------
// Events: pages with a `date:` below a `list: events` page. They are listed (not put in the
// navbar) and split into upcoming / recent by date; main.js re-checks the split in the browser.
// ---------------------------------------------------------------------------
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateParts = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return {
    day: d,
    month: dt.toLocaleDateString('en-CA', { month: 'short' }),
    weekday: dt.toLocaleDateString('en-CA', { weekday: 'short' }),
    long: dt.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
  };
};

function eventMetaItems(e) {
  return [
    e.meta.time && `${icon('clock', 'size-4 shrink-0')}<span>${esc(String(e.meta.time))}</span>`,
    e.meta.location && `${icon('pin', 'size-4 shrink-0')}<span>${esc(String(e.meta.location))}</span>`,
  ].filter(Boolean);
}

function eventCardHtml(e) {
  const date = String(e.meta.date);
  const p = dateParts(date);
  const cover = e.cover
    ? `<img class="event-cover" src="${esc(e.cover)}" alt="" loading="lazy" decoding="async" width="800" height="450">`
    : `<div class="event-cover event-cover-empty" aria-hidden="true">${icon('calendar', 'size-8')}</div>`;
  const meta = eventMetaItems(e).map((m) => `<span class="event-meta-item">${m}</span>`).join('');
  const desc = e.meta.description ? `<p class="event-desc">${esc(truncate(String(e.meta.description), 140))}</p>` : '';
  return (
    `<article class="event-card" data-event-date="${date}" data-reveal>${cover}` +
    `<div class="event-date" aria-hidden="true"><span class="event-month">${esc(p.month)}</span><span class="event-day">${p.day}</span><span class="event-weekday">${esc(p.weekday)}</span></div>` +
    `<div class="event-body"><p class="event-when"><time datetime="${date}">${esc(p.long)}</time></p>` +
    `<h3 class="event-title"><a href="${esc(e.href)}">${esc(e.title)}</a></h3>${meta ? `<p class="event-meta">${meta}</p>` : ''}${desc}</div></article>`
  );
}

// Month calendar: the build embeds the events as JSON and main.js draws the grid
// (it stays hidden without JS; the upcoming/recent lists below cover that case).
function calendarHtml(events) {
  const data = events.map((e) => ({ date: String(e.meta.date), title: e.title, href: e.href, time: e.meta.time ? String(e.meta.time) : '', location: e.meta.location ? String(e.meta.location) : '' }));
  const btn = (dir, label, path) =>
    `<button type="button" class="cal-btn" data-cal="${dir}" aria-label="${label}"><svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg></button>`;
  return (
    `<section class="calendar not-prose" aria-labelledby="calendar-title" data-calendar hidden>` +
    `<div class="cal-head"><h2 id="calendar-title" class="section-title">Calendar</h2>` +
    `<div class="cal-nav">${btn('prev', 'Previous month', 'm15 18-6-6 6-6')}<p class="cal-month" aria-live="polite"></p>${btn('next', 'Next month', 'm9 18 6-6-6-6')}` +
    `<button type="button" class="cal-today-btn" data-cal="today">Today</button></div></div>` +
    `<div class="cal-weekdays" aria-hidden="true"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>` +
    `<div class="cal-grid"></div><ul class="cal-agenda"></ul>` +
    `<p class="cal-foot"><a class="cal-subscribe" href="/events.ics">${icon('calendar', 'size-4')}Add all GCSS events to your calendar (.ics)</a></p>` +
    `<script type="application/json" class="cal-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script></section>`
  );
}

// events.ics: every event as an all-day entry (time and location go in the details).
function icsCalendar(events, stamp) {
  const text = (v) => String(v).replace(/\\/g, '\\\\').replace(/[,;]/g, '\\$&').replace(/\n/g, '\\n');
  const fold = (line) => line.match(/.{1,73}/gu).join('\r\n ');
  const day = (iso) => iso.replace(/-/g, '');
  const next = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return day(localDate(new Date(y, m - 1, d + 1)));
  };
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${site.shortName}//Events//EN`, 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${text(`${site.shortName} events`)}`];
  for (const e of events) {
    const date = String(e.meta.date);
    const details = [e.meta.time && `Time: ${e.meta.time}`, e.meta.description, site.baseURL + e.href].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.segs.join('-')}@${new URL(site.baseURL).host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(date)}`,
      `DTEND;VALUE=DATE:${next(date)}`,
      `SUMMARY:${text(e.title)}`,
      ...(e.meta.location ? [`LOCATION:${text(e.meta.location)}`] : []),
      `DESCRIPTION:${text(details)}`,
      `URL:${site.baseURL + e.href}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

function eventsHtml(node, today) {
  if (!node.events) return '';
  const byDate = (a, b) => String(a.meta.date).localeCompare(String(b.meta.date));
  const upcoming = node.events.filter((e) => e.meta.date >= today).sort(byDate);
  const past = node.events.filter((e) => e.meta.date < today).sort(byDate).reverse();
  const section = (id, title, cls, list, empty) =>
    `<section class="events-section not-prose" aria-labelledby="${id}"><h2 id="${id}" class="section-title">${title}</h2>` +
    `<div class="${cls}" data-events="${id}">${list.map(eventCardHtml).join('')}</div><p class="events-empty">${empty}</p></section>`;
  return (
    section('upcoming', 'Upcoming events', 'event-list', upcoming, `No upcoming events right now. Check back soon, or <a href="mailto:${esc(site.email)}">suggest one</a>.`) +
    section('recent', 'Recent events', 'event-grid', past, 'No past events yet.')
  );
}

// ---------------------------------------------------------------------------
// Gallery: albums are pages below a `list: gallery` page. An album's `photos:` folder (under
// contents/) is listed automatically; the gallery page shows one card per album, newest first.
// ---------------------------------------------------------------------------
const PHOTO_EXT = /\.(jpe?g|png|webp|avif|gif|svg)$/i;

// All photos in a /contents/… folder, sorted by file name ("01.jpg", "02.jpg", …).
function listPhotos(folder, where, errors) {
  const rel = String(folder).replace(/^\/+/, '').replace(/\/+$/, '');
  const dir = path.join(ROOT, rel);
  if (!rel.startsWith('contents/') || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    errors.push(`${where}: photo folder "${folder}" not found (it must be a folder inside contents/)`);
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => PHOTO_EXT.test(f) && !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => encodeURI(`/${rel}/${f}`));
}

function galleryGridHtml(photos, title) {
  const items = photos
    .map((src, i) => `<a class="gallery-item" href="${esc(src)}"><img src="${esc(src)}" alt="${esc(`${title}, photo ${i + 1}`)}" loading="lazy" decoding="async" width="600" height="450"></a>`)
    .join('');
  return `<div class="gallery not-prose" data-gallery>${items}</div>`;
}

const photoCount = (n) => `${n} photo${n === 1 ? '' : 's'}`;
const monthYear = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
};

function albumsHtml(node) {
  if (!node.albums) return '';
  const cards = node.albums
    .map((a) => {
      const cover = a.cover || a.photos?.[0];
      const img = cover
        ? `<img class="album-cover" src="${esc(cover)}" alt="" loading="lazy" decoding="async" width="800" height="600">`
        : `<div class="album-cover album-cover-empty" aria-hidden="true">${icon('camera', 'size-8')}</div>`;
      const meta = [isDate(a.meta.date) ? monthYear(String(a.meta.date)) : '', photoCount(a.photos?.length || 0)].filter(Boolean).join(' · ');
      return `<a class="album-card" href="${esc(a.href)}" data-reveal>${img}<span class="album-body"><span class="album-title">${esc(a.title)}</span><span class="album-meta">${esc(meta)}</span></span></a>`;
    })
    .join('');
  return (
    `<section class="albums not-prose" aria-labelledby="albums"><h2 id="albums" class="section-title">Albums</h2>` +
    `<div class="album-grid">${cards}</div><p class="events-empty">Photos coming soon. Have some from a GCSS event? <a href="mailto:${esc(site.email)}">Send them to us</a>.</p></section>`
  );
}

function albumHeroHtml(a) {
  const items = [
    isDate(a.meta.date) && `${icon('calendar', 'size-4 shrink-0')}<time datetime="${a.meta.date}">${esc(dateParts(String(a.meta.date)).long)}</time>`,
    `${icon('camera', 'size-4 shrink-0')}<span>${photoCount(a.photos?.length || 0)}</span>`,
  ].filter(Boolean);
  return `<ul class="hero-meta">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

function eventHeroHtml(e, today) {
  const items = [`${icon('calendar', 'size-4 shrink-0')}<time datetime="${e.meta.date}">${esc(dateParts(String(e.meta.date)).long)}</time>`, ...eventMetaItems(e)];
  const past = e.meta.date < today ? '<li class="hero-meta-tag">Past event</li>' : '';
  return `<ul class="hero-meta">${items.map((i) => `<li>${i}</li>`).join('')}${past}</ul>`;
}

// ---------------------------------------------------------------------------
// Navbar, breadcrumb, head
// ---------------------------------------------------------------------------
const CHEVRON =
  '<svg class="chevron size-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06Z" clip-rule="evenodd"/></svg>';

const visible = (nodes) => nodes.filter((n) => !n.meta.hidden && (n.href || visible(n.children).length));
const isAncestor = (node, current) => node.url !== '/' && current.startsWith(node.url);
const current = (node, url) => (node.href === url ? ' aria-current="page"' : '');

// First-level dropdown items show a one-line description (from front matter) under the label.
function treeHtml(nodes, url, depth = 0) {
  return nodes
    .map((n) => {
      const kids = visible(n.children);
      const desc = depth === 0 && n.meta.description ? `<span class="tree-desc">${esc(truncate(String(n.meta.description), 70))}</span>` : '';
      const label = n.href
        ? `<a class="tree-link" href="${esc(n.href)}"${current(n, url)}><span class="tree-label">${esc(n.label)}</span>${desc}</a>`
        : `<span class="tree-group">${esc(n.label)}</span>`;
      return `<li>${label}${kids.length ? `<ul class="tree-sub">${treeHtml(kids, url, depth + 1)}</ul>` : ''}</li>`;
    })
    .join('');
}

// Dropdowns open on hover/keyboard focus on desktop (CSS), and on tap via main.js.
function navHtml(root, url) {
  return visible(root.children)
    .map((n, i) => {
      const kids = visible(n.children);
      const active = isAncestor(n, url) ? ' is-active' : '';
      if (!kids.length) {
        return `<li><a class="nav-link${active}" href="${esc(n.href)}"${current(n, url)}>${esc(n.label)}</a></li>`;
      }
      const id = `dd-${i}`;
      const overview = n.href
        ? `<li><a class="tree-link tree-overview" href="${esc(n.href)}"${current(n, url)}><span class="tree-label">${esc(n.title)}</span><span class="tree-desc">Overview</span></a></li>`
        : '';
      return (
        `<li class="dd">` +
        `<button type="button" class="nav-link dd-btn${active}" aria-expanded="false" aria-controls="${id}">${esc(n.label)}${CHEVRON}</button>` +
        `<div class="dd-panel" id="${id}"><ul class="dd-card tree">${overview}${treeHtml(kids, url)}</ul></div></li>`
      );
    })
    .join('');
}

function crumbs(node, ctx) {
  const list = [];
  for (let i = 0; i <= node.segs.length; i++) {
    const n = ctx.bySegs.get(node.segs.slice(0, i).join('/'));
    if (n) list.push({ name: i === 0 ? 'Home' : n.title, href: n.href });
  }
  return list;
}

function breadcrumbHtml(items) {
  if (items.length < 2) return '';
  const li = items.map((c, i) => {
    if (i === items.length - 1) return `<li aria-current="page" class="text-night-ink">${esc(c.name)}</li>`;
    const sep = '<span aria-hidden="true" class="mx-2 text-spark">/</span>';
    return `<li>${c.href ? `<a class="hover:text-night-ink hover:underline" href="${esc(c.href)}">${esc(c.name)}</a>` : esc(c.name)}${sep}</li>`;
  });
  return `<nav aria-label="Breadcrumb" class="mb-5 text-sm text-night-muted"><ol class="flex flex-wrap items-center">${li.join('')}</ol></nav>`;
}

const ICONS = {
  instagram:
    '<rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><path d="M17.5 6.5h.01"/>',
  github:
    '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 3.5c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  linkedin:
    '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  // Icons for :::feature, :::note and :::tip (icon=name).
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  presentation: '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  wallet:
    '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  graduation: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/><path d="M22 10v6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  heart:
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  network: '<circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><path d="M12 8v3m-4.5 5.5L10 13m6.5 3.5L14 13"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  lightbulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
};
const BLOCK_ICONS = ['megaphone', 'presentation', 'users', 'wallet', 'graduation', 'shield', 'heart', 'network', 'book', 'calendar', 'message', 'code', 'sparkles', 'info', 'lightbulb', 'mail', 'camera'];
const icon = (name, cls = 'size-5') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const SOCIAL_NAMES = { instagram: 'Instagram', github: 'GitHub', linkedin: 'LinkedIn' };

// Bottom line: the configured related links, after the copyright.
function relatedHtml() {
  return (site.footerLinks || [])
    .map((l) => `<span aria-hidden="true" class="hidden md:inline">·</span><a class="hover:text-link hover:underline" href="${esc(l.url)}" rel="noopener">${esc(l.label)} <span aria-hidden="true">↗</span></a>`)
    .join('');
}

function socialHtml() {
  return Object.entries(site.social)
    .filter(([name, url]) => url && ICONS[name])
    .map(([name, url]) => {
      const label = `${site.shortName} on ${SOCIAL_NAMES[name] || name}`;
      return `<a class="foot-icon" href="${esc(url)}" rel="noopener" aria-label="${esc(label)}" title="${esc(label)}">${icon(name)}</a>`;
    })
    .concat(`<a class="foot-icon" href="mailto:${esc(site.email)}" aria-label="Email ${esc(site.email)}" title="${esc(site.email)}">${icon('mail')}</a>`)
    .join('');
}

// The header/footer logo is inlined (not an <img>), so it paints with the page instead of
// waiting for a separate image request. Shapes come from the colour logo file; the two theme
// colours are applied by CSS (.logo-ink / .logo-code in styles.css).
function inlineLogo(cls) {
  const file = path.join(ROOT, site.logo.light.replace(/^\//, ''));
  return fs
    .readFileSync(file, 'utf8')
    .replace(/<svg\b([^>]*)>/, (m, attrs) => `<svg${attrs.replace(/\s(?:role|aria-label|xmlns)="[^"]*"/g, '')} class="${cls}" aria-hidden="true" focusable="false">`)
    .replace(/fill="#4F2C1D"/gi, 'class="logo-ink"')
    .replace(/stroke="#385E9D"/gi, 'class="logo-code"')
    .replace(/\n/g, '')
    .trim();
}

const absUrl = (u) => (/^https?:\/\//.test(u) ? u : site.baseURL + u);

function headHtml(node, description, items, ctx) {
  const isHome = node.url === '/';
  const title = isHome ? site.siteName : `${node.title} | ${site.shortName}`;
  const canonical = site.baseURL + node.url;
  const image = node.meta.image ? resolveRef(String(node.meta.image), node, ctx, 'image') : node.cover || site.image;
  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
  ];
  if (node.meta.noindex) tags.push('<meta name="robots" content="noindex">');
  if (!node.is404) {
    tags.push(
      `<link rel="canonical" href="${esc(canonical)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="${esc(site.siteName)}">`,
      `<meta property="og:title" content="${esc(isHome ? site.siteName : node.title)}">`,
      `<meta property="og:description" content="${esc(description)}">`,
      `<meta property="og:url" content="${esc(canonical)}">`,
      `<meta property="og:locale" content="en_CA">`,
      `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    );
    if (image) tags.push(`<meta property="og:image" content="${esc(absUrl(image))}">`);
    if (isHome) {
      tags.push(
        jsonLd({
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: site.siteName,
          alternateName: site.shortName,
          url: `${site.baseURL}/`,
          logo: absUrl(site.logo.light),
          email: site.email,
          sameAs: Object.values(site.social).filter((u) => /^https?:\/\//.test(u)),
          parentOrganization: { '@type': 'CollegeOrUniversity', ...site.parentOrganization },
        }),
      );
    } else {
      if (node.isEvent) {
        tags.push(
          jsonLd({
            '@context': 'https://schema.org',
            '@type': 'Event',
            name: node.title,
            startDate: String(node.meta.date),
            description,
            url: canonical,
            eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
            location: { '@type': 'Place', name: String(node.meta.location || site.parentOrganization.name), address: site.parentOrganization.name },
            organizer: { '@type': 'Organization', name: site.siteName, url: `${site.baseURL}/` },
            ...(image ? { image: absUrl(image) } : {}),
          }),
        );
      }
      const linked = items.filter((c) => c.href);
      tags.push(
        jsonLd({
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: linked.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: absUrl(c.href) })),
        }),
      );
    }
  }
  return tags.join('\n    ');
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in values ? values[key] : m));
}

function cleanDist() {
  // Keep the compiled CSS so `npm run dev` (Tailwind in watch mode) is not disturbed by rebuilds.
  if (!fs.existsSync(DIST)) return;
  for (const e of fs.readdirSync(DIST)) {
    if (e === 'assets') {
      for (const a of fs.readdirSync(path.join(DIST, e))) if (a !== 'site.css') fs.rmSync(path.join(DIST, e, a), { recursive: true, force: true });
    } else fs.rmSync(path.join(DIST, e), { recursive: true, force: true });
  }
}

function lastmod(node) {
  if (!node.isEvent && !node.isAlbum && isDate(node.meta.date)) return String(node.meta.date); // event/album dates are not edit dates
  const d = fs.statSync(node.file).mtime;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function build({ log = console.log } = {}) {
  const started = Date.now();
  const warnings = [];
  const ctx = { errors: [], warn: (w) => warnings.push(w), byFile: new Map(), bySegs: new Map(), urls: new Set(['/404.html', '/sitemap.xml', '/robots.txt', '/events.ics']) };

  const homeFile = path.join(APP, PAGE_FILE);
  if (!fs.existsSync(homeFile)) throw new BuildError(`missing home page ${rel(homeFile)}`);
  const root = makeNode([], homeFile);
  root.children = scanDir(APP, [], ctx);
  const all = flatten(root);
  for (const n of all) {
    ctx.bySegs.set(n.segs.join('/'), n);
    if (n.file) ctx.byFile.set(n.file, n);
    if (n.file && !n.meta.link) ctx.urls.add(n.url);
  }
  const pages = all.filter((n) => n.file && !n.meta.link);
  const today = localDate(new Date());
  for (const n of all) if (n.meta.cover) n.cover = resolveRef(String(n.meta.cover), n, ctx, 'image');
  for (const list of all.filter((n) => n.meta.list === 'events')) {
    list.events = flatten(list).filter((n) => n !== list && n.file && !n.meta.link && n.meta.date !== undefined);
    for (const e of list.events) {
      if (!isDate(e.meta.date)) ctx.errors.push(`${rel(e.file)}: date must look like 2026-11-20`);
      e.isEvent = true;
      e.meta.hidden = true; // listed on the events page instead of the navbar
    }
  }
  for (const n of all) if (n.meta.photos) n.photos = listPhotos(n.meta.photos, rel(n.file), ctx.errors);
  for (const list of all.filter((n) => n.meta.list === 'gallery')) {
    const byDate = (a, b) => String(b.meta.date || '').localeCompare(String(a.meta.date || '')) || a.title.localeCompare(b.title);
    list.albums = list.children.filter((n) => n.file && !n.meta.link).sort(byDate);
    for (const a of list.albums) {
      a.isAlbum = true;
      a.meta.hidden = true; // shown as album cards on the gallery page instead of the navbar
    }
  }
  for (const n of all.filter((n) => n.meta.link)) n.href = resolveRef(n.href, n, ctx, 'link');

  const template = fs.readFileSync(path.join(SRC, 'layout.html'), 'utf8');
  const shared = {
    lang: site.lang,
    siteName: esc(site.siteName),
    shortName: esc(site.shortName),
    logoMark: inlineLogo('size-10 shrink-0'),
    favicon: esc(site.favicon),
    themeLight: esc(site.themeColor.light),
    themeDark: esc(site.themeColor.dark),
    email: esc(site.email),
    social: socialHtml(),
    related: relatedHtml(),
    year: String(new Date().getFullYear()),
  };
  for (const [name, url] of Object.entries(site.social)) {
    if (url === '#') ctx.warn(`site.config.js: social.${name} is a placeholder ('#'); set the real URL`);
  }

  // Content width: the home page is a full landing page, `layout: wide` suits card-heavy pages.
  const MAIN_WIDTH = { home: 'max-w-6xl', wide: 'max-w-6xl' };
  const ITALIC_PRELOAD = '<link rel="preload" href="/assets/fonts/inter-italic.woff2" as="font" type="font/woff2" crossorigin>';
  const DEFAULT_WIDTH = 'max-w-6xl'; // same column as the header and footer, so every page lines up
  const output = [];
  for (const node of pages) {
    const { html, description, heroTitle } = renderPage(node, ctx);
    const items = crumbs(node, ctx);
    const home = node.meta.layout === 'home';
    const lead = node.meta.lead ?? node.meta.description;
    output.push({
      file: path.join(DIST, ...node.segs, 'index.html'),
      html: fill(template, {
        ...shared,
        head: headHtml(node, description, items, ctx),
        // Fetch the italic font early only on pages that use italics (e.g. gold title words).
        preloadItalic: /<em[\s>]/.test(heroTitle + html) ? ITALIC_PRELOAD : '',
        nav: navHtml(root, node.url),
        hero: home ? '' : pageHeroHtml(heroTitle, lead ? String(lead) : '', breadcrumbHtml(items), MAIN_WIDTH[node.meta.layout] || DEFAULT_WIDTH, node.isEvent ? eventHeroHtml(node, today) : node.isAlbum ? albumHeroHtml(node) : ''),
        layout: home ? 'home' : 'page',
        mainWidth: MAIN_WIDTH[node.meta.layout] || DEFAULT_WIDTH,
        mainPad: home ? 'pt-0 pb-16' : 'py-12 md:py-16', // home: the hero sits right under the header
        // The events calendar goes last, at the bottom of the page.
        content:
          (node.isAlbum ? '' : coverHtml(node)) + html + (node.photos ? galleryGridHtml(node.photos, node.title) : '') +
          albumsHtml(node) + eventsHtml(node, today) + childCardsHtml(node) + (node.events ? calendarHtml(node.events) : ''),
      }),
    });
  }

  if (ctx.errors.length) throw new BuildError(`${ctx.errors.length} problem(s) found:\n  - ${ctx.errors.join('\n  - ')}`);

  const notFound = { url: '/404.html', segs: [], title: 'Page not found', meta: { noindex: true }, is404: true };
  output.push({
    file: path.join(DIST, '404.html'),
    html: fill(template, {
      ...shared,
      head: headHtml(notFound, 'The page you are looking for does not exist.', [], ctx),
      preloadItalic: '',
      nav: navHtml(root, ''),
      hero: pageHeroHtml('Page not found', 'Sorry, that page does not exist or has moved.', '', DEFAULT_WIDTH),
      layout: 'page',
      mainWidth: DEFAULT_WIDTH,
      mainPad: 'py-12 md:py-16',
      content: `<div class="buttons not-prose"><p><a href="/">Go to the home page</a> <a href="mailto:${esc(site.email)}">Tell us about a broken link</a></p></div>`,
    }),
  });

  cleanDist();
  for (const o of output) {
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    fs.writeFileSync(o.file, o.html);
  }
  fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'main.js'), path.join(DIST, 'assets', 'main.js'));
  fs.mkdirSync(path.join(DIST, 'assets', 'fonts'), { recursive: true });
  const fonts = path.join(ROOT, 'node_modules');
  fs.copyFileSync(path.join(fonts, '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'), path.join(DIST, 'assets/fonts/inter.woff2'));
  fs.copyFileSync(path.join(fonts, '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2'), path.join(DIST, 'assets/fonts/inter-italic.woff2'));
  if (fs.existsSync(CONTENTS)) fs.cpSync(CONTENTS, path.join(DIST, 'contents'), { recursive: true });

  const indexable = pages.filter((n) => !n.meta.noindex);
  fs.writeFileSync(
    path.join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexable
      .map((n) => `  <url><loc>${esc(site.baseURL + n.url)}</loc><lastmod>${lastmod(n)}</lastmod></url>`)
      .join('\n')}\n</urlset>\n`,
  );
  const allEvents = all.filter((n) => n.isEvent).sort((a, b) => String(a.meta.date).localeCompare(String(b.meta.date)));
  if (allEvents.length || all.some((n) => n.meta.list === 'events')) {
    fs.writeFileSync(path.join(DIST, 'events.ics'), icsCalendar(allEvents, new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')));
  }
  fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site.baseURL}/sitemap.xml\n`);

  warnings.forEach((w) => log(`warning: ${w}`));
  log(`built ${pages.length} pages in ${Date.now() - started} ms`);
  return { pages: pages.length, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    build();
  } catch (err) {
    console.error(err instanceof BuildError ? `build failed: ${err.message}` : err);
    process.exit(1);
  }
}
