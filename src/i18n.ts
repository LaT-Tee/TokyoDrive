// Interface language: Chinese, Japanese, English. The default follows the browser's
// preferred languages; a choice made in the garage is remembered in localStorage.
export type Lang = 'zh' | 'ja' | 'en';
export const LANGS: { id: Lang; label: string }[] = [{ id: 'zh', label: '中文' }, { id: 'ja', label: '日本語' }, { id: 'en', label: 'English' }];

type Entry = Record<Lang, string>;
const D: Record<string, Entry> = {
  'app.sub': { zh: '东京・川崎・横滨 自由驾驶', ja: '東京・川崎・横浜 フリードライブ', en: 'Free driving in Tokyo, Kawasaki and Yokohama' },
  'garage.lang': { zh: '语言', ja: '言語', en: 'Language' },
  'garage.vehicle': { zh: '载具', ja: '乗り物', en: 'Vehicle' },
  'garage.color': { zh: '车身颜色', ja: 'ボディカラー', en: 'Body color' },
  'garage.customColor': { zh: '自定义颜色', ja: 'カスタムカラー', en: 'Custom color' },
  'garage.spawn': { zh: '出发地点', ja: 'スタート地点', en: 'Starting point' },
  'garage.quality': { zh: '画质（切换后建筑会重新加载）', ja: '画質（切り替えると建物を再読み込みします）', en: 'Quality (buildings reload when changed)' },
  'quality.performance': { zh: '流畅', ja: '軽量', en: 'Performance' },
  'quality.performance.sub': { zh: '低负载，无阴影', ja: '低負荷・影なし', en: 'Light, no shadows' },
  'quality.balanced': { zh: '均衡', ja: '標準', en: 'Balanced' },
  'quality.balanced.sub': { zh: '默认', ja: 'デフォルト', en: 'Default' },
  'quality.ultra': { zh: '极致', ja: '最高', en: 'Ultra' },
  'quality.ultra.sub': { zh: '更远、更细，负载高', ja: '遠く・細かく・高負荷', en: 'Farther, finer, heavier' },
  'google.title': { zh: 'Google 贴图（可选）', ja: 'Google テクスチャ（任意）', en: 'Google textures (optional)' },
  'google.placeholder': { zh: 'Cesium ion 令牌 或 Google Maps API key', ja: 'Cesium ion トークン または Google Maps API キー', en: 'Cesium ion token or Google Maps API key' },
  'google.apply': { zh: '应用', ja: '適用', en: 'Apply' },
  'google.hint': {
    zh: 'PLATEAU 中没有贴图的建筑，改用 Google 扫描数据里同一面墙的真实颜色。留空即关闭。令牌只保存在本浏览器。',
    ja: 'PLATEAU でテクスチャのない建物に、Google の3Dスキャンから同じ壁の実際の色を貼ります。空欄でオフ。トークンはこのブラウザにのみ保存されます。',
    en: "Buildings without a PLATEAU texture take the real colours of the same walls from Google's 3D scans. Leave empty to turn off. The token is stored only in this browser.",
  },
  'google.off': { zh: '未启用', ja: 'オフ', en: 'Off' },
  'google.loading': { zh: '连接中…', ja: '接続中…', en: 'Connecting…' },
  'google.on': { zh: '已启用', ja: '有効', en: 'On' },
  'google.error': { zh: '失败：{msg}', ja: '失敗：{msg}', en: 'Failed: {msg}' },
  'keys': {
    zh: '<b>汽车</b>　W/S 油门・刹车　A/D 转向　空格 手刹<br><b>飞机</b>　W/S 压杆・拉杆　A/D 滚转　Q/E 方向舵　空格/Shift 加减油门<br><b>直升机</b>　W/S 前后　A/D 转向　Q/E 横移　空格/Shift 升降<br><b>C</b> 视角　<b>鼠标</b> 环顾・滚轮远近　<b>L</b> 灯　<b>R</b> 复位　<b>M</b> 地图　<b>N</b> 静音　<b>G</b> 车库',
    ja: '<b>車</b>　W/S アクセル・ブレーキ　A/D ハンドル　スペース サイドブレーキ<br><b>飛行機</b>　W/S 機首下げ・上げ　A/D ロール　Q/E ラダー　スペース/Shift スロットル増減<br><b>ヘリ</b>　W/S 前進・後退　A/D 旋回　Q/E 横移動　スペース/Shift 上昇・下降<br><b>C</b> 視点　<b>マウス</b> 見回す・ホイールで距離　<b>L</b> ライト　<b>R</b> リセット　<b>M</b> 地図　<b>N</b> ミュート　<b>G</b> ガレージ',
    en: '<b>Car</b>　W/S throttle / brake　A/D steer　Space handbrake<br><b>Plane</b>　W/S nose down / up　A/D roll　Q/E rudder　Space/Shift throttle up / down<br><b>Helicopter</b>　W/S forward / back　A/D turn　Q/E sideways　Space/Shift climb / descend<br><b>C</b> camera　<b>Mouse</b> look around, wheel to zoom　<b>L</b> lights　<b>R</b> reset　<b>M</b> map　<b>N</b> mute　<b>G</b> garage',
  },
  'start': { zh: '出发', ja: '出発', en: 'Drive' },
  'start.loading': { zh: '加载中…', ja: '読み込み中…', en: 'Loading…' },
  'credit': {
    zh: '3D 城市模型: Project PLATEAU（国土交通省）/ 高程・航拍・地图: 国土地理院 / 道路: © OpenStreetMap contributors / 超跑模型: Khronos Car Concept (CC-BY 4.0)',
    ja: '3D都市モデル: Project PLATEAU（国土交通省）/ 標高・航空写真・地図: 国土地理院 / 道路: © OpenStreetMap contributors / スーパーカー: Khronos Car Concept (CC-BY 4.0)',
    en: '3D city models: Project PLATEAU (MLIT) / Elevation, aerial photos, maps: GSI Japan / Roads: © OpenStreetMap contributors / Supercar: Khronos Car Concept (CC-BY 4.0)',
  },
  'hud.garage': { zh: '车库 G', ja: 'ガレージ G', en: 'Garage G' },
  'hud.map': { zh: '地图 M', ja: '地図 M', en: 'Map M' },
  'hud.recover': { zh: '回到道路 R', ja: '道路に戻る R', en: 'Back to road R' },
  'hud.camera': { zh: '视角 C：{cam}', ja: '視点 C：{cam}', en: 'Camera C: {cam}' },
  'hud.lights': { zh: '车灯 L：{state}', ja: 'ライト L：{state}', en: 'Lights L: {state}' },
  'hud.on': { zh: '开', ja: 'オン', en: 'on' },
  'hud.off': { zh: '关', ja: 'オフ', en: 'off' },
  'cam.chase': { zh: '追尾', ja: '追従', en: 'Chase' },
  'cam.far': { zh: '远追尾', ja: '遠追従', en: 'Far chase' },
  'cam.cockpit': { zh: '车内', ja: '車内', en: 'Cockpit' },
  'cam.hood': { zh: '引擎盖', ja: 'ボンネット', en: 'Hood' },
  'cam.top': { zh: '俯视', ja: '真上', en: 'Top' },
  'hud.agl': { zh: '离地 {m} m', ja: '対地 {m} m', en: '{m} m above ground' },
  'hud.throttle': { zh: '油门 {p}%', ja: 'スロットル {p}%', en: 'throttle {p}%' },
  'hud.crashed': { zh: '坠毁，重新部署中', ja: '墜落、再配置中', en: 'crashed, redeploying' },
  'hud.tunnel': { zh: '隧道', ja: 'トンネル', en: 'tunnel' },
  'hud.roadTunnel': { zh: '{road}（隧道）', ja: '{road}（トンネル）', en: '{road} (tunnel)' },
  'hud.gear': { zh: '{g} 挡 {rpm} rpm', ja: '{g} 速 {rpm} rpm', en: 'gear {g} · {rpm} rpm' },
  'hud.stuckHint': { zh: '卡住了？{s} 秒后自动脱困（或按 R）', ja: '動けない？{s} 秒後に自動で脱出（R でも可）', en: 'Stuck? Freeing the car in {s} s (or press R)' },
  'hud.unstuckAhead': { zh: '已自动脱困：向前 {m} m', ja: '自動で脱出しました：{m} m 前方へ', en: 'Car freed: moved {m} m ahead' },
  'hud.unstuck': { zh: '已自动脱困：退回 {m} m', ja: '自動で脱出しました：{m} m 戻りました', en: 'Car freed: moved back {m} m' },
  'hud.unstuckRoad': { zh: '已自动脱困：回到最近的道路', ja: '自動で脱出しました：最寄りの道路へ', en: 'Car freed: back to the nearest road' },
  'hud.loading': { zh: '加载中 {n}', ja: '読み込み中 {n}', en: 'Loading {n}' },
  'map.title': { zh: '地图 — 点击亮色区域传送（滚轮缩放，拖动平移）', ja: '地図 — 明るいエリアをクリックでワープ（ホイールで拡大縮小、ドラッグで移動）', en: 'Map — click a bright area to teleport (wheel to zoom, drag to pan)' },
  'map.close': { zh: '关闭 M', ja: '閉じる M', en: 'Close M' },
  'map.outside': { zh: '这里不在已准备的数据范围内', ja: 'ここはデータの範囲外です', en: 'Outside the prepared data area' },
  'veh.concept': { zh: '概念超跑', ja: 'コンセプトスーパーカー', en: 'Concept supercar' },
  'veh.concept.note': { zh: 'V8 · 330 km/h · 写实模型', ja: 'V8 · 330 km/h · リアルモデル', en: 'V8 · 330 km/h · detailed model' },
  'veh.plane': { zh: '私人飞机', ja: 'ビジネスジェット', en: 'Business jet' },
  'veh.plane.note': { zh: '双涡扇 · 巡航 430 · 最高 830 km/h', ja: '双発ターボファン · 巡航 430 · 最高 830 km/h', en: 'Twin turbofan · cruise 430 · max 830 km/h' },
  'veh.heli': { zh: '直升机', ja: 'ヘリコプター', en: 'Helicopter' },
  'veh.heli.note': { zh: '单发 · 可悬停 · 最高 240 km/h', ja: '単発 · ホバリング可 · 最高 240 km/h', en: 'Single engine · can hover · max 240 km/h' },
  'spawn.shinjuku': { zh: '新宿站 西口', ja: '新宿駅 西口', en: 'Shinjuku Sta. West Exit' },
  'spawn.tokyo': { zh: '东京站 丸之内', ja: '東京駅 丸の内', en: 'Tokyo Sta. Marunouchi' },
  'spawn.fuchu': { zh: '府中站', ja: '府中駅', en: 'Fuchū Station' },
  'spawn.tachikawa': { zh: '立川站', ja: '立川駅', en: 'Tachikawa Station' },
  'spawn.minatomirai': { zh: '横滨 港未来', ja: '横浜 みなとみらい', en: 'Yokohama Minato Mirai' },
  'spawn.rainbow': { zh: '彩虹桥', ja: 'レインボーブリッジ', en: 'Rainbow Bridge' },
};

