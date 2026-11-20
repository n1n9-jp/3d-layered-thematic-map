/** JSON を取得する。存在しないファイルが index.html で返る開発サーバでも、JSON として読めなければ失敗にする。 */
export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${url}: JSON として読めません`);
  }
}

export async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}
