// プロの判断の検証（米国株・決算への反応）。2026-11-17〜 オーナーの指示「機械的すぎる。もっと専門性を持って、突き詰めて」
// 今のルール：決算の翌日（反応日）に+10%以上 → 次の取引日の始値で買って20日持つ。
// ここでは反応日に+5%以上の銘柄すべてについて「プロが見るもの」を数字にし、どれが本当に効くかを前半・後半で確かめる。
//   反応の質：上げ幅、寄り付きで跳ねたのか場中に買われたのか、高値引けか（その日の値幅のどこで終わったか）、出来高の増え方
//   材料の中身：EPS・売上の前年比（SEC）、アナリスト予想との差（Alpha Vantage、取れた銘柄だけ）
//   位置：発表前の上昇、52週高値との差（高値更新か）、50日線との差、値動きの荒さ、売買代金
//   相場の空気：S&P500と200日平均の差、反応日のS&P500、5日の動き
//   寄り付き（買う瞬間に分かる）：買う日の寄り付きの上げ下げ
//   売り方：5・10・20・40日、荒さに合わせた損切り（20日まで）、20日線割れで売る（最長40日）
// 未来の情報は使わない。モデルは前半だけで作り、後半で成績を見る。出力は集計値だけ（reports-out/pro-us.json）
import fs from 'node:fs';
import path from 'node:path';
import { usFeatures, usScore, sma, yoy } from './lib-pro.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data-us';
const OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
fs.mkdirSync(OUT, { recursive: true });
const writeOut = (o) => fs.writeFileSync(path.join(OUT, 'pro-us.json'), JSON.stringify(o, null, 1));
const spyF = path.join(DATA, 'prices', 'SPY.json');
if (!fs.existsSync(spyF)) { writeOut({ ok: false, reason: 'データ不足' }); process.exit(0); }
const spy = JSON.parse(fs.readFileSync(spyF, 'utf8'));
const dates = spy.map((r) => r[0]);
const D = dates.length;
const di = new Map(dates.map((d, k) => [d, k]));
const SPC = spy.map((r) => r[4]);
const universe = JSON.parse(fs.readFileSync(path.join(DATA, 'universe.json'), 'utf8')).list;
const S = [];
for (const u of universe) {
  const f = path.join(DATA, 'prices', `${u.t}.json`);
  if (!fs.existsSync(f)) continue;
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (rows.length < 260) continue;
  const O = new Float64Array(D).fill(NaN), H = O.slice(), L = O.slice(), C = O.slice(), V = O.slice(), RC = O.slice();
  for (const [d, o, h, l, c, v, , , rc] of rows) { const k = di.get(d); if (k === undefined) continue; O[k] = o; H[k] = h; L[k] = l; C[k] = c; V[k] = v; RC[k] = rc; }
  const secF = path.join(DATA, 'sec', `${u.t}.json`);
  const sec = fs.existsSync(secF) ? JSON.parse(fs.readFileSync(secF, 'utf8')) : { earnings: [], eps: [], rev: [] };
  const avF = path.join(DATA, 'av', `${u.t}.json`);
  const av = fs.existsSync(avF) ? JSON.parse(fs.readFileSync(avF, 'utf8')) : null;
  S.push({ ...u, O, H, L, C, V, RC, sec, av });
}
const firstIdx = (d) => { let lo = 0, hi = D; while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] >= d) hi = m; else lo = m + 1; } return lo < D ? lo : null; };
const split = Math.floor(D * 0.6);
const spyMA200 = (k) => sma(SPC, k, 200);

// ---------- 売り方（entry の始値で買う） ----------
function outcomes(s, entry, atr) {
  const o = s.O[entry]; if (!(o > 0)) return null;
  const px = o * (1 + SLIP), sell = (p) => (p * (1 - SLIP)) / px - 1;
  const out = {};
  for (const n of [5, 10, 20, 40]) { const k = entry + n - 1; if (k < D && s.C[k] > 0) out['h' + n] = { ret: sell(s.C[k]), days: n }; }
  if (atr > 0 && entry + 19 < D) { // 損切り 2×1日の値幅（最長20日）
    const sp = px * (1 - 2 * atr);
    for (let k = entry; k <= entry + 19; k++) {
      if (!(s.C[k] > 0)) continue;
      if (k > entry && s.O[k] <= sp) { out.stop20 = { ret: sell(s.O[k]), days: k - entry + 1 }; break; }
      if (s.L[k] <= sp) { out.stop20 = { ret: sell(sp), days: k - entry + 1 }; break; }
      if (k === entry + 19) out.stop20 = { ret: sell(s.C[k]), days: 20 };
    }
  }
  if (entry + 39 < D) { // 終値が20日線を割ったら翌朝売る（最長40日）。勢いが続く限り持つ
    for (let k = entry + 1; k <= entry + 39; k++) {
      if (!(s.C[k] > 0)) continue;
      if (s.C[k] < sma(s.C, k, 20) && k + 1 < D && s.O[k + 1] > 0) { out.trend40 = { ret: sell(s.O[k + 1]), days: k + 1 - entry + 1 }; break; }
      if (k === entry + 39) out.trend40 = { ret: sell(s.C[k]), days: 40 };
    }
  }
  return out;
}
const EXITS = { h5: '5日目の引けで売る', h10: '10日目の引けで売る', h20: '20日目の引けで売る（今のルール）', h40: '40日目の引けで売る', stop20: '荒さに合わせた損切り（最長20日）', trend40: '20日線を割ったら売る（最長40日）' };

