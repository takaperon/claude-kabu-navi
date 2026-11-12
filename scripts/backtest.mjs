// 日足スイング戦略のバックテスト。出力は集計値のみ（個別銘柄の価格は出さない）。
// ルール：シグナルは当日終値まで、エントリーは翌営業日の始値。滑り0.1%/片道、手数料0円。
import fs from 'node:fs';
import path from 'node:path';
import { detectEvents } from './lib/events.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data';
const OUT = args.out ?? 'reports-out';
let SLIP = 0.001;
// 再現性のための乱数（毎回同じ結果になる）
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const MIN_TURNOVER = 1e8; // 20日平均売買代金 1億円以上
const MIN_PRICE = 100;
fs.mkdirSync(OUT, { recursive: true });

// ---------- データ読み込み ----------
const files = fs.existsSync(path.join(DATA, 'prices'))
  ? fs.readdirSync(path.join(DATA, 'prices')).filter((f) => f.endsWith('.json')).sort()
  : [];
if (files.length < 150) {
  const r = { ok: false, reason: `データ不足（${files.length}日分）` };
  fs.writeFileSync(path.join(OUT, 'backtest.json'), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r));
  process.exit(0);
}
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
// プライム・スタンダード・グロースの株式のみ（ETF・REIT等を除く）
const STOCK_MKT = new Set(['0111', '0112', '0113']);
const universe = new Map();
for (const m of master) if (STOCK_MKT.has(m.Mkt)) universe.set(m.Code, m);

const dates = files.map((f) => f.slice(0, 10));
const D = dates.length;
const codes = [...universe.keys()];
const ci = new Map(codes.map((c, i) => [c, i]));
const N = codes.length;
const F = (n) => new Float32Array(n * D).fill(NaN);
const O = F(N), H = F(N), L = F(N), C = F(N), V = F(N), VA = F(N);
files.forEach((f, d) => {
  for (const [code, o, h, l, c, vo, va] of JSON.parse(fs.readFileSync(path.join(DATA, 'prices', f), 'utf8'))) {
    const i = ci.get(code);
    if (i === undefined || c == null || o == null) continue;
    const k = i * D + d;
    O[k] = o; H[k] = h; L[k] = l; C[k] = c; V[k] = vo; VA[k] = va;
  }
});

// ---------- 指標 ----------
const at = (A, i, d) => A[i * D + d];
function sma(A, i, d, n) {
  if (d < n - 1) return NaN;
  let s = 0;
  for (let k = d - n + 1; k <= d; k++) {
    const v = A[i * D + k];
    if (Number.isNaN(v)) return NaN;
    s += v;
  }
  return s / n;
}
function maxOf(A, i, from, to) {
  let m = -Infinity;
  for (let k = from; k <= to; k++) {
    const v = A[i * D + k];
    if (Number.isNaN(v)) return NaN;
    if (v > m) m = v;
  }
  return m;
}
function rsi(i, d, n) {
  if (d < n) return NaN;
  let up = 0, dn = 0;
  for (let k = d - n + 1; k <= d; k++) {
    const ch = at(C, i, k) - at(C, i, k - 1);
    if (Number.isNaN(ch)) return NaN;
    if (ch > 0) up += ch; else dn -= ch;
  }
  if (up + dn === 0) return 50;
  return (100 * up) / (up + dn);
}
const eligible = (i, d) => {
  const c = at(C, i, d);
  if (!(c >= MIN_PRICE)) return false;
  const t = sma(VA, i, d, 20);
  return t >= MIN_TURNOVER;
};

// ---------- 戦略（当日 d の終値までで判定、score が高いほど優先） ----------
const STRATEGIES = {
  vol_ma25: {
    name: '出来高急増＋25日線上抜け',
    signal(i, d) {
      const c = at(C, i, d), pc = at(C, i, d - 1);
      const ma = sma(C, i, d, 25), pma = sma(C, i, d - 1, 25);
      const vr = at(V, i, d) / sma(V, i, d - 1, 20);
      if (c > ma && pc <= pma && vr >= 2) return vr;
      return null;
    },
  },
  breakout20: {
    name: '20日高値ブレイク＋出来高増',
    signal(i, d) {
      if (d < 21) return null;
      const hh = maxOf(H, i, d - 20, d - 1);
      const vr = at(V, i, d) / sma(V, i, d - 1, 20);
      if (at(C, i, d) > hh && vr >= 1.5) return vr;
      return null;
    },
  },
  pullback: {
    name: '上昇トレンド中の押し目',
    signal(i, d) {
      if (d < 80) return null;
      const c = at(C, i, d);
      const ma75 = sma(C, i, d, 75), ma25 = sma(C, i, d, 25), ma25p = sma(C, i, d - 5, 25);
      const r = rsi(i, d, 3);
      if (c > ma75 && ma25 > ma25p && r < 15) return 15 - r;
      return null;
    },
  },
  reversal: {
    name: '5日で10%以上下落の反発狙い',
    signal(i, d) {
      if (d < 5) return null;
      const ret5 = at(C, i, d) / at(C, i, d - 5) - 1;
      if (ret5 <= -0.1) return -ret5;
      return null;
    },
  },
  all: {
    name: '比較用：条件なし（全銘柄平均）',
    signal(i, d) {
      return d % 5 === 0 ? rand() : null; // 5日おきに全銘柄を抽出
    },
  },
};


