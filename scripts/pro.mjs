// プロの判断の検証（日本株）。2026-11-17〜 オーナーの指示「機械的すぎる。もっと専門性を持って、突き詰めてちゃんとやって」
// 増配・上方修正のイベントごとに「プロが見るもの」を数字にして、どれが本当に効くかを前半（学習）・後半（テスト）で確かめる。
//   1) 相場の空気：前日の市場全体（全銘柄の平均）、市場の流れ（25日平均との差）、前夜の米国株（SPY）
//   2) 材料の中身：増配の大きさ、業績の上方修正も同時か、配当利回り、発表の時刻（場中か引け後か休日か）、発表日の反応、発表前の上昇
//   3) 銘柄の性格：値動きの荒さ、売買代金、株価の流れ（25日線との差）
//   4) 寄り付き（買う瞬間に分かる）：その株の寄り付きの上げ下げ、市場全体の寄り付き
//   売り方：その日の引け／5日／10日／マイナスなら最長10日持ち越し／値動きの荒さに合わせた損切り・利確
// 未来の情報は使わない：特徴は「シグナル日の終値まで」＋（寄り付きの特徴だけ）「買う日の始値」。モデルは前半だけで作り、後半で成績を見る。
// 出力は集計値だけ（個別銘柄の価格は出さない）。reports-out/pro-jp.json
import fs from 'node:fs';
import path from 'node:path';
import { detectEvents } from './lib/events.mjs';
import { proFeatures, proScore } from './lib/pro-features.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data';
const OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
const MIN_TURNOVER = 1e8, MIN_PRICE = 100;
fs.mkdirSync(OUT, { recursive: true });
const status = { startedAt: new Date().toISOString() };
const writeOut = (o) => fs.writeFileSync(path.join(OUT, 'pro-jp.json'), JSON.stringify(o, null, 1));

// ---------- データ ----------
const pdir = path.join(DATA, 'prices');
const files = fs.existsSync(pdir) ? fs.readdirSync(pdir).filter((f) => f.endsWith('.json')).sort() : [];
if (files.length < 300) { writeOut({ ok: false, reason: `データ不足（${files.length}日分）` }); process.exit(0); }
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
const STOCK_MKT = new Set(['0111', '0112', '0113']);
const codes = master.filter((m) => STOCK_MKT.has(m.Mkt)).map((m) => m.Code);
const ci = new Map(codes.map((c, i) => [c, i]));
const N = codes.length;
const dates = files.map((f) => f.slice(0, 10));
const D = dates.length;
const di = new Map(dates.map((x, k) => [x, k]));
const F = () => new Float32Array(N * D).fill(NaN);
const O = F(), H = F(), L = F(), C = F(), VA = F(), RO = F();
files.forEach((f, d) => {
  for (const [code, o, h, l, c, , va] of JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'))) {
    const i = ci.get(code);
    if (i === undefined || c == null || o == null) continue;
    const k = i * D + d;
    O[k] = o; H[k] = h; L[k] = l; C[k] = c; VA[k] = va;
  }
});
if (fs.existsSync(path.join(DATA, 'raw'))) {
  for (const f of fs.readdirSync(path.join(DATA, 'raw'))) {
    const d = di.get(f.slice(0, 10));
    if (d == null) continue;
    for (const [code, o] of JSON.parse(fs.readFileSync(path.join(DATA, 'raw', f), 'utf8'))) {
      const i = ci.get(code);
      if (i != null && o > 0) RO[i * D + d] = o;
    }
  }
}
const at = (A, i, d) => A[i * D + d];
const sma = (A, i, d, n) => { if (d < n - 1) return NaN; let s = 0; for (let k = d - n + 1; k <= d; k++) { const v = A[i * D + k]; if (Number.isNaN(v)) return NaN; s += v; } return s / n; };
const elig = new Uint8Array(N * D);
for (let i = 0; i < N; i++) for (let d = 20; d < D; d++) elig[i * D + d] = at(C, i, d) >= MIN_PRICE && sma(VA, i, d, 20) >= MIN_TURNOVER ? 1 : 0;

