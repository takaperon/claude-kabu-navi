// 米国株（S&P500構成銘柄）の材料イベント検証。出力は集計値のみ
// 決算発表（SEC 8-K 2.02）の時刻：米東部9:30より前なら当日の始値、それ以降なら翌営業日の始値で買う
// EPS・売上はその四半期の10-Q/10-Kの値（発表時のプレスリリースと同じ数字という前提）
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data-us';
const OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
fs.mkdirSync(OUT, { recursive: true });
let seed = 777;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const spyF = path.join(DATA, 'prices', 'SPY.json');
const uniF = path.join(DATA, 'universe.json');
if (!fs.existsSync(spyF) || !fs.existsSync(uniF)) {
  fs.writeFileSync(path.join(OUT, 'us-backtest.json'), JSON.stringify({ ok: false, reason: 'データ不足' }, null, 2));
  console.log('us: no data');
  process.exit(0);
}
const spy = JSON.parse(fs.readFileSync(spyF, 'utf8'));
const dates = spy.map((r) => r[0]);
const D = dates.length;
const di = new Map(dates.map((d, k) => [d, k]));
const universe = JSON.parse(fs.readFileSync(uniF, 'utf8')).list;

// 価格を共通の日付に並べる
const S = [];
for (const u of universe) {
  const f = path.join(DATA, 'prices', `${u.t}.json`);
  if (!fs.existsSync(f)) continue;
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (rows.length < 200) continue;
  const O = new Float64Array(D).fill(NaN), H = O.slice(), L = O.slice(), C = O.slice(), V = O.slice(), DV = new Float64Array(D).fill(0), RC = O.slice();
  for (const [d, o, h, l, c, v, div, , rawC] of rows) {
    const k = di.get(d);
    if (k === undefined) continue;
    O[k] = o; H[k] = h; L[k] = l; C[k] = c; V[k] = v; DV[k] = div || 0; RC[k] = rawC;
  }
  const secF = path.join(DATA, 'sec', `${u.t}.json`);
  const sec = fs.existsSync(secF) ? JSON.parse(fs.readFileSync(secF, 'utf8')) : { earnings: [], eps: [], rev: [] };
  const avF = path.join(DATA, 'av', `${u.t}.json`);
  const av = fs.existsSync(avF) ? JSON.parse(fs.readFileSync(avF, 'utf8')) : null;
  S.push({ ...u, O, H, L, C, V, DV, RC, sec, av });
}
const N = S.length;
const sma = (A, k, n) => { if (k < n - 1) return NaN; let s = 0; for (let j = k - n + 1; j <= k; j++) s += A[j]; return s / n; };
const firstIdxOnOrAfter = (d) => { let lo = 0, hi = D; while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] >= d) hi = m; else lo = m + 1; } return lo < D ? lo : null; };

