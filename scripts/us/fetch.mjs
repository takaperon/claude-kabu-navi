// 米国株：S&P500銘柄の一覧、Tiingoの日足、SECの決算発表日時とEPS・売上を取得して data-us/ に保存
// 生データはリポジトリにコミットしない（暗号化キャッシュ）。ログ・ステータスには件数だけを出す
// SECの連絡先は Secrets の SEC_CONTACT_EMAIL（2026-11-07 登録）
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data-us';
const OUT = args.out ?? 'reports-out';
const MAX_MIN = Number(args['max-minutes'] ?? 300);
const FROM = '2021-01-01';
const started = Date.now();
for (const d of ['prices', 'sec', 'av']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const KEY = process.env.TIINGO_API_KEY;
const SEC_UA = 'ClaudeKabuNavi takaperon@users.noreply.github.com'; // SECは「名前 連絡先メール」の形式を求める
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
const stale = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
const minutes = () => (Date.now() - started) / 60000;

const status = {
  startedAt: new Date().toISOString(),
  keyPresent: !!KEY,
  universe: 0,
  tiingo: { requests: 0, updated: 0, failed: 0, limitHits: 0, lastError: null },
  sec: { requests: 0, submissions: 0, facts: 0, failed: 0, lastError: null },
  av: { keyPresent: !!process.env.ALPHAVANTAGE_API_KEY, requests: 0, stored: 0, failed: 0, limitHit: false, lastError: null },
  stoppedBy: 'done',
};
const writeStatus = () => {
  status.finishedAt = new Date().toISOString();
  status.pricesStored = fs.readdirSync(path.join(DATA, 'prices')).length;
  status.secStored = fs.readdirSync(path.join(DATA, 'sec')).length;
  status.av.stored = fs.readdirSync(path.join(DATA, 'av')).length;
  // 公開されるので、秘密の値（APIキー・メール）と「API key as ○○」のような文字列は必ず伏せる（2026-11-14 漏えいの修正）
  let text = JSON.stringify(status, null, 2);
  for (const v of [process.env.TIINGO_API_KEY, process.env.ALPHAVANTAGE_API_KEY, process.env.SEC_CONTACT_EMAIL]) if (v && v.length > 3) text = text.split(v).join('***');
  text = text.replace(/(api ?key( is| as)?:?\s*)[A-Za-z0-9_-]{6,}/gi, '$1***').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
  fs.writeFileSync(path.join(OUT, 'us-fetch-status.json'), text);
  console.log(text.replace(/\s+/g, ' '));
};

// ---------- 銘柄一覧（WikipediaのS&P500構成銘柄表。ティッカーとCIK） ----------
async function loadUniverse() {
  const f = path.join(DATA, 'universe.json');
  const old = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  if (old && Date.now() - Date.parse(old.at) < 7 * 864e5) return old.list;
  try {
    const res = await fetch('https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw', { headers: { 'User-Agent': SEC_UA } });
    const t = await res.text();
    // 表の各行： | {{NyseSymbol|MMM}} || [[3M]] || ... || 0000066740 || 1902
    const list = [];
    for (const row of t.split('\n|-')) {
      const sym = row.match(/\{\{(?:NyseSymbol|NasdaqSymbol|nyse|nasdaq|Nyse|Nasdaq)\|([A-Z.\-]+)\}\}/);
      const cik = row.match(/\b(\d{10})\b/);
      const name = row.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      const sector = row.split('||')[2]?.trim();
      if (sym && cik) list.push({ t: sym[1], cik: cik[1], name: (name?.[2] ?? name?.[1] ?? sym[1]).trim(), sector });
    }
    if (list.length > 400) {
      fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), list }));
      return list;
    }
    status.universeError = `parsed ${list.length}`;
  } catch (e) {
    status.universeError = e.message;
  }
  return old?.list ?? [];
}

