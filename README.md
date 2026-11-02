# GCSS website

Website of the Graduate Computer Science Society (GCSS), University of Manitoba: [umgcss.org](https://umgcss.org).

Every page is a Markdown file in `app/`; the folder structure becomes the navbar automatically. Media lives in `contents/`. A small Node script builds plain, fast static HTML (with Tailwind CSS) into `dist/`.

```sh
npm install     # once
npm run dev     # live preview at http://localhost:3000 (includes drafts)
npm run build   # production site in dist/
```

Requires Node.js 20 or newer. To deploy, use `npm run build` as the build command and publish `dist/`.

**Maintaining the site** (adding pages, events, executives, resources, and every formatting option, with examples): see [MAINTAINING.md](MAINTAINING.md).
