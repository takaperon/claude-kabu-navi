// 毎日の仮想売買（お金は使わない）
// 各営業日の引け後に実行：
//   1) 前回までに出たシグナルを、その日の始値で仮想購入
//   2) 保有日数に達したものを、その日の終値で仮想売却
//   3) 新しい開示から次の営業日に買う候補を作る
// 状態（価格を含む）は data/paper/state.json（暗号化キャッシュ内）に置き、
// 公開する reports-out/paper.json には銘柄名・日付・損益率だけを出す。
import fs from 'node:fs';
import path from 'node:path';
import { detectEvents } from './lib/events.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data';
const OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
const MIN_TURNOVER = 1e8;
const MIN_PRICE = 100;
const START = 1_000_000;
// 税金（特定口座・源泉徴収あり）：その年の売却益の合計に 20.315%。年内に損が出たら払いすぎた分は戻る。年をまたいだ損の繰越は考えない
const TAX = 0.20315;
const yearOf = (d) => d.slice(0, 4);
function taxDueAt(st, date) {
  const y = yearOf(date);
  const net = st.closed.filter((c) => yearOf(c.exitDate) === y && c.exitDate <= date).reduce((a, c) => a + c.profitYen, 0);
  return Math.round(Math.max(0, net) * TAX);
}
const STOCK_MKT = new Set(['0111', '0112', '0113']);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(DATA, 'paper'), { recursive: true });

const STRATS = {
  swing_div: { name: '配当予想の引き上げ（5日保有）', kinds: ['div_up'], hold: 5 },
  swing_earn: { name: '上方修正＋株価が上向き（5日保有）', kinds: ['earn_up'], hold: 5, trend: true },
  dt_div: { name: 'デイトレ：配当予想の引き上げ（寄りで買って引けで売る）', kinds: ['div_up'], hold: 1 },
  // 夜の反応で選別：寄り付きが前日終値より上の時だけ買う
  swing_earn_gap: { name: '上方修正＋上向き＋朝高く始まった時だけ（5日保有）', kinds: ['earn_up'], hold: 5, trend: true, gap: true, base: 'swing_earn' },
  swing_div_gap: { name: '配当予想の引き上げ＋朝高く始まった時だけ（5日保有）', kinds: ['div_up'], hold: 5, gap: true, base: 'swing_div' },
  // 本番と同じ条件（2026-11-12〜）：ウィブルは日本株を100株単位でしか買えないので、30万円・最大2銘柄・100株単位
  real30_div_gap: { name: '本番想定：30万円・100株単位・2銘柄（増配＋朝高）', kinds: ['div_up'], hold: 5, gap: true, base: 'swing_div_gap', capital: 300_000, maxN: 2, lot: 100 },
};

// ---------- データ ----------
const priceFiles = fs.readdirSync(path.join(DATA, 'prices')).filter((f) => f.endsWith('.json')).sort();
const dates = priceFiles.map((f) => f.slice(0, 10));
const priceCache = new Map();
function pricesOn(date) {
  if (!priceCache.has(date)) {
    const m = new Map();
    for (const [code, o, h, l, c, vo, va] of JSON.parse(fs.readFileSync(path.join(DATA, 'prices', `${date}.json`), 'utf8'))) {
      m.set(code, { o, h, l, c, va });
    }
    priceCache.set(date, m);
  }
  return priceCache.get(date);
}
const rawCache = new Map();
function rawOn(date) {
  if (!rawCache.has(date)) {
    const f = path.join(DATA, 'raw', `${date}.json`);
    rawCache.set(date, new Map(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).map(([c, o]) => [c, o]) : []));
  }
  return rawCache.get(date);
}
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
const info = new Map(master.map((m) => [m.Code, m]));
const nameOf = (c) => info.get(c)?.CoName ?? c;

const finsRows = [];
for (const f of fs.readdirSync(path.join(DATA, 'fins')).sort()) {
  for (const r of JSON.parse(fs.readFileSync(path.join(DATA, 'fins', f), 'utf8'))) finsRows.push(r);
}
const events = detectEvents(finsRows);

