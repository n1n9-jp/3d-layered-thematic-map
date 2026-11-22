import { BitmapLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { memoLoad } from '../lib/memoLoad';
import { fetchBuffer, fetchJson } from '../lib/fetch';
import { asModelMatrix } from '../stack';
import type { LayerModule } from '../types';
import { schemeLegend } from './flood/classes';
import { buildFloodData, floodImage, sampleFlood, schemeOf, sectionFlood, subsetFlood, summarizeFlood } from './flood/model';
import type { FloodData, FloodMeta } from './flood/model';

export type { FloodData };

const boundsCache = new WeakMap<FloodData, [number, number, number, number]>();
function boundsOf(d: FloodData): [number, number, number, number] {
  let b = boundsCache.get(d);
  if (!b) {
    b = [d.minX, d.minY, d.maxX, d.maxY];
    boundsCache.set(d, b);
  }
  return b;
}

const flood: LayerModule<FloodData> = {
  id: 'flood',
  label: '浸水',
  load: memoLoad(async (base) => {
    const meta = await fetchJson<FloodMeta>(`${base}flood.json`);
    const [riverDepth, tideDepth, riverDuration, tideDuration] = await Promise.all([
      fetchBuffer(`${base}${meta.files.riverDepth}`),
      fetchBuffer(`${base}${meta.files.tideDepth}`),
      fetchBuffer(`${base}${meta.files.riverDuration}`),
      fetchBuffer(`${base}${meta.files.tideDuration}`),
    ]);
    const data = buildFloodData(meta, { riverDepth, tideDepth, riverDuration, tideDuration });
    floodImage(data, schemeOf({ floodScenario: 'max', floodView: 'depth' })); // 既定の画像は、利用者の操作の前に作っておく
    return data;
  }),
  render(data, ctx) {
    // 画像は、データと（想定, 見るもの）の組ごとに1回だけ作る。組を切り替えると、別の画像に差し替わる。
    return [
      new BitmapLayer({
        id: 'flood-bitmap',
        image: floodImage(data, schemeOf(ctx.options)),
        bounds: boundsOf(data),
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        modelMatrix: asModelMatrix(ctx.modelMatrix),
        opacity: ctx.opacity,
        textureParameters: { minFilter: 'nearest', magFilter: 'nearest' },
        pickable: false,
      }),
    ];
  },
  sample: sampleFlood,
  subset: subsetFlood,
  summarize: summarizeFlood,
  section: (data, line, options) => [sectionFlood(data, line, options)],
  legend: (options) => schemeLegend(schemeOf(options)),
  controls: [
    {
      key: 'floodScenario',
      label: '想定',
      choices: [
        { value: 'max', label: '大きいほう', title: '洪水と高潮の、セルごとに大きいほう（足し合わせではありません）' },
        { value: 'river', label: '洪水', title: '想定最大規模の洪水（支川の氾濫・高潮・内水は含みません）' },
        { value: 'tide', label: '高潮', title: '想定最大規模の高潮（堤防等の決壊を見込む）' },
      ],
    },
    {
      key: 'floodView',
      label: '見るもの',
      choices: [
        { value: 'depth', label: '深さ' },
        { value: 'duration', label: '水が引くまで', title: '浸水深 0.5m 以上が続く時間（浸水継続時間）' },
      ],
    },
  ],
  notes: () => [
    '想定最大規模の想定です。洪水は、支川の氾濫・高潮・内水を含みません。区域の外が安全とは限りません。',
    '洪水と高潮は別々の災害の想定で、足し合わせていません。',
  ],
};

export default flood;
