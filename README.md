# 3D Layered Thematic Map

東京23区の主題データ（標高・人口・道路・公共交通・施設）を、テーマごとの平面レイヤーとして縦に積んで見せるインタラクティブな地図の試作です。
静止画でよく見る「傾けて積んだ地図」を、同じ地点をレイヤー間で対応づけて読める道具にすることが目的です。

ブラウザで動かせることは次のとおりです。

- レイヤー間の間隔を変えて、重ね合わせた状態から積み上げた状態まで連続的に切り替える
- 視点を回転・パン・ズームして、積層を好きな角度から眺める
- 地図上の1点に「探針」（全レイヤーを貫く垂直線）を立てて、その地点の各レイヤーの値を読む
- レイヤーの並べ替え・表示切替・単独表示（真上からの2D表示）

## 使い方

Node.js 22 で動作を確かめています。リポジトリを取得したら、依存関係を入れます。

```sh
npm ci            # 依存関係の導入（package-lock.json のとおりに入れる）
npm run dev       # 開発サーバーの起動。表示される URL（既定は http://localhost:5173/）をブラウザで開く
npm run build     # 型検査（tsc --noEmit）と本番ビルド。出力は dist/
npm run preview   # ビルド結果の確認用サーバー
npm test          # 単体テスト（vitest）
```

