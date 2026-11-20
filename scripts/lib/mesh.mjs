// 地域メッシュ（標準地域メッシュ）のメッシュコード処理。純粋関数のみ。
// 8桁までは 1次〜3次メッシュ（緯度 2/3度×経度 1度 → 8×8 → 10×10）。
// 9桁目以降は 2×2 の分割で、1=南西, 2=南東, 3=北西, 4=北東（500m は9桁、250m は10桁）。

/**
 * メッシュコード（4桁以上の数字の文字列）から、メッシュの南西端と大きさ（度）を求める。
 * @returns {{ lon: number, lat: number, dLon: number, dLat: number }} 南西端の経度・緯度と、経度方向・緯度方向の幅
 */
export function meshBounds(code) {
  if (typeof code !== 'string' || !/^\d{8,}$/.test(code)) {
    throw new Error(`メッシュコードが8桁以上の数字ではありません: ${JSON.stringify(code)}`);
  }
  const d = (i) => code.charCodeAt(i) - 48;
  let lat = Number(code.slice(0, 2)) / 1.5;
  let lon = Number(code.slice(2, 4)) + 100;
  let dLat = 2 / 3;
  let dLon = 1;
  dLat /= 8;
  dLon /= 8;
  lat += d(4) * dLat;
  lon += d(5) * dLon;
  dLat /= 10;
  dLon /= 10;
  lat += d(6) * dLat;
  lon += d(7) * dLon;
  for (let i = 8; i < code.length; i++) {
    const q = d(i) - 1;
    if (q < 0 || q > 3) throw new Error(`メッシュコードの${i + 1}桁目が 1〜4 ではありません: ${code}`);
    dLat /= 2;
    dLon /= 2;
    if (q & 1) lon += dLon;
    if (q & 2) lat += dLat;
  }
  return { lon, lat, dLon, dLat };
}

/**
 * メッシュコードから四隅の [経度, 緯度]（度）を、南西 → 南東 → 北東 → 北西 の順で返す（閉じない4点）。
 */
export function meshCorners(code) {
  const { lon, lat, dLon, dLat } = meshBounds(code);
  return [
    [lon, lat],
    [lon + dLon, lat],
    [lon + dLon, lat + dLat],
    [lon, lat + dLat],
  ];
}

/**
 * 8桁の3次メッシュコード（8桁）の下にある、500m（9桁）または 250m（10桁）メッシュのコードを全て並べる。
 */
export function subMeshCodes(code8, size) {
  if (size !== 500 && size !== 250) throw new Error(`size は 500 か 250 です: ${size}`);
  const out = [];
  for (let a = 1; a <= 4; a++) {
    if (size === 500) out.push(`${code8}${a}`);
    else for (let b = 1; b <= 4; b++) out.push(`${code8}${a}${b}`);
  }
  return out;
}

/**
 * 1次メッシュ（4桁）の中にある、500m（9桁）または 250m（10桁）メッシュのコードを全て列挙する。
 */
export function enumerateMeshCodes(primary, size) {
  if (!/^\d{4}$/.test(primary)) throw new Error(`1次メッシュコードは4桁の数字です: ${primary}`);
  const out = [];
  for (let a = 0; a < 8; a++)
    for (let b = 0; b < 8; b++)
      for (let c = 0; c < 10; c++)
        for (let d = 0; d < 10; d++) out.push(...subMeshCodes(`${primary}${a}${b}${c}${d}`, size));
  return out;
}
