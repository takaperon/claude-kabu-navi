// 前もって日付が分かる金融政策の発表と日本株（2026-11-21〜、オーナー「利上げ発表なども加味して提案するように」）
//   日銀の金融政策決定会合の決定日（昼ごろ発表）と、米FOMCの決定（日本時間の早朝）の後の最初の東証の日
//   A) 市場全体：その日の寄り→引け、前日の引け→引け（ほかの日と比べる）
//   B) 増配デイトレ（寄りで買って引けで売る、reports-out/jp-events.json の dt）：買う日が日銀の日・FOMCの次の日・それ以外
// 日程は前もって公表される（未来の情報ではない）。公開は集計値だけ（reports-out/macro-jp.json）
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data', OUT = args.out ?? 'reports-out';
fs.mkdirSync(OUT, { recursive: true });
// 日銀の決定日。2026・2027 は日銀の公表日程（boj.or.jp、2026-11-21 確認）。2021〜2025 は Claude の知識（確かさは中）
const BOJ = ['2021-01-21', '2021-03-19', '2021-04-27', '2021-06-18', '2021-07-16', '2021-09-22', '2021-10-28', '2021-12-17',
  '2022-01-18', '2022-03-18', '2022-04-28', '2022-06-17', '2022-07-21', '2022-09-22', '2022-10-28', '2022-12-20',
  '2023-01-18', '2023-03-10', '2023-04-28', '2023-06-16', '2023-07-28', '2023-09-22', '2023-10-31', '2023-12-19',
  '2024-01-23', '2024-03-19', '2024-04-26', '2024-06-14', '2024-07-31', '2024-09-20', '2024-10-31', '2024-12-19',
  '2025-01-24', '2025-03-19', '2025-05-01', '2025-06-17', '2025-07-31', '2025-09-19', '2025-10-30', '2025-12-19',
  '2026-01-23', '2026-03-19', '2026-04-28', '2026-06-16', '2026-07-31', '2026-09-18', '2026-10-30', '2026-12-18',
  '2027-01-22', '2027-03-18', '2027-04-28', '2027-06-11', '2027-07-22', '2027-09-22', '2027-10-29', '2027-12-17'];
// FOMC の決定日（米国時間）。scripts/us/macro.mjs と同じ一覧
const FOMC = ['2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16', '2021-07-28', '2021-09-22', '2021-11-03', '2021-12-15',
  '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
  '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08'];
const pdir = path.join(DATA, 'prices');
const files = fs.readdirSync(pdir).filter((f) => f.endsWith('.json')).sort();
const dates = files.map((f) => f.slice(0, 10)), D = dates.length;
const firstOnOrAfter = (iso) => { const k = dates.findIndex((d) => d >= iso); return k < 0 ? null : k; };
const firstAfter = (iso) => { const k = dates.findIndex((d) => d > iso); return k < 0 ? null : k; };
// 市場全体（売買代金1億円以上・100円以上の平均）
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
const STOCK = new Set(['0111', '0112', '0113']);
const codes = master.filter((m) => STOCK.has(m.Mkt)).map((m) => m.Code);
const ci = new Map(codes.map((c, i) => [c, i])), N = codes.length;
const O = new Float32Array(N * D).fill(NaN), C = O.slice(), VA = O.slice();
files.forEach((f, d) => { for (const [code, o, , , c, , va] of JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'))) { const i = ci.get(code); if (i === undefined) continue; O[i * D + d] = o; C[i * D + d] = c; VA[i * D + d] = va; } });
const at = (A, i, d) => (d >= 0 && d < D ? A[i * D + d] : NaN);
const liq = new Uint8Array(N * D);
for (let i = 0; i < N; i++) { let s = 0, n = 0; for (let d = 0; d < D; d++) { const v = at(VA, i, d); if (v > 0) { s += v; n++; } if (d >= 20) { const w = at(VA, i, d - 20); if (w > 0) { s -= w; n--; } } liq[i * D + d] = d >= 20 && n >= 15 && s / n >= 1e8 && at(C, i, d) >= 100 ? 1 : 0; } }
const CC = new Float64Array(D), OC = new Float64Array(D), GAP = new Float64Array(D);
for (let d = 1; d < D; d++) { let s = 0, n = 0, so = 0, no = 0, sg = 0, ng = 0; for (let i = 0; i < N; i++) { if (!liq[i * D + d - 1]) continue; const r = at(C, i, d) / at(C, i, d - 1) - 1; if (Number.isFinite(r) && Math.abs(r) < 0.5) { s += r; n++; } const ro = at(C, i, d) / at(O, i, d) - 1; if (Number.isFinite(ro) && Math.abs(ro) < 0.5) { so += ro; no++; } const g = at(O, i, d) / at(C, i, d - 1) - 1; if (Number.isFinite(g) && Math.abs(g) < 0.5) { sg += g; ng++; } } CC[d] = n ? s / n : 0; OC[d] = no ? so / no : 0; GAP[d] = ng ? sg / ng : 0; }
const split = Math.floor(D * 0.6);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
function summ(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), up: r4(a.filter((x) => x > 0).length / a.length), sd: r4(Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length - (a.reduce((x, y) => x + y, 0) / a.length) ** 2)) }; }
const bojK = new Set(BOJ.map(firstOnOrAfter).filter((k) => k != null && dates[k] && BOJ.includes(dates[k])));
const fomcK = new Set(FOMC.map(firstAfter).filter((k) => k != null && k > 0)); // FOMC の結果を受けた最初の東証の日
const label = (k) => (bojK.has(k) ? '日銀の決定日' : fomcK.has(k) ? 'FOMCの次の日' : 'それ以外');
const A = {};
for (let k = 21; k < D; k++) { const h = k < split ? 'train' : 'test'; const g = (A[label(k)] ??= { oc: { train: [], test: [] }, cc: { train: [], test: [] }, gap: { train: [], test: [] } }); g.oc[h].push(OC[k]); g.cc[h].push(CC[k]); g.gap[h].push(GAP[k]); }
let ev = [];
try { ev = JSON.parse(fs.readFileSync(path.join(OUT, 'jp-events.json'), 'utf8')).list; } catch {}
const di = new Map(dates.map((d, k) => [d, k]));
const B = {};
for (const e of ev) { const k = di.get(e.e); if (k == null || e.dt == null) continue; const h = k < split ? 'train' : 'test'; ((B[label(k)] ??= { train: [], test: [] })[h]).push(e.dt); ((B['全部'] ??= { train: [], test: [] })[h]).push(e.dt); }
const fin = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.train ? { train: summ(v.train), test: summ(v.test) } : fin(v)]));
const today = dates[D - 1];
fs.writeFileSync(path.join(OUT, 'macro-jp.json'), JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), asOf: today, periods: { train: [dates[21], dates[split - 1]], test: [dates[split], today] },
  note: 'A) 市場全体（売買代金1億円以上の平均）の、寄り→引け（oc）・前日の引け→引け（cc）・寄り付きの上げ下げ（gap）。B) 増配デイトレ（寄り→引け、jp-events.json の dt は2023-11以降だけ）を買う日で分けた。sd＝ばらつき',
  upcomingBoj: BOJ.filter((d) => d > today).slice(0, 3), upcomingFomcJp: FOMC.filter((d) => d >= today).slice(0, 3).map((d) => d + 'の次の東証の日'),
  market: fin(A), divDaytrade: fin(B), counts: { boj: bojK.size, fomcNext: fomcK.size, events: ev.length } }, null, 1));
console.log(`macro-jp ok: boj=${bojK.size} fomc=${fomcK.size} events=${ev.length}`);