// ---------- Tiingo ----------
async function tiingoDaily(ticker, from) {
  const t = ticker.replace('.', '-');
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(t)}/prices?startDate=${from}&format=json`;
  status.tiingo.requests++;
  const res = await fetch(url, { headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' } });
  const body = await res.text();
  if (res.status === 429 || /allocation|limit/i.test(res.ok ? '' : body)) {
    status.tiingo.limitHits++;
    status.tiingo.lastError = `${res.status} ${body.slice(0, 160)}`;
    return 'limit';
  }
  if (!res.ok) {
    status.tiingo.failed++;
    status.tiingo.lastError = `${res.status} ${body.slice(0, 160)}`;
    return null;
  }
  const j = JSON.parse(body);
  if (!Array.isArray(j)) { status.tiingo.failed++; status.tiingo.lastError = body.slice(0, 160); return null; }
  return j.map((r) => [r.date.slice(0, 10), r.adjOpen, r.adjHigh, r.adjLow, r.adjClose, r.adjVolume, r.divCash, r.splitFactor, r.close]);
}

// ---------- SEC ----------

// Node標準のfetchはブラウザ風の sec-fetch-mode 等を自動で付けるため、SECの検問に弾かれることがある。素のhttpsで送る
function httpsGet(url, ua) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate', Host: new URL(url).host } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        try {
          if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
          else if (res.headers['content-encoding'] === 'deflate') buf = zlib.inflateSync(buf);
        } catch {}
        const text = buf.toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}
let lastSec = 0;
// SECが拒否する理由を調べるため、名乗り方を何通りか試し、最初に通ったものを使う（応答本文の冒頭だけ記録。個人情報なし）
// 連絡先メールは Secrets（SEC_CONTACT_EMAIL）から。公開リポジトリなので、ステータスやログには名前（label）だけを出す
const CONTACT = process.env.SEC_CONTACT_EMAIL?.trim();
const UA_CANDIDATES = [
  ...(CONTACT ? [{ label: 'secret-email', ua: `ClaudeKabuNavi ${CONTACT}` }] : []),
  { label: 'github-noreply', ua: SEC_UA },
];
let secUA = SEC_UA;
async function probeSec() {
  status.sec.probe = [];
  for (const { label, ua } of UA_CANDIDATES) {
    try {
      const res = await httpsGet('https://data.sec.gov/submissions/CIK0000320193.json', ua);
      const body = await res.text();
      status.sec.probe.push({ ua: label, status: res.status, body: res.ok ? 'ok' : body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300) });
      if (res.ok) { secUA = ua; return true; }
    } catch (e) { status.sec.probe.push({ ua: label, error: e.message.slice(0, 120) }); }
    await sleep(1000);
  }
  // 比較用：curl でも同じか（通れば、Node側の送り方が原因と分かる）
  try {
    const { execFileSync } = await import('node:child_process');
    const code = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-A', UA_CANDIDATES[0].ua, 'https://data.sec.gov/submissions/CIK0000320193.json']).toString();
    status.sec.probe.push({ via: 'curl', ua: UA_CANDIDATES[0].label, status: Number(code) });
  } catch (e) { status.sec.probe.push({ via: 'curl', error: 'curl failed', code: e.status ?? null }); } // エラー文にはコマンド（連絡先入り）が含まれるので出さない
  return false;
}
async function secJSON(url) {
  const w = lastSec + 150 - Date.now();
  if (w > 0) await sleep(w);
  lastSec = Date.now();
  status.sec.requests++;
  const res = await httpsGet(url, secUA);
  if (!res.ok) { status.sec.failed++; status.sec.lastError = `${res.status} ${url.split('/').pop()}`; return null; }
  return res.json();
}
const QTAGS_EPS = ['EarningsPerShareDiluted', 'EarningsPerShareBasic'];
const QTAGS_REV = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenuesNetOfInterestExpense'];
function quarterly(facts, tags, unit) {
  // 期間が約3か月（70〜110日）の値だけ。end ごとに最初に提出された値を使う
  for (const tag of tags) {
    const arr = facts?.['us-gaap']?.[tag]?.units?.[unit];
    if (!arr) continue;
    const m = new Map();
    for (const x of arr) {
      if (!x.start || !x.end) continue;
      const days = (Date.parse(x.end) - Date.parse(x.start)) / 864e5;
      if (days < 70 || days > 110) continue;
      const prev = m.get(x.end);
      if (!prev || x.filed < prev.filed) m.set(x.end, { end: x.end, val: x.val, filed: x.filed });
    }
    if (m.size >= 4) return [...m.values()].sort((a, b) => a.end.localeCompare(b.end));
  }
  return [];
}
async function secFor(u) {
  const f = path.join(DATA, 'sec', `${u.t}.json`);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 3 * 864e5) return;
  const sub = await secJSON(`https://data.sec.gov/submissions/CIK${u.cik}.json`);
  if (!sub) return;
  status.sec.submissions++;
  const r = sub.filings?.recent ?? {};
  const earnings = [];
  for (let k = 0; k < (r.form?.length ?? 0); k++) {
    if (r.form[k] !== '8-K' && r.form[k] !== '8-K/A') continue;
    if (!String(r.items?.[k] ?? '').split(',').includes('2.02')) continue;
    if (r.filingDate[k] < FROM) continue;
    earnings.push(r.acceptanceDateTime[k]); // 例 2024-07-30T16:05:12.000Z（SECの時刻は米東部時間をZ表記で返す）
  }
  const facts = await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${u.cik}.json`);
  if (facts) status.sec.facts++;
  fs.writeFileSync(f, JSON.stringify({
    earnings: earnings.sort(),
    eps: quarterly(facts?.facts, QTAGS_EPS, 'USD/shares'),
    rev: quarterly(facts?.facts, QTAGS_REV, 'USD'),
  }));
}


// ---------- Alpha Vantage（決算のEPS実績・事前予想・サプライズ・発表タイミング）----------
// 無料枠は1日25回。持っていない銘柄から順に、全銘柄そろったら90日以上古いものを取り直す
const AV_KEY = process.env.ALPHAVANTAGE_API_KEY;
async function avRun(universe) {
  if (!AV_KEY) return;
  const list = universe.map((u) => {
    const f = path.join(DATA, 'av', `${u.t}.json`);
    return { u, f, age: fs.existsSync(f) ? Date.now() - fs.statSync(f).mtimeMs : Infinity };
  }).filter((x) => x.age > 90 * 864e5).sort((a, b) => b.age - a.age);
  status.av.needed = list.length;
  for (const x of list.slice(0, 25)) {
    status.av.requests++;
    try {
      const res = await fetch(`https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(x.u.t.replace('.', '-'))}&apikey=${AV_KEY}`);
      const j = await res.json();
      if (j.Information || j.Note) { status.av.limitHit = true; status.av.lastError = String(j.Information || j.Note).slice(0, 160); break; }
      if (!Array.isArray(j.quarterlyEarnings)) { status.av.failed++; status.av.lastError = JSON.stringify(j).slice(0, 160); fs.writeFileSync(x.f, '[]'); continue; }
      const num = (v) => (v == null || v === 'None' || v === '' ? null : Number(v));
      fs.writeFileSync(x.f, JSON.stringify(j.quarterlyEarnings.map((q) => ({
        rd: q.reportedDate, fde: q.fiscalDateEnding, eps: num(q.reportedEPS), est: num(q.estimatedEPS), spp: num(q.surprisePercentage), time: q.reportTime ?? null,
      }))));
    } catch (e) { status.av.failed++; status.av.lastError = e.message.slice(0, 160); }
    await sleep(13000); // 1分5回まで
  }
}

// ---------- 実行 ----------
const universe = await loadUniverse();
status.universe = universe.length;
const extra = [{ t: 'SPY', cik: null, name: 'S&P500 ETF' }];

if (!KEY) {
  status.stoppedBy = 'no-key';
} else {
  // SEC（1秒に10回まで。余裕を持って約6回）
  const secOk = await probeSec();
  for (const u of secOk ? universe : []) {
    if (minutes() > MAX_MIN * 0.3) break;
    try { await secFor(u); } catch (e) { status.sec.failed++; status.sec.lastError = e.message; }
  }
  await avRun(universe);
  // Tiingo：持っていない銘柄を優先、次に古い順。上限に当たったら1時間待って続ける
  const need = [...extra, ...universe].map((u) => {
    const f = path.join(DATA, 'prices', `${u.t}.json`);
    const rows = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    return { u, f, rows, last: rows?.at(-1)?.[0] ?? '' };
  // 無料枠は1時間50回なので、毎日全銘柄は取り直さない。持っていない銘柄と、7日以上更新していない銘柄だけ
  }).filter((x) => x.last < stale).sort((a, b) => a.last.localeCompare(b.last));
  status.tiingo.needed = need.length;
  for (const x of need) {
    if (minutes() > MAX_MIN) { status.stoppedBy = 'time'; break; }
    // 既存分は直近から取り直す（分割・配当の調整値が変わるので、30日以上古ければ全期間を取り直す）
    const fullRefetch = !x.rows || Date.now() - Date.parse(x.last) > 30 * 864e5;
    const from = fullRefetch ? FROM : x.last;
    let rows = await tiingoDaily(x.u.t, from);
    if (rows === 'limit' && /month/i.test(status.tiingo.lastError ?? '')) { status.stoppedBy = 'tiingo-monthly-symbols'; break; } // 月500銘柄の上限は待っても戻らない
    if (rows === 'limit') {
      if (minutes() + 62 > MAX_MIN) { status.stoppedBy = 'tiingo-limit'; break; }
      await sleep(61 * 60000);
      rows = await tiingoDaily(x.u.t, from);
      if (rows === 'limit') { status.stoppedBy = 'tiingo-limit'; break; }
    }
    if (!rows || !rows.length) continue;
    let merged = rows;
    if (!fullRefetch && x.rows) {
      // 調整値が変わっていたら（分割・配当）全期間を取り直す必要があるので、次回に回す
      const keep = x.rows.filter((r) => r[0] < rows[0][0]);
      const overlap = x.rows.find((r) => r[0] === rows[0][0]);
      if (overlap && Math.abs(overlap[4] - rows[0][4]) / rows[0][4] > 0.001) {
        fs.writeFileSync(x.f, JSON.stringify(x.rows.slice(0, 1))); // 古い扱いにして次回は全期間
        continue;
      }
      merged = [...keep, ...rows];
    }
    fs.writeFileSync(x.f, JSON.stringify(merged));
    status.tiingo.updated++;
    await sleep(1200);
  }
}
writeStatus();
