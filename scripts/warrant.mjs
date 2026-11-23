// 新株予約権の「行使完了」の発表の後の値動き（2026-11-23〜、オーナーの提案「行使が終わったと発表された安い株を買って翌日に売れば？」）
//   発表の一覧：やのしん TDnet WebAPI（webapi.yanoshin.jp、情報収集・分析向けの公開API。キー不要）。題名に「新株予約権」と「行使完了／行使が完了」を含むもの
//   取得した一覧は data/warrant/list.json（暗号化キャッシュ）。月ごとに取り、取得済みの月は取り直さない（最近2か月だけ取り直す）
//   買う日：発表が 9:00 より前ならその日の寄り、それ以外は次の取引日の寄り（場中の発表も次の日にして甘くしない）
//   売る：その日の引け（h0）・1/2/5/20 取引日後の引け。滑り 0.1%×2。全銘柄平均との差（ex）も
//   分け方：前日の株価（100円未満・100〜300円・300〜1000円・1000円以上）、行使価額修正条項付（MS型）か、寄りの上げ下げ
// 公開は集計値だけ（reports-out/warrant-jp.json）
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data', OUT = args.out ?? 'reports-out';
fs.mkdirSync(OUT, { recursive: true });
const WDIR = path.join(DATA, 'warrant'); fs.mkdirSync(WDIR, { recursive: true });
const LIST = path.join(WDIR, 'list.json');
const status = { source: 'webapi.yanoshin.jp', months: 0, fetched: 0, errors: 0, firstError: null };
let store = { months: {}, items: {} };
try { store = JSON.parse(fs.readFileSync(LIST, 'utf8')); } catch {}

const pdir = path.join(DATA, 'prices');
const files = fs.readdirSync(pdir).filter((f) => f.endsWith('.json')).sort();
const dates = files.map((f) => f.slice(0, 10)), D = dates.length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 月の一覧（価格データの最初の月〜今月）
const months = [];
{ let [y, m] = dates[0].slice(0, 7).split('-').map(Number); const [ey, em] = dates[D - 1].slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { months.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } } }
const recent = new Set(months.slice(-2));
const KW = ['行使完了', '行使が完了'];
for (const mo of months) {
  if (store.months[mo] && !recent.has(mo)) continue;
  const [y, m] = mo.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const key = `${y}${String(m).padStart(2, '0')}01-${y}${String(m).padStart(2, '0')}${last}`;
  let ok = true;
  for (const kw of KW) {
    const url = `https://webapi.yanoshin.jp/webapi/tdnet/list/${key}.json?keyword=${encodeURIComponent(kw)}&limit=3000`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'claude-kabu-navi research (personal)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      for (const x of j.items ?? []) { const t = x.Tdnet ?? x; if (!t?.title) continue; const id = t.id ?? `${t.company_code}-${t.pubdate}-${t.title}`; store.items[id] = { pubdate: t.pubdate, code: String(t.company_code ?? ''), title: t.title }; }
      status.fetched++;
    } catch (e) { ok = false; status.errors++; status.firstError ??= `${mo} ${String(e.message).slice(0, 80)}`; }
    await sleep(1200);
  }
  if (ok) store.months[mo] = true;
}
fs.writeFileSync(LIST, JSON.stringify(store));
status.months = Object.keys(store.months).length;

