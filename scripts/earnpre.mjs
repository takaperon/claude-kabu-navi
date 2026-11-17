// 決算発表の「前」の動き（日本株）。2026-11-18〜 オーナーの提案「確実にこの日、という日は早くて1か月前に発表される。前もって予測しておく方がいい」
// J-Quants の決算発表予定日（/fins/earnings-date）は「いつ公表されたか（PubDate）」が残るので、その日以降だけ予定日を知っていたことにする（未来の情報なし）。
// 試す形（寄りで買う・全銘柄平均との差）：
//   pre10/pre5/pre3 : 予定日の10・5・3営業日前に買い、予定日の前日の引けで売る（決算そのものは持ち越さない）
//   thru            : 予定日の5営業日前に買い、予定日の翌営業日の引けで売る（決算をまたぐ）
// さらに「前の決算で上方修正・進捗率の進みすぎ・前回の決算で上げたか」で分ける。公開は集計値だけ（reports-out/earnpre-jp.json）
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data', OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
fs.mkdirSync(OUT, { recursive: true });
const edir = path.join(DATA, 'earndate');
const efiles = fs.existsSync(edir) ? fs.readdirSync(edir).filter((f) => f.endsWith('.json')) : [];
const write = (o) => fs.writeFileSync(path.join(OUT, 'earnpre-jp.json'), JSON.stringify(o, null, 1));
if (efiles.length < 100) { write({ ok: false, reason: `決算発表予定日のデータがまだ少ない（${efiles.length}日分）` }); process.exit(0); }
const pdir = path.join(DATA, 'prices');
const files = fs.readdirSync(pdir).filter((f) => f.endsWith('.json')).sort();
const dates = files.map((f) => f.slice(0, 10)), D = dates.length;
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
const STOCK = new Set(['0111', '0112', '0113']);
const codes = master.filter((m) => STOCK.has(m.Mkt)).map((m) => m.Code);
const ci = new Map(codes.map((c, i) => [c, i])), N = codes.length;
const O = new Float32Array(N * D).fill(NaN), C = O.slice(), VA = O.slice();
files.forEach((f, d) => { for (const [code, o, , , c, , va] of JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'))) { const i = ci.get(code); if (i === undefined) continue; O[i * D + d] = o; C[i * D + d] = c; VA[i * D + d] = va; } });
const at = (A, i, d) => (d >= 0 && d < D ? A[i * D + d] : NaN);
const liq = new Uint8Array(N * D);
for (let i = 0; i < N; i++) { let s = 0, n = 0; for (let d = 0; d < D; d++) { const v = at(VA, i, d); if (v > 0) { s += v; n++; } if (d >= 20) { const w = at(VA, i, d - 20); if (w > 0) { s -= w; n--; } } liq[i * D + d] = d >= 20 && n >= 15 && s / n >= 1e8 && at(C, i, d) >= 100 ? 1 : 0; } }
const MK = new Float64Array(D).fill(1);
for (let d = 1; d < D; d++) { let s = 0, n = 0; for (let i = 0; i < N; i++) { if (!liq[i * D + d - 1]) continue; const r = at(C, i, d) / at(C, i, d - 1) - 1; if (Number.isFinite(r) && Math.abs(r) < 0.5) { s += r; n++; } } MK[d] = MK[d - 1] * (1 + (n ? s / n : 0)); }
const idxOnOrAfter = (iso) => { let lo = 0, hi = D; while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] >= iso) hi = m; else lo = m + 1; } return lo < D ? lo : null; };
const split = Math.floor(D * 0.6);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
function summ(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), win: r4(a.filter((x) => x > 0).length / a.length) }; }