// ---------- 開示イベント（決算・業績修正・配当） ----------
// 開示日の翌営業日の始値で買う（場中の開示でも当日は買わない＝未来の情報を使わない）
const di = new Map(dates.map((x, k) => [x, k]));
function signalDayFor(discDate) {
  // 開示日より後の最初の営業日 e を探し、その前日 e-1 をシグナル日とする
  let lo = 0, hi = D;
  while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] > discDate) hi = m; else lo = m + 1; }
  return lo < D ? lo - 1 : null;
}
const EVENTS = { earn_up: [], earn_down: [], guidance: [], div_up: [], results: [] };
const finsDir = path.join(DATA, 'fins');
let finsDays = 0, finsRows = 0;
if (fs.existsSync(finsDir)) {
  const rows = [];
  for (const f of fs.readdirSync(finsDir).sort()) {
    finsDays++;
    for (const r of JSON.parse(fs.readFileSync(path.join(finsDir, f), 'utf8'))) rows.push(r);
  }
  finsRows = rows.length;
  for (const ev of detectEvents(rows)) {
    const i = ci.get(ev.c);
    const d = signalDayFor(ev.dd);
    if (i === undefined || d == null || d < 26 || d >= D - 1) continue;
    EVENTS[ev.kind].push({ i, d, score: ev.kind === 'results' ? rand() : ev.score });
  }
}
const aboveMA25 = (i, d) => at(C, i, d) > sma(C, i, d, 25);
const EVENT_STRATEGIES = {
  ev_results: { name: '比較用：決算発表のあった銘柄すべて', events: () => EVENTS.results },
  ev_earn_up: { name: '業績予想の上方修正（営業利益+10%以上）', events: () => EVENTS.earn_up },
  ev_earn_up_trend: { name: '上方修正＋株価が25日線より上', events: () => EVENTS.earn_up.filter((e) => aboveMA25(e.i, e.d)) },
  ev_guidance: { name: '本決算で来期予想が今期比+20%以上', events: () => EVENTS.guidance },
  ev_div_up: { name: '配当予想の引き上げ（+5%以上）', events: () => EVENTS.div_up },
  ev_earn_down: { name: '参考：業績予想の下方修正（買わない側の確認用）', events: () => EVENTS.earn_down },
  // 夜の反応で選別：翌朝の寄り付きが前日終値より上の時だけ買う（寄り前の気配で判断できる前提）
  ev_earn_up_trend_mkt: { name: '上方修正＋上向き＋市場全体が25日線より上', events: () => EVENTS.earn_up.filter((e) => aboveMA25(e.i, e.d) && MKTI[e.d] > mktMA(e.d, 25)) },
  ev_earn_up_trend_nodrop: { name: '上方修正＋上向き＋前日に市場が-1.5%以上下げていない', events: () => EVENTS.earn_up.filter((e) => aboveMA25(e.i, e.d) && MKT[e.d] > -0.015) },
  ev_div_up_mkt: { name: '増配＋市場全体が25日線より上', events: () => EVENTS.div_up.filter((e) => MKTI[e.d] > mktMA(e.d, 25)) },
  ev_div_up_nodrop: { name: '増配＋前日に市場が-1.5%以上下げていない', events: () => EVENTS.div_up.filter((e) => MKT[e.d] > -0.015) },
  ev_div_up_gap: { name: '増配＋寄り付きが前日終値より上', events: () => EVENTS.div_up.filter((e) => at(O, e.i, e.d + 1) > at(C, e.i, e.d)) },
  ev_earn_up_trend_gap: { name: '上方修正＋上向き＋寄り付きが前日終値より上', events: () => EVENTS.earn_up.filter((e) => aboveMA25(e.i, e.d) && at(O, e.i, e.d + 1) > at(C, e.i, e.d)) },
};

