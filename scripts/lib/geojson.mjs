import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('public/data');

/** `public/data/<fileName>` に、インデントなしの FeatureCollection を書き出す。 */
export async function writeFeatureCollection(fileName, features) {
  await mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, fileName);
  await writeFile(file, JSON.stringify({ type: 'FeatureCollection', features }));
  return file;
}
