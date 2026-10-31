// FX 日足戦略のバックテスト（円建て口座、通貨ペアごとに別口座で計算）
// ルール：シグナルは当日終値まで、売買は翌営業日の始値。
// コスト：スプレッド（滑り込み）＋スワップ（政策金利差−0.5%で近似）
// レバレッジ：1・2・5・10・25倍。必要証拠金4%、証拠金維持率50%でロスカット。
// 窓開けでロスカットが間に合わない場合は、口座がマイナス＝不足金（借金）として記録する。
// 出力は集計値のみ（為替レートそのものは出さない）
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data-fx';
const OUT = args.out ?? 'reports-out';
fs.mkdirSync(OUT, { recursive: true });

const PAIRS = ['usdjpy', 'eurjpy', 'gbpjpy', 'audjpy'];
// スプレッド＋滑り（往復、円）。今の主要FX会社より広めに見込む
const SPREAD = { usdjpy: 0.008, eurjpy: 0.012, gbpjpy: 0.025, audjpy: 0.015 };
const SWAP_MARKUP = 0.5; // 年%：業者の取り分として不利側に見込む
const MARGIN = 0.04; // 必要証拠金（25倍）
const LOSSCUT = 0.5; // 証拠金維持率50%でロスカット
const LEVERAGES = [1, 2, 5, 10, 25];
const START = 1_000_000;
const SPLIT = args.split ?? '2018-01-01';

let seed = 4242;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// ---------- データ ----------
const rates = fs.existsSync(path.join(DATA, 'rates.json')) ? JSON.parse(fs.readFileSync(path.join(DATA, 'rates.json'), 'utf8')) : {};
function ffill(series, dates) {
  // series: [[date, pct]...] 昇順 → dates に合わせて前方埋め（なければ null）
  const out = new Array(dates.length).fill(null);
  if (!series) return out;
  let j = -1;
  for (let k = 0; k < dates.length; k++) {
    while (j + 1 < series.length && series[j + 1][0] <= dates[k]) j++;
    out[k] = j >= 0 ? series[j][1] : null;
  }
  return out;
}

function loadPair(p) {
  const f = path.join(DATA, `${p}.json`);
  if (!fs.existsSync(f)) return null;
  const rows = JSON.parse(fs.readFileSync(f, 'utf8')).filter((r) => r[0] >= '2000-01-01');
  const dates = rows.map((r) => r[0]);
  const O = rows.map((r) => r[1]), H = rows.map((r) => r[2]), L = rows.map((r) => r[3]), C = rows.map((r) => r[4]);
  const rb = ffill(rates[p.slice(0, 3)], dates), rj = ffill(rates.jpy, dates);
  const diff = dates.map((_, k) => (rb[k] != null && rj[k] != null ? rb[k] - rj[k] : null));
  const closeOnly = rows.every((r) => r[2] === r[4] && r[3] === r[4]);
  return { p, dates, O, H, L, C, diff, closeOnly, n: rows.length };
}

// ---------- 指標 ----------
const sma = (A, k, n) => {
  if (k < n - 1) return NaN;
  let s = 0;
  for (let j = k - n + 1; j <= k; j++) s += A[j];
  return s / n;
};
const hi = (A, k, n) => (k < n ? NaN : Math.max(...A.slice(k - n, k)));
const lo = (A, k, n) => (k < n ? NaN : Math.min(...A.slice(k - n, k)));
function rsi(C, k, n) {
  if (k < n) return NaN;
  let up = 0, dn = 0;
  for (let j = k - n + 1; j <= k; j++) {
    const ch = C[j] - C[j - 1];
    if (ch > 0) up += ch; else dn -= ch;
  }
  return up + dn === 0 ? 50 : (100 * up) / (up + dn);
}

