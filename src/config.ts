// Central configuration. See CLAUDE.md §3, §6.
export const ORIGIN = { lat: 35.6896, lon: 139.7006 }; // Shinjuku Station

export interface SpawnPoint { id: string; name: string; lat: number; lon: number; heading: number }
// heading: degrees clockwise from north.
export const SPAWNS: SpawnPoint[] = [
  { id: 'shinjuku', name: '新宿駅 西口', lat: 35.6896, lon: 139.7006, heading: 0 },
  { id: 'tokyo', name: '東京駅 丸の内', lat: 35.6812, lon: 139.7671, heading: 0 },
  { id: 'fuchu', name: '府中駅', lat: 35.6689, lon: 139.4777, heading: 90 },
  { id: 'tachikawa', name: '立川駅', lat: 35.6977, lon: 139.4137, heading: 0 },
  { id: 'minatomirai', name: '横浜 みなとみらい', lat: 35.4549, lon: 139.6319, heading: 0 },
  { id: 'rainbow', name: 'レインボーブリッジ', lat: 35.6367, lon: 139.7636, heading: 135 },
];

// Data (manifest, OSM bake, downloaded tiles) is read from /data: the dev / preview server
// serves the local ./data directory there first (tiles fetched by scripts/download.mjs),
// then public/data. Layers that are not on this machine stream from the official endpoints.
export const DATA_BASE = '/data';

export type Quality = 'performance' | 'balanced' | 'ultra';
export interface QualityPreset {
  // 3D Tiles screen-space error (px). PLATEAU tiles carry large geometric errors, so this
  // decides how close you must be before the most detailed (leaf) tiles replace coarse ones.
  errorTarget: number;
  loadDistance: number;   // buildings are only loaded / shown within this distance of the camera (m)
  terrainRadius: number;  // detailed ground chunks (≈1 km each) around the car
  pixelRatio: number;     // upper bound; dynamic resolution may go below it to hold the frame rate
  textureNear: number;    // max building texture edge for detailed (near) tiles (px)
  textureFar: number;     // max building texture edge for coarse (distant) tiles (px)
  aerial: boolean;        // atmospheric haze post effect
  shadowSize: number;     // sun shadow map resolution (0 = off)
  shadowRange: number;    // half-width of the shadowed area around the car (m)
  cacheGB: number;        // tile cache byte cap
}
export const QUALITY: Record<Quality, QualityPreset> = {
  performance: { errorTarget: 16, loadDistance: 600, terrainRadius: 1, pixelRatio: 0.75, textureNear: 512, textureFar: 256, aerial: false, shadowSize: 0, shadowRange: 0, cacheGB: 0.8 },
  balanced: { errorTarget: 8, loadDistance: 1000, terrainRadius: 2, pixelRatio: 1, textureNear: 1024, textureFar: 256, aerial: true, shadowSize: 2048, shadowRange: 220, cacheGB: 1.6 },
  ultra: { errorTarget: 6, loadDistance: 1800, terrainRadius: 3, pixelRatio: 1.5, textureNear: 2048, textureFar: 512, aerial: true, shadowSize: 4096, shadowRange: 300, cacheGB: 2.6 },
};

export const CAMERA_NEAR = 0.5;
export const CAMERA_FAR = 20000;

// Wall probe (CLAUDE.md §3)
export const WALL_PROBE_DIST = 2.0;
export const WALL_STEP = 1.2;
export const WALL_SLOPE = Math.tan((29 * Math.PI) / 180);
