import { defineConfig, type Plugin } from 'vite';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

// Serves the git-ignored ./data directory (tiles downloaded by scripts/download.mjs) at
// /data in dev and preview, ahead of public/data: local data always wins, and whatever is
// not on this machine falls through to public/data / the official streaming endpoints.
// Tiles are never bundled into the build (CLAUDE.md §4).
const MIME: Record<string, string> = {
  '.json': 'application/json', '.b3dm': 'application/octet-stream', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.bin': 'application/octet-stream',
};
function serveData(): Plugin {
  const root = process.env.TOKYODRIVE_DATA_DIR ?? join(process.cwd(), "data");
  const handler = (req: any, res: any, next: any) => {
    const url = decodeURIComponent((req.url as string).split('?')[0]);
    if (!url.startsWith('/data/')) return next();
    const file = normalize(join(root, url.slice(6)));
    if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error('not a file');
      res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
      res.setHeader('Content-Length', st.size);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      createReadStream(file).pipe(res);
    } catch { next(); } // not in the local data dir: fall through to public/data
  };
  return {
    name: 'serve-data',
    configureServer(s) { s.middlewares.use(handler); },
    configurePreviewServer(s) { s.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [serveData()],
  server: { port: 5173, strictPort: false, watch: { ignored: ['**/data/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  test: { include: ['src/**/*.test.ts'] },
} as any);