// ---------- 戦略：各日の終値時点で「次の日に持ちたいポジション」(+1買い/-1売り/0なし) ----------
const STRATEGIES = {
  hold_long: { name: '比較用：ずっと買い持ち', run: (s) => s.C.map(() => 1) },
  ma200: {
    name: '200日線より上なら買い・下なら売り',
    run: (s) => s.C.map((c, k) => { const m = sma(s.C, k, 200); return Number.isNaN(m) ? 0 : c > m ? 1 : -1; }),
  },
  ma200_long: {
    name: '200日線より上の時だけ買い',
    run: (s) => s.C.map((c, k) => { const m = sma(s.C, k, 200); return Number.isNaN(m) ? 0 : c > m ? 1 : 0; }),
  },
  ma_cross: {
    name: '50日線と200日線の交差（ゴールデン/デッドクロス）',
    run: (s) => s.C.map((_, k) => { const a = sma(s.C, k, 50), b = sma(s.C, k, 200); return Number.isNaN(b) ? 0 : a > b ? 1 : -1; }),
  },
  donchian: {
    name: '55日高値ブレイクで買い・20日安値で手じまい（売りも対称）',
    run: (s) => {
      const out = []; let pos = 0;
      for (let k = 0; k < s.n; k++) {
        const c = s.C[k];
        if (k >= 55) {
          if (pos <= 0 && c > hi(s.H, k, 55)) pos = 1;
          else if (pos >= 0 && c < lo(s.L, k, 55)) pos = -1;
          else if (pos === 1 && c < lo(s.L, k, 20)) pos = 0;
          else if (pos === -1 && c > hi(s.H, k, 20)) pos = 0;
        }
        out.push(pos);
      }
      return out;
    },
  },
  tsmom3: {
    name: '過去3か月上がっていれば買い・下がっていれば売り',
    run: (s) => s.C.map((c, k) => (k < 63 ? 0 : c > s.C[k - 63] ? 1 : -1)),
  },
  tsmom12: {
    name: '過去12か月上がっていれば買い・下がっていれば売り',
    run: (s) => s.C.map((c, k) => (k < 252 ? 0 : c > s.C[k - 252] ? 1 : -1)),
  },
  carry: {
    name: '金利差が1%以上ある時だけ高金利通貨を買う',
    run: (s) => s.diff.map((d) => (d == null ? 0 : d >= 1 ? 1 : 0)),
  },
  carry_trend: {
    name: '金利差1%以上＋200日線より上の時だけ買い',
    run: (s) => s.C.map((c, k) => { const m = sma(s.C, k, 200); const d = s.diff[k]; return d != null && d >= 1 && c > m ? 1 : 0; }),
  },
  rsi2: {
    name: '短期の行き過ぎ戻り（RSI2）＋200日線の方向だけ',
    run: (s) => {
      const out = []; let pos = 0;
      for (let k = 0; k < s.n; k++) {
        const m = sma(s.C, k, 200), r = rsi(s.C, k, 2), m5 = sma(s.C, k, 5), c = s.C[k];
        if (!Number.isNaN(m)) {
          if (pos === 0 && c > m && r < 10) pos = 1;
          else if (pos === 0 && c < m && r > 90) pos = -1;
          else if (pos === 1 && c > m5) pos = 0;
          else if (pos === -1 && c < m5) pos = 0;
        }
        out.push(pos);
      }
      return out;
    },
  },
};

