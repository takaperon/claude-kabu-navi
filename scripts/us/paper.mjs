// 米国株の仮想売買（お金は使わない。2026-11-14〜）
// ルール（過去5年・全銘柄の検証で前半・後半ともS&P500を上回ったもの）：
//   決算発表のあと最初の取引日（反応日）に、株価が前日終値から+10%以上上がった銘柄を、次の取引日の始値で買い、20取引日目の終値で売る。
//   同時に最大10銘柄・1銘柄は資金の10%。空いているお金はS&P500（SPY）に置いておく。株価5ドル未満は買わない。
// 実行：毎朝（日本時間）、米国市場の引け後。data-us の株価（Tiingo）とSECの決算発表時刻を使う。
// 状態（価格入り）は data-us/paper/state.json（暗号化キャッシュ）。公開の reports-out/us-paper.json は銘柄・日付・損益率だけ。
import fs from 'node:fs';
import path from 'node:path';
import { usFeatures, usScore, US_LABEL } from './lib-pro.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data-us';
const OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
const START = 300_000; // 円換算の元手（為替は考えない）
const TAX = 0.20315;
// 設定は検証（backtest.mjs）が自動で選んだもの（data-us/choice.json）を使う。無ければ既定値
const choiceF = path.join(DATA, 'choice.json');
const CH = fs.existsSync(choiceF) ? JSON.parse(fs.readFileSync(choiceF, 'utf8')) : null;
const HOLD = CH?.hold ?? 20, REACT = CH?.react ?? 0.10, IDLE = CH?.idle ?? 'spy', MAXN = 10, MIN_PX = 5;
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(DATA, 'paper'), { recursive: true });

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const spyF = path.join(DATA, 'prices', 'SPY.json');
if (!fs.existsSync(spyF)) { console.log('us-paper: no SPY'); process.exit(0); }
const spy = load(spyF); // [date, adjO, adjH, adjL, adjC, adjV, div, split, rawC]
const dates = spy.map((r) => r[0]);
const di = new Map(dates.map((d, k) => [d, k]));
const D = dates.length;
const latest = dates.at(-1);
const universe = load(path.join(DATA, 'universe.json')).list;

// 各銘柄の価格（共通の日付に並べる）
const P = new Map();
function px(t) {
  if (!P.has(t)) {
    const f = path.join(DATA, 'prices', `${t}.json`);
    const m = { O: new Float64Array(D).fill(NaN), H: new Float64Array(D).fill(NaN), L: new Float64Array(D).fill(NaN), C: new Float64Array(D).fill(NaN), V: new Float64Array(D).fill(NaN), RC: new Float64Array(D).fill(NaN) };
    if (fs.existsSync(f)) for (const [d, o, h, l, c, v, , , rc] of load(f)) { const k = di.get(d); if (k != null) { m.O[k] = o; m.H[k] = h; m.L[k] = l; m.C[k] = c; m.V[k] = v; m.RC[k] = rc; } }
    P.set(t, m);
  }
  return P.get(t);
}
const ma200 = (k) => { if (k < 199) return Infinity; let t = 0; for (let j = k - 199; j <= k; j++) t += spy[j][4]; return t / 200; };
const firstIdxOnOrAfter = (d) => { let lo = 0, hi = D; while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] >= d) hi = m; else lo = m + 1; } return lo < D ? lo : null; };

// 決算への反応（バックテストと同じ定義）。反応日 = 9:30前の発表は当日、それ以降は翌取引日
function reactions(u) {
  const f = path.join(DATA, 'sec', `${u.t}.json`);
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const acc of load(f).earnings ?? []) {
    const day = acc.slice(0, 10), hm = acc.slice(11, 16);
    let k = firstIdxOnOrAfter(day);
    if (k == null) continue;
    if (dates[k] === day && hm >= '09:30') k++;
    if (k >= D || k < 1) continue;
    const p = px(u.t);
    const re = p.C[k] / p.C[k - 1] - 1;
    if (!Number.isFinite(re)) continue;
    out.push({ t: u.t, name: u.name, acc, day, k, re, raw: p.RC[k] });
  }
  return out;
}

