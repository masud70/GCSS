// Dev server: rebuilds on changes in app/, contents/ and src/, runs Tailwind in watch mode, serves dist/.
// Usage: node scripts/dev.js   (PORT=4000 to change the port)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
};

// Each rebuild runs in a fresh process, so edits to scripts/ (build.js, site.config.js) apply too.
// Draft pages (`draft: true`) are included here, never in `npm run build`.
function rebuild() {
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, GCSS_DRAFTS: '1' } });
}

rebuild();

const tailwind = spawn(path.join(ROOT, 'node_modules', '.bin', 'tailwindcss'), ['-i', 'src/styles.css', '-o', 'dist/assets/site.css', '--watch=always'], {
  cwd: ROOT,
  stdio: 'inherit',
});
process.on('exit', () => tailwind.kill());
process.on('SIGINT', () => process.exit());

let timer;
for (const dir of ['app', 'contents', 'src', 'scripts']) {
  fs.watch(path.join(ROOT, dir), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 100);
  });
}

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = path.join(DIST, urlPath);
    if (!file.startsWith(DIST)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!urlPath.endsWith('/')) return res.writeHead(301, { Location: `${urlPath}/` }).end();
      file = path.join(file, 'index.html');
    }
    const found = fs.existsSync(file);
    const target = found ? file : path.join(DIST, '404.html');
    // Fonts never change, so let the browser keep them (no re-download and font swap on every reload).
    const cache = urlPath.startsWith('/assets/fonts/') ? 'public, max-age=31536000, immutable' : 'no-store';
    res.writeHead(found ? 200 : 404, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(target).pipe(res);
  })
  .listen(PORT, () => console.log(`serving http://localhost:${PORT}`));
