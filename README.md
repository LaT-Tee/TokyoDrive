# Tokyo Drive

在真实的东京与横滨里自由驾驶和飞行的浏览器游戏。城市来自日本国土交通省的
PLATEAU 3D 城市模型，用 Three.js 直接渲染，没有游戏引擎，没有账号，没有任何 API key。

- 汽车：一辆写实概念超跑，真实级别的极速，合成的引擎声
- 私人飞机（双涡扇公务机）和直升机：在代码里按真实机型比例建模，选中即部署在离地 300 米的空中；直升机旋翼用慢快门式的模糊转盘
- 城市：建筑、桥梁、航拍地面、实测路缘铺成的矢量路面、程序生成的高架和隧道
- 飞行时远处用 LOD1 白模补到地平线，加载边界抖动淡出
- 可选：用你自己的 Cesium ion 令牌，给没有贴图的 PLATEAU 建筑取用 Google 扫描数据的真实颜色
- 地图传送、车内视角、鼠标环顾、太阳阴影、三档画质
- 界面支持中文、日本語、English：默认跟随浏览器语言，车库页可随时切换（会记住选择）

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
| 写实 3D 瓦片（可选，只取颜色） | Google，经 Cesium ion | 仅在填入令牌后运行时加载 |
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

**平时不需要运行这些脚本**：道路数据已经烘焙好提交在 `public/data` 里，游戏直接读取。
只有扩大覆盖范围时才需要重跑。`osm.mjs` 会向公共 Overpass 服务器发几十个大查询，
很慢，而且可能因超出用量被临时封禁；中途失败时不要接着运行 `publish-data.mjs`，
否则会用不完整的数据覆盖 `public/data`。

## Google 贴图（可选，默认关闭）

PLATEAU 有不少建筑没有立面贴图，游戏会给它们画程序生成的窗格立面。在车库页的
「Google 3D 补全」里填入 Cesium ion 访问令牌（或 Google Maps API key）后，这些
建筑会改用 Google 写实 3D 瓦片里同一面墙、同一块屋顶的真实颜色。

- Google 的网格本身从不出现在画面里。车周围约 260 米内每栋没有贴图的楼，会按
  朝向逐面"拍照"：一台正对墙面的正交相机只拍墙前 3 米到墙后 6 米这一层里的扫描
  模型，结果存进这栋楼的贴图。扫描模型凹凸、整体偏几米也能拍到；墙前的树、
  对面的楼被切掉。贴图固定在墙上，不随视角变化。每面墙拍一次，更精细的扫描瓦片
  到达后再补拍，每帧最多占用约 3 毫秒。
- 令牌只保存在你自己的浏览器里，不进仓库；也可以在构建时用环境变量
  `VITE_CESIUM_ION_TOKEN` 或 `VITE_GOOGLE_MAPS_KEY` 提供。构建进站点的令牌任何
  访问者都能看到，公开部署时请在 Cesium ion 里限制令牌的允许域名。
- **使用条款**：Google 的 Map Tiles API 条款对署名、缓存、修改内容以及与非 Google
  地图混用都有限制。公开发布或商用前请自行确认是否符合 Cesium ion 和 Google 的
  现行条款。游戏会在屏幕底部显示瓦片自带的署名，但没有附带 Google 的 Logo 图片。

## 部署

`npm run build` 生成的 `dist/` 是纯静态文件，放到任何静态托管上都能运行。
其中 `dist/data` 有 800 多个文件，托管服务需要允许这个数量。

## 许可

**源码**：MIT，见 [LICENSE](LICENSE)。

**随仓库分发的素材和数据各有自己的许可，不在 MIT 之内：**

| 内容 | 许可 | 出处 |
|---|---|---|
| `public/cars/concept/` 概念超跑模型 | CC-BY 4.0 | Khronos glTF Sample Assets “Car Concept”，源自 Unity Fan 的公有领域模型。见该目录下的 `LICENSE.md` |
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
