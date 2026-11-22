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
import { overallHeadline } from './overallModel';
import Disclosure from './Disclosure';

const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/**
 * 「浸水が想定される区域に住む人」の表（深さの区分ごとの人口と65歳以上人口）。23区全体と、クローズアップの円の中で同じ表を使う。
 * variant='bars'（23区全体）は、区分ごとの人口を横棒（色は浸水の段の配色）で見せ、人口が 0 の深い区分は1行にまとめ、注記は出さない（折りたたみ側に出す）。
 */
export function ExposureTable({
  exposure,
  testId,
  caption,
  variant = 'plain',
}: {
  exposure: Exposure;
  testId: string;
  caption: string;
  variant?: 'plain' | 'bars';
}) {
  const t: Model = exposureTable(exposure);
  const bars = variant === 'bars';
  // 人口が 0 の区分（浸水なしを除く）は、棒にならないので1行にまとめる
  const shown = bars ? t.rows.filter((r) => r.peopleValue > 0 || r.key === '0') : t.rows;
  const empty = bars ? t.rows.filter((r) => r.peopleValue <= 0 && r.key !== '0') : [];
  return (
    <section className={`ex${bars ? ' ex-bars' : ''}`} data-testid={testId} data-scenario={exposure.scenario}>
      <div className="ex-head">
        {/* 23区全体の表は、見出しが開閉の見出し（アコーディオン）になっているので、表の中には置かない */}
        {!bars && <h3 className="ex-title">{caption}</h3>}
        <div className="ex-scenario" data-testid={`${testId}-scenario`}>
          想定：{t.scenario}
        </div>
      </div>
      <table className="ex-table">
        <thead>
          <tr>
            <th scope="col">浸水の深さ</th>
            {bars && <th scope="col" aria-hidden="true" />}
            <th scope="col">人口（人）</th>
            <th scope="col">{bars ? 'うち65歳以上' : 'うち65歳以上（人）'}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key} data-rank={r.key} data-testid={`${testId}-row`}>
              <th scope="row">
                <span className="ex-swatch" style={{ background: rgb(r.color) }} />
                {r.label}
              </th>
              {bars && (
                <td className="ex-barcell" aria-hidden="true">
                  <span className="ex-bar">
                    <span style={{ width: `${(r.barRatio * 100).toFixed(1)}%`, background: rgb(r.color) }} />
                  </span>
                </td>
              )}
              <td data-col="people">
                {r.people} <span className="ic-dim">{r.share}</span>
              </td>
              <td data-col="elderly">{r.elderly}</td>
            </tr>
          ))}
          {empty.length > 0 && (
            <tr className="ex-empty" data-testid={`${testId}-empty`} data-ranks={empty.map((r) => r.key).join(',')}>
              <th scope="row" colSpan={bars ? 4 : 3}>
                {empty
                  .map((r) => r.label)
                  .reverse()
                  .join('・')}
                ：想定される区域に住む人なし（0 人）
              </th>
            </tr>
          )}
          <tr className="ex-total" data-testid={`${testId}-total`}>
            <th scope="row">合計</th>
            {bars && <td />}
            <td data-col="people">{t.total.people}</td>
            <td data-col="elderly">{t.total.elderly}</td>
          </tr>
          {t.belowSea && (
            <tr className="ex-below" data-testid={`${testId}-below`}>
              <th scope="row">標高 0m 未満の土地</th>
              {bars && <td />}
              <td data-col="people">{t.belowSea.people}</td>
              <td data-col="elderly">{t.belowSea.elderly}</td>
            </tr>
          )}
        </tbody>
      </table>
      {!bars && (
        <div className="ex-notes">
          {t.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
    </section>
  );
}

/** 数え方・データの注意。既定では折りたたむ。 */
function Notes({ exposure, shelters }: { exposure: Exposure | null; shelters: ShelterData | null }) {
  const open = useMapStore((s) => s.open.notes);
  const toggleOpen = useMapStore((s) => s.toggleOpen);
  const o = shelters ? shelterOverview(shelters) : null;
  const t = exposure ? exposureTable(exposure) : null;
  return (
    <Disclosure id="overall-notes" testId="overall-notes" open={open} onToggle={() => toggleOpen('notes')} title="数え方とデータの注意" scrollIntoView>
      <div className="ov-notes-body">
        {t && (
          <>
            <h4>数え方</h4>
            {t.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
            <p>「大きいほう」は、洪水と高潮を足し合わせません。地点ごとに、深いほうの想定を採ります。</p>
            <p>標高 0m 未満の土地は、メッシュの中心を含む標高のセルが 0m 未満のメッシュの人口です（想定の切り替えによりません）。</p>
          </>
        )}
        {o && (
          <>
            <h4>避難場所の読み方</h4>
            <p>
              洪水・高潮で使える避難場所 {o.usable.toLocaleString('ja-JP')} か所のほか、地震・火事などの避難場所が {o.other.toLocaleString('ja-JP')} か所、病院が{' '}
              {o.hospitals.toLocaleString('ja-JP')} 院あります。
            </p>
            <p>指定緊急避難場所は、災害の種別ごとに指定されています。データは最新でない場合や、未掲載の場合があります（国土地理院、{o.updated} 更新分）。収容人数は含みません。</p>
            <p>
              <b>指定なし</b>は、データに載っていて、洪水・高潮用の指定が 0 件の区です：{o.none.map((w) => w.name).join('・') || '該当なし'}。
              地震・火事などの避難場所は載っています（{o.none.map((w) => `${w.name} ${w.total} か所`).join('・') || '該当なし'}）。
              <b>未公開</b>は、このデータに指定緊急避難場所が載っていない区です：{o.unpublished.join('・') || '該当なし'}。0 件は「ない」ではなく「データがない」で、あるかどうかは分かりません。
            </p>
            <p>
              「指定なし」は「避難できない」ことではありません。このデータから分かるのは、洪水・高潮で使える指定緊急避難場所が載っているかどうかまでで、各区の避難の計画は分かりません。
            </p>
          </>
        )}
      </div>
    </Disclosure>
  );
}

/** 「浸水の深さの区分ごとの人口」の表。見出しを押すと開く（既定は閉じる）。 */
function PopulationTable({ exposure }: { exposure: Exposure }) {
  const open = useMapStore((s) => s.open.table);
  const toggleOpen = useMapStore((s) => s.toggleOpen);
  return (
    <Disclosure id="overall-table" testId="overall-table" open={open} onToggle={() => toggleOpen('table')} title="浸水の深さの区分ごとの人口" scrollIntoView>
      <ExposureTable exposure={exposure} testId="overall-exposure" caption="浸水の深さの区分ごとの人口" variant="bars" />
    </Disclosure>
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
  const shelters = status.shelters === 'ready' ? (data.shelters as ShelterData) : null;
  const head = exposure ? overallHeadline(exposure) : null;
  const table = exposure ? exposureTable(exposure) : null;
  return (
    <div className="ov" data-testid="overall">
      <h2 className="ov-title">23区全体：水害の想定と、避難できる場所</h2>
      {exposure && head && table ? (
        <>
          <section className="ov-scen" data-testid="overall-scenario">
            <span className="ov-chip">想定：{table.scenario}</span>
          </section>
          <section className="ov-hero" data-testid="overall-lead">
            <div className="ov-kicker">深さ 3m 以上の浸水が想定される区域に住む人</div>
            <div className="ov-hero-main">
              <span className="ov-bignum" data-testid="overall-severe" title={head.severe.people.exact}>
                {head.severe.people.approx}
              </span>
              <span className="ov-hero-sub">
                うち65歳以上 <b data-testid="overall-severe-elderly" title={head.severe.elderly.exact}>{head.severe.elderly.approx}</b>
              </span>
            </div>
          </section>
        </>
      ) : (
        <p className="ic-dim">{failed ? '集計に使うデータの読み込みに失敗しました' : '集計中…（人口と浸水想定の読み込みを待っています）'}</p>
      )}
      {exposure && <PopulationTable exposure={exposure} />}
      <Notes exposure={exposure} shelters={shelters} />
    </div>
  );
}
