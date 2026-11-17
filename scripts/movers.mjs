// 日本株：本日の値上がり・値下がりランキング（2026-11-18〜、オーナーの要望）
// 最新の取引日の終値を前日の終値と比べる。売買代金が小さい株（20日平均1億円未満）と100円未満は除く（ほとんど売買されない株の急騰を外すため）
// 公開するのは銘柄名・コード・上げ下げの率だけ（値段は出さない）。前の日〜当日に増配・上方修正などの開示があれば理由として付ける
import fs from 'node:fs';
import path from 'node:path';
import { detectEvents } from './lib/events.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const DATA = args.data ?? 'data', OUT = args.out ?? 'reports-out';
fs.mkdirSync(OUT, { recursive: true });
const pdir = path.join(DATA, 'prices');
const files = fs.readdirSync(pdir).filter((f) => f.endsWith('.json')).sort().slice(-21);
if (files.length < 21) { console.log('movers: not enough data'); process.exit(0); }
const load = (f) => new Map(JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8')).map(([c, o, h, l, cl, v, va]) => [c, { c: cl, va }]));
const days = files.map(load);
const today = days.at(-1), prev = days.at(-2);
const date = files.at(-1).slice(0, 10);
const master = JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8'));
const info = new Map(master.map((m) => [m.Code, m]));
const STOCK = new Set(['0111', '0112', '0113']);
// 直近の開示（前の取引日〜今日）
const fdir = path.join(DATA, 'fins');
const rows = [];
const since = files.at(-2).slice(0, 10);
if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir).filter((f) => f.slice(0, 10) >= since)) for (const r of JSON.parse(fs.readFileSync(path.join(fdir, f), 'utf8'))) rows.push(r);
const evByCode = new Map();
const LABEL = { div_up: '増配', div_down: '減配', earn_up: '上方修正', earn_down: '下方修正' };
for (const e of detectEvents(rows)) if (e.dd >= since && LABEL[e.kind]) { if (!evByCode.has(e.c)) evByCode.set(e.c, new Set()); evByCode.get(e.c).add(LABEL[e.kind]); }
const list = [];
for (const [code, p] of today) {
  const m = info.get(code);
  if (!m || !STOCK.has(m.Mkt)) continue;
  const pc = prev.get(code)?.c;
  if (!(pc > 0) || !(p.c >= 100)) continue;
  let va = 0, n = 0;
  for (const d of days.slice(0, 20)) { const x = d.get(code)?.va; if (x > 0) { va += x; n++; } }
  if (n < 15 || va / n < 1e8) continue;
  const r = p.c / pc - 1;
  if (!Number.isFinite(r)) continue;
  list.push({ code: code.slice(0, 4), name: m.CoName, sector: m.S33Nm ?? m.Sector33CodeName ?? null, pct: Math.round(r * 1000) / 10, news: evByCode.has(code) ? [...evByCode.get(code)].join('・') : null });
}
list.sort((a, b) => b.pct - a.pct);
const avg = list.length ? Math.round((list.reduce((a, x) => a + x.pct, 0) / list.length) * 10) / 10 : null;
const out = { date, updatedAt: new Date().toISOString(), note: '売買代金（20日平均）1億円以上・100円以上の東証の株', count: list.length, avgPct: avg, up: list.filter((x) => x.pct > 0).length, down: list.filter((x) => x.pct < 0).length, gainers: list.slice(0, 20), losers: list.slice(-10).reverse() };
fs.writeFileSync(path.join(OUT, 'movers-jp.json'), JSON.stringify(out, null, 1));
console.log(`movers-jp ok: ${date} n=${list.length}`);