// 市場全体（流動性条件を満たす銘柄の等金額平均）：日次（前日終値→終値）と寄り付き（前日終値→始値）
const MKT = new Float64Array(D), MKTI = new Float64Array(D).fill(1), MGAP = new Float64Array(D).fill(NaN);
for (let d = 1; d < D; d++) {
  let s = 0, n = 0, g = 0, gn = 0;
  for (let i = 0; i < N; i++) {
    if (!elig[i * D + d - 1]) continue;
    const pc = at(C, i, d - 1);
    const r = at(C, i, d) / pc - 1, gp = at(O, i, d) / pc - 1;
    if (Number.isFinite(r) && Math.abs(r) < 0.5) { s += r; n++; }
    if (Number.isFinite(gp) && Math.abs(gp) < 0.5) { g += gp; gn++; }
  }
  MKT[d] = n ? s / n : 0; MKTI[d] = MKTI[d - 1] * (1 + MKT[d]); MGAP[d] = gn ? g / gn : NaN;
}
const mktMA = (d, n) => { if (d < n - 1) return NaN; let s = 0; for (let k = d - n + 1; k <= d; k++) s += MKTI[k]; return s / n; };
const MK = { r: (j) => MKT[j], idx: (j) => MKTI[j], ma: mktMA };

// ---------- 前夜の米国株（SPY、Stooqの日足。取れなければ使わない） ----------
const US = new Map(); // 米国の日付 → 前日終値→終値
try {
  const res = await fetch('https://stooq.com/q/d/l/?s=spy.us&i=d', { signal: AbortSignal.timeout(30000) });
  const t = await res.text();
  const rows = t.trim().split('\n').slice(1).map((l) => l.split(',')).filter((r) => r.length >= 5 && +r[4] > 0);
  for (let k = 1; k < rows.length; k++) US.set(rows[k][0], +rows[k][4] / +rows[k - 1][4] - 1);
  status.spyDays = US.size;
} catch (e) { status.spyError = e.name; }
const usDates = [...US.keys()].sort();
function usBefore(jpDate) { // 日本の取引日 jpDate の朝までに終わっている米国の取引日（jpDate より前の最後の日）
  let lo = 0, hi = usDates.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (usDates[m] < jpDate) lo = m + 1; else hi = m; }
  return lo > 0 ? US.get(usDates[lo - 1]) : null;
}

// ---------- イベント ----------
const rows = [];
const fdir = path.join(DATA, 'fins');
if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir).sort()) for (const r of JSON.parse(fs.readFileSync(path.join(fdir, f), 'utf8'))) rows.push(r);
const evs = detectEvents(rows);
const sameDisc = new Map(); // code|dd → kinds
for (const ev of evs) { const k = ev.c + '|' + ev.dd; if (!sameDisc.has(k)) sameDisc.set(k, new Set()); sameDisc.get(k).add(ev.kind); }
function signalDayFor(dd) { let lo = 0, hi = D; while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] > dd) hi = m; else lo = m + 1; } return lo < D ? lo - 1 : null; }

