// Shared helpers for the data pipeline scripts.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// When run from the local build mirror, TOKYODRIVE_DATA_DIR points back at the project.
export const dataDir = process.env.TOKYODRIVE_DATA_DIR ?? join(here, '..', 'data');
const manifestFile = join(dataDir, 'manifest.json');

/** data/manifest.json, seeded from the catalog enumeration (public/manifest.remote.json). */
export function loadManifest() {
  if (existsSync(manifestFile)) return JSON.parse(readFileSync(manifestFile, 'utf8'));
  const seed = join(here, '..', 'public', 'manifest.remote.json');
  if (!existsSync(seed)) throw new Error('Run `node scripts/catalog.mjs` first (public/manifest.remote.json missing)');
  return JSON.parse(readFileSync(seed, 'utf8'));
}

export function saveManifest(m) {
  mkdirSync(dataDir, { recursive: true });
  m.generated = new Date().toISOString();
  writeFileSync(manifestFile + '.tmp', JSON.stringify(m, null, 1));
  renameSync(manifestFile + '.tmp', manifestFile);
}
