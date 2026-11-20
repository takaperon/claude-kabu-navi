// 相場の状態（米国）と、その状態ごとの成績（2026-11-20〜、オーナーの指摘「下がりそうだから買わない、上がりそうだから買う、も入れ込んで提案しないとダメ」）
// その日の引けまでに分かることだけで相場の状態を判定し、
//   A) S&P500（SPY）を次の日の寄りで買って20・60取引日持った成績（S&P500そのもの）
//   B) 今のルール（決算で+10%以上上がった株を20日持つ）の1件ごとの成績（S&P500との差も）
// を状態ごとに分ける。前半（60%）・後半（40%）の両方で差が出るかを見る。公開は集計値と今日の状態だけ（値段は出さない）
// 注意：20日・60日の成績は日がかぶるので、件数ほどの確かさは無い（実質の独立な件数はずっと少ない）
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data-us', OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
fs.mkdirSync(OUT, { recursive: true });
const write = (o) => fs.writeFileSync(path.join(OUT, 'regime-us.json'), JSON.stringify(o, null, 1));
const spyF = path.join(DATA, 'prices', 'SPY.json');
if (!fs.existsSync(spyF)) { write({ ok: false, reason: 'SPY のデータが無い' }); process.exit(0); }
const spy = JSON.parse(fs.readFileSync(spyF, 'utf8'));
const dates = spy.map((r) => r[0]), D = dates.length, di = new Map(dates.map((d, k) => [d, k]));
const SO = spy.map((r) => r[1]), SH = spy.map((r) => r[2]), SL = spy.map((r) => r[3]), SC = spy.map((r) => r[4]);

// ---- FRED（無料・キー不要）：政策金利（実効FF金利・日次）、10年国債利回り、VIX ----
async function fred(id) {
  try {
    const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: { 'User-Agent': 'kabunavi-research' } });
    if (!r.ok) return null;
    const m = new Map();
    for (const line of (await r.text()).trim().split('\n').slice(1)) { const [d, v] = line.split(','); const x = Number(v); if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(x) && v !== '.') m.set(d, x); }
    return m.size ? m : null;
  } catch { return null; }
}
const status = {};
const FR = {};
for (const id of ['DFF', 'DGS10', 'VIXCLS']) { FR[id] = await fred(id); status[id] = FR[id] ? FR[id].size : 0; }
// その日までに出ている一番新しい値（未来の値を使わない）
const asof = (m) => { const a = new Float64Array(D).fill(NaN); if (!m) return a; let last = NaN; const ks = [...m.keys()].sort(); let j = 0; for (let k = 0; k < D; k++) { while (j < ks.length && ks[j] <= dates[k]) { last = m.get(ks[j]); j++; } a[k] = last; } return a; };
const FF = asof(FR.DFF), Y10 = asof(FR.DGS10), VIX = asof(FR.VIXCLS);

// ---- 銘柄（広がり：50日平均より上にある銘柄の割合） ----
const universe = JSON.parse(fs.readFileSync(path.join(DATA, 'universe.json'), 'utf8')).list;
const S = new Map();
const above = new Float64Array(D), cnt = new Float64Array(D);
for (const u of universe) {
  const f = path.join(DATA, 'prices', `${u.t}.json`); if (!fs.existsSync(f)) continue;
  const O = new Float64Array(D).fill(NaN), C = O.slice();
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) { const k = di.get(r[0]); if (k != null) { O[k] = r[1]; C[k] = r[4]; } }
  S.set(u.t, { O, C });
  let s = 0, n = 0;
  for (let k = 0; k < D; k++) {
    if (C[k] > 0) { s += C[k]; n++; }
    if (k >= 50 && C[k - 50] > 0) { s -= C[k - 50]; n--; }
    if (k >= 50 && n >= 45 && C[k] > 0) { cnt[k]++; if (C[k] > s / n) above[k]++; }
  }
}