// ---------- 状態 ----------
const statePath = path.join(DATA, 'paper', 'state.json');
let st = fs.existsSync(statePath) ? load(statePath) : null;
if (!st) st = { startDate: latest, lastDate: latest, cash: START, positions: [], pending: [], closed: [], seen: {}, tax: {}, equity: [{ date: latest, value: START }] };

const yearOf = (d) => d.slice(0, 4);
const taxDue = (date) => {
  const y = yearOf(date);
  const net = st.closed.filter((c) => yearOf(c.exitDate) === y && c.exitDate <= date).reduce((a, c) => a + c.profitYen, 0);
  return Math.round(Math.max(0, net) * TAX);
};
const pct = (x) => Math.round(x * 1000) / 10;

// ---------- 新しい取引日を順に処理 ----------
const newDates = dates.filter((d) => d > st.lastDate);
for (const T of newDates) {
  const k = di.get(T);
  // 空いているお金はSPYに置いている：前日終値→当日終値のSPYの動きで増減
  const s0 = spy[k - 1]?.[4], s1 = spy[k][4];
  const inSpy = IDLE === 'spy' || (IDLE === 'trend' && s0 > ma200(k - 1));
  if (inSpy && s0 > 0 && s1 > 0) st.cash *= s1 / s0;
  st.idleNow = inSpy ? 'spy' : 'cash';
  // 始値で購入（スコア＝反応の大きい順）
  const eq = st.cash + st.positions.reduce((a, p) => a + p.size, 0);
  for (const pd of st.pending.sort((a, b) => b.re - a.re)) {
    if (st.positions.length >= MAXN) break;
    if (st.positions.some((p) => p.t === pd.t)) continue;
    const o = px(pd.t).O[k];
    if (!(o > 0)) continue;
    const size = Math.min(st.cash, eq * 0.1);
    if (size < eq * 0.05) break;
    st.cash -= size;
    st.positions.push({ t: pd.t, name: pd.name, reason: pd.reason, entryDate: T, entryPx: o * (1 + SLIP), size, held: 0, hold: HOLD, lastPx: null });
  }
  st.pending = [];
  // 20取引日目の終値で売却
  for (let j = st.positions.length - 1; j >= 0; j--) {
    const pos = st.positions[j];
    const c = px(pos.t).C[k];
    if (!(c > 0)) continue; // 値段がない日は持ち越し
    pos.held++;
    pos.lastPx = c;
    if (pos.held >= (pos.hold ?? HOLD)) {
      const r = (c * (1 - SLIP)) / pos.entryPx - 1;
      st.cash += pos.size * (1 + r);
      st.closed.push({ t: pos.t, name: pos.name, reason: pos.reason, entryDate: pos.entryDate, exitDate: T, retPct: pct(r), profitYen: Math.round(pos.size * r) });
      st.positions.splice(j, 1);
      const y = yearOf(T), due = taxDue(T);
      st.cash -= due - (st.tax[y] ?? 0);
      st.tax[y] = due;
    }
  }
  const mark = st.cash + st.positions.reduce((a, p) => a + p.size * ((p.lastPx ?? p.entryPx) * (1 - SLIP)) / p.entryPx, 0);
  st.equity.push({ date: T, value: Math.round(mark) });
  st.lastDate = T;
}

