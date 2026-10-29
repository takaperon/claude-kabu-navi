// 日足スイング戦略のバックテスト。出力は集計値のみ（個別銘柄の価格は出さない）。
// ルール：シグナルは当日終値まで、エントリーは翌営業日の始値。滑り0.1%/片道、手数料0円。
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data';
const OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
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
  rows.sort((a, b) => (a.dd + (a.dt ?? '')).localeCompare(b.dd + (b.dt ?? '')));
  const lastFop = new Map(), lastDiv = new Map();
  for (const r of rows) {
    const i = ci.get(r.c);
    const d = signalDayFor(r.dd);
    const ok = i !== undefined && d != null && d >= 26 && d < D - 1;
    const isResults = /FinancialStatements/.test(r.ty ?? '');
    // 会社の業績予想（営業利益）：同じ事業年度の前回予想と比べる
    const upd = (fy, v, kind) => {
      if (!fy || v == null) return;
      const k = r.c + '|' + fy;
      const prev = lastFop.get(k);
      lastFop.set(k, v);
      if (!ok || prev == null || !(prev > 0)) return;
      const ch = v / prev - 1;
      if (ch >= 0.1) EVENTS.earn_up.push({ i, d, score: ch });
      if (ch <= -0.1) EVENTS.earn_down.push({ i, d, score: -ch });
    };
    upd(r.fy, r.fop);
    upd(r.nfy, r.nfop);
    // 本決算で「来期予想」が今期実績より大きく伸びる（強気の見通し）
    if (ok && isResults && r.pt === 'FY' && r.op > 0 && r.nfop != null && r.nfop / r.op - 1 >= 0.2) {
      EVENTS.guidance.push({ i, d, score: r.nfop / r.op - 1 });
    }
    // 配当予想の引き上げ（同じ事業年度の前回予想比）、本決算で来期配当予想が今期実績を上回る
    const updDiv = (fy, v) => {
      if (!fy || v == null) return;
      const k = r.c + '|' + fy;
      const prev = lastDiv.get(k);
      lastDiv.set(k, v);
      if (ok && prev > 0 && v / prev - 1 >= 0.05) EVENTS.div_up.push({ i, d, score: v / prev - 1 });
    };
    updDiv(r.fy, r.fdiv);
    updDiv(r.nfy, r.nfdiv);
    if (ok && isResults && r.pt === 'FY' && r.div > 0 && r.nfdiv != null && r.nfdiv / r.div - 1 >= 0.05) {
      EVENTS.div_up.push({ i, d, score: r.nfdiv / r.div - 1 });
    }
    if (ok && isResults) EVENTS.results.push({ i, d, score: rand() });
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
    peak = Math.max(peak, m);
    maxDD = Math.max(maxDD, 1 - m / peak);
  }
  for (const p of pos) cash += p.size * (1 + p.ret);
  return { final: Math.round(cash), returnPct: Math.round((cash / 1_000_000 - 1) * 1000) / 10, maxDDPct: Math.round(maxDD * 1000) / 10, trades };
}

// 流動性条件は一度だけ計算
const elig = new Uint8Array(N * D);
for (let i = 0; i < N; i++) for (let d = 20; d < D; d++) elig[i * D + d] = eligible(i, d) ? 1 : 0;

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
};
fs.writeFileSync(path.join(OUT, 'backtest.json'), JSON.stringify(out, null, 2));
console.log(`backtest ok: days=${D} universe=${N}`);
