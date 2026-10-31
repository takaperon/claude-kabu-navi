// FXの日足と各国の政策金利を取得して data-fx/ に保存する（リポジトリにはコミットしない）
// 取得元：Stooq（日足の始値・高値・安値・終値）。使えない場合は FRED（終値のみ）で代用
// 金利：FRED（スワップポイントの近似に使う）
// ログ・ステータスには件数と期間だけを出す
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data-fx';
const OUT = args.out ?? 'reports-out';
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

export const PAIRS = ['usdjpy', 'eurjpy', 'gbpjpy', 'audjpy'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'User-Agent': 'claude-kabu-navi (personal research)' };

async function getText(url) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: UA });
      const t = await res.text();
      if (res.ok) return t;
      if (res.status < 500) return null;
    } catch {}
    await sleep(5000);
  }
  return null;
}

// Stooq: Date,Open,High,Low,Close[,Volume]
function parseStooq(t) {
  if (!t || !/^Date,Open,High,Low,Close/i.test(t.trim())) return null;
  const rows = [];
  for (const line of t.trim().split('\n').slice(1)) {
    const [d, o, h, l, c] = line.split(',');
    const v = [o, h, l, c].map(Number);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v.every((x) => x > 0)) rows.push([d, ...v]);
  }
  return rows.length > 100 ? rows : null;
}

// FRED: observation_date,SERIES
async function fred(id) {
  const t = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
  if (!t) return null;
  const out = [];
  for (const line of t.trim().split('\n').slice(1)) {
    const [d, v] = line.split(',');
    const x = Number(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v !== '.' && v !== '' && Number.isFinite(x)) out.push([d, x]);
  }
  return out.length ? out : null;
}

const status = { startedAt: new Date().toISOString(), pairs: {}, rates: {} };

// ---- 為替 ----
let fredFx = null;
for (const p of PAIRS) {
  let rows = parseStooq(await getText(`https://stooq.com/q/d/l/?s=${p}&i=d`));
  let source = 'stooq';
  if (!rows) {
    // FRED の対ドルレートから終値だけで作る（高値・安値は終値で代用）
    fredFx ??= {
      usd: await fred('DEXJPUS'), // 1ドル=円
      eur: await fred('DEXUSEU'), // 1ユーロ=ドル
      gbp: await fred('DEXUSUK'), // 1ポンド=ドル
      aud: await fred('DEXUSAL'), // 1豪ドル=ドル
    };
    const jp = new Map(fredFx.usd ?? []);
    const base = p.slice(0, 3);
    const src = base === 'usd' ? null : new Map(fredFx[base] ?? []);
    rows = [];
    for (const [d, usdjpy] of jp) {
      const c = base === 'usd' ? usdjpy : src.has(d) ? src.get(d) * usdjpy : null;
      if (c) rows.push([d, c, c, c, c]);
    }
    source = rows.length ? 'fred-close-only' : 'none';
  }
  if (rows.length) fs.writeFileSync(path.join(DATA, `${p}.json`), JSON.stringify(rows));
  status.pairs[p] = { source, rows: rows.length, from: rows[0]?.[0] ?? null, to: rows.at(-1)?.[0] ?? null };
  await sleep(2000);
}

// ---- 政策金利（スワップの近似用）。最初に取れたものを使う ----
const RATE_SERIES = {
  usd: ['DFF', 'FEDFUNDS'],
  jpy: ['IRSTCI01JPM156N', 'IR3TIB01JPM156N', 'INTDSRJPM193N'],
  eur: ['ECBDFR', 'IR3TIB01EZM156N'],
  gbp: ['IUDSOIA', 'IR3TIB01GBM156N'],
  aud: ['IRSTCI01AUM156N', 'IR3TIB01AUM156N'],
};
const rates = {};
for (const [cur, ids] of Object.entries(RATE_SERIES)) {
  for (const id of ids) {
    const r = await fred(id);
    if (r && r.length > 50) {
      rates[cur] = r;
      status.rates[cur] = { series: id, rows: r.length, from: r[0][0], to: r.at(-1)[0] };
      break;
    }
    await sleep(1000);
  }
  if (!rates[cur]) status.rates[cur] = { series: null };
}
fs.writeFileSync(path.join(DATA, 'rates.json'), JSON.stringify(rates));

status.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'fx-fetch-status.json'), JSON.stringify(status, null, 2));
console.log(JSON.stringify(status));
