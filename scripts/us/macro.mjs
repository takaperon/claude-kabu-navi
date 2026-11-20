// 前もって日付が分かっている金融政策の発表（FOMC）をまたいで持つか、前に逃げるか（2026-11-20〜、オーナー「利上げ発表とかが分かってれば、ルールの途中でも売った方がいいとかなるやん」）
// FOMC の日程は1年以上前に公表される（未来の情報ではない）。決定の中身（上げ・下げ・据え置き）はその日まで分からないので、比べ方には使わず説明にだけ使う。
// 買う前に分かる「利上げ局面か」（政策金利の半年の動き）は使ってよい。
//   A) S&P500（SPY）：会合の前日の引け→会合の日の引け、→翌日の引け、の値動き（ほかの日と比べる）
//   B) 今のルール（決算+10%以上・20日持つ）：持っている途中に会合があった件で、
//      hold＝そのまま持つ／dodge＝会合の前日の引けで売り、会合の次の日の寄りで買い直す／exit＝会合の前日の引けで売って終わり
// 公開は集計値だけ（reports-out/macro-us.json）
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data-us', OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
const write = (o) => fs.writeFileSync(path.join(OUT, 'macro-us.json'), JSON.stringify(o, null, 1));
fs.mkdirSync(OUT, { recursive: true });
// FOMC の決定日（2日間の会合の2日目）。出どころ：FRB の公表日程（2021〜2025 は公表済みの実績、2026・2027 は fedratecalc.com の一覧で確認 2026-11-20）
const FOMC = ['2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16', '2021-07-28', '2021-09-22', '2021-11-03', '2021-12-15',
  '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
  '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08'];
const spyF = path.join(DATA, 'prices', 'SPY.json');
if (!fs.existsSync(spyF)) { write({ ok: false, reason: 'SPY のデータが無い' }); process.exit(0); }
const spy = JSON.parse(fs.readFileSync(spyF, 'utf8'));
const dates = spy.map((r) => r[0]), D = dates.length, di = new Map(dates.map((d, k) => [d, k]));
const SO = spy.map((r) => r[1]), SC = spy.map((r) => r[4]);
async function fred(id) {
  try {
    const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: { 'User-Agent': 'kabunavi-research' } });
    if (!r.ok) return null; const m = new Map();
    for (const line of (await r.text()).trim().split('\n').slice(1)) { const [d, v] = line.split(','); const x = Number(v); if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(x)) m.set(d, x); }
    return m;
  } catch { return null; }
}
const TGT = await fred('DFEDTARU'), DFF = await fred('DFF');
const before = (m, d) => { if (!m) return NaN; let best = null; for (const [k, v] of m) if (k < d && (!best || k > best[0])) best = [k, v]; return best ? best[1] : NaN; };
const onOrAfter = (m, d, n) => { if (!m) return NaN; const ks = [...m.keys()].filter((k) => k >= d).sort(); return ks.length > n ? m.get(ks[n]) : NaN; };
const meet = [];
for (const f of FOMC) {
  const k = di.get(f); if (k == null || k < 130 || k + 2 >= D) continue;
  const t0 = before(TGT, f), t1 = onOrAfter(TGT, f, 1);
  const decision = !(Number.isFinite(t0) && Number.isFinite(t1)) ? '不明' : t1 > t0 + 1e-9 ? '利上げ' : t1 < t0 - 1e-9 ? '利下げ' : '据え置き';
  const ffNow = before(DFF, f), ffAgo = before(DFF, dates[k - 126]);
  const cycle = !(Number.isFinite(ffNow) && Number.isFinite(ffAgo)) ? '不明' : ffNow - ffAgo >= 0.25 ? '利上げ局面' : ffNow - ffAgo <= -0.25 ? '利下げ局面' : '据え置き局面';
  meet.push({ d: f, k, decision, cycle });
}
const split = Math.floor(D * 0.6);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
function summ(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), up: r4(a.filter((x) => x > 0).length / a.length) }; }