// ---------- 出口ルール ----------
const EXITS = {
  hold5: { name: '5日保有', hold: 5 },
  hold10: { name: '10日保有', hold: 10 },
  stop: { name: '損切り-8%／利確+15%／最大10日', hold: 10, stop: -0.08, take: 0.15 },
};
function simulate(i, d, ex) {
  const e = d + 1;
  const op = at(O, i, e);
  if (!(op > 0)) return null;
  const entry = op * (1 + SLIP);
  const last = Math.min(D - 1, d + ex.hold);
  if (d + ex.hold > D - 1) return null; // 期間末で決済できないものは除外
  for (let k = e; k <= last; k++) {
    const o = at(O, i, k), h = at(H, i, k), l = at(L, i, k), c = at(C, i, k);
    if (Number.isNaN(c)) continue;
    if (ex.stop != null) {
      const sp = entry * (1 + ex.stop), tp = entry * (1 + ex.take);
      if (k > e && o <= sp) return { ret: (o * (1 - SLIP)) / entry - 1, days: k - e + 1 };
      if (l <= sp) return { ret: (sp * (1 - SLIP)) / entry - 1, days: k - e + 1 }; // 同日に両方なら損切り優先
      if (k > e && o >= tp) return { ret: (o * (1 - SLIP)) / entry - 1, days: k - e + 1 };
      if (h >= tp) return { ret: (tp * (1 - SLIP)) / entry - 1, days: k - e + 1 };
    }
    if (k === last) return { ret: (c * (1 - SLIP)) / entry - 1, days: k - e + 1 };
  }
  return null;
}

// ---------- 集計 ----------
const split = Math.floor(D * 0.6);
const periods = {
  train: { name: '学習期間', from: dates[0], to: dates[split - 1] },
  test: { name: 'テスト期間', from: dates[split], to: dates[D - 1] },
};
function summarize(rets) {
  const n = rets.length;
  if (!n) return { n: 0 };
  const s = rets.slice().sort((a, b) => a - b);
  const wins = rets.filter((r) => r > 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = -rets.filter((r) => r <= 0).reduce((a, b) => a + b, 0);
  const r4 = (x) => Math.round(x * 10000) / 10000;
  return {
    n,
    winRate: r4(wins.length / n),
    avgRet: r4(rets.reduce((a, b) => a + b, 0) / n),
    medRet: r4(s[Math.floor(n / 2)]),
    profitFactor: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null,
  };
}

// 資金シミュレーション：100万円、最大10銘柄、1銘柄あたり資産の10%、端株可（プチ株前提）
function portfolio(signalsByDay, ex, fromD, toD, caps = null) {
  let cash = 1_000_000;
  const pos = []; // {i, entryD, exitD, ret, size}
  let peak = cash, maxDD = 0, trades = 0;
  // 時価評価：保有中は当日終値で評価（決済日の最終損益は ret で確定）
  const mark = (d) => cash + pos.reduce((a, p) => { const c = at(C, p.i, d); return a + (Number.isNaN(c) ? p.size : p.size * (c * (1 - SLIP)) / p.entryPx); }, 0);
  const equityAt = () => cash + pos.reduce((a, p) => a + p.size, 0);
  const yearly = {}; let yStart = null, yName = null;
  for (let d = fromD; d <= toD; d++) {
    for (let k = pos.length - 1; k >= 0; k--) {
      if (pos[k].exitD <= d) {
        cash += pos[k].size * (1 + pos[k].ret);
        pos.splice(k, 1);
      }
    }
    const eq = equityAt();
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, 1 - eq / peak);
    const cands = signalsByDay.get(d - 1) ?? []; // 前日シグナル → 当日始値で買い
    for (const s of cands) {
      if (pos.length >= 10) break;
      if (pos.some((p) => p.i === s.i)) continue;
      if (caps && s.tier != null && pos.filter((p) => p.tier === s.tier).length >= caps[s.tier]) continue;
      const size = Math.min(cash, eq * 0.1);
      if (size < eq * 0.05) break;
      cash -= size;
      pos.push({ i: s.i, exitD: d - 1 + 1 + s.days, ret: s.ret, size, tier: s.tier, entryPx: at(O, s.i, d) * (1 + SLIP) });
      trades++;
    }
    const m = mark(d);
    const yn = dates[d].slice(0, 4);
    if (yn !== yName) { if (yName) yearly[yName] = Math.round((prevM / yStart - 1) * 1000) / 10; yName = yn; yStart = d === fromD ? 1_000_000 : prevM; }
    var prevM = m;
    peak = Math.max(peak, m);
    maxDD = Math.max(maxDD, 1 - m / peak);
  }
  for (const p of pos) cash += p.size * (1 + p.ret);
  if (yName) yearly[yName] = Math.round((cash / yStart - 1) * 1000) / 10;
  return { final: Math.round(cash), returnPct: Math.round((cash / 1_000_000 - 1) * 1000) / 10, maxDDPct: Math.round(maxDD * 1000) / 10, trades, yearly };
}

// 流動性条件は一度だけ計算
const elig = new Uint8Array(N * D);
for (let i = 0; i < N; i++) for (let d = 20; d < D; d++) elig[i * D + d] = eligible(i, d) ? 1 : 0;

