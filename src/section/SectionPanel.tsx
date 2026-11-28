import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { registry } from '../layers';
import { STATION_SECTION_RADIUS } from '../layers/transitModel';
import { lineLength } from '../lib/section';
import { cachedDistrictLookup } from '../probe/district';
import { layerZ } from '../stack';
import { useMapStore } from '../store';
import type { LayerStatus } from '../store';
import type { BoundaryData, SectionLine, SectionMarks, SectionSeries, SectionTrack } from '../types';
import { SUMMARY_H, placeCharts, stackedPlacement } from './alignment';
import type { AlignMode, Placement, Tier } from './alignment';
import { placeSection, releaseSection } from './controller';
import { EXAMPLE_LINES } from './examples';
import { sectionFloodSummary } from '../aggregate/sectionExposure';
import type { FloodData } from '../layers/flood/model';
import type { ShelterData } from '../layers/shelters/model';
import { SCENARIO_LABEL } from '../layers/flood/classes';
import {
  bandQuads,
  cappedMax,
  distanceTicks,
  dToX,
  edgeRuns,
  formatAlong,
  formatLength,
  groupByColor,
  isNearMark,
  readoutText,
  summaryLine,
  valueAt,
  valueTicks,
  xToD,
} from './model';
import type { XScale } from './model';
import { planeCenterY, useTierScreen } from './tierScreen';
import type { TierScreen } from './tierScreen';
import { useSectionTracks } from './tracks';
import Disclosure from '../info/Disclosure';
import './SectionPanel.css';

/**
 * グラフの左の余白（レイヤー名を置く）と右の余白（縦軸の目盛りを置く）（px）。すべてのグラフで同じ。
 * 左の名前は、全体の地図の各段の右脇の名前と向かい合う（同じ高さ）。
 */
const ML = 58;
const MR = 58;
/** 枠の中の縦の余白（px）。 */
const PAD_Y = 1;
/** 列の左右の余白（px）。 */
const SIDE = 12;
/** 横軸の高さ（px）と、いちばん下のチャートとの隙間。 */
const AXIS_H = 24;
const AXIS_GAP = 6;
/** カーソルの位置の線の色（全体の地図の、探針と同じ水色）。 */
const CURSOR = '#5adcff';
/** カーソルが指す交差や地物を探す範囲（px）。 */
const READ_TOLERANCE_PX = 8;

const LABELS = Object.fromEntries(LAYER_IDS.map((id) => [id, registry[id].label])) as Record<LayerId, string>;

const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const fix = (v: number) => v.toFixed(1);

/** 点 (x, y) の区名。区境界が読み込めていなければ null。 */
function useDistrictOf(p: { x: number; y: number }): string | null {
  const boundary = useMapStore((s) => s.data.boundary);
  const ready = useMapStore((s) => s.status.boundary === 'ready');
  return ready && boundary ? cachedDistrictLookup(boundary as BoundaryData)(p.x, p.y) : null;
}

interface Box {
  width: number;
  height: number;
  /** ブラウザの画面での、要素の上端の位置（px）。全体の地図の各段の位置と同じ座標。 */
  top: number;
}