// ---------- 口座シミュレーション ----------
function simulate(s, want, lev, from, to) {
  // from..to は日付インデックス（両端含む）。want[k] は k日終値時点の希望 → k+1 日始値で執行
  const half = SPREAD[s.p] / 2;
  let cash = START; // 確定済みの資金（未実現損益は含まない）
  let dir = 0, units = 0, entry = 0;
  let peak = START, minEq = START, maxDD = 0, trades = 0, losscuts = 0, ruined = false, debt = 0, swapSum = 0, costSum = 0;
  let wins = 0, closed = 0, sumTradeRet = 0;
  const equity = (p) => cash + dir * units * (p - entry);
  const close = (p, reason) => {
    const pnl = dir * units * (p - entry) - units * half;
    costSum += units * half;
    sumTradeRet += (dir * (p - entry) - half) / entry;
    if (pnl > 0) wins++;
    closed++;
    cash += pnl;
    dir = 0; units = 0;
    if (reason === 'losscut') losscuts++;
    if (cash <= 0) { ruined = true; debt = Math.max(debt, -cash); cash = Math.min(cash, 0); }
  };
  for (let k = from; k <= to; k++) {
    if (ruined) break;
    // 1) 始値で希望ポジションへ
    const w = k - 1 >= 0 ? want[k - 1] : 0;
    if (w !== dir) {
      if (dir !== 0) close(s.O[k], 'signal');
      if (ruined) break;
      if (w !== 0 && cash > 0) {
        dir = w;
        entry = s.O[k];
        units = (cash * lev) / entry;
        cash -= units * half;
        costSum += units * half;
        trades++;
      }
    }
    // 2) ロスカット判定（その日の不利な値まで動いたと仮定）
    if (dir !== 0) {
      const thr = (p) => LOSSCUT * MARGIN * units * p;
      if (equity(s.O[k]) <= thr(s.O[k])) {
        close(s.O[k], 'losscut'); // 窓開け：始値でしか切れない
      } else {
        const worst = dir === 1 ? s.L[k] : s.H[k];
        if (equity(worst) <= thr(worst)) {
          // 維持率がちょうど50%になる価格で決済
          const pcut = dir === 1
            ? (units * entry - cash) / (units * (1 - LOSSCUT * MARGIN))
            : (cash + units * entry) / (units * (1 + LOSSCUT * MARGIN));
          close(pcut, 'losscut');
        }
      }
    }
    if (ruined) break;
    // 3) スワップ（暦日数ぶん）
    if (dir !== 0 && k > from) {
      const days = Math.max(1, Math.round((Date.parse(s.dates[k]) - Date.parse(s.dates[k - 1])) / 864e5));
      const d = s.diff[k];
      if (d != null) {
        const sw = units * s.C[k] * ((dir * d - SWAP_MARKUP) / 100) * (days / 365);
        cash += sw;
        swapSum += sw;
      }
    }
    // 4) 終値で評価
    const eq = dir !== 0 ? equity(s.C[k]) : cash;
    if (eq <= 0) { ruined = true; debt = Math.max(debt, -eq); break; }
    peak = Math.max(peak, eq);
    minEq = Math.min(minEq, eq);
    maxDD = Math.max(maxDD, 1 - eq / peak);
  }
  if (!ruined && dir !== 0) close(s.C[to], 'end');
  const final = ruined ? Math.min(cash, 0) : cash;
  const years = (Date.parse(s.dates[to]) - Date.parse(s.dates[from])) / (365.25 * 864e5);
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    finalYen: Math.round(final),
    totalPct: r1((final / START - 1) * 100),
    cagrPct: final > 0 ? r1((Math.pow(final / START, 1 / years) - 1) * 100) : -100,
    maxDDPct: ruined ? 100 : r1(maxDD * 100),
    minEquityPct: ruined ? 0 : r1((minEq / START) * 100),
    trades,
    losscuts,
    ruined,
    debtYen: Math.round(debt),
    swapYen: Math.round(swapSum),
    costYen: Math.round(costSum),
    winRate: closed ? Math.round((wins / closed) * 1000) / 10 : null,
    avgTradePct: closed ? Math.round((sumTradeRet / closed) * 10000) / 100 : null,
  };
}

// 無作為：10営業日ごとに買い/売り/なしを無作為に選ぶ ×200回
function randomWant(n) {
  const out = []; let cur = 0;
  for (let k = 0; k < n; k++) {
    if (k % 10 === 0) { const r = rand(); cur = r < 1 / 3 ? 1 : r < 2 / 3 ? -1 : 0; }
    out.push(cur);
  }
  return out;
}