// 予定日ごとに、最初に公表された日（PubDate）を取る。予定日が後から変わったものは、変わった後の日付をその公表日から知っていたことにする
const sched = new Map(); // code|SchDate → 最初の PubDate
for (const f of efiles) for (const [code, pub, sch] of JSON.parse(fs.readFileSync(path.join(edir, f), 'utf8'))) { if (!sch) continue; const k = code + '|' + sch; if (!sched.has(k) || pub < sched.get(k)) sched.set(k, pub); }
// 前の決算での材料（上方修正・進捗率・反応）
const rows = [];
const fdir = path.join(DATA, 'fins');
if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir)) for (const r of JSON.parse(fs.readFileSync(path.join(fdir, f), 'utf8'))) rows.push(r);
const resBy = new Map(); // code → [{dd, pt, op, fop}]
for (const r of rows) if (/FinancialStatements/.test(r.ty ?? '')) { if (!resBy.has(r.c)) resBy.set(r.c, []); resBy.get(r.c).push(r); }
for (const a of resBy.values()) a.sort((x, y) => x.dd.localeCompare(y.dd));
const NORM = { '1Q': 0.25, '2Q': 0.5, '3Q': 0.75 };

const groups = {};
const add = (key, h, form, v) => { (((groups[key] ??= {})[form] ??= { train: [], test: [] })[h]).push(v); };
let used = 0, leadDays = [];
for (const [k, pub] of sched) {
  const [code, sch] = k.split('|');
  const i = ci.get(code); if (i == null) continue;
  const e = idxOnOrAfter(sch); if (e == null || e < 30 || e + 2 >= D || dates[e] !== sch) continue; // 予定日が取引日のものだけ
  const pubIdx = idxOnOrAfter(pub); if (pubIdx == null) continue;
  leadDays.push(e - pubIdx);
  if (!liq[i * D + e - 11]) continue;
  // 前回の決算（予定日より前で一番新しい決算短信）
  const prev = (resBy.get(code) ?? []).filter((r) => r.dd < dates[Math.max(0, e - 10)]).at(-1);
  let progK = '進捗率なし';
  if (prev && NORM[prev.pt] && prev.fop > 0 && prev.op != null) { const ex = prev.op / prev.fop - NORM[prev.pt]; progK = ex >= 0.1 ? '前回の進捗が進みすぎ（+10pt以上）' : ex <= -0.1 ? '前回の進捗が遅れ（-10pt以下）' : '前回の進捗はふつう'; }
  let reactK = '前回の反応なし';
  if (prev) { const pd = idxOnOrAfter(prev.dd); if (pd != null && pd + 1 < D) { const rr = at(C, i, pd + 1) / at(C, i, pd - 1) - 1; if (Number.isFinite(rr)) reactK = rr >= 0.03 ? '前回の決算で上げた（+3%以上）' : rr <= -0.03 ? '前回の決算で下げた（-3%以下）' : '前回の決算はほぼ横ばい'; } }
  const run20 = at(C, i, e - 11) / at(C, i, e - 31) - 1;
  const runK = !Number.isFinite(run20) ? null : run20 >= 0.1 ? '直前に+10%以上上げている' : run20 <= -0.1 ? '直前に-10%以上下げている' : '直前の動きはふつう';
  const h = e < split ? 'train' : 'test';
  const forms = { pre10: [e - 10, e - 1], pre5: [e - 5, e - 1], pre3: [e - 3, e - 1], thru: [e - 5, e + 1] };
  for (const [form, [b, s]] of Object.entries(forms)) {
    if (b <= pubIdx) continue; // 予定日を知った後にしか買えない
    const o = at(O, i, b), c = at(C, i, s);
    if (!(o > 0 && c > 0)) continue;
    const v = (c * (1 - SLIP)) / (o * (1 + SLIP)) - 1 - (MK[s] / MK[b - 1] - 1);
    for (const key of ['全体', progK, reactK, runK].filter(Boolean)) add(key, h, form, v);
  }
  used++;
}
const out = { ok: true, generatedAt: new Date().toISOString(), periods: { train: [dates[30], dates[split - 1]], test: [dates[split], dates[D - 1]] },
  note: '予定日の何営業日前に買うか（pre10/5/3 は予定日の前日の引けで売る、thru は予定日の翌営業日の引けまで持つ）。全銘柄平均との差。予定日を公表した日より後にしか買わない',
  events: used, leadDays: summ(leadDays.map((x) => x / 1)), groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([f, w]) => [f, { train: summ(w.train), test: summ(w.test) }]))])) };
write(out);
console.log(`earnpre-jp ok: events=${used}`);
