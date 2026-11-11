// ニュース記録（reports ブランチの news/*.json）の「当たり外れ」を集計する。
//   - 調査日（ファイルの date）の始値で買ったとみなし、1・5・20営業日後の終値までの損益率を出す
//   - 同じ期間の全銘柄平均（等金額）との差（超過リターン）で判定する。"+" なら差がプラス、"-" ならマイナスで当たり
//   - 調査日より前の反応（イベント日前日終値 → 調査日始値）も出す（もう織り込まれていたかの目安）
//   - 企業発表は J-Quants の開示（/fins/summary）と照合し、会社予想の営業利益・配当が実際にどう変わったかを付ける
// 公開する reports-out/news-eval.json には損益率・件数だけを出し、株価そのものは出さない。
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data';
const NEWS = args.news ?? 'news-in/news';
const OUT = args.out ?? 'reports-out';
const SLIP = 0.001;
const HORIZONS = [1, 5, 20];
const STOCK_MKT = new Set(['0111', '0112', '0113']);
fs.mkdirSync(OUT, { recursive: true });

const out = { updatedAt: new Date().toISOString(), note: '', horizons: HORIZONS, summary: {}, items: [] };
const finish = () => {
  fs.writeFileSync(path.join(OUT, 'news-eval.json'), JSON.stringify(out, null, 2));
  console.log(`news-eval: ${out.items.length} stocks, note="${out.note}"`);
};
if (!fs.existsSync(NEWS) || !fs.existsSync(path.join(DATA, 'prices'))) {
  out.note = 'ニュースまたは株価データがない';
  finish();
  process.exit(0);
}

// ---------- 株価 ----------
const dates = fs.readdirSync(path.join(DATA, 'prices')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 10)).sort();
const priceCache = new Map();
function pricesOn(date) {
  if (!priceCache.has(date)) {
    const m = new Map();
    for (const [code, o, h, l, c] of JSON.parse(fs.readFileSync(path.join(DATA, 'prices', `${date}.json`), 'utf8'))) m.set(code, { o, c });
    priceCache.set(date, m);
  }
  return priceCache.get(date);
}
const master = fs.existsSync(path.join(DATA, 'master.json')) ? JSON.parse(fs.readFileSync(path.join(DATA, 'master.json'), 'utf8')) : [];
const stockCodes = new Set(master.filter((m) => STOCK_MKT.has(m.Mkt)).map((m) => m.Code));
const firstIdxOnOrAfter = (d) => { let lo = 0, hi = dates.length; while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] < d) lo = m + 1; else hi = m; } return lo; };
const jq = (code4) => code4 + '0'; // J-Quants は5桁（末尾0）

// 全銘柄平均（始値 → 終値、等金額）。同じ期間は使い回す
const mktCache = new Map();
function marketRet(i, j) {
  const k = i + '|' + j;
  if (!mktCache.has(k)) {
    const a = pricesOn(dates[i]), b = pricesOn(dates[j]);
    let s = 0, n = 0;
    for (const [code, p] of a) {
      if (stockCodes.size && !stockCodes.has(code)) continue;
      const q = b.get(code);
      if (!(p.o > 0) || !(q?.c > 0)) continue;
      const r = q.c / p.o - 1;
      if (Math.abs(r) > 2) continue; // 分割などの異常値よけ
      s += r; n++;
    }
    mktCache.set(k, n ? s / n : null);
  }
  return mktCache.get(k);
}

// ---------- 開示（照合用） ----------
const finsByCode = new Map();
if (fs.existsSync(path.join(DATA, 'fins'))) {
  for (const f of fs.readdirSync(path.join(DATA, 'fins')).sort()) {
    for (const r of JSON.parse(fs.readFileSync(path.join(DATA, 'fins', f), 'utf8'))) {
      if (!finsByCode.has(r.c)) finsByCode.set(r.c, []);
      finsByCode.get(r.c).push(r);
    }
  }
  for (const a of finsByCode.values()) a.sort((x, y) => (x.dd + (x.dt ?? '')).localeCompare(y.dd + (y.dt ?? '')));
}
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
function disclosureCheck(code, eventDate, fileDate) {
  const rows = finsByCode.get(code);
  if (!rows) return { found: false };
  const from = addDays(eventDate, -3);
  const hits = rows.filter((r) => r.dd >= from && r.dd <= fileDate);
  if (!hits.length) return { found: false };
  const chg = (key) => {
    for (const r of hits.slice().reverse()) {
      if (r[key] == null || !r.fy) continue;
      const prev = rows.filter((x) => x.dd < r.dd && x.fy === r.fy && x[key] != null).pop();
      if (prev && prev[key] > 0) return pct(r[key] / prev[key] - 1);
    }
    return null;
  };
  return { found: true, n: hits.length, opForecastChg: chg('fop'), divForecastChg: chg('fdiv') };
}