// ---------- 市場全体（流動性条件を満たす銘柄の等金額平均）----------
const MKT = new Float64Array(D).fill(0); // 日次リターン
const MKTI = new Float64Array(D).fill(1); // 指数（初日=1）
for (let d = 1; d < D; d++) {
  let s = 0, n = 0;
  for (let i = 0; i < N; i++) {
    if (!elig[i * D + d - 1]) continue;
    const r = at(C, i, d) / at(C, i, d - 1) - 1;
    if (Number.isFinite(r) && Math.abs(r) < 0.5) { s += r; n++; }
  }
  MKT[d] = n ? s / n : 0;
  MKTI[d] = MKTI[d - 1] * (1 + MKT[d]);
}
const mktMA = (d, n) => { if (d < n - 1) return NaN; let s = 0; for (let k = d - n + 1; k <= d; k++) s += MKTI[k]; return s / n; };
// 大きく下げた日のあと、市場全体はどうなったか（翌日・5日後・20日後）
const afterDrops = (() => {
  const out = {};
  for (const [name, lo, hi] of [['-1〜-2%', -0.02, -0.01], ['-2〜-3%', -0.03, -0.02], ['-3%以上', -1, -0.03], ['比較：全営業日', -1, 1]]) {
    const acc = { 1: [], 5: [], 20: [] };
    let cnt = 0;
    for (let d = 1; d < D; d++) {
      if (!(MKT[d] >= lo && MKT[d] < hi)) continue;
      cnt++;
      for (const h of [1, 5, 20]) if (d + h < D) acc[h].push(MKTI[d + h] / MKTI[d] - 1);
    }
    const st = (a) => a.length ? { avgPct: Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10000) / 100, upRatePct: Math.round((a.filter((x) => x > 0).length / a.length) * 1000) / 10, worstPct: Math.round(Math.min(...a) * 1000) / 10 } : null;
    out[name] = { days: cnt, next1: st(acc[1]), next5: st(acc[5]), next20: st(acc[20]) };
  }
  return out;
})();


const results = {};
const BYDAY = {};
for (const [sk, st] of Object.entries({ ...STRATEGIES, ...EVENT_STRATEGIES })) {
  // シグナルは戦略ごとに一度だけ判定
  let sigs = [];
  if (st.events) {
    const seen = new Set();
    for (const e of st.events()) {
      const k = e.i * D + e.d;
      if (!elig[k] || seen.has(k)) continue;
      seen.add(k);
      sigs.push(e);
    }
  } else {
    for (let d = 26; d < D - 1; d++) {
      for (let i = 0; i < N; i++) {
        if (!elig[i * D + d]) continue;
        const score = st.signal(i, d);
        if (score == null || !Number.isFinite(score)) continue;
        sigs.push({ i, d, score });
      }
    }
  }
  results[sk] = { name: st.name, exits: {} };
  for (const [ek, ex] of Object.entries(EXITS)) {
    const per = { train: [], test: [] };
    const byDay = new Map();
    for (const s of sigs) {
      const t = simulate(s.i, s.d, ex);
      if (!t) continue;
      per[s.d < split ? 'train' : 'test'].push(t.ret);
      if (!byDay.has(s.d)) byDay.set(s.d, []);
      byDay.get(s.d).push({ i: s.i, score: s.score, ...t });
    }
    for (const arr of byDay.values()) arr.sort((a, b) => b.score - a.score);
    BYDAY[sk + '|' + ek] = byDay;
    results[sk].exits[ek] = {
      name: ex.name,
      train: summarize(per.train),
      test: summarize(per.test),
      portfolioTrain: portfolio(byDay, ex, 26, split - 1),
      portfolioTest: portfolio(byDay, ex, split, D - 1),
    };
  }
}


// ---------- 組み合わせ（優先順位つき） ----------
// 同じ日に候補が複数あれば、上の段の戦略から順に買う
function mergeTiers(keys) {
  const m = new Map();
  keys.forEach((k, t) => {
    for (const [d, arr] of BYDAY[k]) {
      if (!m.has(d)) m.set(d, []);
      for (const s of arr) m.get(d).push({ ...s, tier: t, score: (keys.length - t) * 1e6 + s.score });
    }
  });
  for (const arr of m.values()) arr.sort((a, b) => b.score - a.score);
  return m;
}
const COMBOS = {
  combo_a: { name: '組み合わせA：上方修正＋上向き(10日) → 増配(5日)', keys: ['ev_earn_up_trend|hold10', 'ev_div_up|hold5'] },
  combo_b: { name: '組み合わせB：上方修正＋上向き(10日) → 増配(5日) → 押し目(10日、最大5銘柄)', keys: ['ev_earn_up_trend|hold10', 'ev_div_up|hold5', 'pullback|hold10'], caps: [10, 10, 5] },
  combo_c: { name: '組み合わせC：上方修正＋上向き(10日) → 押し目(10日、最大5銘柄)', keys: ['ev_earn_up_trend|hold10', 'pullback|hold10'], caps: [10, 5] },
  combo_d: { name: '組み合わせD：上方修正＋上向き(10日) → 増配(5日、最大5銘柄)', keys: ['ev_earn_up_trend|hold10', 'ev_div_up|hold5'], caps: [10, 5] },
};
const combos = {};
for (const [k, c] of Object.entries(COMBOS)) {
  const m = mergeTiers(c.keys);
  combos[k] = { name: c.name, portfolioTrain: portfolio(m, null, 26, split - 1, c.caps), portfolioTest: portfolio(m, null, split, D - 1, c.caps) };
}