- 画面が読むデータは `public/data/` にあります。作り方は[データの再生成](#データの再生成)を参照してください。
- `public/data/` にファイルがないレイヤーは、レイヤー一覧に「読み込み失敗」と出て、ほかのレイヤーは動き続けます。
- 前処理の結果によらず画面を試したいときは、仮データ（`public/data-fixture/`）に切り替えます。`http://localhost:5173/?data=fixture` を開いてください。仮データは `node scripts/make-fixtures.mjs` で作った架空の地図で、実在の地名・数値ではありません。何度実行しても同じ出力になります。

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

## 操作

### レイヤー間隔のスライダー

画面右上の「レイヤー間隔」。左端（0 km、「重ねる」）で全レイヤーが同じ高さに重なり、右へ動かすと間隔が広がります（右端は 12 km、100 m 刻み、初期値は 5 km）。ドラッグ中は積層の高さが指に追従し、キーボードの矢印キーでも動かせます。

### 視点

| 操作 | 動き |
| --- | --- |
| 左ボタンのドラッグ | 回転（左右で水平方向、上下で傾き） |
| 右ボタンのドラッグ、または Shift を押しながら左ボタンのドラッグ | パン（平行移動） |
| マウスホイール | ズーム |

- 傾きは、ほぼ真横（8度）から真上（90度）までです。ズームと注視点にも範囲があり、描画範囲の外へはパンできません。
- 視点を自分で動かすまでは、画面の大きさやレイヤー間隔に合わせて、積層全体が収まるように自動で調整します。

### 探針

積層の平面にカーソルを置くと、カーソルの下の地点を全レイヤーに貫く垂直線（探針）と、その地点の区名と各レイヤーの値の一覧が、画面左下に出ます。

- **カーソルを置く**：水色の探針がカーソルに追従します。
- **クリック**：探針をその地点に固定します（橙色、「● 固定中」）。固定中はカーソルを動かしても値が変わりません。
- **解除**：Esc キー、平面の外をクリック、またはパネルの「解除」ボタン。解除後はカーソルを動かすと、再び追従します。
- 探針は、表示中のレイヤーだけを貫きます。非表示のレイヤーや、単独表示のときの他のレイヤーは対象になりません。
- 一覧の下に、地点のローカル座標（[座標系](#座標系全データ共通)）を m 単位で出します。

### レイヤー一覧

画面右上、スライダーの下。上が最上段です。

- **並べ替え**：左端のつまみ（⠿）をドラッグする。つまみにフォーカスして上下キーでも動かせる。▲▼ボタンで1段ずつ動かすこともできる。ドラッグ中に Esc で取り消す。
- **表示切替**：レイヤー名のチェックボックス。非表示にしたレイヤーのぶんは積層から詰まります。
- **単独表示**：「単独表示」ボタン。そのレイヤーだけを真上（北が上）から見た2D表示に切り替えます。もう一度押すか「積層表示に戻る」で、元の視点に戻ります。

## URL クエリ

URL のクエリで、初期状態を指定できます。画面を操作して決めた状態を共有したり、スクリーンショットを再現したりするときに使います。不正な値は無視して既定値を使います。

| クエリ | 値 | 意味 |
| --- | --- | --- |
| `data` | `fixture` | `public/data-fixture/` の仮データを読む。省略時は `public/data/` |
| `spacing` | 数値（m） | レイヤー間隔。0〜12000 に丸める。既定 5000 |
| `order` | レイヤーIDをカンマ区切り | 積層の順（**下から上**）。書かなかったレイヤーは、既定の順で後ろ（上）に続く。例: `order=facilities,roads` は下から 施設・道路・標高・人口・公共交通 |
| `hidden` | レイヤーIDをカンマ区切り | 最初から非表示にするレイヤー |
| `solo` | レイヤーID | 最初から単独表示にするレイヤー |
| `probe` | `x,y` | 探針をその地点に固定した状態で始める。**ローカルのメートル座標**（経緯度ではない） |
| `rx` | 数値（度） | 傾き。8（ほぼ真横）〜90（真上）。既定 25 |
| `ro` | 数値（度） | 水平方向の回転。既定 45 |
| `zoom` | 数値 | ズーム（2のべき乗。値が1増えると倍率が2倍）。指定すると自動の拡縮合わせは行わない。-9〜-1 に丸める |

レイヤーID は `elevation`（標高）、`population`（人口）、`roads`（道路）、`transit`（公共交通）、`facilities`（施設）です。

例：

```
?data=fixture&spacing=8000&order=facilities,transit&hidden=roads&rx=40&ro=20
?solo=elevation
?probe=1548,133
```

### `probe` の座標

`probe` の `x`, `y` は、[座標系](#座標系全データ共通)のローカル座標（東向きが x、北向きが y、単位 m、原点は東経139.75度・北緯35.68度）です。経緯度からは `scripts/lib/projection.mjs` の `toLocal(lon, lat)` で求めます。

```sh
node -e "import('./scripts/lib/projection.mjs').then(({ toLocal }) => console.log(toLocal(139.7671, 35.6812).map(Math.round)))"
# → [ 1548, 133 ]（東京駅）
```

目安になる地点：

| 地点 | 経度, 緯度 | `probe` |
| --- | --- | --- |
| 東京駅 | 139.7671, 35.6812 | `probe=1548,133` |
| 新宿駅 | 139.7006, 35.6896 | `probe=-4471,1066` |
| 渋谷駅 | 139.7016, 35.6580 | `probe=-4383,-2440` |
| 池袋駅 | 139.7109, 35.7295 | `probe=-3537,5493` |
| 上野駅 | 139.7774, 35.7141 | `probe=2479,3784` |
| 東京スカイツリー | 139.8107, 35.7101 | `probe=5493,3341` |
| 皇居（天守台付近） | 139.7547, 35.6877 | `probe=425,854` |

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

ファイルサイズの上限は、1ファイル 10MB、`public/data/` 全体で 30MB です（1MB = 1024 × 1024 byte）。

標高は格子データです。

- `elevation.bin`：Float32（リトルエンディアン）の格子。行は北から南、列は西から東の順。データなしは NaN
- `elevation.json`：`{ width, height, cellSize, minX, minY, maxX, maxY, min, max }`
  - 範囲は `EXTENT` と同じ、`cellSize` は 50（m）、したがって `width = height = 720`
  - `min` / `max` は23区内の有効値の最小・最大（m）
  - 各セルの値は、セルの中心での標高です。列 `col`・行 `row`（どちらも0始まり）のセルの中心は `x = minX + (col + 0.5) × cellSize`、`y = maxY − (row + 0.5) × cellSize`
  - 地点 `(x, y)` を含むセルは `col = floor((x − minX) / cellSize)`、`row = floor((maxY − y) / cellSize)`
  - 23区の外と水面はデータなし（NaN）にします

各データは23区の範囲に絞ります（区の境界で切り抜くか、区に交差するものだけを残します）。

## 各レイヤーの内容

画面に出すレイヤーと、元データから何を採るかです。いずれも、区の境界（`boundary.geojson`）で23区に絞ります。

| レイヤー | 内容 |
| --- | --- |
| 標高 | 50 m 格子。各セルの値は、セルの中心での標高（m）。水面と、23区の外は、データなし |
| 人口 | 250 m メッシュ（国勢調査の地域メッシュ統計）のうち、メッシュの中心が23区内にあるもの。人口と人口密度。500 m メッシュにも切り替えられる（`--size 500`） |
| 道路 | 高速道路・国道・都道と、幅13 m 以上のその他の道路。路線名（`name`）を持つのは高速道路だけ（国土数値情報の高速道路時系列データから付ける） |
| 公共交通 | 鉄道の路線と駅。路線名は、法定上の線名 |
| 施設 | 学校と病院の位置。学校は小・中・高・特別支援・大学など（幼稚園・専修学校・各種学校は除く）。医療機関は病院のみ（診療所・歯科診療所は除く） |

## データの再生成

`public/data/` のデータは、公開データを取得して `scripts/build-*.mjs` で作ります（`npm run` には登録していません。リポジトリのルートで `node scripts/build-boundary.mjs` のように直接実行します）。インターネットへの接続が必要です。

- ダウンロードしたデータは `.cache/` に保存し、同じ URL は2回目から取得しません（`.cache/` は Git に含めません）。

### 実行の順番

**最初に区境界を作ります。** 区境界の輪郭は、ほかの前処理が「その地点が23区内か」の判定に使います。それ以外の順番は自由です。

```sh
node scripts/build-boundary.mjs       # 1. 区境界（最初）
node scripts/build-elevation.mjs      # 2. 以降は順不同
node scripts/build-population.mjs     #    （500 m メッシュなら --size 500）
node scripts/build-roads.mjs
node scripts/build-transit.mjs
node scripts/build-facilities.mjs
node scripts/validate-data.mjs        # 3. 検証
```

### 各スクリプトが取得するもの

| スクリプト | 出力（`public/data/`） | 取得するもの |
| --- | --- | --- |
| `build-boundary.mjs` | `boundary.geojson` | 国土数値情報の行政区域データ（東京都）。23区（団体コード 13101〜13123）を区ごとにまとめ、面積 5,000 m² 未満のポリゴン（小島など）を除く |
| `build-elevation.mjs` | `elevation.bin`, `elevation.json` | 国土地理院の標高タイル（DEM5A、ズーム14）。描画範囲を覆うタイルを取得し、50 m 格子にして、区の外を NaN にする。`--check` で生成済みの出力を既知地点（東京駅など）と照合、`--preview f.png` で確認用の画像を書く |
| `build-population.mjs` | `population.geojson` | e-Stat の令和2年国勢調査 地域メッシュ統計（250 m メッシュ）。`--size 500` で 500 m メッシュに切り替える |
| `build-roads.mjs` | `roads.geojson` | 国土数値情報の道路データ（**展開後に約 700 MB**）と、高速道路時系列データ（路線名の付与用）。ディスクの空きに注意 |
| `build-transit.mjs` | `rail.geojson`, `stations.geojson` | 国土数値情報の鉄道データ（全国）。区内に頂点がある路線と、区内にある駅を残す |
| `build-facilities.mjs` | `facilities.geojson` | 国土数値情報の学校データと医療機関データ（東京都） |

### 検証

```sh
node scripts/validate-data.mjs                   # public/data を、「データ仕様」の各項目に照らして検査する
node scripts/validate-data.mjs --require-all     # 全ファイルがそろっていることも求める
node scripts/validate-data.mjs public/data-fixture --require-all   # 仮データの検査
node scripts/build-elevation.mjs --check         # 標高を既知の地点と照合する
```

違反があると終了コード 1 で終わります（引数やディレクトリの誤りは 2）。ファイルが未作成のものは「未作成」と表示します。

## スクリーンショット

```sh
node scripts/shot.mjs --query "data=fixture&spacing=5000" --out shots/stack.png
```

Vite を自動で起動し、ブラウザで開いて画像に保存します（`window.__ready` が true になるまで待ちます）。ブラウザのエラーも一覧で表示します。`shots/` は Git に含めません。

| オプション | 意味 |
| --- | --- |
| `--query <q>` | URL クエリ（[URL クエリ](#url-クエリ)） |
| `--out <path>` | 出力パス（既定 `shots/shot.png`） |
| `--size <幅x高さ>` | ビューポート（既定 `1400x1000`） |
| `--scale <n>` | deviceScaleFactor（既定 1。人が見る画像は 2 にする） |
| `--hover <x,y>` | 撮影前にマウスを動かす画面座標。探針の確認に使う |
| `--wait <ms>` | 撮影前の追加待ち時間 |
| `--url <URL>` | 起動済みのサーバーを撮る（Vite は起動しない） |

ブラウザは、この環境にプリインストールされた Playwright（と Chromium）を使います。`package.json` の依存関係には含めていないので、Playwright が入っていない環境では、別途用意してください。

## 出典表示の部品

画面に出す出典表示は `src/panel/Credits.tsx`（既定エクスポート）です。常に1行の出典を見せ、押すと、各データの出典と配布元へのリンクを開きます。位置は呼び出し側が決めます。

```tsx
import Credits from './panel/Credits';

<Credits style={{ position: 'absolute', right: 12, bottom: 12 }} />
```

- `style` / `className`：位置と大きさの指定。部品自身は位置を決めない
- `opens`：詳細を開く向き。`'up'`（既定、画面の下端に置くとき）か `'down'`（上端に置くとき）
- 閉じるには、「閉じる」ボタン、1行の部分をもう一度押す、Esc（部品にフォーカスがあるとき）

## 出典

使っているデータは、いずれも出典の明記と、加工して作成した旨の記載が利用条件です。画面の隅（`Credits`）と、この節の両方に記載します。

- 区の境界（`boundary.geojson`）：出典：国土交通省 国土数値情報（行政区域データ 2026年（令和8年）1月1日時点）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html）を加工して作成
- 標高（`elevation.bin`）：『標高タイル（基盤地図情報数値標高モデル）』（国土地理院、https://maps.gsi.go.jp/development/ichiran.html ）をもとに作成
- 人口（`population.geojson`）：出典：総務省統計局『令和2年国勢調査 地域メッシュ統計（250mメッシュ、世界測地系）』政府統計の総合窓口(e-Stat)（https://www.e-stat.go.jp/）を加工して作成
| データ | 出典 | 基準時点 |
| --- | --- | --- |
| 区の境界 | 「国土数値情報（行政区域データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html）を加工して作成 | 2026年1月1日 |
| 標高 | 「標高タイル（基盤地図情報数値標高モデル）」（国土地理院）（https://maps.gsi.go.jp/development/ichiran.html）をもとに作成 | 航空レーザ測量による5mメッシュ（DEM5A） |
| 人口 | 総務省統計局「令和2年国勢調査 地域メッシュ統計（250mメッシュ、世界測地系）」政府統計の総合窓口(e-Stat)（https://www.e-stat.go.jp/）を加工して作成 | 2020年10月1日（国勢調査） |
| 道路 | 「国土数値情報（道路データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N13-2024.html）を加工して作成。高速道路の路線名は「国土数値情報（高速道路時系列データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html）を加工して作成 | 2024年9月 |
| 鉄道と駅 | 「国土数値情報（鉄道データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html）を加工して作成 | 2025年12月31日 |
| 学校 | 「国土数値情報（学校データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P29-2023.html）を加工して作成 | 2023年度 |
| 病院 | 「国土数値情報（医療機関データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P04-2020.html）を加工して作成 | 2020年度 |

利用規約：

- 国土数値情報：https://nlftp.mlit.go.jp/ksj/other/agreement.html
- 政府統計の総合窓口(e-Stat)：https://www.e-stat.go.jp/terms-of-use
- 国土地理院コンテンツ利用規約：https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html