// ---------- 売り方（買う日 e の始値で買う） ----------
function outcomes(i, e, atr) {
  const o = at(O, i, e);
  if (!(o > 0)) return null;
  const entry = o * (1 + SLIP);
  const sell = (px) => (px * (1 - SLIP)) / entry - 1;
  const out = {};
  const c0 = at(C, i, e);
  if (c0 > 0) out.dt = { ret: sell(c0), days: 1 };
  const closeAfter = (n) => { const k = e + n - 1; return k < D && at(C, i, k) > 0 ? { ret: sell(at(C, i, k)), days: n } : null; };
  out.h5 = closeAfter(5); out.h10 = closeAfter(10);
  // マイナスで引けたら持ち越し、買値以上で引けた最初の日に売る（最長10日）
  if (c0 > 0 && e + 10 < D) {
    let px = c0, held = 0;
    if (sell(c0) < 0) for (let j = 1; j <= 10; j++) { const cj = at(C, i, e + j); if (!(cj > 0)) continue; px = cj; held = j; if (sell(cj) >= 0) break; }
    out.hl10 = { ret: sell(px), days: held + 1 };
  }
  // 値動きの荒さに合わせた損切り・利確（損切り 1.5×1日の値幅、利確 3×1日の値幅、最長10日。同じ日に両方なら損切りを優先）
  if (atr > 0 && e + 9 < D) {
    const sp = entry * (1 - 1.5 * atr), tp = entry * (1 + 3 * atr);
    for (let k = e; k <= e + 9; k++) {
      const ko = at(O, i, k), kh = at(H, i, k), kl = at(L, i, k), kc = at(C, i, k);
      if (!(kc > 0)) continue;
      if (k > e && ko <= sp) { out.atr = { ret: sell(ko), days: k - e + 1 }; break; }
      if (kl <= sp) { out.atr = { ret: sell(sp), days: k - e + 1 }; break; }
      if (k > e && ko >= tp) { out.atr = { ret: sell(ko), days: k - e + 1 }; break; }
      if (kh >= tp) { out.atr = { ret: sell(tp), days: k - e + 1 }; break; }
      if (k === e + 9) out.atr = { ret: sell(kc), days: 10 };
    }
  }
  return out;
}
const EXITS = { dt: 'その日の引けで売る', h5: '5日目の引けで売る', h10: '10日目の引けで売る', hl10: 'マイナスなら最長10日持ち越し（買値に戻った日に売る）', atr: '荒さに合わせた損切り・利確（最長10日）' };

// ---------- 特徴を作る ----------
const T = [];
const seen = new Set();
const countByDay = {};
for (const ev of evs) {
  if (ev.kind !== 'div_up' && ev.kind !== 'earn_up') continue;
  const i = ci.get(ev.c);
  const d = signalDayFor(ev.dd);
  if (i === undefined || d == null || d < 30 || d >= D - 1) continue;
  const key = ev.kind + '|' + i + '|' + d;
  if (seen.has(key) || !elig[i * D + d]) continue;
  seen.add(key);
  countByDay[ev.kind + '|' + d] = (countByDay[ev.kind + '|' + d] ?? 0) + 1;
  const e = d + 1;
  const q = (j) => (j >= 0 && at(C, i, j) > 0 ? { o: at(O, i, j), h: at(H, i, j), l: at(L, i, j), c: at(C, i, j), va: at(VA, i, j) } : null);
  const f = proFeatures(ev, d, q, (j) => (at(RO, i, j) > 0 ? at(RO, i, j) : NaN), MK, { sameKinds: sameDisc.get(ev.c + '|' + ev.dd) ?? new Set(), crowd: 1, isTradingDay: dates[d] === ev.dd });
  f.us1 = usBefore(dates[e]) ?? NaN;            // 前夜の米国株
  f.gap = at(O, i, e) / at(C, i, d) - 1;        // 寄り付きの上げ下げ（買う瞬間に分かる）
  f.mgap = MGAP[e];                             // 市場全体の寄り付き（買う瞬間に分かる）
  const out = outcomes(i, e, f.atr);
  if (!out) continue;
  T.push({ kind: ev.kind, i, d, e, half: d < Math.floor(D * 0.6) ? 'train' : 'test', year: dates[e].slice(0, 4), score: ev.score, f, out });
}
for (const t of T) t.f.crowd = Math.log2(countByDay[t.kind + '|' + t.d] ?? 1);
status.events = { div_up: T.filter((t) => t.kind === 'div_up').length, earn_up: T.filter((t) => t.kind === 'earn_up').length };
const split = Math.floor(D * 0.6);