// ---------- 比較用の物差し：無作為に選ぶのを200回やった平均 ----------
function randomBaseline(fromD, toD, runs) {
  const base = BYDAY['all|hold10'];
  const rets = [], dds = [];
  for (let r = 0; r < runs; r++) {
    const m = new Map();
    for (const [d, arr] of base) m.set(d, arr.map((x) => ({ ...x, score: rand() })).sort((a, b) => b.score - a.score));
    const p = portfolio(m, null, fromD, toD);
    rets.push(p.returnPct);
    dds.push(p.maxDDPct);
  }
  rets.sort((a, b) => a - b);
  const avg = (a) => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10;
  return { runs, avgReturnPct: avg(rets), p10: rets[Math.floor(runs * 0.1)], p90: rets[Math.floor(runs * 0.9)], avgMaxDDPct: avg(dds) };
}
const baseline = { name: '無作為に10日保有×200回', train: randomBaseline(26, split - 1, 200), test: randomBaseline(split, D - 1, 200) };

// ---------- デイトレ検証：シグナルの翌営業日に「寄り付きで買って引けで売る」 ----------
// 日足（始値・高値・安値・終値）だけで計算できる範囲。分足が必要な戦略はここでは扱わない
function dayRet(i, d, side, stop) {
  const e = d + 1;
  const o = at(O, i, e), h = at(H, i, e), l = at(L, i, e), c = at(C, i, e), pc = at(C, i, d);
  if (!(o > 0) || Number.isNaN(c)) return null;
  const gap = o / pc - 1;
  if (side === 1) {
    const entry = o * (1 + SLIP);
    if (stop && l <= o * (1 - stop)) return { ret: (o * (1 - stop) * (1 - SLIP)) / entry - 1, gap };
    return { ret: (c * (1 - SLIP)) / entry - 1, gap };
  }
  // 空売り（参考）：寄りで売って引けで買い戻す
  const entry = o * (1 - SLIP);
  if (stop && h >= o * (1 + stop)) return { ret: entry / (o * (1 + stop) * (1 + SLIP)) - 1, gap };
  return { ret: entry / (c * (1 + SLIP)) - 1, gap };
}
const DT_SIGNALS = {
  div_up: { name: '配当予想の引き上げ', events: () => EVENTS.div_up },
  earn_up: { name: '上方修正', events: () => EVENTS.earn_up },
  earn_up_trend: { name: '上方修正＋上向き', events: () => EVENTS.earn_up.filter((e) => aboveMA25(e.i, e.d)) },
  results: { name: '比較用：決算発表すべて', events: () => EVENTS.results },
  earn_down_short: { name: '参考：下方修正を空売り', events: () => EVENTS.earn_down, side: -1 },
  surge10: {
    name: '前日+10%以上上がった銘柄',
    events: () => { const o = []; for (let d = 26; d < D - 1; d++) for (let i = 0; i < N; i++) { const r = at(C, i, d) / at(C, i, d - 1) - 1; if (r >= 0.1) o.push({ i, d, score: r }); } return o; },
  },
  drop10: {
    name: '前日-10%以上下がった銘柄（反発狙い）',
    events: () => { const o = []; for (let d = 26; d < D - 1; d++) for (let i = 0; i < N; i++) { const r = at(C, i, d) / at(C, i, d - 1) - 1; if (r <= -0.1) o.push({ i, d, score: -r }); } return o; },
  },
};
const DT_FILTERS = {
  all: { name: '条件なし', ok: () => true },
  gapUp: { name: '寄り付きが前日終値より上', ok: (g) => g > 0 },
  gapDown: { name: '寄り付きが前日終値以下', ok: (g) => g <= 0 },
  bigGap: { name: '寄り付きで+3%以上', ok: (g) => g >= 0.03 },
};
// 1日最大10銘柄、各10%。その日のうちに全部決済するので毎日リセット
function dtPortfolio(byDay, fromD, toD) {
  let eq = 1_000_000, peak = eq, maxDD = 0, trades = 0;
  const yearly = {};
  let yName = null, yStart = eq;
  for (let d = fromD; d <= toD; d++) {
    const yn = dates[d].slice(0, 4);
    if (yn !== yName) { if (yName) yearly[yName] = Math.round((eq / yStart - 1) * 1000) / 10; yName = yn; yStart = eq; }
    const arr = byDay.get(d - 1);
    if (!arr) continue;
    let ch = 0;
    for (const s of arr.slice(0, 10)) { ch += 0.1 * s.ret; trades++; }
    eq *= 1 + ch;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, 1 - eq / peak);
  }
  if (yName) yearly[yName] = Math.round((eq / yStart - 1) * 1000) / 10;
  return { returnPct: Math.round((eq / 1_000_000 - 1) * 1000) / 10, maxDDPct: Math.round(maxDD * 1000) / 10, trades, yearly };
}
const daytrade = {};
const DTBYDAY = {};
for (const [sk, sg] of Object.entries(DT_SIGNALS)) {
  const evs = sg.events();
  for (const stop of [0, 0.02]) {
    for (const [fk, f] of Object.entries(DT_FILTERS)) {
      const per = { train: [], test: [] };
      const byDay = new Map();
      const seen = new Set();
      for (const e of evs) {
        const k = e.i * D + e.d;
        if (!elig[k] || seen.has(k)) continue;
        seen.add(k);
        const t = dayRet(e.i, e.d, sg.side ?? 1, stop);
        if (!t || !f.ok(t.gap)) continue;
        per[e.d < split ? 'train' : 'test'].push(t.ret);
        if (!byDay.has(e.d)) byDay.set(e.d, []);
        byDay.get(e.d).push({ i: e.i, score: e.score, ret: t.ret });
      }
      for (const a of byDay.values()) a.sort((x, y) => y.score - x.score);
      DTBYDAY[`${sk}|${stop ? 'stop2' : 'nostop'}|${fk}`] = byDay;
      daytrade[`${sk}|${stop ? 'stop2' : 'nostop'}|${fk}`] = {
        name: `${sg.name} / ${stop ? '損切り-2%' : '損切りなし'} / ${f.name}`,
        train: summarize(per.train),
        test: summarize(per.test),
        portfolioTrain: dtPortfolio(byDay, 27, split - 1),
        portfolioTest: dtPortfolio(byDay, split, D - 1),
      };
    }
  }
}
// 比較用：毎日、流動性条件を満たす銘柄から無作為に10銘柄を寄り買い・引け売り ×200回
const dtBaseline = (() => {
  const daily = new Map();
  for (let d = 26; d < D - 1; d++) {
    const a = [];
    for (let i = 0; i < N; i++) { if (!elig[i * D + d]) continue; const t = dayRet(i, d, 1, 0); if (t) a.push(t.ret); }
    daily.set(d, a);
  }
  const res = { train: [], test: [] };
  for (let r = 0; r < 200; r++) {
    for (const [pk, [a, b]] of [['train', [27, split - 1]], ['test', [split, D - 1]]]) {
      let eq = 1;
      for (let d = a; d <= b; d++) {
        const arr = daily.get(d - 1);
        if (!arr || !arr.length) continue;
        let ch = 0;
        for (let k = 0; k < 10; k++) ch += 0.1 * arr[Math.floor(rand() * arr.length)];
        eq *= 1 + ch;
      }
      res[pk].push(Math.round((eq - 1) * 1000) / 10);
    }
  }
  const sum = (x) => { x.sort((p, q) => p - q); return { avg: Math.round((x.reduce((p, q) => p + q, 0) / x.length) * 10) / 10, p90: x[180] }; };
  return { name: '無作為に10銘柄を寄り買い引け売り×200回', train: sum(res.train), test: sum(res.test) };
})();

