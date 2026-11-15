// Minimal static HTTP server for the self-hosted data directory (CORS on).
// Run it on whichever machine holds data/ and point the game at it:
//
//   node scripts/serve-data.mjs [dir] [port]        (default: ./data, 8787)
//   VITE_DATA_BASE_URL=http://<host>:8787 npm run dev
//
// No dependencies; any other static server (nginx, caddy, `python3 -m http.server`
// behind a CORS proxy) works just as well.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'data');
const port = Number(process.argv[3] ?? 8787);
const MIME = { '.json': 'application/json', '.b3dm': 'application/octet-stream', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.img': 'image/*', '.webp': 'image/webp' };

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  const file = normalize(join(root, decodeURIComponent((req.url ?? '/').split('?')[0])));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log(`serving ${root} at http://0.0.0.0:${port}`));