// ---------- 集計の道具 ----------
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);
function summ(a) {
  if (!a.length) return { n: 0 };
  const s = a.slice().sort((x, y) => x - y);
  return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), win: r4(a.filter((x) => x > 0).length / a.length), p10: r4(s[Math.floor(a.length * 0.1)]), p90: r4(s[Math.floor(a.length * 0.9)]) };
}
const NUMF = ['size', 'withOther', 'withDown', 'nextYear', 'yield', 'react0', 'run5', 'run20', 'ma25', 'vol20', 'atr', 'liq', 'crowd', 'mkt1', 'mkt5', 'mktTrend', 'us1', 'gap', 'mgap'];
const OPENF = new Set(['gap', 'mgap']); // 寄り付きの瞬間に分かる特徴
const FNAME = {
  size: '引き上げ幅', withOther: '増配と上方修正が同時', withDown: '同時に下方修正', nextYear: '本決算での来期予想', yield: '配当利回り（引き上げ後）',
  react0: '発表日の値動き', run5: '発表前5日の上昇', run20: '発表前20日の上昇', ma25: '25日線との差', vol20: '値動きの荒さ（日々の上下）', atr: '1日の値幅の平均',
  liq: '売買代金', crowd: '同じ日の同じ材料の件数', mkt1: '前日の市場全体', mkt5: '市場全体の5日の動き', mktTrend: '市場全体と25日平均の差', us1: '前夜の米国株（SPY）',
  gap: 'その株の寄り付き（買う瞬間）', mgap: '市場全体の寄り付き（買う瞬間）', timing: '発表の時刻',
};
// 1つの特徴で分けた成績（区切りは前半のデータの5分位で決め、後半にも同じ区切りを使う）
function buckets(sub, fname, exit) {
  const tr = sub.filter((t) => t.half === 'train');
  if (fname === 'timing') {
    const g = {};
    for (const t of sub) { const r = t.out[exit]?.ret; if (r == null) continue; ((g[t.f.timing] ??= { train: [], test: [] })[t.half]).push(r); }
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { train: summ(v.train), test: summ(v.test) }]));
  }
  const vals = tr.map((t) => t.f[fname]).filter(Number.isFinite).sort((a, b) => a - b);
  if (vals.length < 50) return null;
  const uniq = [...new Set(vals)];
  const cuts = uniq.length <= 2 ? [uniq[0]] : [0.2, 0.4, 0.6, 0.8].map((q) => vals[Math.floor(vals.length * q)]).filter((v, k, a) => a.indexOf(v) === k);
  const label = (v) => { let b = 0; while (b < cuts.length && v > cuts[b]) b++; return b; };
  const g = {};
  for (const t of sub) {
    const v = t.f[fname], r = t.out[exit]?.ret;
    if (!Number.isFinite(v) || r == null) continue;
    const b = label(v);
    ((g[b] ??= { train: [], test: [], lo: Infinity, hi: -Infinity })[t.half]).push(r);
    if (t.half === 'train') { g[b].lo = Math.min(g[b].lo, v); g[b].hi = Math.max(g[b].hi, v); }
  }
  return Object.fromEntries(Object.keys(g).sort().map((b) => [b, { range: [r4(g[b].lo), r4(g[b].hi)], train: summ(g[b].train), test: summ(g[b].test) }]));
}