// Municipality names in English (PLATEAU only gives them in Japanese). Keyed by city code.
const CITY_EN: Record<string, string> = {
  13101: 'Chiyoda', 13102: 'Chūō', 13103: 'Minato', 13104: 'Shinjuku', 13105: 'Bunkyō', 13106: 'Taitō', 13107: 'Sumida',
  13108: 'Kōtō', 13109: 'Shinagawa', 13110: 'Meguro', 13111: 'Ōta', 13112: 'Setagaya', 13113: 'Shibuya', 13114: 'Nakano',
  13115: 'Suginami', 13116: 'Toshima', 13117: 'Kita', 13118: 'Arakawa', 13119: 'Itabashi', 13120: 'Nerima', 13121: 'Adachi',
  13122: 'Katsushika', 13123: 'Edogawa',
  13202: 'Tachikawa', 13203: 'Musashino', 13204: 'Mitaka', 13206: 'Fuchū', 13208: 'Chōfu', 13209: 'Machida', 13210: 'Koganei',
  13211: 'Kodaira', 13212: 'Hino', 13213: 'Higashimurayama', 13214: 'Kokubunji', 13215: 'Kunitachi', 13219: 'Komae',
  13220: 'Higashiyamato', 13221: 'Kiyose', 13222: 'Higashikurume', 13223: 'Musashimurayama', 13224: 'Tama', 13225: 'Inagi',
  13229: 'Nishitōkyō',
  14100: 'Yokohama', 14101: 'Tsurumi, Yokohama', 14102: 'Kanagawa, Yokohama', 14103: 'Nishi, Yokohama', 14104: 'Naka, Yokohama',
  14105: 'Minami, Yokohama', 14106: 'Hodogaya, Yokohama', 14107: 'Isogo, Yokohama', 14108: 'Kanazawa, Yokohama',
  14109: 'Kōhoku, Yokohama', 14110: 'Totsuka, Yokohama', 14111: 'Kōnan, Yokohama', 14112: 'Asahi, Yokohama',
  14113: 'Midori, Yokohama', 14114: 'Seya, Yokohama', 14115: 'Sakae, Yokohama', 14116: 'Izumi, Yokohama',
  14117: 'Aoba, Yokohama', 14118: 'Tsuzuki, Yokohama',
  14130: 'Kawasaki', 14131: 'Kawasaki Ward, Kawasaki', 14132: 'Saiwai, Kawasaki', 14133: 'Nakahara, Kawasaki',
  14134: 'Takatsu, Kawasaki', 14135: 'Tama, Kawasaki', 14136: 'Miyamae, Kawasaki', 14137: 'Asao, Kawasaki',
};

function detect(): Lang {
  try { const saved = localStorage.getItem('td.lang'); if (saved === 'zh' || saved === 'ja' || saved === 'en') return saved; } catch { /* private window */ }
  for (const l of navigator.languages ?? [navigator.language]) {
    const s = (l ?? '').toLowerCase();
    if (s.startsWith('zh')) return 'zh';
    if (s.startsWith('ja')) return 'ja';
    if (s.startsWith('en')) return 'en';
  }
  return 'en';
}

export let lang: Lang = detect();
const listeners: (() => void)[] = [];
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;

/** Translate a key; {name} placeholders are filled from vars. Unknown keys return the key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = D[key]?.[lang] ?? D[key]?.en ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

/** Municipality label: English romanisation in English, the official name otherwise. */
export function cityName(code: string, native: string): string {
  return lang === 'en' ? CITY_EN[code] ?? native : native;
}

export function setLang(l: Lang): void {
  if (l === lang) return;
  lang = l;
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : l;
  try { localStorage.setItem('td.lang', l); } catch { /* private window */ }
  for (const f of listeners) f();
}

export function onLangChange(f: () => void): void { listeners.push(f); }
