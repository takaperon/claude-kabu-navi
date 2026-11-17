// 「決まった時期の動き」の検証（日本株）。2026-11-18〜 オーナーの指摘「プライムセールのような分かりやすい販促の前後で上げ下げする、そういうファクターが必要」
// A) 会社ごとの季節性：その会社が、過去の年の「同じ月」に市場より上がっていたか。毎月はじめに、過去の同じ月の成績が良い上位20銘柄を買って月末まで持つ
//    （セールや繁忙期・決算期など、会社ごとに毎年くり返す出来事は、同じ月の値動きに表れるはず）
// B) 権利付き最終日：配当の権利が付く最後の日（決算期末の2営業日前）に向けて買われるか。10営業日前の寄りで買い、権利付き最終日の引けで売る。
//    権利落ち日（翌営業日）の寄りで買って20日持つ（落ちた分を戻すか）も
// 未来の情報は使わない（A は前の年までの成績だけ、B の配当は開示済みの予想）。公開は集計値だけ（reports-out/calendar-jp.json）
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data', OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
fs.mkdirSync(OUT, { recursive: true });
const pdir = path.join(DATA, 'prices');
const files = fs.readdirSync(pdir).filter((f) => f.endsWith('.json')).sort();
const dates = files.map((f) => f.slice(0, 10));
const D = dates.length;
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
const STOCK = new Set(['0111', '0112', '0113']);
const ms = master.filter((m) => STOCK.has(m.Mkt));
const codes = ms.map((m) => m.Code);
const ci = new Map(codes.map((c, i) => [c, i]));
const N = codes.length;
const O = new Float32Array(N * D).fill(NaN), C = O.slice(), VA = O.slice(), RO = O.slice();
files.forEach((f, d) => { for (const [code, o, , , c, , va] of JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'))) { const i = ci.get(code); if (i === undefined) continue; O[i * D + d] = o; C[i * D + d] = c; VA[i * D + d] = va; } });
if (fs.existsSync(path.join(DATA, 'raw'))) { const di = new Map(dates.map((x, k) => [x, k])); for (const f of fs.readdirSync(path.join(DATA, 'raw'))) { const d = di.get(f.slice(0, 10)); if (d == null) continue; for (const [code, o] of JSON.parse(fs.readFileSync(path.join(DATA, 'raw', f), 'utf8'))) { const i = ci.get(code); if (i != null && o > 0) RO[i * D + d] = o; } } }
const at = (A, i, d) => (d >= 0 && d < D ? A[i * D + d] : NaN);
const split = Math.floor(D * 0.6);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
function summ(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), win: r4(a.filter((x) => x > 0).length / a.length) }; }
const liq = new Uint8Array(N * D);
for (let i = 0; i < N; i++) { let s = 0, n = 0; for (let d = 0; d < D; d++) { const v = at(VA, i, d); if (v > 0) { s += v; n++; } if (d >= 20) { const w = at(VA, i, d - 20); if (w > 0) { s -= w; n--; } } liq[i * D + d] = d >= 20 && n >= 15 && s / n >= 1e8 && at(C, i, d) >= 100 ? 1 : 0; } }
const MK = new Float64Array(D).fill(1);
for (let d = 1; d < D; d++) { let s = 0, n = 0; for (let i = 0; i < N; i++) { if (!liq[i * D + d - 1]) continue; const r = at(C, i, d) / at(C, i, d - 1) - 1; if (Number.isFinite(r) && Math.abs(r) < 0.5) { s += r; n++; } } MK[d] = MK[d - 1] * (1 + (n ? s / n : 0)); }
const mkt = (a, b) => MK[b] / MK[a - 1] - 1; // a の寄り（前日終値で近似）→ b の引け

// ---------- A) 月ごとの季節性 ----------
const months = []; // {ym, first, last}
for (let d = 0; d < D; d++) { const ym = dates[d].slice(0, 7); if (!months.length || months.at(-1).ym !== ym) months.push({ ym, first: d, last: d }); else months.at(-1).last = d; }
// 銘柄ごと・月ごとの「市場との差」
const ex = new Map(); // i|ym → 市場との差（その月の寄り→月末の引け）
for (const m of months) { if (m.first < 1) continue; const mr = mkt(m.first, m.last); for (let i = 0; i < N; i++) { const o = at(O, i, m.first), c = at(C, i, m.last); if (o > 0 && c > 0) ex.set(i + '|' + m.ym, c / o - 1 - mr); } }
const season = { note: '毎月はじめに、過去の年の同じ月に市場より上がっていた上位20銘柄（2年以上の記録、売買代金1億円以上）を寄りで買い、月末の引けで売る。市場との差', byMonth: [], top: { train: [], test: [] }, bottom: { train: [], test: [] }, consistent: { train: [], test: [] } };
for (const m of months) {
  if (m.first < 21) continue;
  const mm = m.ym.slice(5), y = +m.ym.slice(0, 4);
  const sc = [];
  for (let i = 0; i < N; i++) {
    if (!liq[i * D + m.first - 1]) continue;
    const past = []; for (let yy = y - 1; yy >= y - 4; yy--) { const v = ex.get(i + '|' + yy + '-' + mm); if (v != null) past.push(v); }
    if (past.length < 2) continue;
    const now = ex.get(i + '|' + m.ym); if (now == null) continue;
    sc.push({ s: past.reduce((a, b) => a + b, 0) / past.length, allUp: past.every((v) => v > 0.02), now: now - 2 * SLIP });
  }
  if (sc.length < 100) continue;
  sc.sort((a, b) => b.s - a.s);
  const h = m.first < split ? 'train' : 'test';
  const t = sc.slice(0, 20), b = sc.slice(-20), c = sc.filter((x) => x.allUp);
  season.top[h].push(t.reduce((a, x) => a + x.now, 0) / t.length);
  season.bottom[h].push(b.reduce((a, x) => a + x.now, 0) / b.length);
  if (c.length) season.consistent[h].push(c.reduce((a, x) => a + x.now, 0) / c.length);
  season.byMonth.push({ ym: m.ym, n: sc.length, top20: r4(t.reduce((a, x) => a + x.now, 0) / t.length), bottom20: r4(b.reduce((a, x) => a + x.now, 0) / b.length), consistentN: c.length });
}
for (const k of ['top', 'bottom', 'consistent']) for (const h of ['train', 'test']) season[k][h] = summ(season[k][h]);
season.consistentNote = 'consistent = 過去の同じ月に毎年（2年以上）市場より+2%以上上がっていた銘柄すべて';

// ---------- B) 権利付き最終日 ----------
const rows = [];
const fdir = path.join(DATA, 'fins');
if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir).sort()) for (const r of JSON.parse(fs.readFileSync(path.join(fdir, f), 'utf8'))) rows.push(r);
rows.sort((a, b) => a.dd.localeCompare(b.dd));
// 会社ごとの決算期末と、直近の年間配当予想（開示日つき）
const fyEnd = new Map(), divHist = new Map();
for (const r of rows) { if (r.fy) fyEnd.set(r.c, r.fy.slice(5)); if (r.fdiv > 0) { if (!divHist.has(r.c)) divHist.set(r.c, []); divHist.get(r.c).push([r.dd, r.fdiv]); } }
const lastTradingOnOrBefore = (iso) => { let lo = 0, hi = D; while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] <= iso) lo = m + 1; else hi = m; } return lo - 1; };
const kenri = { note: '権利付き最終日＝期末（本決算・中間）の2営業日前。期末が休みなら前の営業日から数える。配当予想はその時点で開示済みのもの。市場との差', pre: {}, post: {} };
const add = (obj, key, h, v) => { ((obj[key] ??= { train: [], test: [] })[h]).push(v); };
for (const [code, mmdd] of fyEnd) {
  const i = ci.get(code); if (i == null) continue;
  const fm = +mmdd.slice(0, 2);
  const ends = [];
  for (let y = +dates[0].slice(0, 4); y <= +dates[D - 1].slice(0, 4); y++) for (const mo of [fm, ((fm + 5) % 12) + 1]) { const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); ends.push(last); }
  for (const end of ends) {
    const re = lastTradingOnOrBefore(end); // 期末（の直前の営業日）
    const k = re - 2; // 権利付き最終日（受け渡し2営業日）
    if (k < 30 || k + 21 >= D) continue;
    if (!liq[i * D + k - 10]) continue;
    const dv = (divHist.get(code) ?? []).filter(([dd]) => dd <= dates[k - 10]).at(-1);
    const raw = at(RO, i, k - 10);
    const yld = dv && raw > 0 ? dv[1] / raw : 0;
    const yb = yld <= 0 ? '無配' : yld < 0.02 ? '利回り2%未満' : yld < 0.035 ? '2〜3.5%' : yld < 0.05 ? '3.5〜5%' : '5%以上';
    const h = k < split ? 'train' : 'test';
    const b = k - 9, o = at(O, i, b), c = at(C, i, k);
    if (o > 0 && c > 0) { const v = (c * (1 - SLIP)) / (o * (1 + SLIP)) - 1 - mkt(b, k); add(kenri.pre, yb, h, v); add(kenri.pre, '全体', h, v); }
    const e = k + 1, o2 = at(O, i, e), c2 = at(C, i, e + 19);
    if (o2 > 0 && c2 > 0) { const v = (c2 * (1 - SLIP)) / (o2 * (1 + SLIP)) - 1 - mkt(e, e + 19); add(kenri.post, yb, h, v); add(kenri.post, '全体', h, v); }
  }
}
for (const o of [kenri.pre, kenri.post]) for (const k of Object.keys(o)) o[k] = { train: summ(o[k].train), test: summ(o[k].test) };
const out = { ok: true, generatedAt: new Date().toISOString(), periods: { train: [dates[0], dates[split - 1]], test: [dates[split], dates[D - 1]] }, season, kenri };
fs.writeFileSync(path.join(OUT, 'calendar-jp.json'), JSON.stringify(out, null, 1));
console.log(`calendar-jp ok: months=${season.byMonth.length}`);