// ---------- 発表当日にすでにどれだけ上がっていたか別の成績（場中の発表で当日に跳ねたケースの確認） ----------
const dayMoveBuckets = (() => {
  const B = [['下落', -1, 0], ['0〜5%', 0, 0.05], ['5〜10%', 0.05, 0.1], ['10%以上', 0.1, 9]];
  const out = {};
  for (const [sk, evf] of [['div_up', () => EVENTS.div_up], ['earn_up_trend', () => EVENTS.earn_up.filter((e) => aboveMA25(e.i, e.d))]]) {
    for (const [hk, ex] of [['dt', null], ['hold5', EXITS.hold5]]) {
      const acc = {};
      const seen = new Set();
      for (const e of evf()) {
        const k = e.i * D + e.d;
        if (!elig[k] || seen.has(k)) continue;
        seen.add(k);
        const mv = at(C, e.i, e.d) / at(C, e.i, e.d - 1) - 1;
        const b = B.find(([, lo, hi]) => mv >= lo && mv < hi);
        if (!b) continue;
        const t = ex ? simulate(e.i, e.d, ex) : dayRet(e.i, e.d, 1, 0);
        if (!t) continue;
        const per = e.d < split ? 'train' : 'test';
        ((acc[b[0]] ??= { train: [], test: [] })[per]).push(t.ret);
      }
      out[`${sk}|${hk}`] = Object.fromEntries(Object.entries(acc).map(([b, v]) => [b, { train: summarize(v.train), test: summarize(v.test) }]));
    }
  }
  return out;
})();