// ---------- 実行 ----------
const series = PAIRS.map(loadPair).filter(Boolean);
if (!series.length) {
  fs.writeFileSync(path.join(OUT, 'fx-backtest.json'), JSON.stringify({ ok: false, reason: 'データなし' }, null, 2));
  console.log('fx: no data');
  process.exit(0);
}
const idx = (s, date) => { const k = s.dates.findIndex((d) => d >= date); return k < 0 ? s.n - 1 : k; };
const periodsOf = (s) => {
  const warm = Math.min(260, s.n - 1); // 指標が揃うまで待つ
  const sp = idx(s, SPLIT);
  return { train: [warm, sp - 1], test: [sp, s.n - 1] };
};

const pairsInfo = {};
for (const s of series) {
  const pr = periodsOf(s);
  pairsInfo[s.p] = {
    rows: s.n,
    closeOnly: s.closeOnly,
    swapCoverage: Math.round((s.diff.filter((x) => x != null).length / s.n) * 100),
    train: [s.dates[pr.train[0]], s.dates[pr.train[1]]],
    test: [s.dates[pr.test[0]], s.dates[pr.test[1]]],
  };
}

const results = {};
for (const [sk, st] of Object.entries(STRATEGIES)) {
  results[sk] = { name: st.name, byLev: {} };
  for (const lev of LEVERAGES) {
    const per = {};
    for (const period of ['train', 'test']) {
      const byPair = {};
      for (const s of series) {
        const [a, b] = periodsOf(s)[period];
        byPair[s.p] = simulate(s, st.run(s), lev, a, b);
      }
      const vals = Object.values(byPair);
      const avg = (f) => Math.round((vals.reduce((x, v) => x + f(v), 0) / vals.length) * 10) / 10;
      per[period] = {
        avgCagrPct: avg((v) => v.cagrPct),
        avgMaxDDPct: avg((v) => v.maxDDPct),
        pairsRuined: vals.filter((v) => v.ruined).length,
        pairsWipedOut: vals.filter((v) => v.ruined || v.minEquityPct < 10).length,
        totalLosscuts: vals.reduce((x, v) => x + v.losscuts, 0),
        maxDebtYen: Math.max(...vals.map((v) => v.debtYen)),
        byPair,
      };
    }
    results[sk].byLev[lev] = per;
  }
}

const baseline = {};
for (const lev of LEVERAGES) {
  baseline[lev] = {};
  for (const period of ['train', 'test']) {
    const cagrs = [];
    let ruinedRuns = 0;
    for (let r = 0; r < 200; r++) {
      let sum = 0, anyRuin = false;
      for (const s of series) {
        const [a, b] = periodsOf(s)[period];
        const v = simulate(s, randomWant(s.n), lev, a, b);
        sum += v.cagrPct;
        if (v.ruined) anyRuin = true;
      }
      cagrs.push(sum / series.length);
      if (anyRuin) ruinedRuns++;
    }
    cagrs.sort((x, y) => x - y);
    const r1 = (x) => Math.round(x * 10) / 10;
    baseline[lev][period] = {
      avgCagrPct: r1(cagrs.reduce((x, y) => x + y, 0) / cagrs.length),
      p10: r1(cagrs[20]),
      p90: r1(cagrs[180]),
      runsWithRuin: ruinedRuns,
    };
  }
}

const out = {
  ok: true,
  generatedAt: new Date().toISOString(),
  rules: { spread: SPREAD, swapMarkupPct: SWAP_MARKUP, margin: MARGIN, losscutLevel: LOSSCUT, start: START, split: SPLIT, entry: '翌営業日始値' },
  pairs: pairsInfo,
  results,
  baseline: { name: '無作為に10日ごと買い/売り/なし×200回（4ペア平均の年率）', byLev: baseline },
};
fs.writeFileSync(path.join(OUT, 'fx-backtest.json'), JSON.stringify(out, null, 2));
console.log(`fx backtest ok: pairs=${series.length}`);
