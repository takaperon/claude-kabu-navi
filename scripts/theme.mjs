// テーマ株（出来事で関連株がまとめて上がる）を先回りできるかの検証（日本株、2026-11-20〜、オーナー「世間の出来事から上がる前にしっかり拾って」）
// A) 出来事の検証：大きく報道されたサイバー事件の「報道の後で最初に買える寄り付き」でセキュリティ株をまとめて買うと、1・5・20営業日後に全銘柄平均より上か
//    ＋ 報道の当日（買う前）にどれだけ上げてしまっていたか（追いかけになるか）
// B) 値動きの検証（出来事の一覧に頼らない）：テーマの銘柄の半分以上が同じ日に+3%以上上げた日（＝テーマに火がついた日）の次の日の寄りで買うと、その後どうか（過去5年すべて）
// 公開は集計値だけ（reports-out/theme-jp.json）
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data', OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
fs.mkdirSync(OUT, { recursive: true });
// テーマの銘柄（4桁）。見つからないコードは飛ばす
const THEMES = {
  security: { name: 'サイバーセキュリティ', codes: ['4704', '3857', '4493', '3692', '2326', '3042', '4288', '4398', '4258', '3762', '153A', '338A', '436A', '3909', '4417', '4062'] },
};
// 大きく報道されたサイバー事件。news＝報道が出た日、entry＝報道の後で最初に買える寄り付きの日（休日・引け後の報道は次の営業日）
// 出どころ：各社の第1報・報道（2026-11-20 調べ）。日付の確かさが低いものは sure:false
const EVENTS = [
  { name: '小島プレス工業へのランサムウェア（トヨタ全工場停止）', news: '2022-02-27', entry: '2022-02-28', sure: true },
  { name: '大阪急性期・総合医療センターへのランサムウェア', news: '2022-10-31', entry: '2022-11-01', sure: false },
  { name: '名古屋港のシステムへのランサムウェア', news: '2023-07-04', entry: '2023-07-05', sure: true },
  { name: 'KADOKAWA・ニコニコへのランサムウェア', news: '2024-06-08', entry: '2024-06-10', sure: true },
  { name: 'JAL・NTTドコモなどへのDDoS攻撃（年末年始）', news: '2024-12-26', entry: '2024-12-27', sure: false },
  { name: 'アサヒグループへのサイバー攻撃（工場停止）', news: '2025-09-29', entry: '2025-09-30', sure: false },
  { name: 'アスクルへのランサムウェア（出荷停止）', news: '2025-10-19', entry: '2025-10-20', sure: true },
  { name: '楽天証券への不正アクセス・プレイド「KARTE」経由の漏えい', news: '2026-11-17', entry: '2026-11-18', sure: true },
];
const pdir = path.join(DATA, 'prices');
const files = fs.readdirSync(pdir).filter((f) => f.endsWith('.json')).sort();
const dates = files.map((f) => f.slice(0, 10)), D = dates.length, di = new Map(dates.map((d, k) => [d, k]));
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
const STOCK = new Set(['0111', '0112', '0113']);
const codes = master.filter((m) => STOCK.has(m.Mkt)).map((m) => m.Code);
const ci = new Map(codes.map((c, i) => [c, i])), N = codes.length;
const O = new Float32Array(N * D).fill(NaN), C = O.slice(), VA = O.slice();
files.forEach((f, d) => { for (const [code, o, , , c, , va] of JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'))) { const i = ci.get(code); if (i === undefined) continue; O[i * D + d] = o; C[i * D + d] = c; VA[i * D + d] = va; } });
const at = (A, i, d) => (d >= 0 && d < D ? A[i * D + d] : NaN);
// 全銘柄平均（売買代金1億円以上・100円以上）の終値→終値と、寄り→引け
const liq = new Uint8Array(N * D);
for (let i = 0; i < N; i++) { let s = 0, n = 0; for (let d = 0; d < D; d++) { const v = at(VA, i, d); if (v > 0) { s += v; n++; } if (d >= 20) { const w = at(VA, i, d - 20); if (w > 0) { s -= w; n--; } } liq[i * D + d] = d >= 20 && n >= 15 && s / n >= 1e8 && at(C, i, d) >= 100 ? 1 : 0; } }
const MK = new Float64Array(D).fill(1), MO = new Float64Array(D).fill(0);
for (let d = 1; d < D; d++) { let s = 0, n = 0, so = 0, no = 0; for (let i = 0; i < N; i++) { if (!liq[i * D + d - 1]) continue; const r = at(C, i, d) / at(C, i, d - 1) - 1; if (Number.isFinite(r) && Math.abs(r) < 0.5) { s += r; n++; } const ro = at(C, i, d) / at(O, i, d) - 1; if (Number.isFinite(ro) && Math.abs(ro) < 0.5) { so += ro; no++; } } MK[d] = MK[d - 1] * (1 + (n ? s / n : 0)); MO[d] = no ? so / no : 0; }
// 寄りで買って h 営業日目の引けで売った時の、全銘柄平均（同じ日の寄り→h日目の引け）との差
const mkOpenTo = (e, x) => (1 + MO[e]) * (MK[x] / MK[e]) - 1;
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
function summ(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: a.length, avg: r4(a.reduce((x, y) => x + y, 0) / a.length), med: r4(s[a.length >> 1]), up: r4(a.filter((x) => x > 0).length / a.length) }; }
const HS = [1, 5, 20];
const out = { ok: true, generatedAt: new Date().toISOString(), period: [dates[0], dates[D - 1]], themes: {} };
for (const [tk, th] of Object.entries(THEMES)) {
  const idx = th.codes.map((c) => ci.get(c + '0') ?? ci.get(c)).filter((i) => i != null);
  const basket = (e, x) => { const rs = []; for (const i of idx) { const o = at(O, i, e), c = at(C, i, x); if (o > 0 && c > 0) rs.push((c * (1 - SLIP)) / (o * (1 + SLIP)) - 1); } return rs.length >= 3 ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN; };
  const dayRet = (d) => { const rs = []; for (const i of idx) { const a = at(C, i, d - 1), b = at(C, i, d); if (a > 0 && b > 0) rs.push(b / a - 1); } return rs; };
  // A) 出来事
  const evs = [];
  for (const ev of EVENTS) {
    const e = di.get(ev.entry); if (e == null) { evs.push({ ...ev, missing: true }); continue; }
    const pre = dayRet(e - 1), first = dayRet(e);
    const r = { name: ev.name, entry: ev.entry, sure: ev.sure,
      newsDayBasket: r4(pre.length ? pre.reduce((a, b) => a + b, 0) / pre.length : NaN), // 報道の日（買う前の日）にもう上げていた分
      entryGap: r4((() => { const rs = []; for (const i of idx) { const a = at(C, i, e - 1), o = at(O, i, e); if (a > 0 && o > 0) rs.push(o / a - 1); } return rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : NaN; })()), // 買う日の寄りの上げ（寄り前に上がってしまう分）
      stocks: first.length };
    for (const h of HS) { const x = e + h - 1; if (x < D) { const b = basket(e, x); r['h' + h] = r4(b); r['h' + h + 'vsMkt'] = r4(b - mkOpenTo(e, x)); } }
    evs.push(r);
  }
  const done = evs.filter((v) => !v.missing);
  const sumA = Object.fromEntries(HS.map((h) => [h, summ(done.map((v) => v['h' + h + 'vsMkt']).filter((x) => x != null))]));
  // B) 値動きで火がついた日：テーマの半分以上が+3%以上、かつテーマの平均が全銘柄平均より+3%以上
  const fires = { vsMkt: Object.fromEntries(HS.map((h) => [h, { train: [], test: [] }])), list: [] };
  const split = Math.floor(D * 0.6);
  let last = -100;
  for (let d = 21; d < D - 1; d++) {
    const rs = dayRet(d); if (rs.length < 5) continue;
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length, mk = MK[d] / MK[d - 1] - 1;
    if (!(rs.filter((x) => x >= 0.03).length >= rs.length / 2 && avg - mk >= 0.03)) continue;
    if (d - last < 10) continue; // 続けて火がついた日は最初の日だけ
    last = d;
    const e = d + 1; const h = e < split ? 'train' : 'test';
    const row = { day: dates[d], themeDay: r4(avg), mkt: r4(mk) };
    for (const hh of HS) { const x = e + hh - 1; if (x < D) { const v = basket(e, x) - mkOpenTo(e, x); if (Number.isFinite(v)) { fires.vsMkt[hh][h].push(v); row['h' + hh] = r4(v); } } }
    fires.list.push(row);
  }
  out.themes[tk] = { name: th.name, stocksFound: idx.length, codesFound: idx.map((i) => codes[i].slice(0, 4)),
    events: { note: '報道の後で最初に買える寄り付きで、テーマの銘柄を同じ金額ずつ買った成績（h1＝その日の引け、h5・h20＝5・20営業日目の引け）。vsMkt＝全銘柄平均との差。newsDayBasket＝報道の日（買えない日）の上げ、entryGap＝買う日の寄りでもう上げていた分', list: evs, summary: sumA },
    fires: { note: 'テーマの銘柄の半分以上が+3%以上・テーマ平均が全銘柄平均より+3%以上上げた日（火がついた日）の次の日の寄りで買った成績（全銘柄平均との差）。10営業日以内の続きは数えない', split: dates[split],
      summary: Object.fromEntries(HS.map((h) => [h, { train: summ(fires.vsMkt[h].train), test: summ(fires.vsMkt[h].test) }])), recent: fires.list.slice(-12) } };
}
fs.writeFileSync(path.join(OUT, 'theme-jp.json'), JSON.stringify(out, null, 1));
console.log(`theme-jp ok: ${Object.entries(out.themes).map(([k, v]) => `${k}=${v.stocksFound}`).join(' ')}`);