// ---------- 集計 ----------
const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);
const files = fs.readdirSync(NEWS).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const lastDate = dates[dates.length - 1];
const seen = new Set(); // 同じ日・同じ銘柄・同じ向きは1回だけ数える
for (const f of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(NEWS, f), 'utf8'));
  const fileDate = doc.date ?? f.slice(0, 10);
  const i = firstIdxOnOrAfter(fileDate);
  for (const it of doc.items ?? []) {
    for (const s of it.stocks ?? []) {
      if (!/^[0-9A-Z]{4}$/.test(s.code ?? '') || !['+', '-'].includes(s.direction)) continue;
      const key = fileDate + '|' + s.code + '|' + s.direction;
      if (seen.has(key)) continue;
      seen.add(key);
      const code = jq(s.code);
      const row = {
        date: fileDate, eventDate: it.eventDate, code: s.code, name: s.name, direction: s.direction,
        type: it.type, confidence: it.confidence, horizon: it.horizon, headline: it.headline,
        entryDate: dates[i] ?? null, ret: {}, excess: {}, hit: {}, pre: null, status: 'ok',
      };
      const p0 = i < dates.length ? pricesOn(dates[i]).get(code) : null;
      if (i >= dates.length) row.status = 'まだ取引日のデータがない';
      else if (!(p0?.o > 0)) row.status = '株価が見つからない';
      else {
        for (const h of HORIZONS) {
          const j = i + h - 1;
          if (j >= dates.length) continue;
          const q = pricesOn(dates[j]).get(code);
          if (!(q?.c > 0)) continue;
          const r = q.c / p0.o - 1 - 2 * SLIP;
          const m = marketRet(i, j);
          row.ret[h] = pct(r);
          if (m != null) {
            const ex = r - m;
            row.excess[h] = pct(ex);
            row.hit[h] = s.direction === '+' ? ex > 0 : ex < 0;
          }
        }
        // 調査日より前の反応：イベント日の前営業日終値 → 調査日始値
        const e = firstIdxOnOrAfter(it.eventDate ?? fileDate) - 1;
        const pe = e >= 0 && e < i ? pricesOn(dates[e]).get(code) : null;
        if (pe?.c > 0) row.pre = pct(p0.o / pe.c - 1);
      }
      if (it.type === '企業発表') row.disclosure = disclosureCheck(code, it.eventDate ?? fileDate, fileDate);
      out.items.push(row);
    }
  }
}

function summarize(rows) {
  const o = { n: rows.length };
  for (const h of HORIZONS) {
    const done = rows.filter((r) => r.hit[h] != null);
    o[h] = done.length
      ? {
          n: done.length,
          hitRate: pct(done.filter((r) => r.hit[h]).length / done.length),
          // 向き込みの超過リターン（"-" は符号を反転。空売りではなく「当たった度合い」の目安）
          avgSignedExcess: pct(done.reduce((a, r) => a + (r.direction === '+' ? 1 : -1) * r.excess[h] / 100, 0) / done.length),
        }
      : null;
  }
  return o;
}
const group = (key) => {
  const g = {};
  for (const r of out.items) (g[r[key] ?? '不明'] ??= []).push(r);
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, summarize(v)]));
};
out.summary = {
  all: summarize(out.items),
  byDirection: group('direction'),
  byConfidence: group('confidence'),
  byType: group('type'),
};
out.lastPriceDate = lastDate;
out.newsFiles = files.length;
out.note = '調査日の始値で買い、n営業日後の終値で売った場合。全銘柄平均との差で判定。手数料0・滑り0.1%/片道。少数のうちは偶然の影響が大きい';
finish();
