# 3D Layered Thematic Map

東京23区の主題データを、テーマごとの平面レイヤーとして縦に積んで見せるインタラクティブな地図の試作です。
静止画でよく見る「傾けて積んだ地図」を、同じ地点をレイヤー間で対応づけて読める道具にすることが目的です。

## 画面の構成

- 平行投影の3Dビューに、5枚のレイヤーを下から順に積みます。
  1. 標高（`elevation`）
  2. 人口（`population`）
  3. 道路（`roads`）
  4. 公共交通（`transit`）
  5. 施設（`facilities`）
- 主な操作
  - レイヤー間隔のスライダー（間隔0で重ね合わせ、広げると分解）
  - 探針：カーソル位置を全レイヤーに貫く垂直線と、その地点の各レイヤーの値の一覧
  - レイヤーの並べ替え・表示切替・単独表示（真上からの2D表示）
  - 視点の回転

## 技術構成

- Vite + React + TypeScript + deck.gl 9、状態管理は zustand
- 3Dビューは deck.gl の `OrbitView`（`orthographic: true`）
- 地理データは前処理でローカルのメートル座標に変換し、画面側は `COORDINATE_SYSTEM.CARTESIAN` で描画します
- 前処理は `scripts/` 配下の Node.js（ESM）スクリプトで行い、生成物を `public/data/` に置きます
- ダウンロードした元データは `.cache/` に置き、Git には含めません

## 座標系（全データ共通）

横メルカトル図法のローカル座標で、単位はメートルです。

```
+proj=tmerc +lat_0=35.68 +lon_0=139.75 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs
```

- `x` は東向き、`y` は北向き。原点は東経139.75度・北緯35.68度
- 描画範囲（`EXTENT`）は 36km 四方の正方形：`minX=-19000, minY=-19000, maxX=17000, maxY=17000`
- ベクタデータの座標は 1m 単位に丸めます
- レイヤーの高さ（z）は画面側で与えるため、データには含めません

## データ仕様（`public/data/`）

ベクタデータは GeoJSON の FeatureCollection 形式で、`coordinates` に上記ローカル座標を入れます。

| ファイル | geometry | properties |
| --- | --- | --- |
| `boundary.geojson` | Polygon / MultiPolygon（区ごとに1 Feature） | `code`（市区町村コード5桁）, `name`（区名） |
| `population.geojson` | Polygon（メッシュ1個ごと。4隅をたどって始点に戻る5点の閉じたリング） | `meshCode`, `population`（人）, `density`（人/km²） |
| `roads.geojson` | LineString | `class`（`motorway` / `national` / `prefectural` / `other`）, `name`（なければ null） |
| `rail.geojson` | LineString | `operator`（事業者名）, `line`（路線名） |
| `stations.geojson` | Point | `name`（駅名）, `operator`, `line` |
| `facilities.geojson` | Point | `kind`（`school` / `hospital`）, `name`, `subtype`（学校種別・病院/診療所の別など） |

標高は格子データです。

- `elevation.bin`：Float32（リトルエンディアン）の格子。行は北から南、列は西から東の順。データなしは NaN
- `elevation.json`：`{ width, height, cellSize, minX, minY, maxX, maxY, min, max }`
  - 範囲は `EXTENT` と同じ、`cellSize` は 50（m）、したがって `width = height = 720`
  - `min` / `max` は23区内の有効値の最小・最大（m）
  - 各セルの値は、セルの中心での標高です。列 `col`・行 `row`（どちらも0始まり）のセルの中心は `x = minX + (col + 0.5) × cellSize`、`y = maxY − (row + 0.5) × cellSize`
  - 地点 `(x, y)` を含むセルは `col = floor((x − minX) / cellSize)`、`row = floor((maxY − y) / cellSize)`
  - 23区の外と水面はデータなし（NaN）にします

各データは23区の範囲に絞ります（区の境界で切り抜くか、区に交差するものだけを残します）。

## 出典

各データの出典と利用条件は、データを追加するときにこの節へ追記します。