// ---------- 予測モデル（リッジ回帰。前半だけで作る） ----------
function design(t, cols, stats) {
  const x = [1];
  for (const c of cols) {
    if (c.startsWith('timing=')) { x.push(t.f.timing === c.slice(7) ? 1 : 0); continue; }
    const v = t.f[c];
    x.push(Number.isFinite(v) ? Math.max(-4, Math.min(4, (v - stats[c].m) / (stats[c].s || 1))) : 0);
  }
  return x;
}
function ridge(X, y, lam) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Float64Array(p)), b = new Float64Array(p);
  for (let r = 0; r < X.length; r++) { const x = X[r]; for (let a = 0; a < p; a++) { b[a] += x[a] * y[r]; for (let c = 0; c < p; c++) A[a][c] += x[a] * x[c]; } }
  for (let a = 1; a < p; a++) A[a][a] += lam * X.length;
  // ガウスの消去法
  const M = A.map((row, k) => [...row, b[k]]);
  for (let col = 0; col < p; col++) {
    let piv = col; for (let r = col + 1; r < p; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const dv = M[col][col] || 1e-12;
    for (let c = col; c <= p; c++) M[col][c] /= dv;
    for (let r = 0; r < p; r++) if (r !== col) { const f = M[r][col]; if (f) for (let c = col; c <= p; c++) M[r][c] -= f * M[col][c]; }
  }
  return M.map((row) => row[p]);
}
function fitModel(sub, exit, useOpen) {
  const tr = sub.filter((t) => t.half === 'train' && t.out[exit]);
  const cols = NUMF.filter((c) => (useOpen || !OPENF.has(c)) && tr.some((t) => Number.isFinite(t.f[c])));
  const stats = {};
  for (const c of cols) { const v = tr.map((t) => t.f[c]).filter(Number.isFinite); const m = v.reduce((a, b) => a + b, 0) / v.length; stats[c] = { m, s: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) }; }
  const allCols = [...cols, 'timing=intraday', 'timing=holiday'];
  const X = tr.map((t) => design(t, allCols, stats));
  const y = tr.map((t) => Math.max(-0.2, Math.min(0.2, t.out[exit].ret))); // 極端な1件に引っぱられないよう±20%で切る
  const w = ridge(X, y, 0.05);
  const pred = (t) => design(t, allCols, stats).reduce((a, v, k) => a + v * w[k], 0);
  const trScores = tr.map(pred).sort((a, b) => a - b);
  const q = (p) => trScores[Math.floor(trScores.length * p)];
  const cuts = [q(0.2), q(0.4), q(0.6), q(0.8)];
  // 効き方（係数）：大きい順。+ は「高いほど成績が良い」
  const coef = allCols.map((c, k) => ({ f: c.startsWith('timing=') ? (c === 'timing=intraday' ? '場中の発表（引け後と比べて）' : '休日の発表（引け後と比べて）') : FNAME[c], w: r4(w[k + 1] * 100) })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  return { pred, cuts, coef };
}
function quintiles(sub, exit, m) {
  const g = { train: [[], [], [], [], []], test: [[], [], [], [], []] };
  for (const t of sub) { const r = t.out[exit]?.ret; if (r == null) continue; const s = m.pred(t); let b = 0; while (b < 4 && s > m.cuts[b]) b++; g[t.half][b].push(r); }
  return { train: g.train.map(summ), test: g.test.map(summ) };
}

// ---------- 資金のシミュレーション ----------
// 1) 100万円・最大10銘柄・各10%（端株可）。2) 30万円・100株単位・最大2/3銘柄（ウィブルの日本株の条件）
function byDayOf(sub, exit, pick) {
  const m = new Map();
  for (const t of sub) {
    const o = t.out[exit]; if (!o) continue;
    const s = pick(t); if (s == null) continue;
    if (!m.has(t.d)) m.set(t.d, []);
    m.get(t.d).push({ i: t.i, ret: o.ret, days: o.days, score: s });
  }
  for (const a of m.values()) a.sort((x, y) => y.score - x.score);
  return m;
}
function sim(byDay, fromD, toD, { capital = 1_000_000, maxN = 10, lot = false } = {}) {
  let cash = capital, peak = capital, maxDD = 0, trades = 0, noMoney = 0;
  const pos = [];
  for (let d = fromD; d <= toD; d++) {
    for (let k = pos.length - 1; k >= 0; k--) if (pos[k].exitD <= d) { cash += pos[k].size * (1 + pos[k].ret); pos.splice(k, 1); }
    const eq = cash + pos.reduce((a, p) => a + p.size, 0);
    for (const s of byDay.get(d - 1) ?? []) {
      if (pos.length >= maxN) break;
      if (pos.some((p) => p.i === s.i)) continue;
      let size;
      if (lot) {
        const px = at(RO, s.i, d) > 0 ? at(RO, s.i, d) : at(O, s.i, d);
        const unit = px * 100 * (1 + SLIP);
        const lots = Math.floor(Math.min(cash, eq / maxN) / unit);
        if (lots < 1) { noMoney++; continue; }
        size = lots * unit;
      } else {
        size = Math.min(cash, eq / maxN);
        if (size < eq / maxN / 2) break;
      }
      cash -= size;
      pos.push({ i: s.i, exitD: d + s.days, ret: s.ret, size, entryPx: at(O, s.i, d) * (1 + SLIP) });
      trades++;
    }
    const m = cash + pos.reduce((a, p) => { const c = at(C, p.i, d); return a + (c > 0 ? p.size * (c * (1 - SLIP)) / p.entryPx : p.size); }, 0);
    peak = Math.max(peak, m); maxDD = Math.max(maxDD, 1 - m / peak);
  }
  for (const p of pos) cash += p.size * (1 + p.ret);
  return { returnPct: Math.round((cash / capital - 1) * 1000) / 10, maxDDPct: Math.round(maxDD * 1000) / 10, trades, noMoney };
}

