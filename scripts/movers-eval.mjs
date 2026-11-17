// 値上がりした株の「その後」と「上がった理由」の学習（2026-11-18〜、オーナーの指示「なんで値上がりしたのか分析して、自己学習に活かそう」）
// A) 過去5年：毎日の値上がり上位20銘柄（よく売買されている株）を、理由（前の日〜当日の開示：上方修正・増配・決算・開示なし）で分け、
//    次の日の寄りで買った場合の 1日（寄り→引け）・5日・20日の成績と、全銘柄平均との差を、前半・後半で出す
// B) 毎朝の調査で調べた理由（reports の movers/*.json。カテゴリ付き）ごとに、同じように成績を積み上げる
// 公開は損益率と件数だけ（値段は出さない）
import fs from 'node:fs';
import path from 'node:path';
import { detectEvents } from './lib/events.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data', OUT = args.out ?? 'reports-out', MOV = args.movers ?? 'news-in/movers';
const SLIP = 0.001, TOP = 20;
fs.mkdirSync(OUT, { recursive: true });
const pdir = path.join(DATA, 'prices');
const files = fs.readdirSync(pdir).filter((f) => f.endsWith('.json')).sort();
const dates = files.map((f) => f.slice(0, 10));
const D = dates.length;
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
const STOCK = new Set(['0111', '0112', '0113']);
const codes = master.filter((m) => STOCK.has(m.Mkt)).map((m) => m.Code);
const ci = new Map(codes.map((c, i) => [c, i]));
const N = codes.length;
const O = new Float32Array(N * D).fill(NaN), C = O.slice(), VA = O.slice();
files.forEach((f, d) => { for (const [code, o, , , c, , va] of JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'))) { const i = ci.get(code); if (i === undefined) continue; O[i * D + d] = o; C[i * D + d] = c; VA[i * D + d] = va; } });
const at = (A, i, d) => A[i * D + d];
// 流動性（20日平均の売買代金1億円以上・100円以上）
const liq = new Uint8Array(N * D);
for (let i = 0; i < N; i++) { let s = 0, n = 0; for (let d = 0; d < D; d++) { const v = at(VA, i, d); if (v > 0) { s += v; n++; } if (d >= 20) { const w = at(VA, i, d - 20); if (w > 0) { s -= w; n--; } } liq[i * D + d] = d >= 20 && n >= 15 && s / n >= 1e8 && at(C, i, d) >= 100 ? 1 : 0; } }
// 市場全体（同じ条件の株の平均）：次の日の寄り→ n日後の引け
function mktRet(e, n) { let s = 0, k = 0; for (let i = 0; i < N; i++) { if (!liq[i * D + e - 1]) continue; const o = at(O, i, e), c = at(C, i, e + n - 1); if (o > 0 && c > 0) { const r = c / o - 1; if (Math.abs(r) < 1) { s += r; k++; } } } return k ? s / k : 0; }
const mktCache = new Map();
const mkt = (e, n) => { const key = e * 100 + n; if (!mktCache.has(key)) mktCache.set(key, mktRet(e, n)); return mktCache.get(key); };

// 開示：前の取引日〜当日の開示を理由とみなす
const rows = [];
const fdir = path.join(DATA, 'fins');
if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir).sort()) for (const r of JSON.parse(fs.readFileSync(path.join(fdir, f), 'utf8'))) rows.push(r);
const kindsBy = new Map(); // code|dd → Set
for (const e of detectEvents(rows)) { const k = e.c + '|' + e.dd; if (!kindsBy.has(k)) kindsBy.set(k, new Set()); kindsBy.get(k).add(e.kind); }
const discBy = new Map(); // code|dd → 決算などの開示があった
for (const r of rows) if (r.c && r.dd) discBy.set(r.c + '|' + r.dd, true);
function reasonOf(code, d) {
  const ks = new Set(); let disc = false;
  for (let dd = new Date(dates[d - 1]); dd <= new Date(dates[d]); dd.setDate(dd.getDate() + 1)) {
    const iso = dd.toISOString().slice(0, 10);
    for (const k of kindsBy.get(code + '|' + iso) ?? []) ks.add(k);
    if (discBy.get(code + '|' + iso)) disc = true;
  }
  if (ks.has('earn_up') && ks.has('div_up')) return '上方修正＋増配';
  if (ks.has('earn_up')) return '上方修正';
  if (ks.has('div_up')) return '増配';
  if (ks.has('earn_down') || ks.has('div_down')) return '下方修正・減配なのに上昇';
  if (disc) return '決算などの開示（修正なし）';
  return '開示なし（材料は別）';
}

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
function summ(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), win: r4(a.filter((x) => x > 0).length / a.length) }; }
const split = Math.floor(D * 0.6);
const H = [1, 5, 20];

