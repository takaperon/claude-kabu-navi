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
import { proFeatures, proScore } from './lib/pro-features.mjs';

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
  real30_dt: { name: '本番想定：30万円・100株単位・3銘柄（増配デイトレ）', kinds: ['div_up'], hold: 1, base: 'dt_div', capital: 300_000, maxN: 3, lot: 100 },
  real30_div_gap: { name: '本番想定：30万円・100株単位・2銘柄（増配＋朝高）', kinds: ['div_up'], hold: 5, gap: true, base: 'swing_div_gap', capital: 300_000, maxN: 2, lot: 100 },
  // 試験中（2026-11-17〜、オーナーの指示「もっと専門性を持って」）：プロの判断の検証（scripts/pro.mjs）で前半だけで選んだ「効く特徴」の点数で選ぶ
  real30_dt_pro: { name: '試験中：プロの判断のデイトレ（点数2以上だけ・マイナスで引けたら最長10日持ち越し）', kinds: ['div_up'], hold: 1, holdLosers: 10, capital: 300_000, maxN: 3, lot: 100, pro: { key: 'div_up|hl10', min: 2 }, trial: true },
  real30_div_pro: { name: '試験中：プロの判断のスイング（点数1以上・5日）', kinds: ['div_up'], hold: 5, capital: 300_000, maxN: 3, lot: 100, pro: { key: 'div_up|h5', min: 1 }, trial: true },
};
const choiceF = path.join(DATA, 'paper', 'pro-choice.json');
const PRO = fs.existsSync(choiceF) ? JSON.parse(fs.readFileSync(choiceF, 'utf8')) : null;
const PRO_LABEL = { size: '引き上げ幅が大きい', withOther: '上方修正も同時', withDown: '同時に下方修正', nextYear: '本決算での来期予想', yield: '配当利回りが高い', react0: '発表日に上げた', run5: '直前5日', run20: '直前20日', ma25: '25日線との差', vol20: '値動きの荒さ', atr: '値幅', liq: '売買代金', crowd: '材料の多い日', mkt1: '前日の市場', mkt5: '市場の5日の動き', mktTrend: '市場が25日平均より' };
function proLabel(c) {
  if (c.side === 'is1') return PRO_LABEL[c.key];
  const lo = c.side === 'low';
  if (c.key === 'run5' || c.key === 'run20') return lo ? `${PRO_LABEL[c.key]}で上がりすぎていない` : `${PRO_LABEL[c.key]}で上げている`;
  if (c.key === 'mkt1' || c.key === 'mkt5') return lo ? `${PRO_LABEL[c.key]}が下げた後` : `${PRO_LABEL[c.key]}が上げた後`;
  if (c.key === 'mktTrend') return lo ? '市場が25日平均より下（押し目）' : '市場が25日平均より上';
  return PRO_LABEL[c.key] ?? c.key;
}

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
      const rNow = (p.c * (1 - SLIP)) / pos.entryPx - 1;
      // マイナスで引けたら持ち越し、買値以上で引けた日に売る（最長 hold + holdLosers 日）
      const keep = cfg.holdLosers && pos.held >= cfg.hold && rNow < 0 && pos.held < cfg.hold + cfg.holdLosers;
      if (pos.held >= cfg.hold && !keep) {
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
  // ---------- IPO一晩持ち（2026-11-16〜）：上場初日（初値がついた日）の引けで買い、次の日の寄りで売る。30万円・100株単位・最大2銘柄 ----------
  {
    const st = (state.ipoNight ??= { cash: 300_000, positions: [], closed: [], tax: {}, equity: [{ date: state.lastDate, value: 300_000 }] });
    const k = idxOf.get(T);
    // 1) 前の日の引けで買ったものを、今日の寄りで売る
    for (const pos of st.positions.splice(0)) {
      const p = px.get(pos.code);
      const o = p?.o > 0 ? p.o : p?.c; // 寄りがつかなければ（売買停止など）終値で
      if (!(o > 0)) { st.positions.push(pos); continue; }
      const r = (o * (1 - SLIP)) / pos.entryPx - 1;
      st.cash += pos.size * (1 + r);
      st.closed.push({ code: pos.code, name: nameOf(pos.code), reason: pos.reason, entryDate: pos.entryDate, exitDate: T, retPct: pct(r), profitYen: Math.round(pos.size * r), shares: pos.shares });
      const y = yearOf(T), net = st.closed.filter((c) => yearOf(c.exitDate) === y).reduce((a, c) => a + c.profitYen, 0);
      const due = Math.round(Math.max(0, net) * TAX);
      st.cash -= due - (st.tax[y] ?? 0); st.tax[y] = due;
    }
    // 2) 今日が上場初日（直近25営業日に始値がない銘柄に、今日はじめて始値がついた）なら、引けで買う
    const firsts = [];
    for (const [code, p] of px) {
      if (!(p.o > 0 && p.c > 0) || !STOCK_MKT.has(info.get(code)?.Mkt)) continue;
      let before = false;
      for (let j = Math.max(0, k - 25); j < k; j++) { if (pricesOn(dates[j]).get(code)?.o > 0) { before = true; break; } }
      if (before || k < 25) continue;
      firsts.push({ code, p });
    }
    firsts.sort((a, b) => (b.p.va ?? 0) - (a.p.va ?? 0)); // 売買代金の大きい順
    const eq = st.cash;
    for (const { code, p } of firsts) {
      if (st.positions.length >= 2) break;
      const raw = rawOn(T).get(code) ?? p.o;
      const rawC = raw * (p.c / p.o); // 調整前の終値（rawは始値なので比で換算）
      const lotCost = rawC * 100 * (1 + SLIP);
      const lots = Math.floor(Math.min(st.cash, eq / 2) / lotCost);
      if (lots < 1) continue;
      st.cash -= lots * lotCost;
      st.positions.push({ code, entryDate: T, entryPx: p.c * (1 + SLIP), size: lots * lotCost, shares: lots * 100, reason: `${T}に新規上場（初日の引けで購入）` });
    }
    st.equity.push({ date: T, value: Math.round(st.cash + st.positions.reduce((a, q) => a + q.size, 0)) });
  }
  state.lastDate = T;
}