// ---------- 試験中（2026-11-17〜）：プロの判断。反応日に+5%以上の銘柄のうち、検証（scripts/us/pro.mjs）が前半だけで選んだ
// 「効く特徴」に3つ以上当てはまるものを次の朝に買い、40日持つ。最大10銘柄×10%、空いているお金はSPY ----------
const PRO_HOLD = 40, PRO_MIN = 3, PRO_REACT = 0.05;
const proChoiceF = path.join(DATA, 'pro-choice.json');
const PROC = fs.existsSync(proChoiceF) ? load(proChoiceF) : null;
st.pro ??= { startDate: st.lastDate, cash: START, positions: [], pending: [], closed: [], tax: {}, equity: [{ date: st.lastDate, value: START }] };
{
  const P = st.pro;
  const taxDueP = (date) => { const y = yearOf(date); const net = P.closed.filter((c) => yearOf(c.exitDate) === y && c.exitDate <= date).reduce((a, c) => a + c.profitYen, 0); return Math.round(Math.max(0, net) * TAX); };
  for (const T of newDates) {
    const k = di.get(T);
    const s0 = spy[k - 1]?.[4], s1 = spy[k][4];
    if (s0 > 0 && s1 > 0) P.cash *= s1 / s0;
    const eq = P.cash + P.positions.reduce((a, q) => a + q.size, 0);
    for (const pd of P.pending.sort((a, b) => b.score - a.score)) {
      if (P.positions.length >= MAXN) break;
      if (P.positions.some((q) => q.t === pd.t)) continue;
      const o = px(pd.t).O[k];
      if (!(o > 0)) continue;
      const size = Math.min(P.cash, eq * 0.1);
      if (size < eq * 0.05) break;
      P.cash -= size;
      P.positions.push({ t: pd.t, name: pd.name, reason: pd.reason, entryDate: T, entryPx: o * (1 + SLIP), size, held: 0, hold: PRO_HOLD, lastPx: null });
    }
    P.pending = [];
    for (let j = P.positions.length - 1; j >= 0; j--) {
      const pos = P.positions[j];
      const c = px(pos.t).C[k];
      if (!(c > 0)) continue;
      pos.held++; pos.lastPx = c;
      if (pos.held >= pos.hold) {
        const r = (c * (1 - SLIP)) / pos.entryPx - 1;
        P.cash += pos.size * (1 + r);
        P.closed.push({ t: pos.t, name: pos.name, reason: pos.reason, entryDate: pos.entryDate, exitDate: T, retPct: pct(r), profitYen: Math.round(pos.size * r) });
        P.positions.splice(j, 1);
        const y = yearOf(T), due = taxDueP(T);
        P.cash -= due - (P.tax[y] ?? 0); P.tax[y] = due;
      }
    }
    P.equity.push({ date: T, value: Math.round(P.cash + P.positions.reduce((a, q) => a + q.size * ((q.lastPx ?? q.entryPx) * (1 - SLIP)) / q.entryPx, 0)) });
  }
}

// ---------- 次の取引日に買う候補：反応日が最新の取引日で、+10%以上 ----------
const lastK = di.get(st.lastDate);
const found = [];
const recent = [];
for (const u of universe) {
  for (const r of reactions(u)) {
    if (r.k < lastK - 4) continue;
    if (r.k <= lastK) recent.push({ t: r.t, name: r.name, date: dates[r.k], rePct: pct(r.re) });
    if (r.k !== lastK) continue;
    const key = `${r.t}|${r.acc}`;
    if (st.seen[key]) continue;
    st.seen[key] = 1;
    if (PROC?.rules && r.re >= PRO_REACT && r.raw >= MIN_PX && r.k >= 260 && !st.pro.pending.some((q) => q.t === r.t) && !st.pro.positions.some((q) => q.t === r.t)) {
      const secF = path.join(DATA, 'sec', `${u.t}.json`), avF = path.join(DATA, 'av', `${u.t}.json`);
      const sObj = { ...px(u.t), sec: fs.existsSync(secF) ? load(secF) : {}, av: fs.existsSync(avF) ? load(avF) : null };
      const f = usFeatures(sObj, r.k, spy.map((x) => x[4]), r.day);
      const sc = usScore(f, PROC.rules);
      if (sc >= PRO_MIN) {
        const hit = PROC.rules.chosen.filter((c) => usScore(f, { chosen: [c] }) > 0).map((c) => US_LABEL[c.key]?.[c.side === 'high' ? 0 : 1] ?? c.key);
        st.pro.pending.push({ t: r.t, name: r.name, score: sc * 10 + r.re, reason: `決算の翌日に+${pct(r.re)}%（${dates[r.k]}）／点数${sc}：${hit.join('・')}`, signalDate: dates[r.k] });
      }
    }
    if (!(r.re >= REACT) || !(r.raw >= MIN_PX)) continue;
    if (st.pending.some((p) => p.t === r.t) || st.positions.some((p) => p.t === r.t)) continue;
    const reason = `決算の翌日に${pct(r.re) > 0 ? '+' : ''}${pct(r.re)}%（${dates[r.k]}）`;
    st.pending.push({ t: r.t, name: r.name, re: r.re, reason, signalDate: dates[r.k] });
    found.push(r.t);
  }
}
fs.writeFileSync(statePath, JSON.stringify(st));

