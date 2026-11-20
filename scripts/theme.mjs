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
// テーマと、そのテーマを動かした出来事（2026-11-20 オーナー「サイバーだけの話じゃない。あなたの情報量で勝負して」）
// dir：+1＝出来事で上がりそうな側、-1＝下がりそうな側（成績は dir を掛けて「読みどおりに動いた分」で出す）
// news＝報道の日、entry＝報道の後で最初に買える（売れる）寄り付きの日。休日・引け後・場中の報道は次の営業日（場中に出たものはその日の値動きを取れない前提）。
// 銘柄も出来事も 2026-11-20 に私（Claude）が知っている範囲で選んだので後知恵が入る。日付の確かさが低いものは sure:false。見つからないコードは飛ばす
const THEMES = {
  security: { name: 'サイバーセキュリティ', dir: 1, codes: ['4704', '3857', '4493', '3692', '2326', '3042', '4288', '4398', '4258', '3762', '153A', '338A', '436A', '3909', '4417', '4062'], events: [
    { name: '小島プレス工業へのランサムウェア（トヨタ全工場停止）', news: '2022-02-27', entry: '2022-02-28', sure: true },
    { name: '大阪急性期・総合医療センターへのランサムウェア', news: '2022-10-31', entry: '2022-11-01', sure: false },
    { name: '名古屋港のシステムへのランサムウェア', news: '2023-07-04', entry: '2023-07-05', sure: true },
    { name: 'KADOKAWA・ニコニコへのランサムウェア', news: '2024-06-08', entry: '2024-06-10', sure: true },
    { name: 'JAL・NTTドコモなどへのDDoS攻撃（年末年始）', news: '2024-12-26', entry: '2024-12-27', sure: false },
    { name: 'アサヒグループへのサイバー攻撃（工場停止）', news: '2025-09-29', entry: '2025-09-30', sure: false },
    { name: 'アスクルへのランサムウェア（出荷停止）', news: '2025-10-19', entry: '2025-10-20', sure: true },
    { name: '楽天証券への不正アクセス・プレイド「KARTE」経由の漏えい', news: '2026-11-17', entry: '2026-11-18', sure: true }] },
  defense: { name: '防衛', dir: 1, codes: ['7011', '7012', '7013', '6208', '7721', '6203', '6946', '4274', '7963'], events: [
    { name: 'ロシアのウクライナ侵攻', news: '2022-02-24', entry: '2022-02-25', sure: true },
    { name: '中国軍が台湾周辺で大規模演習・日本のEEZにミサイル', news: '2022-08-04', entry: '2022-08-05', sure: true },
    { name: '北朝鮮のミサイルが日本の上空を通過（Jアラート）', news: '2022-10-04', entry: '2022-10-05', sure: true },
    { name: '安保3文書の閣議決定（防衛費の大幅増）', news: '2022-12-16', entry: '2022-12-19', sure: true },
    { name: 'ハマスのイスラエル攻撃', news: '2023-10-07', entry: '2023-10-10', sure: true },
    { name: 'イランのイスラエル攻撃', news: '2024-04-13', entry: '2024-04-15', sure: true },
    { name: 'イスラエルのイラン攻撃', news: '2025-06-13', entry: '2025-06-16', sure: true }] },
  disaster: { name: '防災・建設', dir: 1, codes: ['1926', '1914', '1890', '1805', '1822', '1898', '7963', '3361', '2585'], events: [
    { name: '福島県沖の地震（M7.4）', news: '2022-03-16', entry: '2022-03-17', sure: true },
    { name: '能登半島地震', news: '2024-01-01', entry: '2024-01-04', sure: true },
    { name: '日向灘の地震・南海トラフ地震臨時情報', news: '2024-08-08', entry: '2024-08-09', sure: true },
    { name: 'カムチャツカ半島沖の地震・津波警報', news: '2025-07-30', entry: '2025-07-31', sure: true }] },
  inbound: { name: 'インバウンド（中国関係の悪化）', dir: -1, codes: ['3099', '8233', '8242', '4911', '4922', '9603', '7532', '3086'], events: [
    { name: '中国が処理水の放出に反発し日本の水産物を全面禁輸', news: '2023-08-24', entry: '2023-08-25', sure: true },
    { name: '中国が日本への渡航自粛を呼びかけ', news: '2025-11-14', entry: '2025-11-17', sure: true }] },
  exporters: { name: '輸出株（円買いの為替介入）', dir: -1, codes: ['7203', '7267', '7201', '6902', '6758', '6501', '6954', '7751', '6981'], events: [
    { name: '24年ぶりの円買い介入', news: '2022-09-22', entry: '2022-09-26', sure: true },
    { name: '円買い介入（2回目、151円台から）', news: '2022-10-21', entry: '2022-10-24', sure: true },
    { name: '円買い介入（160円台から）', news: '2024-04-29', entry: '2024-04-30', sure: true },
    { name: '円買い介入（米FOMCの後）', news: '2024-05-01', entry: '2024-05-02', sure: true },
    { name: '円買い介入（米CPIの後）', news: '2024-07-11', entry: '2024-07-12', sure: true }] },
  semis: { name: '半導体（輸出規制の強化）', dir: -1, codes: ['8035', '6857', '6146', '6920', '7735', '6525', '6323', '3436'], events: [
    { name: '米国が中国向け半導体の輸出規制を大幅に強化', news: '2022-10-07', entry: '2022-10-11', sure: true },
    { name: '日本が半導体製造装置23品目を輸出規制へ', news: '2023-03-31', entry: '2023-04-03', sure: false },
    { name: '米国が中国向けの半導体装置・HBMの規制を追加', news: '2024-12-02', entry: '2024-12-03', sure: true },
    { name: '米国がAI半導体の輸出規制（AI拡散規則）を発表', news: '2025-01-13', entry: '2025-01-14', sure: true }] },
  tariff: { name: '自動車など（米国の関税）', dir: -1, codes: ['7203', '7267', '7201', '7269', '7270', '7211', '6902', '5108'], events: [
    { name: '米国が輸入車に25%の関税を発表', news: '2025-03-26', entry: '2025-03-27', sure: true },
    { name: '米国が相互関税を発表', news: '2025-04-02', entry: '2025-04-03', sure: true }] },
};
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
  for (const ev of th.events) {
    const e = dates.findIndex((d) => d >= ev.entry); if (e < 1) { evs.push({ ...ev, missing: true }); continue; }
    const pre = dayRet(e - 1), first = dayRet(e);
    const r = { name: ev.name, entry: ev.entry, sure: ev.sure,
      newsDayBasket: r4(pre.length ? pre.reduce((a, b) => a + b, 0) / pre.length : NaN), // 報道の日（買う前の日）にもう上げていた分
      entryGap: r4((() => { const rs = []; for (const i of idx) { const a = at(C, i, e - 1), o = at(O, i, e); if (a > 0 && o > 0) rs.push(o / a - 1); } return rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : NaN; })()), // 買う日の寄りの上げ（寄り前に上がってしまう分）
      stocks: first.length };
    r.entryUsed = dates[e];
    for (const h of HS) { const x = e + h - 1; if (x < D) { const b = basket(e, x); r['h' + h] = r4(b); r['h' + h + 'vsMkt'] = r4(b - mkOpenTo(e, x)); r['h' + h + 'dir'] = r4(th.dir * (b - mkOpenTo(e, x))); } }
    evs.push(r);
  }
  const done = evs.filter((v) => !v.missing);
  const sumA = Object.fromEntries(HS.map((h) => [h, summ(done.map((v) => v['h' + h + 'dir']).filter((x) => x != null))]));
  const sumSure = Object.fromEntries(HS.map((h) => [h, summ(done.filter((v) => v.sure).map((v) => v['h' + h + 'dir']).filter((x) => x != null))]));
  // B) 値動きで火がついた日：テーマの半分以上が+3%以上、かつテーマの平均が全銘柄平均より+3%以上
  const fires = { vsMkt: Object.fromEntries(HS.map((h) => [h, { train: [], test: [] }])), list: [] };
  const split = Math.floor(D * 0.6);
  let last = -100;
  for (let d = 21; d < D - 1; d++) {
    const rs = dayRet(d); if (rs.length < 5) continue;
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length, mk = MK[d] / MK[d - 1] - 1;
    const dz = th.dir; if (!(rs.filter((x) => dz * x >= 0.03).length >= rs.length / 2 && dz * (avg - mk) >= 0.03)) continue;
    if (d - last < 10) continue; // 続けて火がついた日は最初の日だけ
    last = d;
    const e = d + 1; const h = e < split ? 'train' : 'test';
    const row = { day: dates[d], themeDay: r4(avg), mkt: r4(mk) };
    for (const hh of HS) { const x = e + hh - 1; if (x < D) { const v = th.dir * (basket(e, x) - mkOpenTo(e, x)); if (Number.isFinite(v)) { fires.vsMkt[hh][h].push(v); row['h' + hh] = r4(v); } } }
    fires.list.push(row);
  }
  out.themes[tk] = { name: th.name, stocksFound: idx.length, codesFound: idx.map((i) => codes[i].slice(0, 4)),
    dir: th.dir, events: { summarySure: sumSure, note: 'summary は dir（上がる側+1・下がる側-1）を掛けた「読みどおりに動いた分」。報道の後で最初に買える寄り付きで、テーマの銘柄を同じ金額ずつ買った成績（h1＝その日の引け、h5・h20＝5・20営業日目の引け）。vsMkt＝全銘柄平均との差。newsDayBasket＝報道の日（買えない日）の上げ、entryGap＝買う日の寄りでもう上げていた分', list: evs, summary: sumA },
    fires: { note: 'テーマの銘柄の半分以上が+3%以上・テーマ平均が全銘柄平均より+3%以上上げた日（火がついた日）の次の日の寄りで買った成績（全銘柄平均との差）。10営業日以内の続きは数えない', split: dates[split],
      summary: Object.fromEntries(HS.map((h) => [h, { train: summ(fires.vsMkt[h].train), test: summ(fires.vsMkt[h].test) }])), recent: fires.list.slice(-12) } };
}
// C) 毎朝のニュース調査で拾った「テーマのきっかけ」（reports の events/theme-triggers.json）を、仮想で追いかける（試験中・本物のお金は使わない）
// {items:[{news, entry, theme, title, sources}]}。entry の寄りでテーマの銘柄を同じ金額ずつ買った扱いで、今日までと5・20営業日目の成績（全銘柄平均との差）
try {
  const tf = args.triggers; const tr = tf && fs.existsSync(tf) ? JSON.parse(fs.readFileSync(tf, 'utf8')).items ?? [] : [];
  out.triggers = tr.map((t) => {
    const th = THEMES[t.theme]; const e = di.get(t.entry); if (!th || e == null) return { ...t, status: e == null ? '買う日がまだ来ていない' : '不明なテーマ' };
    const idx = th.codes.map((c) => ci.get(c + '0') ?? ci.get(c)).filter((i) => i != null);
    const bk = (x) => { const rs = []; for (const i of idx) { const o = at(O, i, e), c = at(C, i, x); if (o > 0 && c > 0) rs.push((c * (1 - SLIP)) / (o * (1 + SLIP)) - 1); } return rs.length >= 3 ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN; };
    const r = { news: t.news, entry: t.entry, theme: t.theme, title: t.title, held: D - e };
    r.now = r4(bk(D - 1)); r.nowVsMkt = r4(bk(D - 1) - mkOpenTo(e, D - 1));
    for (const h of [5, 20]) if (e + h - 1 < D) { r['h' + h + 'vsMkt'] = r4(bk(e + h - 1) - mkOpenTo(e, e + h - 1)); }
    return r;
  });
} catch (err) { out.triggersError = String(err.message).slice(0, 100); }
fs.writeFileSync(path.join(OUT, 'theme-jp.json'), JSON.stringify(out, null, 1));
console.log(`theme-jp ok: ${Object.entries(out.themes).map(([k, v]) => `${k}=${v.stocksFound}`).join(' ')}`);