// ---------- 特徴 ----------
const T = [];
for (let i = 0; i < S.length; i++) {
  const s = S[i];
  const used = new Set();
  for (const acc of s.sec.earnings ?? []) {
    const day = acc.slice(0, 10), hm = acc.slice(11, 16);
    let r = firstIdx(day); if (r == null) continue;
    if (dates[r] === day && hm >= '09:30') r++;
    if (r >= D - 1 || r < 260 || used.has(r)) continue;
    used.add(r);
    const re = s.C[r] / s.C[r - 1] - 1;
    if (!(re >= 0.05) || !(s.RC[r] >= 5)) continue;
    const entry = r + 1;
    const f = usFeatures(s, r, SPC, day);
    f.gap = s.O[entry] / s.C[r] - 1;                                   // 買う日の寄り付き（買う瞬間）
    const out = outcomes(s, entry, f.atr);
    if (!out) continue;
    T.push({
      i, r, entry, half: entry < split ? 'train' : 'test', year: dates[entry].slice(0, 4), re,
      f,
      out,
    });
  }
}
const NUMF = ['re', 'gapPart', 'intraday', 'closePos', 'volSurge', 'epsG', 'revG', 'surprise', 'run20', 'hi52', 'ma50', 'vol20', 'atr', 'liq', 'spyTrend', 'spy1', 'spy5', 'gap'];
const OPENF = new Set(['gap']);
const FNAME = {
  re: '反応日の上げ幅', gapPart: '反応日の寄り付きでの跳ね', intraday: '反応日の寄りから引けまで', closePos: '高値引けかどうか', volSurge: '出来高の増え方',
  epsG: 'EPSの前年比', revG: '売上の前年比', surprise: 'アナリスト予想との差', run20: '発表前20日の上昇', hi52: '52週高値との差', ma50: '50日線との差',
  vol20: '値動きの荒さ', atr: '1日の値幅の平均', liq: '売買代金', spyTrend: 'S&P500と200日平均の差', spy1: '反応日のS&P500', spy5: 'S&P500の5日の動き', gap: '買う日の寄り付き（買う瞬間）',
};
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);
function summ(a) {
  if (!a.length) return { n: 0 };
  const s = a.slice().sort((x, y) => x - y);
  return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), win: r4(a.filter((x) => x > 0).length / a.length), p10: r4(s[Math.floor(a.length * 0.1)]), p90: r4(s[Math.floor(a.length * 0.9)]) };
}
function buckets(fname, exit) {
  const vals = T.filter((t) => t.half === 'train').map((t) => t.f[fname]).filter(Number.isFinite).sort((a, b) => a - b);
  if (vals.length < 40) return null;
  const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => vals[Math.floor(vals.length * q)]).filter((v, k, a) => a.indexOf(v) === k);
  const g = {};
  for (const t of T) {
    const v = t.f[fname], r = t.out[exit]?.ret;
    if (!Number.isFinite(v) || r == null) continue;
    let b = 0; while (b < cuts.length && v > cuts[b]) b++;
    ((g[b] ??= { train: [], test: [], lo: Infinity, hi: -Infinity })[t.half]).push(r);
    if (t.half === 'train') { g[b].lo = Math.min(g[b].lo, v); g[b].hi = Math.max(g[b].hi, v); }
  }
  return Object.fromEntries(Object.keys(g).sort().map((b) => [b, { range: [r4(g[b].lo), r4(g[b].hi)], train: summ(g[b].train), test: summ(g[b].test) }]));
}
function ridge(X, y, lam) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Float64Array(p)), b = new Float64Array(p);
  for (let r = 0; r < X.length; r++) { const x = X[r]; for (let a = 0; a < p; a++) { b[a] += x[a] * y[r]; for (let c = 0; c < p; c++) A[a][c] += x[a] * x[c]; } }
  for (let a = 1; a < p; a++) A[a][a] += lam * X.length;
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
function fitModel(exit, useOpen) {
  const tr = T.filter((t) => t.half === 'train' && t.out[exit]);
  const cols = NUMF.filter((c) => (useOpen || !OPENF.has(c)) && tr.filter((t) => Number.isFinite(t.f[c])).length >= tr.length * 0.3);
  const st = {};
  for (const c of cols) { const v = tr.map((t) => t.f[c]).filter(Number.isFinite); const m = v.reduce((a, b) => a + b, 0) / v.length; st[c] = { m, s: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) }; }
  const x = (t) => [1, ...cols.map((c) => (Number.isFinite(t.f[c]) ? Math.max(-4, Math.min(4, (t.f[c] - st[c].m) / (st[c].s || 1))) : 0))];
  const w = ridge(tr.map(x), tr.map((t) => Math.max(-0.4, Math.min(0.4, t.out[exit].ret))), 0.05);
  const pred = (t) => x(t).reduce((a, v, k) => a + v * w[k], 0);
  const sc = tr.map(pred).sort((a, b) => a - b);
  const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => sc[Math.floor(sc.length * q)]);
  return { pred, cuts, coef: cols.map((c, k) => ({ f: FNAME[c], w: r4(w[k + 1] * 100) })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)) };
}
// 資金：最大10銘柄・各10%、空いているお金はSPY（本番と同じ）
function sim(pick, exit, from, to) {
  const byEntry = new Map();
  for (const t of T) { const o = t.out[exit]; if (!o) continue; const s = pick(t); if (s == null) continue; if (!byEntry.has(t.entry)) byEntry.set(t.entry, []); byEntry.get(t.entry).push({ i: t.i, ret: o.ret, exitIdx: t.entry + o.days, score: s }); }
  for (const a of byEntry.values()) a.sort((x, y) => y.score - x.score);
  let cash = 1e6, peak = cash, maxDD = 0, trades = 0;
  const pos = [];
  for (let d = from; d <= to; d++) {
    if (d > from && SPC[d] > 0 && SPC[d - 1] > 0) cash *= SPC[d] / SPC[d - 1];
    for (let k = pos.length - 1; k >= 0; k--) if (pos[k].exitIdx <= d) { cash += pos[k].size * (1 + pos[k].ret); pos.splice(k, 1); }
    for (const c of byEntry.get(d) ?? []) {
      if (pos.length >= 10) break;
      if (pos.some((p) => p.i === c.i)) continue;
      const eq = cash + pos.reduce((a, p) => a + p.size, 0);
      const size = Math.min(cash, eq * 0.1);
      if (size < eq * 0.05) break;
      cash -= size; trades++;
      pos.push({ i: c.i, size, exitIdx: c.exitIdx, ret: c.ret, px: S[c.i].O[d] * (1 + SLIP) });
    }
    const m = cash + pos.reduce((a, p) => a + p.size * (S[p.i].C[d] > 0 ? S[p.i].C[d] / p.px : 1), 0);
    peak = Math.max(peak, m); maxDD = Math.max(maxDD, 1 - m / peak);
  }
  for (const p of pos) cash += p.size * (1 + p.ret);
  return { returnPct: Math.round((cash / 1e6 - 1) * 1000) / 10, maxDDPct: Math.round(maxDD * 1000) / 10, trades };
}
const spyRet = (a, b) => Math.round((SPC[b] / SPC[a] - 1) * 1000) / 10;
const result = { ok: true, generatedAt: new Date().toISOString(), periods: { train: [dates[260], dates[split - 1]], test: [dates[split], dates[D - 1]] }, spy: { train: spyRet(260, split - 1), test: spyRet(split, D - 1) },
  events: { train: T.filter((t) => t.half === 'train').length, test: T.filter((t) => t.half === 'test').length, withSurprise: T.filter((t) => Number.isFinite(t.f.surprise)).length }, exits: {} };