// ---------- 実行 ----------
const result = { ok: true, generatedAt: new Date().toISOString(), status, periods: { train: [dates[30], dates[split - 1]], test: [dates[split], dates[D - 1]] }, exits: EXITS, features: FNAME, kinds: {} };
for (const kind of ['div_up', 'earn_up']) {
  const sub = T.filter((t) => t.kind === kind);
  const K = (result.kinds[kind] = { name: kind === 'div_up' ? '配当予想の引き上げ' : '業績予想の上方修正', n: { train: sub.filter((t) => t.half === 'train').length, test: sub.filter((t) => t.half === 'test').length }, exits: {} });
  for (const exit of Object.keys(EXITS)) {
    const base = { train: summ(sub.filter((t) => t.half === 'train' && t.out[exit]).map((t) => t.out[exit].ret)), test: summ(sub.filter((t) => t.half === 'test' && t.out[exit]).map((t) => t.out[exit].ret)) };
    const avgDays = { train: null, test: null };
    for (const h of ['train', 'test']) { const a = sub.filter((t) => t.half === h && t.out[exit]); avgDays[h] = a.length ? Math.round((a.reduce((x, t) => x + t.out[exit].days, 0) / a.length) * 100) / 100 : null; }
    const X = (K.exits[exit] = { name: EXITS[exit], base, avgDays, byFeature: {}, models: {} });
    for (const f of [...NUMF, 'timing']) { const b = buckets(sub, f, exit); if (b) X.byFeature[f] = b; }
    for (const useOpen of [false, true]) {
      const m = fitModel(sub, exit, useOpen);
      const key = useOpen ? 'atOpen' : 'preOpen';
      const top = (t) => { const s = m.pred(t); return s > m.cuts[2] ? s : null; }; // 前半の上位40%に入る点数だけ買う
      const top20 = (t) => { const s = m.pred(t); return s > m.cuts[3] ? s : null; };
      const all = (t) => t.score;
      const sims = {};
      for (const [nm, pick] of [['all', all], ['top40', top], ['top20', top20]]) {
        const bd = byDayOf(sub, exit, pick);
        sims[nm] = {
          fund10: { train: sim(bd, 31, split - 1), test: sim(bd, split, D - 1) },
          lot30x2: { train: sim(bd, 31, split - 1, { capital: 300000, maxN: 2, lot: true }), test: sim(bd, split, D - 1, { capital: 300000, maxN: 2, lot: true }) },
          lot30x3: { train: sim(bd, 31, split - 1, { capital: 300000, maxN: 3, lot: true }), test: sim(bd, split, D - 1, { capital: 300000, maxN: 3, lot: true }) },
        };
      }
      X.models[key] = { name: useOpen ? '寄り付きの情報も使う（買う瞬間に判断）' : '前の夜までの情報だけ', coef: m.coef.slice(0, 12), quintiles: quintiles(sub, exit, m), sims };
    }
  }
}
// ---------- 前半だけで選んだ「効く特徴」の点数（説明できる形のルール） ----------
// 選び方（前半だけ、後半は見ない）：特徴ごとに前半の5分位で、良い側の1/5（上位または下位）の平均が全体より一定以上（その日に売る=+0.2%、ほか=+0.5%）、
// かつ中央値も全体以上なら「効く」。発表の時刻・同時の上方修正など 0/1 の特徴は、良い側の平均が全体より上なら「効く」。
// 点数 = 効く特徴のうち、その銘柄が良い側に入っている数。寄り付きの特徴は使わない（前の夜までに分かることだけ）
result.scored = {};
for (const [kind, exit] of [['div_up', 'dt'], ['div_up', 'h5'], ['div_up', 'hl10'], ['div_up', 'h10'], ['earn_up', 'h5'], ['earn_up', 'h10']]) {
  const sub = T.filter((t) => t.kind === kind);
  const tr = sub.filter((t) => t.half === 'train' && t.out[exit]);
  const all = summ(tr.map((t) => t.out[exit].ret));
  const margin = exit === 'dt' ? 0.002 : 0.005;
  const chosen = [];
  for (const f of NUMF.filter((c) => !OPENF.has(c))) {
    const v = tr.map((t) => t.f[f]).filter(Number.isFinite).sort((a, b) => a - b);
    if (v.length < tr.length * 0.3) continue;
    const uniq = new Set(v);
    if (uniq.size <= 2) { // 0/1 の特徴
      const one = summ(tr.filter((t) => t.f[f] === 1).map((t) => t.out[exit].ret));
      if (one.n >= 50 && one.avg > all.avg && one.med >= all.med) chosen.push({ f, side: 'is1' });
      continue;
    }
    const lo = v[Math.floor(v.length * 0.2)], hi = v[Math.floor(v.length * 0.8)];
    const top = summ(tr.filter((t) => t.f[f] >= hi).map((t) => t.out[exit].ret)), bot = summ(tr.filter((t) => t.f[f] <= lo).map((t) => t.out[exit].ret));
    if (top.avg - all.avg >= margin && top.med >= all.med) chosen.push({ f, side: 'high', cut: hi });
    else if (bot.avg - all.avg >= margin && bot.med >= all.med) chosen.push({ f, side: 'low', cut: lo });
  }
  const intra = summ(tr.filter((t) => t.f.timing === 'intraday').map((t) => t.out[exit].ret));
  const useIntra = intra.n >= 50 && intra.avg > all.avg && intra.med >= all.med;
  const rules = { chosen: chosen.map((c) => ({ key: c.f, side: c.side, cut: c.cut ?? null })), useIntra };
  const score = (t) => proScore(t.f, rules);
  const byScore = {};
  for (const h of ['train', 'test']) for (let k = 0; k <= 4; k++) (byScore[k] ??= {})[h] = summ(sub.filter((t) => t.half === h && t.out[exit] && Math.min(score(t), 4) === k).map((t) => t.out[exit].ret));
  const sims = {};
  for (const [nm, pick] of [['all', (t) => t.score], ['score1', (t) => (score(t) >= 1 ? score(t) * 10 + t.score : null)], ['score2', (t) => (score(t) >= 2 ? score(t) * 10 + t.score : null)], ['score3', (t) => (score(t) >= 3 ? score(t) * 10 + t.score : null)]]) {
    const bd = byDayOf(sub, exit, pick);
    sims[nm] = {
      fund10: { train: sim(bd, 31, split - 1), test: sim(bd, split, D - 1) },
      lot30x2: { train: sim(bd, 31, split - 1, { capital: 300000, maxN: 2, lot: true }), test: sim(bd, split, D - 1, { capital: 300000, maxN: 2, lot: true }) },
      lot30x3: { train: sim(bd, 31, split - 1, { capital: 300000, maxN: 3, lot: true }), test: sim(bd, split, D - 1, { capital: 300000, maxN: 3, lot: true }) },
    };
  }
  result.scored[kind + '|' + exit] = {
    chosen: [...chosen.map((c) => ({ f: FNAME[c.f], side: c.side === 'is1' ? 'あると良い' : c.side === 'high' ? '高いほど良い' : '低いほど良い', cut: r4(c.cut) })), ...(useIntra ? [{ f: '場中の発表', side: 'あると良い' }] : [])],
    rules, byScore, sims,
  };
}
// ---------- デイトレの途中で売る（2026-11-18 オーナーの指摘「引けでしか売らないの？途中で売り抜けないのが嫌」） ----------
// 日足の高値・安値で、場中に「利益確定の指値（+X%）」と「損切り（-Y%）」を置いた場合を近似する。
// 同じ日に両方に届いた日は、どちらが先か分からないので「損切りが先」とする（悪い方に倒す）。損切りは逆指値が無いので、届いた値段からさらに0.5%悪く売れたとする
// 利益確定の指値は、買ったあとすぐ出しておける（ウィブルの日本株は指値あり）。どれにも届かなければ引けで売る
{
  const sub = T.filter((t) => t.kind === 'div_up');
  const tps = [null, 0.01, 0.02, 0.03, 0.05, 0.08], sls = [null, 0.02, 0.03, 0.05];
  const rules = {};
  for (const tp of tps) for (const sl of sls) {
    const key = `tp${tp ? tp * 100 : '-'}_sl${sl ? sl * 100 : '-'}`;
    const per = { train: [], test: [] }, hitTp = { train: 0, test: 0 }, hitSl = { train: 0, test: 0 };
    const bd = new Map();
    for (const t of sub) {
      const i = t.i, e = t.e, o = at(O, i, e), h = at(H, i, e), l = at(L, i, e), c = at(C, i, e);
      if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
      const entry = o * (1 + SLIP);
      let px = c * (1 - SLIP), how = 'close';
      if (sl && l <= o * (1 - sl)) { px = o * (1 - sl) * (1 - 0.005); how = 'sl'; }
      else if (tp && h >= o * (1 + tp)) { px = o * (1 + tp); how = 'tp'; }
      const r = px / entry - 1;
      per[t.half].push(r);
      if (how === 'tp') hitTp[t.half]++; if (how === 'sl') hitSl[t.half]++;
      if (!bd.has(t.d)) bd.set(t.d, []);
      bd.get(t.d).push({ i, ret: r, days: 1, score: t.score });
    }
    for (const a of bd.values()) a.sort((x, y) => y.score - x.score);
    rules[key] = {
      tp, sl,
      train: { ...summ(per.train), tpRate: r4(hitTp.train / (per.train.length || 1)), slRate: r4(hitSl.train / (per.train.length || 1)) },
      test: { ...summ(per.test), tpRate: r4(hitTp.test / (per.test.length || 1)), slRate: r4(hitSl.test / (per.test.length || 1)) },
      lot30x3: { train: sim(bd, 31, split - 1, { capital: 300000, maxN: 3, lot: true }), test: sim(bd, split, D - 1, { capital: 300000, maxN: 3, lot: true }) },
    };
  }
  result.dtIntraday = { note: '増配デイトレ（寄りで買う）。tp=利益確定の指値、sl=損切り。日足の高値・安値で近似、同じ日に両方なら損切りが先、損切りは0.5%余分に不利', rules };
}
// 年ごとの成績（増配・その日に売る／マイナスなら持ち越し）：偏りの確認
result.byYear = {};
for (const exit of ['dt', 'hl10', 'h5']) {
  const g = {};
  for (const t of T.filter((t) => t.kind === 'div_up')) { const r = t.out[exit]?.ret; if (r != null) (g[t.year] ??= []).push(r); }
  result.byYear[exit] = Object.fromEntries(Object.entries(g).map(([y, a]) => [y, summ(a)]));
}
// 仮想売買（scripts/paper.mjs）が使う「効く特徴」の選び方を保存する（前半だけで選んだもの）
try {
  fs.mkdirSync(path.join(DATA, 'paper'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'paper', 'pro-choice.json'), JSON.stringify({ chosenAt: new Date().toISOString(), trainTo: dates[split - 1], rules: Object.fromEntries(Object.entries(result.scored).map(([k, v]) => [k, v.rules])) }));
} catch (e) { status.choiceWriteError = e.message; }
status.finishedAt = new Date().toISOString();
writeOut(result);
console.log(`pro-jp ok: events div_up=${status.events.div_up} earn_up=${status.events.earn_up} spyDays=${status.spyDays ?? 0}`);