// シグナル日 = 開示日以前で最後の営業日（引け後の開示も含めて翌営業日の始値で買う）
const idxOf = new Map(dates.map((d, k) => [d, k]));
function signalIdx(dd) {
  let lo = 0, hi = dates.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] <= dd) lo = m + 1; else hi = m; }
  return lo - 1;
}
function eligibleAt(code, k) {
  if (!STOCK_MKT.has(info.get(code)?.Mkt)) return false;
  if (k < 25) return false;
  const p = pricesOn(dates[k]).get(code);
  if (!p || !(p.c >= MIN_PRICE)) return false;
  let s = 0;
  for (let j = k - 19; j <= k; j++) { const q = pricesOn(dates[j]).get(code); if (!q) return false; s += q.va; }
  return s / 20 >= MIN_TURNOVER;
}
function aboveMA25(code, k) {
  let s = 0;
  for (let j = k - 24; j <= k; j++) { const q = pricesOn(dates[j]).get(code); if (!q) return false; s += q.c; }
  return pricesOn(dates[k]).get(code).c > s / 25;
}
const evKey = (e) => [e.c, e.dd, e.dt, e.kind, e.detail?.fy ?? '', e.detail?.nextYear ? 'n' : ''].join('|');
const pct = (x) => Math.round(x * 1000) / 10;

// ---------- 状態 ----------
const statePath = path.join(DATA, 'paper', 'state.json');
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
const latest = dates.at(-1);
if (!state) {
  // 初回：今日から開始。今日より前の開示は「見た」扱いにして、過去にさかのぼって買わない
  state = { startDate: latest, lastDate: latest, seen: {}, strategies: {} };
  for (const e of events) if (e.dd < latest) state.seen[evKey(e)] = 1;
}
for (const [k, cfg] of Object.entries(STRATS)) {
  if (!state.strategies[k]) {
    const cap = cfg.capital ?? START;
    state.strategies[k] = { cash: cap, positions: [], pending: [], closed: [], equity: [{ date: state.lastDate, value: cap }] };
    // 途中から追加した戦略は、同じシグナルを使う元の戦略の買い候補を引き継ぐ
    if (cfg.base && state.strategies[cfg.base]) state.strategies[k].pending = JSON.parse(JSON.stringify(state.strategies[cfg.base].pending));
  }
}

// 税金を入れる前の状態からの移行（2026-11-12）：過去の資産の推移と現金から、その時点までの税金を引く
if (!state.taxApplied) {
  for (const st of Object.values(state.strategies)) {
    st.tax = {};
    for (const e of st.equity) e.value -= taxDueAt(st, e.date);
    for (const c of st.closed) { const y = yearOf(c.exitDate); st.tax[y] = taxDueAt(st, `${y}-12-31`); }
    st.cash -= Object.values(st.tax).reduce((a, b) => a + b, 0);
  }
  state.taxApplied = 1;
}

// ---------- 1) 2) 新しい営業日を順に処理 ----------
const newDates = dates.filter((d) => d > state.lastDate);
for (const T of newDates) {
  const px = pricesOn(T);
  for (const [k, cfg] of Object.entries(STRATS)) {
    const st = state.strategies[k];
    const basis = () => st.cash + st.positions.reduce((a, p) => a + p.size, 0);
    // 始値で購入
    for (const pd of st.pending.sort((a, b) => b.score - a.score)) {
      if (st.positions.length >= (cfg.maxN ?? 10)) break;
      if (st.positions.some((p) => p.code === pd.code)) continue;
      const p = px.get(pd.code);
      if (!p || !(p.o > 0)) continue;
      if (cfg.gap) {
        const prevK = idxOf.get(T) - 1;
        const prev = prevK >= 0 ? pricesOn(dates[prevK]).get(pd.code) : null;
        if (!prev || !(p.o > prev.c)) continue; // 朝安く始まったら見送り
      }
      const eq = basis();
      let size;
      if (cfg.lot) {
        // 100株単位：調整前の始値で必要資金を計算。買えなければ次の候補へ
        const raw = rawOn(T).get(pd.code) ?? p.o;
        const lotCost = raw * cfg.lot * (1 + SLIP);
        const lots = Math.floor(Math.min(st.cash, eq / cfg.maxN) / lotCost);
        if (lots < 1) continue;
        size = lots * lotCost;
        pd.shares = lots * cfg.lot;
      } else {
        size = Math.min(st.cash, eq * 0.1);
        if (size < eq * 0.05) break;
      }
      st.cash -= size;
      st.positions.push({ code: pd.code, kind: pd.kind, reason: pd.reason, entryDate: T, entryPx: p.o * (1 + SLIP), size, held: 0, shares: pd.shares });
    }
    st.pending = [];
    // 保有日数に達したら終値で売却
    for (let j = st.positions.length - 1; j >= 0; j--) {
      const pos = st.positions[j];
      const p = px.get(pos.code);
      if (!p) continue; // 売買停止などで値段がない日は持ち越し
      pos.held++;
      pos.lastPx = p.c;
      if (pos.held >= cfg.hold) {
        const r = (p.c * (1 - SLIP)) / pos.entryPx - 1;
        st.cash += pos.size * (1 + r);
        st.closed.push({ code: pos.code, name: nameOf(pos.code), reason: pos.reason, entryDate: pos.entryDate, exitDate: T, retPct: pct(r), profitYen: Math.round(pos.size * r) });
        st.positions.splice(j, 1);
        // 売るたびに、その年の税金を計算し直して差額を引く（損なら戻る）
        st.tax ??= {};
        const y = yearOf(T), due = taxDueAt(st, T);
        st.cash -= due - (st.tax[y] ?? 0);
        st.tax[y] = due;
      }
    }
    const mark = st.cash + st.positions.reduce((a, p) => a + p.size * ((p.lastPx ?? p.entryPx) * (1 - SLIP)) / p.entryPx, 0);
    st.equity.push({ date: T, value: Math.round(mark) });
  }
  state.lastDate = T;
}

