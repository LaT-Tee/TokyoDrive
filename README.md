# Tokyo Drive

在真实的东京与横滨里自由驾驶和飞行的浏览器游戏。城市来自日本国土交通省的
PLATEAU 3D 城市模型，用 Three.js 直接渲染，没有游戏引擎，没有账号，没有任何 API key。

- 汽车：一辆写实概念超跑和六辆低模车，真实级别的极速，合成的引擎声
- 飞机和直升机：选中即部署在离地 300 米的空中
- 城市：建筑、桥梁、航拍地面、实测路缘铺成的矢量路面、程序生成的高架和隧道
- 飞行时远处用 LOD1 白模补到地平线，加载边界抖动淡出
- 可选：用你自己的 Cesium ion 令牌，把 PLATEAU 没有模型的地方用 Google 扫描模型补上
- 地图传送、车内视角、鼠标环顾、太阳阴影、三档画质

## 运行

需要 Node.js 20 以上。

```bash
npm ci
```

```bash
npm run dev
```

打开终端里显示的地址即可。首次进入一个地区时建筑需要十几秒加载完。

其它命令：

```bash
npm run build
```

```bash
npm test
```

## 操作

| | 汽车 | 飞机 | 直升机 |
|---|---|---|---|
| `W` / `S` | 油门 / 刹车、倒车 | 压杆 / 拉杆 | 前进 / 后退 |
| `A` / `D` | 转向 | 滚转 | 转向 |
| `Q` / `E` | — | 方向舵 | 横移 |
| `空格` | 手刹 | 加油门 | 上升 |
| `Shift` | — | 减油门 | 下降 |

通用：`C` 切换视角，鼠标拖动环顾，滚轮远近，`L` 车灯，`R` 复位，`M` 地图传送，
`N` 静音，`G` 回到车库。

## 数据从哪里来

编译产物只有约 10 MB 的程序加 64 MB 的道路数据。其余都是玩的时候由浏览器按需拉取的：

| 数据 | 来源 | 位置 |
|---|---|---|
| 建筑、桥梁、植被、街道设施（3D Tiles） | Project PLATEAU | 运行时从官方端点流式加载 |
| 写实 3D 瓦片（可选） | Google，经 Cesium ion | 仅在填入令牌后运行时加载 |
| 高程、航拍照片、路缘、地图底图 | 国土地理院 | 运行时从地理院瓦片服务器加载 |
| 道路中心线、路名、桥隧标签 | OpenStreetMap | 已烘焙，在 `public/data/osm` |
| 大地水准面高 | 国土地理院 | 已烘焙，在 `public/geoid.json` |

两点需要知道：

- PLATEAU 的官方流式端点是实验性质，不保证可用。它不可用时游戏只剩地面和道路。
  想要稳定，就用 `scripts/download.mjs` 把瓦片下载下来自己托管（全部约 8.2 GB，
  其中约 2.4 GB 是飞行远景用的 LOD1 白模），再用环境变量
  `VITE_DATA_BASE_URL` 指向托管地址。
- 航拍和路缘直接取自国土地理院的服务器，请不要对它发起大量请求。

覆盖范围：东京 23 区、多摩地区立川以东、川崎市、横滨市。

### 重新生成数据

```bash
node scripts/catalog.mjs
```

```bash
node scripts/osm.mjs
```

```bash
node scripts/publish-data.mjs
```

依次是：从 PLATEAU 数据目录枚举覆盖范围、通过 Overpass 烘焙道路数据、
把道路数据复制到 `public/data`。

## Google 3D 补全（可选，默认关闭）

在车库页的「Google 3D 补全」里填入 Cesium ion 访问令牌（或 Google Maps API key），
PLATEAU 没有模型的地方（寺庙、公园里的建筑、缺失的房屋、树）会用 Google 写实
3D 瓦片补上。PLATEAU 始终优先：地面、已有 PLATEAU 模型的位置和高架道路上的
Google 网格都会被丢弃。这一层不参与碰撞。

- 令牌只保存在你自己的浏览器里，不进仓库；也可以在构建时用环境变量
  `VITE_CESIUM_ION_TOKEN` 或 `VITE_GOOGLE_MAPS_KEY` 提供。注意：构建进站点的
  令牌任何访问者都能看到，公开部署时请在 Cesium ion 里限制令牌的允许域名。
- **使用条款**：Google 的 Map Tiles API 条款对署名、缓存、以及与非 Google 地图
  混用都有限制，本项目把它与 PLATEAU、国土地理院数据叠加显示。公开发布或商用前
  请自行确认是否符合 Cesium ion 和 Google 的现行条款。游戏会在屏幕底部显示
  瓦片自带的署名，但没有附带 Google 的 Logo 图片。

## 部署

`npm run build` 生成的 `dist/` 是纯静态文件，放到任何静态托管上都能运行。
其中 `dist/data` 有 800 多个文件，托管服务需要允许这个数量。

## 许可

**源码**：MIT，见 [LICENSE](LICENSE)。

**随仓库分发的素材和数据各有自己的许可，不在 MIT 之内：**

| 内容 | 许可 | 出处 |
|---|---|---|
| `public/cars/concept/` 概念超跑模型 | CC-BY 4.0 | Khronos glTF Sample Assets “Car Concept”，源自 Unity Fan 的公有领域模型。见该目录下的 `LICENSE.md` |
| `public/cars/*.glb` 低模车 | CC0 | Kenney “Car Kit”，www.kenney.nl |
| `public/data/osm/` 道路数据 | ODbL 1.0 | © OpenStreetMap contributors |
| `public/geoid.json` | 国土地理院内容利用规约 | 国土地理院 ジオイド・モデル |
| `public/draco/`、`public/basis/` | Apache-2.0 | Google Draco、Binomial Basis Universal（随 three.js 分发） |

**运行时加载、不随仓库分发的数据：**

- 3D 城市模型：国土交通省 Project PLATEAU
- 高程、航空写真、基盘地图信息、地图瓦片：国土地理院
- 发布或演示本项目时请保留这些出处；各数据的具体使用条款以其官方页面为准。

主要依赖：three.js（MIT）、3d-tiles-renderer（Apache-2.0）、three-mesh-bvh（MIT）、
three-geospatial（MIT）、postprocessing（Zlib）。

## 开发说明

- `scripts/headless-check.mjs` 用无头 Chrome 做验收：`phase1`、`roads`、`spawns`、`tour`、`jitter`。
- `scripts/sound-check.mjs` 离线渲染并测量引擎声。
- `scripts/local.sh` 只在源码放在网络盘上时需要：它把源码同步到本机目录再运行命令。
