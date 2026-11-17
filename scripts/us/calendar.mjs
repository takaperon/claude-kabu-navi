// 「決まった時期の動き」の検証（米国株・S&P500）。2026-11-18〜 オーナーの指摘「プライムセールのような販促の前後で上げ下げするファクター」
// 会社ごとの季節性：過去の年の同じ月にS&P500より上がっていたか。毎月はじめに上位20銘柄を寄りで買い、月末の引けで売る（S&P500との差）
// 未来の情報は使わない（前の年までの成績だけ）。公開は集計値だけ（reports-out/calendar-us.json）
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data-us', OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
fs.mkdirSync(OUT, { recursive: true });
const spyF = path.join(DATA, 'prices', 'SPY.json');
if (!fs.existsSync(spyF)) process.exit(0);
const spy = JSON.parse(fs.readFileSync(spyF, 'utf8'));
const dates = spy.map((r) => r[0]), D = dates.length, di = new Map(dates.map((d, k) => [d, k]));
const SO = spy.map((r) => r[1]), SC = spy.map((r) => r[4]);
const universe = JSON.parse(fs.readFileSync(path.join(DATA, 'universe.json'), 'utf8')).list;
const S = [];
for (const u of universe) {
  const f = path.join(DATA, 'prices', `${u.t}.json`); if (!fs.existsSync(f)) continue;
  const O = new Float64Array(D).fill(NaN), C = O.slice();
  for (const [d, o, , , c] of JSON.parse(fs.readFileSync(f, 'utf8'))) { const k = di.get(d); if (k != null) { O[k] = o; C[k] = c; } }
  S.push({ t: u.t, O, C });
}
const split = Math.floor(D * 0.6);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
function summ(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), win: r4(a.filter((x) => x > 0).length / a.length) }; }
const months = [];
for (let d = 0; d < D; d++) { const ym = dates[d].slice(0, 7); if (!months.length || months.at(-1).ym !== ym) months.push({ ym, first: d, last: d }); else months.at(-1).last = d; }
const ex = new Map();
for (const m of months) { const mr = SC[m.last] / SO[m.first] - 1; S.forEach((s, i) => { const o = s.O[m.first], c = s.C[m.last]; if (o > 0 && c > 0) ex.set(i + '|' + m.ym, c / o - 1 - mr); }); }
const res = { top: { train: [], test: [] }, bottom: { train: [], test: [] }, consistent: { train: [], test: [] }, byMonth: [] };
for (const m of months) {
  const mm = m.ym.slice(5), y = +m.ym.slice(0, 4);
  const sc = [];
  S.forEach((s, i) => {
    const past = []; for (let yy = y - 1; yy >= y - 4; yy--) { const v = ex.get(i + '|' + yy + '-' + mm); if (v != null) past.push(v); }
    if (past.length < 2) return;
    const now = ex.get(i + '|' + m.ym); if (now == null) return;
    sc.push({ t: s.t, s: past.reduce((a, b) => a + b, 0) / past.length, allUp: past.every((v) => v > 0.02), now: now - 2 * SLIP });
  });
  if (sc.length < 100) continue;
  sc.sort((a, b) => b.s - a.s);
  const h = m.first < split ? 'train' : 'test';
  const t = sc.slice(0, 20), b = sc.slice(-20), c = sc.filter((x) => x.allUp);
  const av = (a) => a.reduce((x, z) => x + z.now, 0) / a.length;
  res.top[h].push(av(t)); res.bottom[h].push(av(b)); if (c.length) res.consistent[h].push(av(c));
  res.byMonth.push({ ym: m.ym, top20: r4(av(t)), bottom20: r4(av(b)), consistentN: c.length, top3: t.slice(0, 3).map((x) => x.t) });
}
for (const k of ['top', 'bottom', 'consistent']) for (const h of ['train', 'test']) res[k][h] = summ(res[k][h]);
fs.writeFileSync(path.join(OUT, 'calendar-us.json'), JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), periods: { train: [dates[0], dates[split - 1]], test: [dates[split], dates[D - 1]] }, note: '毎月、過去の同じ月にS&P500より上がっていた上位20銘柄（2年以上の記録）を月初の寄りで買い月末の引けで売る。S&P500との差。consistent＝毎年+2%以上だった銘柄すべて', ...res }, null, 1));
console.log(`calendar-us ok: months=${res.byMonth.length}`);