/** 要素の幅・高さ・上端（px）。中身が空でも測れる。要素が後から現れても追う（コールバック ref）。 */
function useElementBox<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [box, setBox] = useState<Box>({ width: 0, height: 0, top: 0 });
  useLayoutEffect(() => {
    if (!el) {
      setBox({ width: 0, height: 0, top: 0 });
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      // 子は枠線の内側（padding box）の上端から絶対位置で置かれるので、上端は枠線の分だけ下げて測る。
      const next = { width: Math.floor(r.width), height: Math.floor(r.height), top: r.top + el.clientTop };
      setBox((b) => (b.width === next.width && b.height === next.height && b.top === next.top ? b : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [el]);
  return [setEl, box] as const;
}

/* ---------- 1枚のグラフ ---------- */

interface ChartProps {
  id: LayerId;
  tracks: SectionTrack[];
  length: number;
  width: number;
  frameH: number;
  hoverD: number | null;
  /** 全体の地図で、この段の切り口の近くにカーソルがある、または、このチャートにカーソルがある。 */
  hot: boolean;
  onHover(d: number | null): void;
}

/** 線から離れた地物を探した距離（m）。縦軸（線からの距離）の左右の端。 */
function nearRadius(tracks: readonly SectionMarks[]): number {
  return tracks.find((t) => t.radius !== undefined)?.radius ?? STATION_SECTION_RADIUS;
}

/** 縦軸の段のラベルは、この間隔（px）より詰まるとき、間引く（上の段を残す）。 */
const RANK_LABEL_GAP = 10;

function SeriesContent({ series, sc, ph }: { series: SectionSeries; sc: XScale; ph: number }) {
  const y = (t: number) => PAD_Y + (1 - t) * ph;
  const base = y(0);
  const groups = useMemo(() => groupByColor(bandQuads(series)), [series]);
  const runs = useMemo(() => edgeRuns(series), [series]);
  return (
    <>
      {groups.map((g, i) => {
        const color = rgb(g.color);
        const d = g.quads
          .map((q) => {
            const x0 = dToX(sc, q.d0);
            const x1 = dToX(sc, q.d1);
            return `M${fix(x0)} ${fix(base)}L${fix(x1)} ${fix(base)}L${fix(x1)} ${fix(y(q.t1))}L${fix(x0)} ${fix(y(q.t0))}Z`;
          })
          .join('');
        return <path key={i} d={d} fill={color} stroke={color} strokeWidth={0.6} />;
      })}
      {runs.map((r, i) => (
        <polyline key={i} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth={1.1} strokeLinejoin="round" points={r.points.map((p) => `${fix(dToX(sc, p.d))},${fix(y(p.t))}`).join(' ')} />
      ))}
      {runs.flatMap((r, i) => {
        // 縦軸の上端を超えた区間は、上端に白い太い線を引く（地図の中の帯と同じ）。
        const out: ReactElement[] = [];
        let cur: string[] = [];
        const flush = () => {
          if (cur.length >= 2) out.push(<polyline key={`${i}-${out.length}`} data-testid="section-cap" fill="none" stroke="#fff" strokeWidth={3} points={cur.join(' ')} />);
          cur = [];
        };
        for (const p of r.points) {
          if (p.capped) cur.push(`${fix(dToX(sc, p.d))},${fix(y(1))}`);
          else flush();
        }
        flush();
        return out;
      })}
    </>
  );
}

function MarksContent({ id, tracks, sc, ph }: { id: LayerId; tracks: SectionMarks[]; sc: XScale; ph: number }) {
  const marks = tracks.flatMap((t) => t.marks);
  const gaps = tracks.flatMap((t) => t.gaps ?? []);
  const crossings = marks.filter((m) => !isNearMark(m));
  const near = marks.filter(isNearMark);
  const R = nearRadius(tracks);
  const mid = PAD_Y + ph / 2;
  const yOf = (offset: number) => mid - (offset / R) * (ph / 2 - 5);
  const patternId = `sc-hatch-${id}`;
  return (
    <>
      {gaps.length > 0 && (
        <defs>
          <pattern id={patternId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={6} stroke="rgba(176,182,204,0.7)" strokeWidth={1.6} />
          </pattern>
        </defs>
      )}
      {gaps.map((g, i) => {
        const x0 = dToX(sc, g.d0);
        const w = Math.max(1, dToX(sc, g.d1) - x0);
        const cx = fix(x0 + w / 2);
        const cy = PAD_Y + ph / 2;
        if (g.kind === 'unpublished')
          // 未公開の区間：灰の網掛け（0 件ではなく、データがない）
          return (
            <g key={`g${i}`} data-testid="section-gap" data-kind="unpublished">
              <title>{g.label}</title>
              <rect x={fix(x0)} y={PAD_Y} width={fix(w)} height={ph} fill={`url(#${patternId})`} stroke="rgba(176,182,204,0.6)" strokeWidth={0.8} />
              {w > 44 && (
                <text x={cx} y={cy + 3} textAnchor="middle" className="sc-gap-label">
                  未公開
                </text>
              )}
            </g>
          );
        // 指定なしの区間：枠だけ（塗りも網掛けもしない）。未公開の網掛けとは、枠と文字で見分ける
        return (
          <g key={`g${i}`} data-testid="section-gap" data-kind="none">
            <title>{g.label}</title>
            <rect x={fix(x0)} y={PAD_Y} width={fix(w)} height={ph} fill="none" stroke="rgba(214,224,244,0.9)" strokeWidth={1.6} />
            {w > 44 && (
              <text x={cx} y={cy + 3} textAnchor="middle" className="sc-gap-label sc-gap-none">
                指定なし
              </text>
            )}
          </g>
        );
      })}
      {near.length > 0 || id === 'shelters' ? <line x1={sc.left} x2={sc.left + sc.width} y1={mid} y2={mid} stroke="rgba(255,255,255,0.22)" strokeDasharray="3 3" /> : null}
      {crossings.map((m, i) => (
        <line key={`c${i}`} x1={fix(dToX(sc, m.d))} x2={fix(dToX(sc, m.d))} y1={PAD_Y} y2={PAD_Y + ph} stroke={rgb(m.color)} strokeWidth={1.5} strokeOpacity={0.9} />
      ))}
      {near.map((m, i) => {
        const cx = dToX(sc, m.d);
        const cy = yOf(m.offset);
        return m.category === 'hospital' ? (
          <rect key={`n${i}`} x={cx - 3.6} y={cy - 3.6} width={7.2} height={7.2} transform={`rotate(45 ${fix(cx)} ${fix(cy)})`} fill={rgb(m.color)} stroke="rgba(255,255,255,0.9)" strokeWidth={0.9} />
        ) : m.category === 'shelter-other' ? (
          <circle key={`n${i}`} cx={fix(cx)} cy={fix(cy)} r={2.2} fill={rgb(m.color)} fillOpacity={0.85} stroke="rgba(0,0,0,0.6)" strokeWidth={0.5} />
        ) : m.category === 'shelter-usable' && m.inside ? (
          // 浸水が想定される区域の中：同じ色の輪郭だけ（外縁は塗りの丸と同じ 4.4 + 0.5 = 4.9 px）
          <circle key={`n${i}`} cx={fix(cx)} cy={fix(cy)} r={3.9} fill="none" stroke={rgb(m.color)} strokeWidth={2} data-inside="true" />
        ) : m.category === 'shelter-usable' ? (
          <circle key={`n${i}`} cx={fix(cx)} cy={fix(cy)} r={4.4} fill={rgb(m.color)} stroke="rgba(255,255,255,0.95)" strokeWidth={1} />
        ) : (
          <circle key={`n${i}`} cx={fix(cx)} cy={fix(cy)} r={3.6} fill={rgb(m.color)} stroke="rgba(0,0,0,0.8)" strokeWidth={0.8} />
        );
      })}
    </>
  );
}

/** グラフの本体（レイヤー名、要約か値の読み、枠）。位置は、外側の Cell が決める。 */
const Chart = memo(function Chart({ id, tracks, length, width, frameH, hoverD, hot, onHover }: ChartProps) {
  const ph = frameH - 2 * PAD_Y;
  const pw = Math.max(1, width - ML - MR);
  const sc: XScale = { left: ML, width: pw, length };
  const series = tracks.find((t): t is SectionSeries => t.kind === 'series');
  const markTracks = tracks.filter((t): t is SectionMarks => t.kind === 'marks');
  const hasNear = markTracks.some((t) => t.marks.some(isNearMark)) || id === 'shelters' || id === 'transit';
  const xt = useMemo(() => distanceTicks(length), [length]);
  const yTicks = series ? valueTicks(series.domain, series.ranks) : [];
  const yOfValue = (v: number) => (series ? PAD_Y + (1 - (v - series.domain[0]) / (series.domain[1] - series.domain[0])) * ph : 0);
  const R = nearRadius(markTracks);
  const tickX = ML + pw + 5;
  // 段（ランク）の縦軸：段の名前を、段の高さに置く。詰まるときは、上の段を残して間引く。
  const rankLabels = (() => {
    if (!series?.ranks) return null;
    const out: { v: number; text: string }[] = [];
    let lastY = Infinity;
    for (const r of [...series.ranks].reverse()) {
      const y = yOfValue(r.value);
      if (out.length > 0 && y - lastY < RANK_LABEL_GAP) continue;
      out.push({ v: r.value, text: r.short });
      lastY = y;
    }
    return out;
  })();

  const readout = hoverD === null ? null : readoutText(tracks, hoverD, (READ_TOLERANCE_PX * length) / pw);
  const hoverValue = series && hoverD !== null ? valueAt(series, hoverD) : null;
  const capped = series ? cappedMax(series) : null;

  const handle = (e: React.PointerEvent<SVGRectElement>) => {
    // x は SVG の左端から測る（sc.left は、その左端から始点までの余白）。
    const r = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    onHover(xToD(sc, e.clientX - r.left));
  };

  return (
    <>
      <span className="sc-name" style={{ top: SUMMARY_H, height: frameH, width: ML - 6 }}>
        {LABELS[id]}
      </span>
      {/* 要約と、カーソルの位置の値は、同じ場所に重ねる（カーソルがあるあいだ、値が要約に代わる）。枠の上に置き、枠を狭めない。 */}
      <div className="sc-text" style={{ left: ML, width: pw, height: SUMMARY_H }}>
        <div className="sc-sum" data-testid="section-summary" style={hoverD !== null ? { visibility: 'hidden' } : undefined}>
          {summaryLine(id, tracks)}
          {capped !== null && series && <span className="ic-dim">（{series.domain[1].toLocaleString('ja-JP')} 超は頭打ち、白い太線）</span>}
        </div>
        <div className="sc-read" data-testid="section-readout">
          {hoverD !== null ? (readout ?? <span className="ic-dim">{series ? 'データなし' : '該当なし'}</span>) : ''}
        </div>
      </div>
      <svg className="sc-svg" style={{ top: SUMMARY_H }} width={width} height={frameH} role="img" aria-label={`${LABELS[id]}の断面`}>
        <rect x={ML} y={0} width={pw} height={frameH} fill="#0b0f16" stroke={hot ? 'rgba(90,220,255,0.75)' : 'rgba(255,255,255,0.1)'} strokeWidth={1} data-testid="section-frame" />
        {xt.map((t) => (
          <line key={t.d} x1={fix(dToX(sc, t.d))} x2={fix(dToX(sc, t.d))} y1={PAD_Y} y2={PAD_Y + ph} stroke="rgba(255,255,255,0.07)" />
        ))}
        {yTicks.map((v) => {
          const rank = rankLabels?.find((r) => r.v === v);
          return (
            <g key={v}>
              <line x1={ML} x2={ML + pw} y1={fix(yOfValue(v))} y2={fix(yOfValue(v))} stroke="rgba(255,255,255,0.14)" />
              {(!rankLabels || rank) && (
                <text x={tickX} y={yOfValue(v) + 3.5} className="sc-tick" data-testid={rank ? 'section-rank-tick' : undefined}>
                  {rank ? rank.text : v.toLocaleString('ja-JP')}
                </text>
              )}
            </g>
          );
        })}
        {hasNear && (
          <>
            <text x={tickX} y={PAD_Y + 9} className="sc-tick">
              左 {R}m
            </text>
            <text x={tickX} y={PAD_Y + ph / 2 + 3.5} className="sc-tick">
              線上
            </text>
            <text x={tickX} y={PAD_Y + ph - 2} className="sc-tick">
              右 {R}m
            </text>
          </>
        )}
        {series ? <SeriesContent series={series} sc={sc} ph={ph} /> : <MarksContent id={id} tracks={markTracks} sc={sc} ph={ph} />}
        {hoverD !== null && (
          <g pointerEvents="none">
            <line x1={fix(dToX(sc, hoverD))} x2={fix(dToX(sc, hoverD))} y1={PAD_Y} y2={PAD_Y + ph} stroke={CURSOR} strokeWidth={1.5} data-testid="section-cursor" />
            {series && hoverValue !== null && <circle cx={fix(dToX(sc, hoverD))} cy={fix(yOfValue(Math.min(series.domain[1], Math.max(series.domain[0], hoverValue))))} r={3.5} fill="#fff" stroke={CURSOR} strokeWidth={1.5} />}
          </g>
        )}
        <rect x={ML} y={0} width={pw} height={frameH} fill="transparent" onPointerMove={handle} onPointerLeave={() => onHover(null)} style={{ cursor: 'crosshair' }} data-testid="section-plot" />
      </svg>
    </>
  );
});

/** 1つのチャートの置き場所。frame の縦の中心 center（領域の座標）に、枠が来るように置く。カーソルを置くと、全体の地図の対応する段を目立たせる。 */
function Cell({ id, center, frameH, hot, children }: { id: LayerId; center: number; frameH: number; hot: boolean; children: React.ReactNode }) {
  return (
    <div
      className="sc-cell"
      data-testid="section-chart"
      data-layer={id}
      data-hot={hot ? '' : undefined}
      style={{ top: center - frameH / 2 - SUMMARY_H, height: SUMMARY_H + frameH }}
      onPointerEnter={() => useMapStore.getState().setSectionFocus({ id, from: 'chart' })}
      onPointerLeave={() => {
        const s = useMapStore.getState();
        if (s.sectionFocus?.from === 'chart' && s.sectionFocus.id === id) s.setSectionFocus(null);
      }}
    >
      {children}
    </div>
  );
}

/** 横軸（線に沿った距離、km）。いちばん下のチャートの下に1つだけ。全チャートと横の位置が揃う。カーソルの位置の距離も出す。 */
function Axis({ length, width, hoverD, top }: { length: number; width: number; hoverD: number | null; top: number }) {
  const pw = Math.max(1, width - ML - MR);
  const sc: XScale = { left: ML, width: pw, length };
  const ticks = useMemo(() => distanceTicks(length), [length]);
  return (
    <div className="sc-axis" data-testid="section-axis" style={{ top, height: AXIS_H }}>
      <svg width={width} height={AXIS_H} role="img" aria-label="線に沿った距離（km）">
        <line x1={ML} x2={ML + pw} y1={4} y2={4} stroke="rgba(255,255,255,0.35)" />
        {ticks.map((t) => (
          <g key={t.d}>
            <line x1={fix(dToX(sc, t.d))} x2={fix(dToX(sc, t.d))} y1={4} y2={8} stroke="rgba(255,255,255,0.35)" />
            <text x={fix(dToX(sc, t.d))} y={19} textAnchor="middle" className="sc-tick">
              {t.label}
            </text>
          </g>
        ))}
        <text x={ML + pw + 5} y={19} className="sc-tick">
          km
        </text>
        {hoverD !== null && (
          <g>
            <line x1={fix(dToX(sc, hoverD))} x2={fix(dToX(sc, hoverD))} y1={0} y2={8} stroke={CURSOR} strokeWidth={1.5} />
            <text x={Math.min(ML + pw - 20, Math.max(ML + 20, dToX(sc, hoverD)))} y={19} textAnchor="middle" className="sc-tick sc-tick-hot" data-testid="section-axis-d">
              {formatAlong(hoverD, length)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

/* ---------- 列の中身 ---------- */

function Ends({ line }: { line: SectionLine }) {
  const a = useDistrictOf({ x: line.ax, y: line.ay });
  const b = useDistrictOf({ x: line.bx, y: line.by });
  return (
    <div className="sc-ends" data-testid="section-ends">
      <span className="sc-end">
        <b className="sc-badge">A</b> {a ?? '区の外'}
      </span>
      <span className="ic-dim">→</span>
      <span className="sc-end">
        <b className="sc-badge sc-badge-b">B</b> {b ?? '区の外'}
      </span>
    </div>
  );
}

/** 線に沿った集計：浸水 3m 以上の区間の長さと、その区間から 1 km 以内の、洪水・高潮で使える避難場所の数。 */
function SectionHeadline({ line }: { line: SectionLine }) {
  const data = useMapStore((s) => s.data);
  const status = useMapStore((s) => s.status);
  const scenario = useMapStore((s) => s.options.floodScenario);
  const ready = status.flood === 'ready' && status.shelters === 'ready';
  const sum = useMemo(
    () => (ready ? sectionFloodSummary(data.flood as FloodData, data.shelters as ShelterData, line, scenario) : null),
    [ready, data.flood, data.shelters, line, scenario],
  );
  const open = useMapStore((s) => s.open.section);
  const toggleOpen = useMapStore((s) => s.toggleOpen);
  if (!sum) return null;
  const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
  const pct = sum.length > 0 ? Math.round((100 * sum.severeLength) / sum.length) : 0;
  return (
    <Disclosure id="section-headline" testId="section-summary-acc" open={open} onToggle={() => toggleOpen('section')} title="線に沿った集計" scrollIntoView>
      <div className="sc-headline" data-testid="section-headline" data-severe-m={Math.round(sum.severeLength)} data-shelters={sum.shelters}>
        <div title={`想定：${SCENARIO_LABEL[scenario]}`}>
          浸水 3m 以上：<b data-testid="section-severe">{km(sum.severeLength)}</b>（線の {pct}%）。その区間から {sum.radius / 1000} km 以内の、洪水・高潮用の避難場所：{' '}
          <b data-testid="section-severe-shelters">{sum.shelters}</b> か所
        </div>
      </div>
    </Disclosure>
  );
}

function Placeholder({ status, label, frameH, width }: { status: LayerStatus; label: string; frameH: number; width: number }) {
  return (
    <>
      <span className="sc-name" style={{ top: SUMMARY_H, height: frameH, width: ML - 6 }}>
        {label}
      </span>
      <div className="sc-text ic-dim" style={{ left: ML, width: Math.max(1, width - ML - MR), height: SUMMARY_H }}>
        <div className="sc-sum">{status === 'error' ? '読み込み失敗' : '読み込み中…'}</div>
      </div>
    </>
  );
}

/**
 * 各チャートの置き場所。段の画面上の高さ（全体の地図が公開している）から決める。
 * 揃えるか縦並びかは、前の置き方を覚えて、境目で行き来しないようにする。
 * 全体の地図の状態がまだ追いついていない一瞬（段の数が合わない）は、前の置き方を変えずに、縦並びで置く。
 */
function usePlacement(ids: LayerId[], ts: TierScreen | null, stage: Box): { placement: Placement; synced: boolean } {
  const prev = useRef<AlignMode>('aligned');
  const region = { top: 2, bottom: stage.height - AXIS_H - AXIS_GAP };
  const synced = ts !== null && stage.height > 0 && ids.every((id) => ts.shown[id] !== null && ts.goal[id] !== null);
  if (!synced) return { placement: stackedPlacement(ids.map((id) => ({ id, y: 0, goalY: 0 })), region), synced };
  const tiers: Tier[] = ids.map((id) => ({
    id,
    y: planeCenterY(ts, ts.shown[id] as number) - stage.top,
    goalY: planeCenterY({ ...ts, viewState: ts.goalView }, ts.goal[id] as number) - stage.top,
  }));
  const placement = placeCharts({ tiers, region, prev: prev.current });
  prev.current = placement.mode;
  return { placement, synced };
}

/** 揃える／縦並びが切り替わった直後の短いあいだだけ true。そのあいだ、チャートは滑らかに移る（切り替えで跳ねない）。 */
function useSettling(mode: AlignMode): boolean {
  const [settling, setSettling] = useState(false);
  const last = useRef(mode);
  useEffect(() => {
    if (last.current === mode) return;
    last.current = mode;
    setSettling(true);
    const t = window.setTimeout(() => setSettling(false), 450);
    return () => window.clearTimeout(t);
  }, [mode]);
  return settling;
}

/** 「断面」のときの、右の列の中身。 */
export default function SectionBody() {
  const { line, tracks } = useSectionTracks();
  const start = useMapStore((s) => s.sectionStart);
  const hoverD = useMapStore((s) => s.sectionHover);
  const setHover = useMapStore((s) => s.setSectionHover);
  const order = useMapStore((s) => s.order);
  const visible = useMapStore((s) => s.visible);
  const solo = useMapStore((s) => s.solo);
  const spacing = useMapStore((s) => s.spacing);
  const status = useMapStore((s) => s.status);
  const focus = useMapStore((s) => s.sectionFocus);
  const guideOpen = useMapStore((s) => s.open.guide);
  const toggleOpen = useMapStore((s) => s.toggleOpen);
  const [stageRef, stage] = useElementBox<HTMLDivElement>();
  const width = stage.width;
  const ts = useTierScreen();
  const ids = [...order].reverse().filter((id) => layerZ({ order, visible, solo, spacing }, id) !== null);
  const { placement, synced } = usePlacement(ids, ts, stage);
  const settling = useSettling(placement.mode);
  const lastSlot = placement.slots[placement.slots.length - 1];
  const axisTop = lastSlot ? lastSlot.center + placement.frameH / 2 + AXIS_GAP : 0;

  if (!line) {
    return (
      <div className="ic-hint" data-testid="section-hint" data-state={start ? 'start' : 'empty'}>
        {start ? (
          <>
            <p>
              始点（A）を置きました。<b>終点（B）</b>をクリックしてください。カーソルまでの線が下書きで出ます。
            </p>
            <p>
              やめるときは <span className="ic-dim">Esc</span> か{' '}
              <button type="button" className="ic-btn" onClick={releaseSection}>
                やめる
              </button>
            </p>
          </>
        ) : (
          <>
            <div className="sc-examples" data-testid="section-examples">
              {EXAMPLE_LINES.map((e) => (
                <button key={e.id} type="button" className="sc-example" data-testid="section-example" data-example={e.id} onClick={() => placeSection(e.line)}>
                  {e.title}
                </button>
              ))}
            </div>
            <Disclosure id="section-guide" testId="section-guide" open={guideOpen} onToggle={() => toggleOpen('guide')} title="線の引き方と、例の線について">
              <p>全体の地図の平面を1回クリックすると始点（A）、もう1回クリックすると終点（B）が決まります。</p>
              <p>2点を結ぶ線で全レイヤーを縦に切り、線に沿った変化を、地図の中に立てたグラフと、ここの平らなグラフで見比べられます。</p>
              <p>線を引いたあとは、両端の印か線をドラッグして動かせます。端点の外をクリックすると引き直せます。右の「全体」を選ぶか Esc を押すと、線が消えて全体に戻ります。</p>
              <dl className="sc-example-notes" data-testid="section-example-notes">
                {EXAMPLE_LINES.map((e) => (
                  <div key={e.id}>
                    <dt>{e.title}</dt>
                    <dd>{e.note}</dd>
                  </div>
                ))}
              </dl>
            </Disclosure>
          </>
        )}
      </div>
    );
  }

  const length = lineLength(line);
  const inner = Math.max(0, width - 2 * SIDE);
  return (
    <>
      <header className="ic-head" data-testid="section-head">
        <div className="ic-title sc-title-row">
          <span className="ic-district">断面</span>
          <span className="sc-len" data-testid="section-length">
            {formatLength(length)}
          </span>
          <Ends line={line} />
        </div>
      </header>
      {/* チャートを置く領域。各チャートは、全体の地図の対応する段と同じ高さに置く。置けないときは、上から順に並べる。 */}
      <div
        ref={stageRef}
        className="sc-stage"
        data-testid="section-scroll"
        data-layout={placement.mode}
        data-settling={settling ? '' : undefined}
        style={synced ? undefined : { visibility: 'hidden' }} // 全体の地図の段の位置がまだ届かない一瞬は、仮の位置を見せない
      >
        {inner > 0 &&
          ids.map((id) => {
            const slot = placement.slots.find((s) => s.id === id);
            if (!slot) return null;
            const hot = focus?.id === id;
            return (
              <Cell key={id} id={id} center={slot.center} frameH={placement.frameH} hot={hot}>
                {tracks[id] ? (
                  <Chart id={id} tracks={tracks[id] as SectionTrack[]} length={length} width={inner} frameH={placement.frameH} hoverD={hoverD} hot={hot} onHover={setHover} />
                ) : (
                  <Placeholder status={status[id]} label={LABELS[id]} frameH={placement.frameH} width={inner} />
                )}
              </Cell>
            );
          })}
        {inner > 0 && <Axis length={length} width={inner} hoverD={hoverD} top={axisTop} />}
      </div>
      <SectionHeadline line={line} />
    </>
  );
}