// ---------- イベント ----------
// entry = 買う日のインデックス（その日の始値）。sig = その前の営業日（シグナル日）
const EV = { eps_up: [], eps_up_rev: [], eps_down: [], earn_all: [], div_up: [], av_all: [], sup5: [], sup10: [], sup5_rev: [], miss5: [] };
function yoy(series, end) {
  // 同じ四半期の1年前（end の 330〜400日前）
  const cur = series.find((x) => x.end === end);
  if (!cur) return null;
  const t = Date.parse(end);
  const prev = series.find((x) => { const g = (t - Date.parse(x.end)) / 864e5; return g >= 330 && g <= 400; });
  if (!prev) return null;
  return { cur: cur.val, prev: prev.val };
}
for (let i = 0; i < N; i++) {
  const s = S[i];
  for (const acc of s.sec.earnings) {
    const day = acc.slice(0, 10), hm = acc.slice(11, 16);
    let entry = firstIdxOnOrAfter(day);
    if (entry == null) continue;
    if (dates[entry] === day && hm >= '09:30') entry++; // 取引時間中・引け後の発表は翌営業日
    if (entry >= D || entry < 30) continue;
    const sig = entry - 1;
    // この発表に対応する四半期：発表日の前120日以内に終わった最新の四半期
    const t = Date.parse(day);
    const q = s.sec.eps.filter((x) => { const g = (t - Date.parse(x.end)) / 864e5; return g >= 0 && g <= 120; }).at(-1);
    EV.earn_all.push({ i, sig, entry, score: rand() });
    if (!q) continue;
    const e = yoy(s.sec.eps, q.end);
    if (!e || !(e.prev > 0)) continue;
    const g = e.cur / e.prev - 1;
    const r = yoy(s.sec.rev, q.end);
    const rg = r && r.prev > 0 ? r.cur / r.prev - 1 : null;
    if (g >= 0.2) EV.eps_up.push({ i, sig, entry, score: g });
    if (g >= 0.2 && rg != null && rg >= 0.1) EV.eps_up_rev.push({ i, sig, entry, score: g });
    if (g <= -0.2) EV.eps_down.push({ i, sig, entry, score: -g });
  }
  // Alpha Vantage：アナリスト予想に対するサプライズ。pre-market は当日始値、それ以外（post-market）は翌営業日始値
  // 売上の伸びは SEC の値（同じ四半期）を使う
  for (const q of s.av ?? []) {
    if (!q.rd || q.rd < '2021-01-01' || q.spp == null || !Number.isFinite(q.spp) || !(q.est != null)) continue;
    let entry = firstIdxOnOrAfter(q.rd);
    if (entry == null) continue;
    if (dates[entry] === q.rd && q.time !== 'pre-market') entry++;
    if (entry >= D || entry < 30) continue;
    const ev = { i, sig: entry - 1, entry, score: q.spp / 100 };
    EV.av_all.push({ ...ev, score: rand() });
    const r = q.fde ? yoy(s.sec.rev, s.sec.rev.find((x) => Math.abs(Date.parse(x.end) - Date.parse(q.fde)) / 864e5 <= 10)?.end) : null;
    const rg = r && r.prev > 0 ? r.cur / r.prev - 1 : null;
    if (q.spp >= 5) EV.sup5.push(ev);
    if (q.spp >= 10) EV.sup10.push(ev);
    if (q.spp >= 5 && rg != null && rg >= 0.1) EV.sup5_rev.push(ev);
    if (q.spp <= -5) EV.miss5.push({ ...ev, score: -ev.score });
  }
  // 増配：権利落ち日の配当額が前回より+5%以上（発表はもっと前なので、遅れて気づく形）
  let prevDiv = null;
  for (let k = 1; k < D - 1; k++) {
    if (!(s.DV[k] > 0)) continue;
    if (prevDiv != null && s.DV[k] / prevDiv - 1 >= 0.05 && s.DV[k] / prevDiv < 3) EV.div_up.push({ i, sig: k, entry: k + 1, score: s.DV[k] / prevDiv - 1 });
    prevDiv = s.DV[k];
  }
}
const trend = (e) => S[e.i].C[e.sig] > sma(S[e.i].C, e.sig, 50);
const gapUp = (e) => S[e.i].O[e.entry] > S[e.i].C[e.sig];
const STRATS = {
  earn_all: { name: '比較用：決算発表すべて', ev: () => EV.earn_all },
  eps_up: { name: 'EPSが前年同期比+20%以上', ev: () => EV.eps_up },
  eps_up_trend: { name: 'EPS+20%以上＋株価が50日線より上', ev: () => EV.eps_up.filter(trend) },
  eps_up_rev: { name: 'EPS+20%以上＋売上+10%以上', ev: () => EV.eps_up_rev },
  eps_up_rev_gap: { name: 'EPS+20%・売上+10%＋朝高く始まった時だけ', ev: () => EV.eps_up_rev.filter(gapUp) },
  eps_up_gap: { name: 'EPS+20%以上＋朝高く始まった時だけ', ev: () => EV.eps_up.filter(gapUp) },
  eps_down: { name: '参考：EPSが前年同期比-20%以下', ev: () => EV.eps_down },
  div_up: { name: '増配（権利落ち日に確認）', ev: () => EV.div_up },
  av_all: { name: '比較用：予想データのある決算すべて', ev: () => EV.av_all },
  sup5: { name: 'EPSが予想を+5%以上上回った', ev: () => EV.sup5 },
  sup10: { name: 'EPSが予想を+10%以上上回った', ev: () => EV.sup10 },
  sup5_rev: { name: '予想を+5%以上上回り＋売上+10%以上', ev: () => EV.sup5_rev },
  sup5_gap: { name: '予想を+5%以上上回り＋朝高く始まった時だけ', ev: () => EV.sup5.filter(gapUp) },
  sup5_trend: { name: '予想を+5%以上上回り＋株価が50日線より上', ev: () => EV.sup5.filter(trend) },
  miss5: { name: '参考：EPSが予想を5%以上下回った', ev: () => EV.miss5 },
};
const EXITS = { dt: { name: 'デイトレ（寄りで買って引けで売る）', hold: 1 }, hold5: { name: '5日保有', hold: 5 }, hold10: { name: '10日保有', hold: 10 }, hold20: { name: '20日保有', hold: 20 } };
function trade(e, ex) {
  const s = S[e.i];
  const o = s.O[e.entry];
  const x = e.entry + ex.hold - 1;
  if (!(o > 0) || x >= D || Number.isNaN(s.C[x])) return null;
  return { ret: (s.C[x] * (1 - SLIP)) / (o * (1 + SLIP)) - 1, exitIdx: x };
}
const split = Math.floor(D * 0.6);
function summarize(rets) {
  const n = rets.length;
  if (!n) return { n: 0 };
  const w = rets.filter((r) => r > 0);
  const gw = w.reduce((a, b) => a + b, 0), gl = -rets.filter((r) => r <= 0).reduce((a, b) => a + b, 0);
  const r4 = (x) => Math.round(x * 10000) / 10000;
  return { n, winRate: r4(w.length / n), avgRet: r4(rets.reduce((a, b) => a + b, 0) / n), profitFactor: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null };
}
// 資金：最大10銘柄・各10%
function portfolio(byEntry, from, to) {
  let cash = 1_000_000, peak = cash, maxDD = 0, trades = 0;
  const pos = [];
  const yearly = {}; let yName = null, yStart = cash;
  for (let d = from; d <= to; d++) {
    const eqNow = () => cash + pos.reduce((a, p) => a + p.size * (S[p.i].C[d] > 0 ? S[p.i].C[d] / p.px : 1), 0);
    for (const c of byEntry.get(d) ?? []) {
      if (pos.length >= 10) break;
      if (pos.some((p) => p.i === c.i)) continue;
      const eq = cash + pos.reduce((a, p) => a + p.size, 0);
      const size = Math.min(cash, eq * 0.1);
      if (size < eq * 0.05) break;
      cash -= size; trades++;
      pos.push({ i: c.i, size, exitIdx: c.exitIdx, ret: c.ret, px: S[c.i].O[d] * (1 + SLIP) });
    }
    for (let k = pos.length - 1; k >= 0; k--) if (pos[k].exitIdx <= d) { cash += pos[k].size * (1 + pos[k].ret); pos.splice(k, 1); }
    const m = eqNow();
    const yn = dates[d].slice(0, 4);
    if (yn !== yName) { if (yName) yearly[yName] = Math.round((prevM / yStart - 1) * 1000) / 10; yName = yn; yStart = d === from ? 1_000_000 : prevM; }
    var prevM = m;
    peak = Math.max(peak, m); maxDD = Math.max(maxDD, 1 - m / peak);
  }
  for (const p of pos) cash += p.size * (1 + p.ret);
  if (yName) yearly[yName] = Math.round((cash / yStart - 1) * 1000) / 10;
  return { returnPct: Math.round((cash / 1e6 - 1) * 1000) / 10, maxDDPct: Math.round(maxDD * 1000) / 10, trades, yearly };
}
const results = {};
for (const [sk, st] of Object.entries(STRATS)) {
  results[sk] = { name: st.name, exits: {} };
  const evs = st.ev();
  for (const [ek, ex] of Object.entries(EXITS)) {
    const per = { train: [], test: [] };
    const byEntry = new Map();
    const seen = new Set();
    for (const e of evs) {
      const key = e.i * D + e.entry;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(S[e.i].RC[e.sig] >= 5)) continue;
      const t = trade(e, ex);
      if (!t) continue;
      per[e.entry < split ? 'train' : 'test'].push(t.ret);
      if (!byEntry.has(e.entry)) byEntry.set(e.entry, []);
      byEntry.get(e.entry).push({ i: e.i, score: e.score, ...t });
    }
    for (const a of byEntry.values()) a.sort((x, y) => y.score - x.score);
    results[sk].exits[ek] = {
      name: ex.name, train: summarize(per.train), test: summarize(per.test),
      portfolioTrain: portfolio(byEntry, 30, split - 1), portfolioTest: portfolio(byEntry, split, D - 1),
    };
  }
}
// 比較：S&P500（SPY）を買って持っていた場合、無作為に10銘柄を10日ごとに入れ替えた場合
const spyRet = (a, b) => Math.round((spy[b][4] / spy[a][4] - 1) * 1000) / 10;
const randomBase = (() => {
  const res = { train: [], test: [] };
  for (let r = 0; r < 100; r++) {
    for (const [pk, a, b] of [['train', 30, split - 1], ['test', split, D - 1]]) {
      const byEntry = new Map();
      for (let d = a; d <= b; d += 10) {
        const arr = [];
        for (let n = 0; n < 10; n++) {
          const i = Math.floor(rand() * N);
          const t = trade({ i, sig: d - 1, entry: d }, EXITS.hold10);
          if (t) arr.push({ i, score: 0, ...t });
        }
        byEntry.set(d, arr);
      }
      res[pk].push(portfolio(byEntry, a, b).returnPct);
    }
  }
  const st = (x) => { x.sort((p, q) => p - q); return { avg: Math.round((x.reduce((p, q) => p + q, 0) / x.length) * 10) / 10, p90: x[90] }; };
  return { name: '無作為に10銘柄を10日ごとに入れ替え×100回', train: st(res.train), test: st(res.test) };
})();
const out = {
  ok: true,
  generatedAt: new Date().toISOString(),
  universe: N,
  days: D,
  periods: { train: [dates[30], dates[split - 1]], test: [dates[split], dates[D - 1]] },
  events: Object.fromEntries(Object.entries(EV).map(([k, v]) => [k, v.length])),
  secCoverage: { withEarnings: S.filter((s) => s.sec.earnings.length).length, withEps: S.filter((s) => s.sec.eps.length).length },
  avCoverage: S.filter((s) => s.av?.length).length, // 1日25社ずつ増える。そろうまでは一部の銘柄だけの結果

  spy: { trainPct: spyRet(30, split - 1), testPct: spyRet(split, D - 1) },
  randomBase,
  results,
};
fs.writeFileSync(path.join(OUT, 'us-backtest.json'), JSON.stringify(out, null, 2));
console.log(`us backtest ok: universe=${N} days=${D}`);