// ---------- 頑健性チェック：全期間の年ごとの成績、売買コストを厳しくした場合 ----------
function byDayFor(sk, ek) {
  const st = { ...STRATEGIES, ...EVENT_STRATEGIES }[sk];
  const ex = EXITS[ek];
  const m = new Map();
  const src = st.events ? st.events() : [];
  const seen = new Set();
  for (const e of src) {
    const k = e.i * D + e.d;
    if (!elig[k] || seen.has(k)) continue;
    seen.add(k);
    const t = simulate(e.i, e.d, ex);
    if (!t) continue;
    if (!m.has(e.d)) m.set(e.d, []);
    m.get(e.d).push({ i: e.i, score: e.score, ...t });
  }
  for (const arr of m.values()) arr.sort((a, b) => b.score - a.score);
  return m;
}
const robustness = {};
for (const [sk, ek] of [['ev_div_up', 'hold5'], ['ev_earn_up_trend', 'hold5'], ['ev_earn_up', 'stop'], ['ev_div_up_gap', 'hold5'], ['ev_earn_up_trend_gap', 'hold5']]) {
  const key = sk + '|' + ek;
  const r = { name: results[sk].name + ' / ' + EXITS[ek].name };
  r.fullPeriod = portfolio(BYDAY[key], EXITS[ek], 26, D - 1);
  for (const slip of [0.002, 0.003]) {
    const keep = SLIP;
    SLIP = slip;
    const m = byDayFor(sk, ek);
    r['slip' + slip * 1000] = { train: portfolio(m, EXITS[ek], 26, split - 1), test: portfolio(m, EXITS[ek], split, D - 1) };
    SLIP = keep;
  }
  robustness[key] = r;
}
// ---------- 100株単位の資金シミュレーション（2026-11-12〜。ウィブルは日本株の単元未満株に未対応） ----------
// 必要資金は調整前の始値×100株。raw が無い日は調整後の始値で代用（分割前は実際より安く見える＝甘め）
const RO = F(N);
let rawDays = 0;
if (fs.existsSync(path.join(DATA, 'raw'))) {
  for (const f of fs.readdirSync(path.join(DATA, 'raw'))) {
    const d = di.get(f.slice(0, 10));
    if (d == null) continue;
    rawDays++;
    for (const [code, o] of JSON.parse(fs.readFileSync(path.join(DATA, 'raw', f), 'utf8'))) {
      const i = ci.get(code);
      if (i != null && o > 0) RO[i * D + d] = o;
    }
  }
}
function lotPortfolio(signalsByDay, capital, maxN, fromD, toD) {
  let cash = capital, peak = capital, maxDD = 0, trades = 0, noMoney = 0, approx = 0;
  const pos = [];
  const yearly = {}; let yName = null, yStart = capital, prevM = capital;
  for (let d = fromD; d <= toD; d++) {
    for (let k = pos.length - 1; k >= 0; k--) if (pos[k].exitD <= d) { cash += pos[k].size * (1 + pos[k].ret); pos.splice(k, 1); }
    const eq = cash + pos.reduce((a, p) => a + p.size, 0);
    for (const s of signalsByDay.get(d - 1) ?? []) {
      if (pos.length >= maxN) break;
      if (pos.some((p) => p.i === s.i)) continue;
      let px = at(RO, s.i, d);
      if (!(px > 0)) { px = at(O, s.i, d); approx++; }
      const lot = px * 100 * (1 + SLIP);
      const lots = Math.floor(Math.min(cash, eq / maxN) / lot);
      if (lots < 1) { noMoney++; continue; }
      const size = lots * lot;
      cash -= size;
      pos.push({ i: s.i, exitD: d + s.days, ret: s.ret, size, entryPx: at(O, s.i, d) * (1 + SLIP) });
      trades++;
    }
    const m = cash + pos.reduce((a, p) => { const c = at(C, p.i, d); return a + (Number.isNaN(c) ? p.size : p.size * (c * (1 - SLIP)) / p.entryPx); }, 0);
    const yn = dates[d].slice(0, 4);
    if (yn !== yName) { if (yName) yearly[yName] = Math.round((prevM / yStart - 1) * 1000) / 10; yName = yn; yStart = prevM; }
    prevM = m;
    peak = Math.max(peak, m); maxDD = Math.max(maxDD, 1 - m / peak);
  }
  for (const p of pos) cash += p.size * (1 + p.ret);
  if (yName) yearly[yName] = Math.round((cash / yStart - 1) * 1000) / 10;
  return { final: Math.round(cash), returnPct: Math.round((cash / capital - 1) * 1000) / 10, maxDDPct: Math.round(maxDD * 1000) / 10, trades, skippedNoMoney: noMoney, approxPrice: approx, yearly };
}
const lotSim = { rawDays, capitals: [300000, 500000, 1000000, 2000000, 3000000], maxNs: [1, 2, 3, 5, 10], results: {} };
for (const key of ['ev_div_up|hold5', 'ev_div_up_gap|hold5', 'ev_earn_up_trend|hold5', 'ev_earn_up_trend_gap|hold5']) {
  const r = (lotSim.results[key] = { name: robustness[key]?.name ?? key, grid: {} });
  for (const cap of lotSim.capitals) for (const n of lotSim.maxNs) {
    r.grid[`${cap}|${n}`] = { full: lotPortfolio(BYDAY[key], cap, n, 26, D - 1), train: lotPortfolio(BYDAY[key], cap, n, 26, split - 1), test: lotPortfolio(BYDAY[key], cap, n, split, D - 1) };
  }
}