// ---------- 3) 新しい開示から次の営業日の買い候補 ----------
const lastK = idxOf.get(state.lastDate);
const found = [];
// プロの判断の特徴に使う：市場全体（流動性条件を満たす銘柄の等金額平均）、同じ開示の種類、同じ日の件数
const mktCache = new Map();
function mktR(j) {
  if (!mktCache.has(j)) {
    let s = 0, n = 0;
    const a = pricesOn(dates[j]), b = pricesOn(dates[j - 1]);
    for (const [code, p] of a) { const pc = b.get(code)?.c; if (!(pc > 0) || !eligibleAt(code, j - 1)) continue; const r = p.c / pc - 1; if (Number.isFinite(r) && Math.abs(r) < 0.5) { s += r; n++; } }
    mktCache.set(j, n ? s / n : 0);
  }
  return mktCache.get(j);
}
function mktFor(k) {
  const base = k - 30, idx = new Map([[base, 1]]);
  for (let j = base + 1; j <= k; j++) idx.set(j, idx.get(j - 1) * (1 + mktR(j)));
  return { r: mktR, idx: (j) => idx.get(j) ?? NaN, ma: (j, n) => { let t = 0; for (let x = j - n + 1; x <= j; x++) t += idx.get(x); return t / n; } };
}
const sameKindsMap = new Map();
for (const e of events) { const kk = e.c + '|' + e.dd; if (!sameKindsMap.has(kk)) sameKindsMap.set(kk, new Set()); sameKindsMap.get(kk).add(e.kind); }
const crowdMap = new Map();
const mktByK = new Map();
function proOf(e, k) {
  if (!mktByK.has(k)) mktByK.set(k, mktFor(k));
  if (!crowdMap.has(e.kind + '|' + k)) {
    const set = new Set();
    for (const x of events) if (x.kind === e.kind && signalIdx(x.dd) === k && eligibleAt(x.c, k)) set.add(x.c);
    crowdMap.set(e.kind + '|' + k, set.size);
  }
  const q = (j) => { const p = j >= 0 ? pricesOn(dates[j]).get(e.c) : null; return p ? { o: p.o, h: p.h, l: p.l, c: p.c, va: p.va } : null; };
  return proFeatures(e, k, q, (j) => rawOn(dates[j]).get(e.c) ?? NaN, mktByK.get(k), { sameKinds: sameKindsMap.get(e.c + '|' + e.dd) ?? new Set(), crowd: crowdMap.get(e.kind + '|' + k), isTradingDay: dates[k] === e.dd });
}
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
    let reason = e.kind === 'div_up'
      ? `配当予想を${e.detail.nextYear ? '来期' : ''}+${pct(e.score)}%引き上げ（${e.dd}発表）`
      : `営業利益予想を+${pct(e.score)}%上方修正（${e.dd}発表）`;
    let score = e.score;
    if (cfg.pro) {
      const rules = PRO?.rules?.[cfg.pro.key];
      if (!rules || k < 31) continue;
      const f = proOf(e, k);
      const sc = proScore(f, rules);
      if (sc < cfg.pro.min) continue;
      const hit = rules.chosen.filter((c) => proScore(f, { chosen: [c] }) > 0).map(proLabel);
      if (rules.useIntra && f.timing === 'intraday') hit.push('場中の発表');
      reason += `／点数${sc}：${hit.join('・')}${Number.isFinite(f.yield) ? `（利回り${pct(f.yield)}%）` : ''}`;
      score = sc * 10 + e.score;
    }
    st.pending.push({ code: e.c, kind: e.kind, score, reason, signalDate: dates[k], late });
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
    trial: !!cfg.trial,
    proChosenAt: cfg.pro ? PRO?.chosenAt ?? null : undefined,
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
    holdings: st.positions.map((p) => ({ code: p.code, name: nameOf(p.code), reason: p.reason, entryDate: p.entryDate, daysHeld: p.held, shares: p.shares, unrealPct: pct(((p.lastPx ?? p.entryPx) * (1 - SLIP)) / p.entryPx - 1), costYen: Math.round(p.size), valueYen: Math.round(p.size * ((p.lastPx ?? p.entryPx) * (1 - SLIP)) / p.entryPx) })),
    nextBuys: st.pending.sort((a, b) => b.score - a.score).slice(0, 10).map((p) => ({ code: p.code, name: nameOf(p.code), reason: p.reason, late: p.late })),
    recentClosed: st.closed.slice(-30).reverse(),
    equityHistory: st.equity,
  };
}
if (state.ipoNight) {
  const st = state.ipoNight, eqNow = st.equity.at(-1).value, rets = st.closed.map((c) => c.retPct);
  out.ipoNight = {
    name: 'IPO一晩持ち：上場初日の引けで買い、次の日の寄りで売る（30万円・100株単位・2銘柄まで）',
    capital: 300_000, equityYen: eqNow, returnPct: pct(eqNow / 300_000 - 1), taxYen: Object.values(st.tax).reduce((a, b) => a + b, 0),
    trades: st.closed.length, winRatePct: rets.length ? pct(rets.filter((r) => r > 0).length / rets.length) : null,
    holdings: st.positions.map((p) => ({ code: p.code, name: nameOf(p.code), reason: p.reason, entryDate: p.entryDate, shares: p.shares })),
    recentClosed: st.closed.slice(-30).reverse(), equityHistory: st.equity,
  };
}
// 毎日のふりかえり用：その日の市場全体（流動性条件を満たす銘柄の平均）と、売った取引を相場と比べた差
if (lastK >= 31) {
  const m1 = mktR(lastK), mk = mktFor(lastK);
  out.market = { date: state.lastDate, dayPct: pct(m1), fiveDayPct: pct(mk.idx(lastK) / mk.idx(lastK - 5) - 1), vsTrendPct: pct(mk.idx(lastK) / mk.ma(lastK, 25) - 1) };
}
fs.writeFileSync(path.join(OUT, 'paper.json'), JSON.stringify(out, null, 2));
console.log(`paper ok: lastDate=${state.lastDate} newDates=${newDates.length} newSignals=${found.length}`);
