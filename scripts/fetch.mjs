// 日足（調整済み）を日付ごとに取得して data/ に保存する。取得済みの日は取り直さない。
// ログ・ステータスには件数だけを出す（公開リポジトリのため個別価格は出さない）。
import fs from 'node:fs';
import path from 'node:path';
import { getAll, stats, ApiError } from './jquants.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const DATA = args.data ?? 'data';
const OUT = args.out ?? 'reports-out';
const MAX_MIN = Number(args['max-minutes'] ?? 300);
const started = Date.now();

fs.mkdirSync(path.join(DATA, 'prices'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'raw'), { recursive: true }); // 調整前の始値・終値（100株単位の必要資金の計算用。2026-11-12〜）
fs.mkdirSync(path.join(DATA, 'fins'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const status = {
  startedAt: new Date().toISOString(),
  keyPresent: !!process.env.JQUANTS_API_KEY,
  fetchedDays: 0,
  rowsFetched: 0,
  skippedUnavailable: 0,
  errors: {},
  stoppedBy: 'done',
};
const writeStatus = () => {
  Object.assign(status, stats(), { finishedAt: new Date().toISOString() });
  const have = fs.readdirSync(path.join(DATA, 'prices')).filter((f) => f.endsWith('.json')).sort();
  status.storedDays = have.length;
  status.storedFrom = have[0]?.slice(0, 10) ?? null;
  status.storedTo = have.at(-1)?.slice(0, 10) ?? null;
  status.finsStoredDays = fs.readdirSync(path.join(DATA, 'fins')).length;
  fs.writeFileSync(path.join(OUT, 'fetch-status.json'), JSON.stringify(status, null, 2));
  console.log(JSON.stringify(status));
};

if (!status.keyPresent) {
  status.stoppedBy = 'no-key';
  writeStatus();
  process.exit(0);
}

const ymd = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const fromDefault = new Date(today);
fromDefault.setFullYear(today.getFullYear() - Number(process.env.JQUANTS_YEARS ?? 5));
fromDefault.setDate(fromDefault.getDate() + 1); // プラン期間の端ちょうどを避ける

const unavailPath = path.join(DATA, 'unavailable.json');
const unavailable = fs.existsSync(unavailPath) ? JSON.parse(fs.readFileSync(unavailPath, 'utf8')) : {};
const recentLimit = new Date(today);
recentLimit.setDate(recentLimit.getDate() - 10); // 直近は毎回取り直す

try {
  // 銘柄一覧（毎回更新、1リクエスト）
  const master = await getAll('/equities/master', {});
  fs.writeFileSync(path.join(DATA, 'master.json'), JSON.stringify(master));
  status.masterRows = master.length;

  // 取引カレンダー
  // プランの取得可能期間外を指定すると400で「covers the following dates: A ~ B」と返るので、その範囲に合わせる
  let cal;
  try {
    cal = await getAll('/markets/calendar', { from: ymd(fromDefault), to: ymd(today) });
  } catch (e) {
    const m = e instanceof ApiError && e.status === 400 && e.message.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})?/);
    if (!m) throw e;
    const to = m[2] ?? ymd(today);
    status.planRange = `${m[1]}~${to}`;
    cal = await getAll('/markets/calendar', { from: m[1], to });
  }
  // HolDiv: 0=非営業日, 1=営業日, 2=半日立会, 3=非営業日（祝日取引あり）
  const days = cal.filter((r) => r.HolDiv === '1' || r.HolDiv === '2').map((r) => r.Date);
  status.calendarTradingDays = days.length;

  const newSplits = [];
  // 新しい日から順に取る（途中で止まっても最近のデータが揃うように）
  for (const d of days.slice().reverse()) {
    if (d > ymd(today)) continue;
    const file = path.join(DATA, 'prices', `${d}.json`);
    if (fs.existsSync(file)) continue;
    if (unavailable[d] === 'empty' && d < ymd(recentLimit)) {
      status.skippedUnavailable++;
      continue;
    }
    if ((Date.now() - started) / 60000 > MAX_MIN) {
      status.stoppedBy = 'time';
      break;
    }
    try {
      const rows = await getAll('/equities/bars/daily', { date: d.replaceAll('-', '') });
      if (rows.length === 0) {
        unavailable[d] = 'empty';
        continue;
      }
      // [Code, AdjO, AdjH, AdjL, AdjC, AdjVo, Va]
      const compact = rows.map((r) => [r.Code, r.AdjO, r.AdjH, r.AdjL, r.AdjC, r.AdjVo, r.Va]);
      // 株式分割・併合のあった銘柄（調整係数が1でない）。前に取った日の値段は分割前のままなので、後でその銘柄の全期間を取り直す（2026-11-20〜）
      for (const r of rows) { const f = Number(r.AdjFactor ?? r.AdjustmentFactor ?? 1); if (Number.isFinite(f) && f > 0 && f !== 1) newSplits.push({ code: r.Code, date: d, factor: f }); }
      fs.writeFileSync(file, JSON.stringify(compact));
      fs.writeFileSync(path.join(DATA, 'raw', `${d}.json`), JSON.stringify(rows.map((r) => [r.Code, r.O, r.C])));
      delete unavailable[d];
      status.fetchedDays++;
      status.rowsFetched += rows.length;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 400 || e.status === 403)) {
        unavailable[d] = `http${e.status}`;
        status.errors[e.status] = (status.errors[e.status] ?? 0) + 1;
        status.lastErrorMessage = e.message;
        continue;
      }
      throw e;
    }
  }

  // 分割・併合のあった銘柄は、全期間の調整後の値段を取り直して、保存済みの日のファイルを書き換える
  const splitFile = path.join(DATA, 'splits.json');
  const splits = fs.existsSync(splitFile) ? JSON.parse(fs.readFileSync(splitFile, 'utf8')) : [];
  // 仕組みを入れる前に取った日（直近20営業日）は、一度だけ取り直して調整係数を確かめる
  if (!fs.existsSync(splitFile)) {
    for (const d of days.filter((x) => x <= ymd(today)).slice(-20)) {
      try {
        const rows = await getAll('/equities/bars/daily', { date: d.replaceAll('-', '') });
        if (rows[0] && !status.dailyKeys) status.dailyKeys = Object.keys(rows[0]);
        for (const r of rows) { const f = Number(r.AdjFactor ?? r.AdjustmentFactor ?? 1); if (Number.isFinite(f) && f > 0 && f !== 1) newSplits.push({ code: r.Code, date: d, factor: f }); }
      } catch (e) { status.splitRecheckErrors = (status.splitRecheckErrors ?? 0) + 1; }
    }
  }
  status.splitsFound = newSplits.length; status.splitsRewritten = 0;
  for (const sp of newSplits) {
    if (splits.some((x) => x.code === sp.code && x.date === sp.date)) continue;
    try {
      const hist = await getAll('/equities/bars/daily', { code: sp.code });
      const by = new Map(hist.map((r) => [r.Date, [r.Code, r.AdjO, r.AdjH, r.AdjL, r.AdjC, r.AdjVo, r.Va]]));
      let n = 0;
      for (const f of fs.readdirSync(path.join(DATA, 'prices'))) {
        const day = f.slice(0, 10); if (day >= sp.date || !by.has(day)) continue;
        const fp = path.join(DATA, 'prices', f); const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const k = arr.findIndex((x) => x[0] === sp.code); if (k < 0) continue;
        arr[k] = by.get(day); fs.writeFileSync(fp, JSON.stringify(arr)); n++;
      }
      splits.push({ ...sp, rewrittenDays: n, at: new Date().toISOString() });
      status.splitsRewritten++;
    } catch (e) { status.splitErrors = (status.splitErrors ?? 0) + 1; status.lastSplitError = String(e.message).slice(0, 120); }
  }
  fs.writeFileSync(splitFile, JSON.stringify(splits));
  status.splitsStored = splits.length;

  // 調整前の値段の取り直し（過去分。株価ファイルはあるのに raw が無い日だけ。時間の上限まで）
  status.rawBackfilled = 0;
  for (const d of days.slice().reverse()) {
    if (d > ymd(today)) continue;
    if (!fs.existsSync(path.join(DATA, 'prices', `${d}.json`)) || fs.existsSync(path.join(DATA, 'raw', `${d}.json`))) continue;
    if ((Date.now() - started) / 60000 > MAX_MIN) { status.stoppedBy = 'time'; break; }
    try {
      const rows = await getAll('/equities/bars/daily', { date: d.replaceAll('-', '') });
      if (rows.length) { fs.writeFileSync(path.join(DATA, 'raw', `${d}.json`), JSON.stringify(rows.map((r) => [r.Code, r.O, r.C]))); status.rawBackfilled++; }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 400 || e.status === 403)) continue;
      throw e;
    }
  }
  status.rawStored = fs.readdirSync(path.join(DATA, 'raw')).length;

  // 決算・業績修正・配当修正などの開示（財務情報）。開示日ごとに取得。空の日も記録して取り直さない
  const num = (v) => (v === '' || v == null ? null : Number(v));
  status.finsFetchedDays = 0;
  status.finsRows = 0;
  for (const r of cal.slice().reverse()) {
    const d = r.Date;
    if (d > ymd(today)) continue;
    const file = path.join(DATA, 'fins', `${d}.json`);
    // 直近4日は夕方以降の開示が後から増えるので毎回取り直す
    const recentFins = new Date(today);
    recentFins.setDate(recentFins.getDate() - 4);
    if (fs.existsSync(file) && d < ymd(recentFins)) continue;
    if (status.planRange && (d < status.planRange.slice(0, 10) || d > status.planRange.slice(11))) continue;
    if ((Date.now() - started) / 60000 > MAX_MIN) {
      status.stoppedBy = 'time';
      break;
    }
    try {
      const rows = await getAll('/fins/summary', { date: d.replaceAll('-', '') });
      const compact = rows.map((x) => ({
        dd: x.DiscDate, dt: x.DiscTime, no: x.DiscNo, c: x.Code, ty: x.DocType, pt: x.CurPerType, fy: x.CurFYEn, nfy: x.NxtFYEn,
        s: num(x.Sales), op: num(x.OP), np: num(x.NP), fs: num(x.FSales), fop: num(x.FOP), nfop: num(x.NxFOP),
        div: num(x.DivAnn), fdiv: num(x.FDivAnn), nfdiv: num(x.NxFDivAnn),
      }));
      fs.writeFileSync(file, JSON.stringify(compact));
      status.finsFetchedDays++;
      status.finsRows += compact.length;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 400 || e.status === 403)) {
        status.finsErrors = (status.finsErrors ?? 0) + 1;
        status.finsLastError = e.message;
        continue;
      }
      throw e;
    }
  }

  // 決算発表予定日（2026-11-18〜、オーナーの提案「前もって発表される日付の一覧」）：/fins/earnings-date を公表日（PubDate）ごとに取得。
  // 「いつの時点で、いつ決算をすると分かっていたか」が残るので、決算前の値動きを未来の情報なしで検証できる。空の日も記録して取り直さない（直近4日は毎回）
  fs.mkdirSync(path.join(DATA, 'earndate'), { recursive: true });
  status.earnDateFetched = 0;
  for (const r of cal.slice().reverse()) {
    const d = r.Date;
    if (d > ymd(today)) continue;
    const file = path.join(DATA, 'earndate', `${d}.json`);
    const recent = new Date(today); recent.setDate(recent.getDate() - 4);
    if (fs.existsSync(file) && d < ymd(recent)) continue;
    if (status.earnDateUnavailable) break;
    if ((Date.now() - started) / 60000 > MAX_MIN) { status.stoppedBy = 'time'; break; }
    try {
      const rows = await getAll('/fins/earnings-date', { date: d.replaceAll('-', '') });
      fs.writeFileSync(file, JSON.stringify(rows.map((x) => [x.Code, x.PubDate, x.SchDate, x.FQName, x.FYE])));
      status.earnDateFetched++;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 400 || e.status === 403)) {
        status.earnDateErrors = (status.earnDateErrors ?? 0) + 1;
        status.earnDateLastError = e.message;
        if (status.earnDateErrors >= 5 && !status.earnDateFetched) status.earnDateUnavailable = true; // プランで使えない時は打ち切り
        continue;
      }
      throw e;
    }
  }
  status.earnDateStored = fs.readdirSync(path.join(DATA, 'earndate')).length;
} catch (e) {
  status.stoppedBy = 'error';
  status.fatal = `${e.status ?? ''} ${e.message}`.trim();
}

fs.writeFileSync(unavailPath, JSON.stringify(unavailable));
writeStatus();