// デイトレも100株単位で：毎朝、資金を最大N銘柄に分けて100株単位で買い、その日の引けで売る
function lotDt(byDay, capital, maxN, fromD, toD) {
  let eq = capital, peak = eq, maxDD = 0, trades = 0, noMoney = 0;
  const yearly = {}; let yName = null, yStart = eq;
  for (let d = fromD; d <= toD; d++) {
    const yn = dates[d].slice(0, 4);
    if (yn !== yName) { if (yName) yearly[yName] = Math.round((eq / yStart - 1) * 1000) / 10; yName = yn; yStart = eq; }
    const arr = byDay.get(d - 1);
    if (!arr) continue;
    let cash = eq, pnl = 0, n = 0;
    for (const s of arr) {
      if (n >= maxN) break;
      const px = at(RO, s.i, d) > 0 ? at(RO, s.i, d) : at(O, s.i, d);
      const lot = px * 100 * (1 + SLIP);
      const lots = Math.floor(Math.min(cash, eq / maxN) / lot);
      if (lots < 1) { noMoney++; continue; }
      cash -= lots * lot; pnl += lots * lot * s.ret; n++; trades++;
    }
    eq += pnl;
    peak = Math.max(peak, eq); maxDD = Math.max(maxDD, 1 - eq / peak);
  }
  if (yName) yearly[yName] = Math.round((eq / yStart - 1) * 1000) / 10;
  return { final: Math.round(eq), returnPct: Math.round((eq / capital - 1) * 1000) / 10, maxDDPct: Math.round(maxDD * 1000) / 10, trades, skippedNoMoney: noMoney, yearly };
}
lotSim.daytrade = {};
for (const key of ['div_up|nostop|all', 'div_up|nostop|gapUp', 'div_up|stop2|all', 'results|nostop|all']) {
  const r = (lotSim.daytrade[key] = { name: daytrade[key]?.name ?? key, grid: {} });
  for (const cap of lotSim.capitals) for (const n of lotSim.maxNs) {
    r.grid[`${cap}|${n}`] = { full: lotDt(DTBYDAY[key], cap, n, 27, D - 1), train: lotDt(DTBYDAY[key], cap, n, 27, split - 1), test: lotDt(DTBYDAY[key], cap, n, split, D - 1) };
  }
}

// 比較：同じ100株・銘柄数の縛りで、全銘柄から無作為に選んで5日持った場合（50回の平均と上位1割）
lotSim.random = {};
for (const cap of [300000, 500000, 1000000]) for (const n of [1, 2, 3, 5]) {
  const base = BYDAY['all|hold5'];
  if (!base) break;
  const finals = [], dds = [];
  for (let r = 0; r < 50; r++) {
    const m = new Map();
    for (const [d, arr] of base) m.set(d, arr.map((x) => ({ ...x, score: rand() })).sort((a, b) => b.score - a.score).slice(0, 30));
    const p = lotPortfolio(m, cap, n, 26, D - 1);
    finals.push(p.returnPct); dds.push(p.maxDDPct);
  }
  finals.sort((a, b) => a - b);
  lotSim.random[`${cap}|${n}`] = { avg: Math.round(finals.reduce((a, b) => a + b, 0) / finals.length * 10) / 10, p90: finals[45], p10: finals[5], avgDD: Math.round(dds.reduce((a, b) => a + b, 0) / dds.length * 10) / 10 };
}

const randomYearly = (() => {
  const base = BYDAY['all|hold10'];
  const acc = {};
  for (let r = 0; r < 100; r++) {
    const m = new Map();
    for (const [d, arr] of base) m.set(d, arr.map((x) => ({ ...x, score: rand() })).sort((a, b) => b.score - a.score));
    const p = portfolio(m, null, 26, D - 1);
    for (const [y, v] of Object.entries(p.yearly)) (acc[y] ??= []).push(v);
  }
  return Object.fromEntries(Object.entries(acc).map(([y, a]) => { a.sort((x, z) => x - z); return [y, { avg: Math.round((a.reduce((x, z) => x + z, 0) / a.length) * 10) / 10, p90: a[90] }]; }));
})();

const out = {
  ok: true,
  generatedAt: new Date().toISOString(),
  days: D,
  universe: N,
  fins: { days: finsDays, rows: finsRows, events: Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, v.length])) },
  periods,
  rules: { slippagePerSide: SLIP, commission: 0, minTurnover20d: MIN_TURNOVER, minPrice: MIN_PRICE, entry: '翌営業日始値' },
  results,
  combos,
  baseline,
  robustness,
  randomYearly,
  daytrade,
  dtBaseline,
  dayMoveBuckets,
  afterDrops,
  lotSim,
};
fs.writeFileSync(path.join(OUT, 'backtest.json'), JSON.stringify(out, null, 2));
console.log(`backtest ok: days=${D} universe=${N}`);
