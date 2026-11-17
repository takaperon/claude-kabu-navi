// 「上がる前の気配」の検証（日本株）。2026-11-18〜 オーナーの指示「上がる前の気配を察知できるように。上がってから買うのはプロじゃない」
// 1) 進捗率：四半期決算で、通期の会社予想に対して営業利益がどこまで進んでいるか（前の年の同じ時期の進み方と比べた「進みすぎ」）。
//    進みすぎている会社は、あとで上方修正しやすい＝上がる前に仕込めるか。上方修正が出た割合と、その後の株価（全銘柄平均との差）
// 2) 値動きの前兆：毎日（5日おき）の全銘柄について、その日の引けまでに分かること（出来高の増え方・値幅の縮み・高値との距離・業種の勢い・
//    次の決算までの日数・進捗率など）から、次の5日に大きく上がる（+10%以上）株を当てられるか。前半だけでモデルを作り、後半で確かめる
// 未来の情報は使わない。公開は集計値だけ（reports-out/precursor-jp.json）
import fs from 'node:fs';
import path from 'node:path';
import { detectEvents } from './lib/events.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data', OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
fs.mkdirSync(OUT, { recursive: true });
const pdir = path.join(DATA, 'prices');
const files = fs.readdirSync(pdir).filter((f) => f.endsWith('.json')).sort();
const dates = files.map((f) => f.slice(0, 10));
const D = dates.length;
const di = new Map(dates.map((x, k) => [x, k]));
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
const STOCK = new Set(['0111', '0112', '0113']);
const ms = master.filter((m) => STOCK.has(m.Mkt));
const codes = ms.map((m) => m.Code);
const sectorOf = ms.map((m) => String(m.S33 ?? m.Sector33Code ?? ''));
const ci = new Map(codes.map((c, i) => [c, i]));
const N = codes.length;
const O = new Float32Array(N * D).fill(NaN), H = O.slice(), L = O.slice(), C = O.slice(), V = O.slice(), VA = O.slice();
files.forEach((f, d) => { for (const [code, o, h, l, c, v, va] of JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'))) { const i = ci.get(code); if (i === undefined) continue; const k = i * D + d; O[k] = o; H[k] = h; L[k] = l; C[k] = c; V[k] = v; VA[k] = va; } });
const at = (A, i, d) => A[i * D + d];
const split = Math.floor(D * 0.6);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
function summ(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), win: r4(a.filter((x) => x > 0).length / a.length) }; }

// 流動性・市場平均
const liq = new Uint8Array(N * D);
for (let i = 0; i < N; i++) { let s = 0, n = 0; for (let d = 0; d < D; d++) { const v = at(VA, i, d); if (v > 0) { s += v; n++; } if (d >= 20) { const w = at(VA, i, d - 20); if (w > 0) { s -= w; n--; } } liq[i * D + d] = d >= 20 && n >= 15 && s / n >= 1e8 && at(C, i, d) >= 100 ? 1 : 0; } }
const MKTC = new Float64Array(D).fill(1); // 市場全体の指数（終値ベース）
for (let d = 1; d < D; d++) { let s = 0, n = 0; for (let i = 0; i < N; i++) { if (!liq[i * D + d - 1]) continue; const r = at(C, i, d) / at(C, i, d - 1) - 1; if (Number.isFinite(r) && Math.abs(r) < 0.5) { s += r; n++; } } MKTC[d] = MKTC[d - 1] * (1 + (n ? s / n : 0)); }
const mktFromOpen = (e, n) => { // 寄り→n日後の引けの市場平均（近似：前日終値→n日後の終値の指数）
  const k = e + n - 1; return k < D ? MKTC[k] / MKTC[e - 1] - 1 : NaN;
};

// ---------- 開示 ----------
const rows = [];
const fdir = path.join(DATA, 'fins');
if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir).sort()) for (const r of JSON.parse(fs.readFileSync(path.join(fdir, f), 'utf8'))) rows.push(r);
rows.sort((a, b) => (a.dd + (a.dt ?? '')).localeCompare(b.dd + (b.dt ?? '')));
const evs = detectEvents(rows);
const earnUpBy = new Map(); // code → [dd]
for (const e of evs) if (e.kind === 'earn_up') { if (!earnUpBy.has(e.c)) earnUpBy.set(e.c, []); earnUpBy.get(e.c).push(e.dd); }
function signalDayFor(dd) { let lo = 0, hi = D; while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] > dd) hi = m; else lo = m + 1; } return lo < D ? lo - 1 : null; }