// 株価
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
const STOCK = new Set(['0111', '0112', '0113']);
const codes = master.filter((m) => STOCK.has(m.Mkt)).map((m) => m.Code);
const ci = new Map(codes.map((c, i) => [c, i])), N = codes.length;
const O = new Float32Array(N * D).fill(NaN), C = O.slice(), VA = O.slice();
files.forEach((f, d) => { for (const [code, o, , , c, , va] of JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'))) { const i = ci.get(code); if (i === undefined) continue; O[i * D + d] = o; C[i * D + d] = c; VA[i * D + d] = va; } });
const at = (A, i, d) => (d >= 0 && d < D ? A[i * D + d] : NaN);
// 市場全体（売買代金1億円以上の平均）の寄り→引け・引け→引け
const liq = new Uint8Array(N * D);
for (let i = 0; i < N; i++) { let s = 0, n = 0; for (let d = 0; d < D; d++) { const v = at(VA, i, d); if (v > 0) { s += v; n++; } if (d >= 20) { const w = at(VA, i, d - 20); if (w > 0) { s -= w; n--; } } liq[i * D + d] = d >= 20 && n >= 15 && s / n >= 1e8 && at(C, i, d) >= 100 ? 1 : 0; } }
const MOC = new Float64Array(D), MCC = new Float64Array(D);
for (let d = 1; d < D; d++) { let s = 0, n = 0, so = 0, no = 0; for (let i = 0; i < N; i++) { if (!liq[i * D + d - 1]) continue; const r = at(C, i, d) / at(C, i, d - 1) - 1; if (Number.isFinite(r) && Math.abs(r) < 0.5) { s += r; n++; } const ro = at(C, i, d) / at(O, i, d) - 1; if (Number.isFinite(ro) && Math.abs(ro) < 0.5) { so += ro; no++; } } MCC[d] = n ? s / n : 0; MOC[d] = no ? so / no : 0; }
const mktFrom = (k, h) => { let g = 1 + MOC[k]; for (let d = k + 1; d <= k + h && d < D; d++) g *= 1 + MCC[d]; return g - 1; };

const split = Math.floor(D * 0.6);
const SLIP = 0.001, HS = [0, 1, 2, 5, 20];
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
function summ(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y); const avg = a.reduce((x, y) => x + y, 0) / a.length; return { n: a.length, avg: r4(avg), med: r4(s[a.length >> 1]), win: r4(a.filter((x) => x > 0).length / a.length), p10: r4(s[Math.floor(a.length * 0.1)]), p90: r4(s[Math.floor(a.length * 0.9)]) }; }

const isDone = (t) => /新株予約権/.test(t) && /(行使完了|行使が完了)/.test(t) && !/(取消|訂正)/.test(t);
const seen = new Set(), ev = [];
let skipped = { noCode: 0, noDate: 0, noPrice: 0 };
for (const it of Object.values(store.items)) {
  if (!isDone(it.title)) continue;
  let code = it.code.trim(); if (code.length === 4) code += '0';
  const i = ci.get(code); if (i === undefined) { skipped.noCode++; continue; }
  const [day, time = '15:00:00'] = String(it.pubdate).split(' ');
  let k = time < '09:00:00' ? dates.findIndex((d) => d >= day) : dates.findIndex((d) => d > day);
  if (k <= 0) { skipped.noDate++; continue; }
  const key = code + '|' + dates[k]; if (seen.has(key)) continue; seen.add(key);
  const o = at(O, i, k), pc = at(C, i, k - 1);
  if (!(o > 0 && pc > 0)) { skipped.noPrice++; continue; }
  const r = {}, ex = {};
  for (const h of HS) { const c = at(C, i, k + h); if (!(c > 0)) continue; r[h] = c / o - 1 - 2 * SLIP; ex[h] = r[h] - mktFrom(k, h); }
  ev.push({ k, half: k < split ? 'train' : 'test', px: pc, ms: /修正条項/.test(it.title), gap: o / pc - 1, r, ex });
}
const groups = {
  '全部': () => true,
  '前日の株価:100円未満': (e) => e.px < 100, '前日の株価:100〜300円': (e) => e.px >= 100 && e.px < 300,
  '前日の株価:300〜1000円': (e) => e.px >= 300 && e.px < 1000, '前日の株価:1000円以上': (e) => e.px >= 1000,
  'MS型（行使価額修正条項付）': (e) => e.ms, 'MS型以外': (e) => !e.ms,
  '寄り:+3%以上高く始まる': (e) => e.gap >= 0.03, '寄り:-3%〜+3%': (e) => e.gap > -0.03 && e.gap < 0.03, '寄り:-3%以下': (e) => e.gap <= -0.03,
  '300円未満×MS型': (e) => e.px < 300 && e.ms,
};
const res = {};
for (const [g, f] of Object.entries(groups)) {
  res[g] = {};
  for (const half of ['train', 'test']) {
    const sel = ev.filter((e) => e.half === half && f(e));
    res[g][half] = Object.fromEntries(HS.map((h) => [h, { ...summ(sel.map((e) => e.r[h]).filter(Number.isFinite)), exAvg: r4((() => { const a = sel.map((e) => e.ex[h]).filter(Number.isFinite); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; })()) }]));
  }
}
const byYear = {};
for (const e of ev) { const y = dates[e.k].slice(0, 4); (byYear[y] ??= []).push(e.r[1]); }
fs.writeFileSync(path.join(OUT, 'warrant-jp.json'), JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), periods: { train: [dates[1], dates[split - 1]], test: [dates[split], dates[D - 1]] },
  note: '新株予約権の行使完了の発表の後、最初に買える寄りで買い、h0＝その日の引け・1/2/5/20＝その取引日数後の引けで売った時（滑り0.1%×2を引いた）。exAvg＝同じ期間の市場全体との差。p10/p90＝下から10%・90%の値',
  status: { ...status, items: Object.keys(store.items).length, events: ev.length, skipped }, groups: res,
  byYearH1: Object.fromEntries(Object.entries(byYear).map(([y, a]) => [y, summ(a.filter(Number.isFinite))])) }, null, 1));
console.log(`warrant ok: months=${status.months} fetched=${status.fetched} errors=${status.errors} items=${Object.keys(store.items).length} events=${ev.length}`);