// A) SPY：会合の日（前日の引け→当日の引け）と、会合の次の日（当日の引け→翌日の引け）
const A = {};
const add = (o, key, h, v) => { ((o[key] ??= { train: [], test: [] })[h]).push(v); };
const isMeet = new Set(meet.map((m) => m.k));
for (const m of meet) {
  const h = m.k < split ? 'train' : 'test';
  const day = SC[m.k] / SC[m.k - 1] - 1, next = SC[m.k + 1] / SC[m.k] - 1, both = SC[m.k + 1] / SC[m.k - 1] - 1;
  for (const key of ['全部', m.cycle, '決定：' + m.decision]) { add((A.day ??= {}), key, h, day); add((A.next ??= {}), key, h, next); add((A.both ??= {}), key, h, both); }
}
const other = { train: [], test: [] };
for (let k = 1; k < D; k++) if (!isMeet.has(k) && !isMeet.has(k - 1)) other[k < split ? 'train' : 'test'].push(SC[k] / SC[k - 1] - 1);

// B) 今のルールの1件ごと
let ev = [];
try { ev = JSON.parse(fs.readFileSync(path.join(OUT, 'us-events.json'), 'utf8')).events.filter((e) => e.re >= 10); } catch {}
const B = {};
let used = 0;
for (const e of ev) {
  const k = di.get(e.entry); if (k == null || k + 19 >= D) continue;
  const f = path.join(DATA, 'prices', `${e.t}.json`); if (!fs.existsSync(f)) continue;
  const O = new Map(), C = new Map();
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) { O.set(r[0], r[1]); C.set(r[0], r[4]); }
  const px = (M, kk) => M.get(dates[kk]);
  const o0 = px(O, k), cx = px(C, k + 19); if (!(o0 > 0 && cx > 0)) continue;
  const hold = (cx * (1 - SLIP)) / (o0 * (1 + SLIP)) - 1;
  const m = meet.find((mm) => mm.k > k && mm.k <= k + 18); // 買った日より後、売る日より前に会合（会合の次の日に買い直せる）
  if (!m) continue;
  const cPrev = px(C, m.k - 1), oNext = px(O, m.k + 1); if (!(cPrev > 0 && oNext > 0)) continue;
  const part1 = (cPrev * (1 - SLIP)) / (o0 * (1 + SLIP));
  const part2 = (cx * (1 - SLIP)) / (oNext * (1 + SLIP));
  const dodge = part1 * part2 - 1, exit = part1 - 1;
  // 同じ期間をそのまま持った分のうち、会合をまたいだ部分（前日の引け→翌日の寄り）
  const gapPart = oNext / cPrev - 1;
  const h = k < split ? 'train' : 'test'; used++;
  for (const key of ['全部', m.cycle, '決定：' + m.decision]) {
    const g = (B[key] ??= {}); for (const [nm, v] of [['hold', hold], ['dodge', dodge], ['exit', exit], ['dodgeMinusHold', dodge - hold], ['acrossMeeting', gapPart]]) ((g[nm] ??= { train: [], test: [] })[h]).push(v);
  }
}
const fin = (X) => Object.fromEntries(Object.entries(X).map(([k, w]) => [k, Object.fromEntries(Object.entries(w).map(([kk, v]) => [kk, { train: summ(v.train), test: summ(v.test) }]))]));
const upcoming = FOMC.filter((d) => d > dates[D - 1]).slice(0, 3);
write({ ok: true, generatedAt: new Date().toISOString(), asOf: dates[D - 1], periods: { train: [dates[0], dates[split - 1]], test: [dates[split], dates[D - 1]] }, fred: { DFEDTARU: TGT ? TGT.size : 0, DFF: DFF ? DFF.size : 0 },
  meetings: meet.map((m) => ({ d: m.d, decision: m.decision, cycle: m.cycle })), upcoming,
  note: 'A) SPY の会合の日（day=前日の引け→当日の引け）・次の日（next）・2日分（both）。otherDays＝会合の日とその次の日以外の毎日。B) 今のルールで持っている途中に会合があった件：hold＝そのまま／dodge＝前日の引けで売って次の日の寄りで買い直す／exit＝前日の引けで売って終わり。決定の中身はその日まで分からないので説明用',
  spy: Object.fromEntries(['day', 'next', 'both'].map((w) => [w, Object.fromEntries(Object.entries(A[w] ?? {}).map(([k, v]) => [k, { train: summ(v.train), test: summ(v.test) }]))])),
  otherDays: { train: summ(other.train), test: summ(other.test) }, rule: fin(B), ruleEvents: used });
console.log(`macro-us ok: meetings=${meet.length} ruleEvents=${used}`);
