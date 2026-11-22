import { wholeExposure } from '../aggregate/exposure';
import type { Exposure } from '../aggregate/exposure';
import type { FloodData } from '../layers/flood/model';
import type { PopulationData } from '../layers/population';
import { shelterOverview } from '../layers/shelters/model';
import type { ShelterData } from '../layers/shelters/model';
import { useMapStore } from '../store';
import type { ElevationData } from '../types';
import { exposureTable } from './exposureModel';
import type { ExposureTable as Model } from './exposureModel';

const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** 「浸水が想定される区域に住む人」の表（深さの区分ごとの人口と65歳以上人口）。23区全体と、クローズアップの円の中で同じ表を使う。 */
export function ExposureTable({ exposure, testId, caption }: { exposure: Exposure; testId: string; caption: string }) {
  const t: Model = exposureTable(exposure);
  return (
    <section className="ex" data-testid={testId} data-scenario={exposure.scenario}>
      <h3 className="ex-title">{caption}</h3>
      <div className="ex-scenario" data-testid={`${testId}-scenario`}>
        想定：{t.scenario}
      </div>
      <table className="ex-table">
        <thead>
          <tr>
            <th scope="col">浸水の深さ</th>
            <th scope="col">人口（人）</th>
            <th scope="col">うち65歳以上（人）</th>
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r) => (
            <tr key={r.key} data-rank={r.key} data-testid={`${testId}-row`}>
              <th scope="row">
                <span className="ex-swatch" style={{ background: rgb(r.color) }} />
                {r.label}
              </th>
              <td>
                {r.people} <span className="ic-dim">{r.share}</span>
              </td>
              <td>{r.elderly}</td>
            </tr>
          ))}
          <tr className="ex-total" data-testid={`${testId}-total`}>
            <th scope="row">合計</th>
            <td>{t.total.people}</td>
            <td>{t.total.elderly}</td>
          </tr>
          {t.belowSea && (
            <tr className="ex-below" data-testid={`${testId}-below`}>
              <th scope="row">標高 0m 未満の土地</th>
              <td>{t.belowSea.people}</td>
              <td>{t.belowSea.elderly}</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="ex-notes">
        {t.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>
    </section>
  );
}

function ShelterOverview({ shelters }: { shelters: ShelterData }) {
  const o = shelterOverview(shelters);
  return (
    <section className="ex" data-testid="overall-shelters">
      <h3 className="ex-title">避難できる場所</h3>
      <p className="ex-line">
        洪水・高潮で使える避難場所：<b data-testid="overall-usable">{o.usable.toLocaleString('ja-JP')}</b> か所（そのほか、地震・火事などの避難場所 {o.other.toLocaleString('ja-JP')} か所、病院 {o.hospitals.toLocaleString('ja-JP')} 院）
      </p>
      <p className="ex-line">
        <b>データ未公開の区</b>（網掛け）：{o.unpublished.join('・') || 'なし'}。この{o.unpublished.length}区の「0 件」は、避難場所が「ない」ではなく「データがない」ことです。
      </p>
      <p className="ex-line" data-testid="overall-zero">
        <b>洪水・高潮用が 0 件の区</b>：
        {o.zeroUsableOther.map((w) => `${w.name}（洪水・高潮用ではない ${w.total} か所のみ）`).join('、') || 'なし'}。この区は、洪水・高潮で使える場所の指定がありません。
      </p>
      <div className="ex-notes">
        <p>指定緊急避難場所は、災害の種別ごとに指定されています。データは最新でない場合や、未掲載の場合があります（国土地理院、{o.updated} 更新分）。収容人数は含みません。</p>
      </div>
    </section>
  );
}

/** 何も選んでいないときの、23区全体の集計。 */
export default function Overall() {
  const status = useMapStore((s) => s.status);
  const data = useMapStore((s) => s.data);
  const scenario = useMapStore((s) => s.options.floodScenario);
  const needed = (['population', 'flood'] as const).every((k) => status[k] === 'ready');
  const failed = (['population', 'flood'] as const).some((k) => status[k] === 'error');
  let exposure: Exposure | null = null;
  if (needed) {
    try {
      exposure = wholeExposure(
        data.population as PopulationData,
        data.flood as FloodData,
        scenario,
        status.elevation === 'ready' ? (data.elevation as ElevationData) : null,
      );
    } catch (e) {
      console.error('[overall] exposure', e);
    }
  }
  return (
    <div className="ov" data-testid="overall">
      <h2 className="ov-title">23区全体：浸水が想定される区域に住む人</h2>
      {exposure ? (
        <>
          <p className="ex-line ov-lead" data-testid="overall-lead">
            浸水が想定される区域（0.5m 未満を含む）に <b>{exposureTable(exposure).headline.flooded}</b>。うち深さ 3m 以上の区域に{' '}
            <b>{exposureTable(exposure).headline.severe}</b>。
          </p>
          <ExposureTable exposure={exposure} testId="overall-exposure" caption="浸水の深さの区分ごとの人口" />
        </>
      ) : (
        <p className="ic-dim">{failed ? '集計に使うデータの読み込みに失敗しました' : '集計中…（人口と浸水想定の読み込みを待っています）'}</p>
      )}
      {status.shelters === 'ready' ? <ShelterOverview shelters={data.shelters as ShelterData} /> : <p className="ic-dim">避難場所の読み込み中…</p>}
    </div>
  );
}