// ---------- A) 過去5年 ----------
const groups = {}; // key → half → h → {ret:[], ex:[]}
const add = (key, half, h, r, ex) => { const g = ((groups[key] ??= {})[half] ??= {}); (g[h] ??= { ret: [], ex: [] }); g[h].ret.push(r); g[h].ex.push(ex); };
for (let d = 21; d < D - 21; d++) {
  const list = [];
  for (let i = 0; i < N; i++) { if (!liq[i * D + d]) continue; const r = at(C, i, d) / at(C, i, d - 1) - 1; if (Number.isFinite(r) && r < 2) list.push([i, r]); }
  list.sort((a, b) => b[1] - a[1]);
  const e = d + 1, half = d < split ? 'train' : 'test';
  for (const [i, r0] of list.slice(0, TOP)) {
    const o = at(O, i, e); if (!(o > 0)) continue;
    const reason = reasonOf(codes[i], d);
    const size = r0 >= 0.15 ? '+15%以上（ストップ高級）' : r0 >= 0.08 ? '+8〜15%' : '+8%未満';
    const gap = at(O, i, e) / at(C, i, d) - 1;
    const gapK = gap >= 0.02 ? '翌朝さらに+2%以上で始まる' : gap <= -0.02 ? '翌朝-2%以下で始まる' : '翌朝ほぼ横ばいで始まる';
    for (const h of H) {
      const c = at(C, i, e + h - 1); if (!(c > 0)) continue;
      const r = (c * (1 - SLIP)) / (o * (1 + SLIP)) - 1, ex = r - mkt(e, h);
      for (const key of ['全体', '理由:' + reason, '上げ幅:' + size, '翌朝:' + gapK, '理由×上げ幅:' + reason + '／' + size]) add(key, half, h, r, ex);
    }
  }
}
const history = {};
for (const [k, v] of Object.entries(groups)) history[k] = Object.fromEntries(['train', 'test'].map((h) => [h, Object.fromEntries(H.map((n) => [n, v[h]?.[n] ? { ...summ(v[h][n].ret), exAvg: summ(v[h][n].ex).avg, exWin: summ(v[h][n].ex).win } : { n: 0 }]))]));

// ---------- B) 調べた理由ごと（movers/*.json） ----------
const researched = { items: 0, byCat: {} };
if (fs.existsSync(MOV)) {
  const di = new Map(dates.map((x, k) => [x, k]));
  for (const f of fs.readdirSync(MOV).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    const M = JSON.parse(fs.readFileSync(path.join(MOV, f), 'utf8'));
    const d = di.get(M.date); if (d == null) continue;
    for (const it of M.items ?? []) {
      if (it.market !== 'jp') continue;
      const i = ci.get(String(it.code) + '0') ?? ci.get(String(it.code)); if (i == null) continue;
      researched.items++;
      const e = d + 1; if (e >= D) continue;
      const o = at(O, i, e); if (!(o > 0)) continue;
      for (const h of H) { const c = at(C, i, e + h - 1); if (!(c > 0)) continue; const r = (c * (1 - SLIP)) / (o * (1 + SLIP)) - 1; const g = ((researched.byCat[it.cat ?? '不明'] ??= {})[h] ??= { ret: [], ex: [] }); g.ret.push(r); g.ex.push(r - mkt(e, h)); }
    }
  }
  for (const v of Object.values(researched.byCat)) for (const h of Object.keys(v)) v[h] = { ...summ(v[h].ret), exAvg: summ(v[h].ex).avg };
}
const out = { updatedAt: new Date().toISOString(), periods: { train: [dates[21], dates[split - 1]], test: [dates[split], dates[D - 22]] }, note: '毎日の値上がり上位20（売買代金1億円以上）を、次の日の寄りで買った場合。ex=全銘柄平均との差', history, researched };
fs.writeFileSync(path.join(OUT, 'movers-eval.json'), JSON.stringify(out, null, 1));
console.log(`movers-eval ok: groups=${Object.keys(history).length} researched=${researched.items}`);