// ---------- 3) 新しい開示から次の営業日の買い候補 ----------
const lastK = idxOf.get(state.lastDate);
const found = [];
for (const e of events) {
  const key = evKey(e);
  if (state.seen[key]) continue;
  state.seen[key] = 1;
  const k = signalIdx(e.dd);
  if (k < 0) continue;
  const late = k < lastK; // シグナル日を過ぎてから見つかった（夜遅い開示など）
  for (const [sk, cfg] of Object.entries(STRATS)) {
    if (!cfg.kinds.includes(e.kind)) continue;
    if (!eligibleAt(e.c, k)) continue;
    if (cfg.trend && !aboveMA25(e.c, k)) continue;
    const st = state.strategies[sk];
    if (st.pending.some((p) => p.code === e.c)) continue;
    const reason = e.kind === 'div_up'
      ? `配当予想を${e.detail.nextYear ? '来期' : ''}+${pct(e.score)}%引き上げ（${e.dd}発表）`
      : `営業利益予想を+${pct(e.score)}%上方修正（${e.dd}発表）`;
    st.pending.push({ code: e.c, kind: e.kind, score: e.score, reason, signalDate: dates[k], late });
    found.push(sk);
  }
}

fs.writeFileSync(statePath, JSON.stringify(state));

// ---------- 公開用（銘柄名・日付・損益率のみ） ----------
const out = { updatedAt: new Date().toISOString(), startDate: state.startDate, lastDate: state.lastDate, strategies: {} };
for (const [k, cfg] of Object.entries(STRATS)) {
  const st = state.strategies[k];
  const eqNow = st.equity.at(-1).value;
  const rets = st.closed.map((c) => c.retPct);
  out.strategies[k] = {
    name: cfg.name,
    hold: cfg.hold,
    gap: !!cfg.gap,
    kinds: cfg.kinds,
    equityYen: eqNow, // 税引き後（売った分の税金を引いた後。持っている株の含み益には、まだ税金はかからない）
    taxYen: Object.values(st.tax ?? {}).reduce((a, b) => a + b, 0),
    capital: cfg.capital ?? START,
    returnPct: pct(eqNow / (cfg.capital ?? START) - 1),
    trades: st.closed.length,
    winRatePct: rets.length ? pct(rets.filter((r) => r > 0).length / rets.length) : null,
    avgRetPct: rets.length ? Math.round((rets.reduce((a, b) => a + b, 0) / rets.length) * 100) / 100 : null,
    holdings: st.positions.map((p) => ({ code: p.code, name: nameOf(p.code), reason: p.reason, entryDate: p.entryDate, daysHeld: p.held, shares: p.shares, unrealPct: pct(((p.lastPx ?? p.entryPx) * (1 - SLIP)) / p.entryPx - 1) })),
    nextBuys: st.pending.sort((a, b) => b.score - a.score).slice(0, 10).map((p) => ({ code: p.code, name: nameOf(p.code), reason: p.reason, late: p.late })),
    recentClosed: st.closed.slice(-30).reverse(),
    equityHistory: st.equity,
  };
}
fs.writeFileSync(path.join(OUT, 'paper.json'), JSON.stringify(out, null, 2));
console.log(`paper ok: lastDate=${state.lastDate} newDates=${newDates.length} newSignals=${found.length}`);