// ---------- 1) 進捗率 ----------
const isRes = (r) => /FinancialStatements/.test(r.ty ?? '');
const fyActual = new Map(); // code|fy → 通期の営業利益（実績）
const qActual = new Map();  // code|fy|pt → 四半期累計の営業利益
for (const r of rows) if (isRes(r) && r.op != null && r.fy) { if (r.pt === 'FY') fyActual.set(r.c + '|' + r.fy, r.op); else qActual.set(r.c + '|' + r.fy + '|' + r.pt, r.op); }
const prevFy = (fy) => { const y = +fy.slice(0, 4) - 1; return `${y}${fy.slice(4)}`; };
const NORM = { '1Q': 0.25, '2Q': 0.5, '3Q': 0.75 };
const lastProg = new Map(); // code → [{d, excess}] 2) で使う
const progRows = [];
for (const r of rows) {
  if (!isRes(r) || !NORM[r.pt] || !(r.op != null) || !(r.fop > 0)) continue;
  const prog = r.op / r.fop;
  if (!Number.isFinite(prog) || prog < -1 || prog > 3) continue;
  const pf = prevFy(r.fy), lyQ = qActual.get(r.c + '|' + pf + '|' + r.pt), lyF = fyActual.get(r.c + '|' + pf);
  const norm = lyQ != null && lyF > 0 && lyQ / lyF > -1 && lyQ / lyF < 2 ? lyQ / lyF : NORM[r.pt];
  const excess = prog - norm;
  const i = ci.get(r.c);
  const d = signalDayFor(r.dd);
  if (i === undefined || d == null || d < 25 || d >= D - 2) continue;
  if (!lastProg.has(r.c)) lastProg.set(r.c, []);
  lastProg.get(r.c).push({ d, excess, pt: r.pt });
  if (!liq[i * D + d]) continue;
  // 次の決算（約3か月後）までに上方修正が出たか
  const until = new Date(r.dd); until.setDate(until.getDate() + 100);
  const ups = (earnUpBy.get(r.c) ?? []).filter((x) => x > r.dd && x <= until.toISOString().slice(0, 10));
  const e = d + 1, o = at(O, i, e);
  if (!(o > 0)) continue;
  const res = {};
  for (const n of [20, 60]) { if (e + n - 1 >= D) continue; const c = at(C, i, e + n - 1); if (c > 0) res['h' + n] = (c * (1 - SLIP)) / (o * (1 + SLIP)) - 1 - mktFromOpen(e, n); }
  // 「気配で仕込む」：次の決算の約20営業日前に買い、次の決算の2営業日後に売る（次の決算日は約63営業日後と見込む。実際の日は使わない）
  const b = d + 43, s2 = d + 65;
  if (s2 < D && at(O, i, b) > 0 && at(C, i, s2) > 0) res.pre = (at(C, i, s2) * (1 - SLIP)) / (at(O, i, b) * (1 + SLIP)) - 1 - (MKTC[s2] / MKTC[b - 1] - 1);
  progRows.push({ half: d < split ? 'train' : 'test', pt: r.pt, prog, excess, normFromLastYear: lyQ != null, up: ups.length > 0, ...res });
}
const cutsOf = (vals) => { const s = vals.filter(Number.isFinite).sort((a, b) => a - b); return [0.2, 0.4, 0.6, 0.8].map((q) => s[Math.floor(s.length * q)]); };
const pcuts = cutsOf(progRows.filter((x) => x.half === 'train').map((x) => x.excess));
const progress = { note: '進みすぎ＝通期予想に対する営業利益の進み具合 − 前の年の同じ時期の進み具合（無ければ 25/50/75%）。区切りは前半の5分位。h20/h60/pre は全銘柄平均との差', cuts: pcuts.map(r4), byBucket: {} };
for (let b = 0; b < 5; b++) {
  const g = (h) => progRows.filter((x) => x.half === h && (() => { let k = 0; while (k < 4 && x.excess > pcuts[k]) k++; return k === b; })());
  progress.byBucket[b] = Object.fromEntries(['train', 'test'].map((h) => { const a = g(h); return [h, { n: a.length, upRate: r4(a.filter((x) => x.up).length / (a.length || 1)), h20: summ(a.filter((x) => x.h20 != null).map((x) => x.h20)), h60: summ(a.filter((x) => x.h60 != null).map((x) => x.h60)), pre: summ(a.filter((x) => x.pre != null).map((x) => x.pre)) }]; }));
}
// 第3四半期だけ（通期まで残りが短く、進みすぎが一番はっきりする）
progress.q3 = {};
for (let b = 0; b < 5; b++) {
  progress.q3[b] = Object.fromEntries(['train', 'test'].map((h) => { const a = progRows.filter((x) => x.half === h && x.pt === '3Q' && (() => { let k = 0; while (k < 4 && x.excess > pcuts[k]) k++; return k === b; })()); return [h, { n: a.length, upRate: r4(a.filter((x) => x.up).length / (a.length || 1)), h20: summ(a.filter((x) => x.h20 != null).map((x) => x.h20)), pre: summ(a.filter((x) => x.pre != null).map((x) => x.pre)) }]; }));
}

