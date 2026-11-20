import proj4 from 'proj4';

/** 全データ共通のローカル座標系（横メルカトル、単位m）。 */
export const PROJ =
  '+proj=tmerc +lat_0=35.68 +lon_0=139.75 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs';

/** 描画範囲（ローカル座標、m）。 */
export const EXTENT = { minX: -19000, minY: -19000, maxX: 17000, maxY: 17000 };

const converter = proj4('EPSG:4326', PROJ);

/** 経度・緯度（度）→ ローカル座標 [x, y]（m）。 */
export function toLocal(lon, lat) {
  return converter.forward([lon, lat]);
}

/** toLocal の結果を 1m 単位に丸める。 */
export function toLocalRounded(lon, lat) {
  const [x, y] = toLocal(lon, lat);
  return [Math.round(x), Math.round(y)];
}

/** ローカル座標（m）→ [経度, 緯度]（度）。 */
export function toLonLat(x, y) {
  return converter.inverse([x, y]);
}

/** ローカル座標が EXTENT 内か。 */
export function inExtent(x, y) {
  return x >= EXTENT.minX && x <= EXTENT.maxX && y >= EXTENT.minY && y <= EXTENT.maxY;
}