// ---------- 公開用（銘柄・日付・損益率だけ） ----------
const eqNow = st.equity.at(-1).value;
const rets = st.closed.map((c) => c.retPct);
const spyStartK = di.get(st.startDate);
const out = {
  updatedAt: new Date().toISOString(),
  name: `決算の翌日に+${Math.round(REACT * 100)}%以上上がった株を次の朝に買い、${HOLD}日持つ（空いているお金は${IDLE === 'spy' ? 'S&P500' : IDLE === 'trend' ? 'S&P500が上向きの時だけS&P500' : '現金'}）`,
  settings: { react: REACT, hold: HOLD, idle: IDLE, idleNow: st.idleNow ?? null, chosenAt: CH?.chosenAt ?? null, rule: CH?.rule ?? null },
  startDate: st.startDate, lastDate: st.lastDate, capital: START,
  equityYen: eqNow, returnPct: pct(eqNow / START - 1),
  spyReturnPct: spyStartK != null ? pct(spy[lastK][4] / spy[spyStartK][4] - 1) : null,
  idleInSpyPct: st.idleNow === 'cash' ? 0 : pct(st.cash / Math.max(1, eqNow)),
  idlePct: pct(st.cash / Math.max(1, eqNow)),
  taxYen: Object.values(st.tax).reduce((a, b) => a + b, 0),
  trades: st.closed.length,
  winRatePct: rets.length ? pct(rets.filter((r) => r > 0).length / rets.length) : null,
  avgRetPct: rets.length ? Math.round((rets.reduce((a, b) => a + b, 0) / rets.length) * 100) / 100 : null,
  holdings: st.positions.map((p) => ({ t: p.t, name: p.name, reason: p.reason, entryDate: p.entryDate, daysHeld: p.held, daysLeft: Math.max(0, (p.hold ?? HOLD) - p.held), unrealPct: pct(((p.lastPx ?? p.entryPx) * (1 - SLIP)) / p.entryPx - 1) })),
  nextBuys: st.pending.sort((a, b) => b.re - a.re).map((p) => ({ t: p.t, name: p.name, reason: p.reason })),
  recentReactions: recent.sort((a, b) => b.date.localeCompare(a.date) || b.rePct - a.rePct).slice(0, 30),
  recentClosed: st.closed.slice(-30).reverse(),
  equityHistory: st.equity,
};
{
  const P = st.pro, eqP = P.equity.at(-1).value, rp = P.closed.map((c) => c.retPct);
  out.pro = {
    name: '試験中：プロの判断（決算の翌日に+5%以上＋効く特徴が3つ以上、40日持つ。空いているお金はS&P500）', trial: true, chosenAt: PROC?.chosenAt ?? null,
    startDate: P.startDate, capital: START, equityYen: eqP, returnPct: pct(eqP / START - 1), taxYen: Object.values(P.tax).reduce((a, b) => a + b, 0),
    trades: P.closed.length, winRatePct: rp.length ? pct(rp.filter((r) => r > 0).length / rp.length) : null,
    holdings: P.positions.map((p) => ({ t: p.t, name: p.name, reason: p.reason, entryDate: p.entryDate, daysHeld: p.held, daysLeft: Math.max(0, p.hold - p.held), unrealPct: pct(((p.lastPx ?? p.entryPx) * (1 - SLIP)) / p.entryPx - 1) })),
    nextBuys: P.pending.sort((a, b) => b.score - a.score).map((p) => ({ t: p.t, name: p.name, reason: p.reason })),
    recentClosed: P.closed.slice(-30).reverse(), equityHistory: P.equity,
  };
}
fs.writeFileSync(path.join(OUT, 'us-paper.json'), JSON.stringify(out, null, 2));
console.log(`us-paper ok: lastDate=${st.lastDate} newDates=${newDates.length} newSignals=${found.length} holdings=${st.positions.length}`);