// ---------- 2) 値動きの前兆 ----------
const FEAT = ['volUp', 'squeeze', 'hi52', 'ret5', 'ret20', 'ma25', 'secMom', 'mkt5', 'toEarn', 'progEx', 'liqLog', 'gapPrev', 'upDays'];
const FNAME = { volUp: '出来高の増え方（5日/60日）', squeeze: '値幅の縮み（10日/60日）', hi52: '52週高値との差', ret5: '直近5日の上げ', ret20: '直近20日の上げ', ma25: '25日線との差', secMom: '同じ業種の5日の勢い', mkt5: '市場の5日の動き', toEarn: '次の決算までの日数（見込み）', progEx: '進捗率の進みすぎ', liqLog: '売買代金', gapPrev: 'その日の寄りの上げ下げ', upDays: '直近10日の上げた日数' };
// 業種の5日の勢い
const secIdx = new Map(); sectorOf.forEach((s, i) => { if (!secIdx.has(s)) secIdx.set(s, []); secIdx.get(s).push(i); });
const secMom = new Map(); // s|d
const lastDiscD = new Map(); // code → 開示（決算）のシグナル日のリスト
for (const r of rows) if (isRes(r)) { const d = signalDayFor(r.dd); if (d != null) { if (!lastDiscD.has(r.c)) lastDiscD.set(r.c, []); lastDiscD.get(r.c).push(d); } }
const X = [], Y = [], J = [], HALF = [], DAY = [], IDX = [];
for (let d = 260; d < D - 6; d += 5) {
  for (const [s, list] of secIdx) { let t = 0, n = 0; for (const i of list) { const r = at(C, i, d) / at(C, i, d - 5) - 1; if (liq[i * D + d] && Number.isFinite(r) && Math.abs(r) < 1) { t += r; n++; } } secMom.set(s + '|' + d, n >= 3 ? t / n : NaN); }
  for (let i = 0; i < N; i++) {
    if (!liq[i * D + d]) continue;
    const c = at(C, i, d); if (!(c > 0)) continue;
    let v5 = 0, v60 = 0, r10 = 0, r60 = 0, hi = -Infinity, up = 0, ok = true;
    for (let k = d - 59; k <= d; k++) { const vv = at(V, i, k); const rg = (at(H, i, k) - at(L, i, k)) / at(C, i, k - 1); if (!(vv >= 0) || !Number.isFinite(rg)) { ok = false; break; } v60 += vv; r60 += rg; if (k > d - 5) v5 += vv; if (k > d - 10) { r10 += rg; if (at(C, i, k) > at(C, i, k - 1)) up++; } }
    if (!ok || v60 <= 0 || r60 <= 0) continue;
    for (let k = d - 251; k <= d; k++) { const h = at(H, i, k); if (h > hi) hi = h; }
    let s25 = 0; for (let k = d - 24; k <= d; k++) s25 += at(C, i, k);
    const disc = lastDiscD.get(codes[i]) ?? [];
    let lastD = -1; for (const x of disc) if (x <= d && x > lastD) lastD = x;
    const toEarn = lastD >= 0 ? Math.max(0, 63 - (d - lastD)) : NaN;
    const lp = (lastProg.get(codes[i]) ?? []).filter((x) => x.d <= d && d - x.d < 70).at(-1);
    const e = d + 1, o = at(O, i, e);
    let mx = -Infinity; for (let k = e; k < e + 5; k++) { const cc = at(C, i, k); if (cc > 0) mx = Math.max(mx, cc / c - 1); }
    const c5 = at(C, i, e + 4);
    if (!(o > 0) || !(c5 > 0)) continue;
    X.push([v5 / 5 / (v60 / 60), r10 / 10 / (r60 / 60), c / hi - 1, c / at(C, i, d - 5) - 1, c / at(C, i, d - 20) - 1, c / (s25 / 25) - 1, secMom.get(sectorOf[i] + '|' + d), MKTC[d] / MKTC[d - 5] - 1, toEarn, lp ? lp.excess : NaN, Math.log10(at(VA, i, d)), at(O, i, d) / at(C, i, d - 1) - 1, up]);
    Y.push((c5 * (1 - SLIP)) / (o * (1 + SLIP)) - 1 - mktFromOpen(e, 5));
    J.push(mx >= 0.1 ? 1 : 0);
    HALF.push(d < split ? 0 : 1); DAY.push(d); IDX.push(i);
  }
}
// 標準化（前半だけで）
const P = FEAT.length, tr = HALF.map((h, k) => (h === 0 ? k : -1)).filter((k) => k >= 0);
const mu = new Array(P).fill(0), sd = new Array(P).fill(1);
for (let p = 0; p < P; p++) { const v = tr.map((k) => X[k][p]).filter(Number.isFinite); const m = v.reduce((a, b) => a + b, 0) / v.length; mu[p] = m; sd[p] = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1; }
const z = (row) => [1, ...row.map((v, p) => (Number.isFinite(v) ? Math.max(-4, Math.min(4, (v - mu[p]) / sd[p])) : 0))];
function ridge(rowsIdx, target, lam) {
  const q = P + 1, A = Array.from({ length: q }, () => new Float64Array(q)), b = new Float64Array(q);
  for (const k of rowsIdx) { const x = z(X[k]), y = target[k]; for (let a = 0; a < q; a++) { b[a] += x[a] * y; for (let c2 = 0; c2 < q; c2++) A[a][c2] += x[a] * x[c2]; } }
  for (let a = 1; a < q; a++) A[a][a] += lam * rowsIdx.length;
  const M = A.map((row, k) => [...row, b[k]]);
  for (let col = 0; col < q; col++) { let piv = col; for (let r = col + 1; r < q; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r; [M[col], M[piv]] = [M[piv], M[col]]; const dv = M[col][col] || 1e-12; for (let c2 = col; c2 <= q; c2++) M[col][c2] /= dv; for (let r = 0; r < q; r++) if (r !== col) { const f = M[r][col]; if (f) for (let c2 = col; c2 <= q; c2++) M[r][c2] -= f * M[col][c2]; } }
  return M.map((row) => row[q]);
}
const precursor = { samples: { train: tr.length, test: HALF.length - tr.length }, baseJumpRate: {}, models: {} };
for (const h of [0, 1]) { const ks = HALF.map((x, k) => (x === h ? k : -1)).filter((k) => k >= 0); precursor.baseJumpRate[h ? 'test' : 'train'] = r4(ks.reduce((a, k) => a + J[k], 0) / ks.length); }
const Yc = Y.map((y) => Math.max(-0.3, Math.min(0.3, y)));
for (const [name, target] of [['jump', J], ['ret5', Yc]]) {
  const w = ridge(tr, target, 0.01);
  const pred = (k) => z(X[k]).reduce((a, v, p) => a + v * w[p], 0);
  const trS = tr.map(pred).sort((a, b) => a - b);
  const cuts = [0.5, 0.8, 0.9, 0.95, 0.99].map((q) => trS[Math.floor(trS.length * q)]);
  const lab = ['下位50%', '50〜80%', '80〜90%', '90〜95%', '95〜99%', '上位1%'];
  const g = { train: lab.map(() => ({ j: 0, y: [], n: 0 })), test: lab.map(() => ({ j: 0, y: [], n: 0 })) };
  for (let k = 0; k < X.length; k++) { const s = pred(k); let b = 0; while (b < 5 && s > cuts[b]) b++; const G = g[HALF[k] ? 'test' : 'train'][b]; G.n++; G.j += J[k]; G.y.push(Y[k]); }
  // 毎回（5日ごと）、点数の上位10銘柄を寄りで買って5日持つ（全銘柄平均との差の平均）
  const byDay = new Map(); for (let k = 0; k < X.length; k++) { if (!byDay.has(DAY[k])) byDay.set(DAY[k], []); byDay.get(DAY[k]).push([pred(k), Y[k], HALF[k]]); }
  const top = { train: [], test: [] };
  for (const arr of byDay.values()) { arr.sort((a, b) => b[0] - a[0]); const t10 = arr.slice(0, 10); top[t10[0][2] ? 'test' : 'train'].push(t10.reduce((a, x) => a + x[1], 0) / t10.length); }
  precursor.models[name] = {
    name: name === 'jump' ? '次の5日で+10%以上になるかを当てる' : '次の5日の成績（全銘柄平均との差）を当てる',
    coef: FEAT.map((f, p) => ({ f: FNAME[f], w: r4(w[p + 1] * 100) })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)),
    byScore: Object.fromEntries(['train', 'test'].map((h) => [h, lab.map((l, b) => ({ group: l, n: g[h][b].n, jumpRate: r4(g[h][b].j / (g[h][b].n || 1)), ret5: summ(g[h][b].y) }))])),
    top10Every5Days: { train: summ(top.train), test: summ(top.test) },
  };
}
const out = { ok: true, generatedAt: new Date().toISOString(), periods: { train: [dates[260], dates[split - 1]], test: [dates[split], dates[D - 7]] }, progress, precursor };
fs.writeFileSync(path.join(OUT, 'precursor-jp.json'), JSON.stringify(out, null, 1));
console.log(`precursor-jp ok: prog=${progRows.length} samples=${X.length}`);