// ---- 相場の状態（その日の引けで分かる） ----
const sma = (a, k, n) => { if (k < n - 1) return NaN; let s = 0; for (let i = k - n + 1; i <= k; i++) s += a[i]; return s / n; };
function state(k) {
  let hi = -Infinity; for (let i = Math.max(0, k - 251); i <= k; i++) hi = Math.max(hi, SC[i]);
  const m200 = sma(SC, k, 200);
  const ffAgo = k >= 126 ? FF[k - 126] : NaN, yAgo = k >= 63 ? Y10[k - 63] : NaN;
  return {
    dd: SC[k] / hi - 1,                                   // 1年の最高値からの下げ
    trend: m200 ? SC[k] / m200 - 1 : NaN,                 // 200日平均との差
    ret20: k >= 20 ? SC[k] / SC[k - 20] - 1 : NaN,        // 20日の動き
    vix: VIX[k],                                          // 恐怖指数
    rateCycle: FF[k] - ffAgo,                             // 半年で政策金利がどれだけ動いたか（+＝利上げ中）
    y10chg: Y10[k] - yAgo,                                // 3か月で10年国債利回りがどれだけ動いたか
    breadth: cnt[k] >= 100 ? above[k] / cnt[k] : NaN,     // 50日平均より上の銘柄の割合
    down6: k >= 6 && [0, 1, 2, 3, 4, 5].every((j) => SC[k - j] < SC[k - j - 1]) ? 1 : 0,
  };
}
const BK = {
  dd: { name: 'S&P500の1年の最高値からの下げ', cut: (v) => (v > -0.05 ? '-5%以内' : v > -0.1 ? '-5〜-10%' : v > -0.2 ? '-10〜-20%' : '-20%より深い') },
  trend: { name: 'S&P500と200日平均', cut: (v) => (v >= 0.05 ? '+5%以上上' : v >= 0 ? '0〜+5%上' : v >= -0.05 ? '0〜-5%下' : '-5%より下') },
  ret20: { name: 'S&P500の20日の動き', cut: (v) => (v >= 0.03 ? '+3%以上' : v >= 0 ? '0〜+3%' : v >= -0.05 ? '0〜-5%' : '-5%より下げ') },
  vix: { name: '恐怖指数（VIX）', cut: (v) => (v < 15 ? '15未満（落ち着いている）' : v < 20 ? '15〜20' : v < 25 ? '20〜25' : v < 30 ? '25〜30' : '30以上（強い不安）') },
  rateCycle: { name: '政策金利の半年の動き', cut: (v) => (v >= 0.25 ? '利上げ中（+0.25%以上）' : v <= -0.25 ? '利下げ中（-0.25%以下）' : 'ほぼ据え置き') },
  y10chg: { name: '10年国債利回りの3か月の動き', cut: (v) => (v >= 0.5 ? '+0.5%以上上昇' : v >= 0 ? '0〜+0.5%上昇' : v >= -0.5 ? '0〜-0.5%低下' : '-0.5%以上低下') },
  breadth: { name: '50日平均より上の銘柄の割合', cut: (v) => (v >= 0.7 ? '70%以上' : v >= 0.5 ? '50〜70%' : v >= 0.3 ? '30〜50%' : '30%未満') },
  down6: { name: 'S&P500の6日連続の下げ', cut: (v) => (v ? '6日以上続けて下げた' : 'それ以外') },
};
const split = Math.floor(D * 0.6);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
function summ(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), up: r4(a.filter((x) => x > 0).length / a.length) }; }

// A) SPY：k日の引けで状態を見て、k+1日の寄りで買い、k+n日の引けで売る
const A = {};
const ST = [];
for (let k = 200; k < D; k++) {
  const s = state(k); ST[k] = s;
  for (const n of [20, 60]) {
    if (k + n >= D) continue;
    const r = (SC[k + n] * (1 - SLIP)) / (SO[k + 1] * (1 + SLIP)) - 1;
    const h = k < split ? 'train' : 'test';
    for (const [f, b] of Object.entries(BK)) { const v = s[f]; if (!Number.isFinite(v)) continue; const key = b.cut(v); (((A[f] ??= {})[key] ??= {})['spy' + n] ??= { train: [], test: [] })[h].push(r); }
  }
}
// B) 今のルールの1件ごと（us-events.json の re≥10%。買う日の前の日の引けの状態で分ける）
let ev = [];
try { ev = JSON.parse(fs.readFileSync(path.join(OUT, 'us-events.json'), 'utf8')).events.filter((e) => e.re >= 10); } catch {}
const B = {}; let usedB = 0;
for (const e of ev) {
  const k = di.get(e.entry); const s0 = S.get(e.t); if (k == null || !s0 || k < 201 || k + 19 >= D) continue;
  const o = s0.O[k], c = s0.C[k + 19]; if (!(o > 0 && c > 0)) continue;
  const r = (c * (1 - SLIP)) / (o * (1 + SLIP)) - 1, rs = SC[k + 19] / SO[k] - 1;
  const s = ST[k - 1]; if (!s) continue; usedB++;
  const h = k < split ? 'train' : 'test';
  for (const [f, b] of Object.entries(BK)) { const v = s[f]; if (!Number.isFinite(v)) continue; const key = b.cut(v); const g = (((B[f] ??= {})[key] ??= {}) ); (g.ret ??= { train: [], test: [] })[h].push(r); (g.vsSpy ??= { train: [], test: [] })[h].push(r - rs); }
  (((B._all ??= {}).all ??= {}).ret ??= { train: [], test: [] })[h].push(r);
}
const fin = (X) => Object.fromEntries(Object.entries(X).map(([f, g]) => [f, { name: BK[f]?.name ?? '全体', buckets: Object.fromEntries(Object.entries(g).map(([k, m]) => [k, Object.fromEntries(Object.entries(m).map(([mm, w]) => [mm, { train: summ(w.train), test: summ(w.test) }]))])) }]));
const now = state(D - 1);
const today = Object.fromEntries(Object.entries(BK).map(([f, b]) => [f, { name: b.name, value: r4(now[f]), bucket: Number.isFinite(now[f]) ? b.cut(now[f]) : null }]));
write({ ok: true, generatedAt: new Date().toISOString(), asOf: dates[D - 1], periods: { train: [dates[200], dates[split - 1]], test: [dates[split], dates[D - 1]] }, fred: status,
  note: 'その日の引けで分かる相場の状態ごとに、A) S&P500を次の日の寄りで買って20・60取引日持った成績、B) 今のルール（決算+10%以上・20日）の1件ごとの成績とS&P500との差。20日・60日は日がかぶるので件数ほど確かではない',
  today, spy: fin(A), rule: fin(B), ruleEvents: usedB });
console.log(`regime-us ok: asOf=${dates[D - 1]} events=${usedB} fred=${JSON.stringify(status)}`);