for (const exit of Object.keys(EXITS)) {
  const X = (result.exits[exit] = { name: EXITS[exit], base5: {}, base10: {}, byFeature: {}, models: {} });
  for (const h of ['train', 'test']) {
    X.base5[h] = summ(T.filter((t) => t.half === h && t.out[exit]).map((t) => t.out[exit].ret));
    X.base10[h] = summ(T.filter((t) => t.half === h && t.re >= 0.1 && t.out[exit]).map((t) => t.out[exit].ret));
  }
  for (const f of NUMF) { const b = buckets(f, exit); if (b) X.byFeature[f] = b; }
  const sims = {};
  for (const [nm, pick] of [['react10', (t) => (t.re >= 0.1 ? t.re : null)], ['react5', (t) => t.re]]) sims[nm] = { train: sim(pick, exit, 260, split - 1), test: sim(pick, exit, split, D - 1) };
  for (const useOpen of [false, true]) {
    const m = fitModel(exit, useOpen);
    const key = useOpen ? 'atOpen' : 'preOpen';
    const q = { train: [[], [], [], [], []], test: [[], [], [], [], []] };
    for (const t of T) { const r = t.out[exit]?.ret; if (r == null) continue; const s = m.pred(t); let b = 0; while (b < 4 && s > m.cuts[b]) b++; q[t.half][b].push(r); }
    const s40 = (t) => { const s = m.pred(t); return s > m.cuts[2] ? s : null; };
    const s20 = (t) => { const s = m.pred(t); return s > m.cuts[3] ? s : null; };
    sims[key + '_top40'] = { train: sim(s40, exit, 260, split - 1), test: sim(s40, exit, split, D - 1) };
    sims[key + '_top20'] = { train: sim(s20, exit, 260, split - 1), test: sim(s20, exit, split, D - 1) };
    X.models[key] = { coef: m.coef.slice(0, 12), quintiles: { train: q.train.map(summ), test: q.test.map(summ) } };
  }
  X.sims = sims;
}
// ---------- 前半だけで選んだ「効く特徴」で点数をつける（20日持つ） ----------
// 選び方（前半だけ、後半は見ない）：特徴ごとに前半の5分位で、上位1/5（または下位1/5）の平均が全体より+1%以上、かつ中央値も全体以上なら「効く」。
// 点数 = 効く特徴のうち、その銘柄が良い側の1/5に入っている数。点数の高い順に買う
{
  const exit = 'h20';
  const tr = T.filter((t) => t.half === 'train' && t.out[exit]);
  const all = summ(tr.map((t) => t.out[exit].ret));
  const chosen = [];
  for (const f of NUMF.filter((c) => !OPENF.has(c))) {
    const v = tr.map((t) => t.f[f]).filter(Number.isFinite).sort((a, b) => a - b);
    if (v.length < tr.length * 0.3) continue;
    const lo = v[Math.floor(v.length * 0.2)], hi = v[Math.floor(v.length * 0.8)];
    const top = summ(tr.filter((t) => t.f[f] >= hi).map((t) => t.out[exit].ret)), bot = summ(tr.filter((t) => t.f[f] <= lo).map((t) => t.out[exit].ret));
    if (top.avg - all.avg >= 0.01 && top.med >= all.med) chosen.push({ f, side: 'high', cut: hi, train: top });
    else if (bot.avg - all.avg >= 0.01 && bot.med >= all.med) chosen.push({ f, side: 'low', cut: lo, train: bot });
  }
  const rules = { chosen: chosen.map((c) => ({ key: c.f, side: c.side, cut: c.cut })) };
  const score = (t) => usScore(t.f, rules);
  try { fs.writeFileSync(path.join(DATA, 'pro-choice.json'), JSON.stringify({ chosenAt: new Date().toISOString(), trainTo: dates[split - 1], exit: 'h20', rules })); } catch {}
  const byScore = {};
  for (const h of ['train', 'test']) for (let k = 0; k <= 6; k++) {
    const a = T.filter((t) => t.half === h && t.out[exit] && Math.min(score(t), 6) === k).map((t) => t.out[exit].ret);
    (byScore[k] ??= {})[h] = summ(a);
  }
  const sims = {};
  for (const [nm, pick] of [
    ['react10', (t) => (t.re >= 0.1 ? t.re : null)],
    ['react5_score1', (t) => (score(t) >= 1 ? score(t) + t.re : null)],
    ['react5_score2', (t) => (score(t) >= 2 ? score(t) + t.re : null)],
    ['react10_score1', (t) => (t.re >= 0.1 && score(t) >= 1 ? score(t) + t.re : null)],
    ['react10_score0first', (t) => (t.re >= 0.1 ? score(t) + t.re : null)],
    ['react5_score3', (t) => (score(t) >= 3 ? score(t) + t.re : null)],
    ['react5_score4', (t) => (score(t) >= 4 ? score(t) + t.re : null)],
    ['react5_score5', (t) => (score(t) >= 5 ? score(t) + t.re : null)],
    ['react10_score3', (t) => (t.re >= 0.1 && score(t) >= 3 ? score(t) + t.re : null)],
  ]) for (const ex of ['h20', 'h40']) sims[nm + '|' + ex] = { train: sim(pick, ex, 260, split - 1), test: sim(pick, ex, split, D - 1) };
  result.trainChosen = { rules, rule: '前半だけで選ぶ：上位(下位)1/5の平均が全体+1%以上かつ中央値も全体以上', chosen: chosen.map((c) => ({ f: FNAME[c.f], side: c.side === 'high' ? '高いほど良い' : '低いほど良い', cut: r4(c.cut), train: c.train })), byScore, sims };
}
writeOut(result);
console.log(`pro-us ok: events ${result.events.train}/${result.events.test} surprise=${result.events.withSurprise}`);
