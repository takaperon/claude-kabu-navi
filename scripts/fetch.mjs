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
fromDefault.setFullYear(today.getFullYear() - 2);
fromDefault.setDate(fromDefault.getDate() - 7);

const unavailPath = path.join(DATA, 'unavailable.json');
const unavailable = fs.existsSync(unavailPath) ? JSON.parse(fs.readFileSync(unavailPath, 'utf8')) : {};
const recentLimit = new Date(today);
recentLimit.setDate(recentLimit.getDate() - 130); // 12週間遅延の境目付近は毎回取り直す

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
    const m = e instanceof ApiError && e.status === 400 && e.message.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
    if (!m) throw e;
    status.planRange = `${m[1]}~${m[2]}`;
    cal = await getAll('/markets/calendar', { from: m[1], to: m[2] });
  }
  // HolDiv: 0=非営業日, 1=営業日, 2=半日立会, 3=非営業日（祝日取引あり）
  const days = cal.filter((r) => r.HolDiv === '1' || r.HolDiv === '2').map((r) => r.Date);
  status.calendarTradingDays = days.length;

  // 新しい日から順に取る（途中で止まっても最近のデータが揃うように）
  for (const d of days.slice().reverse()) {
    if (d > ymd(today)) continue;
    const file = path.join(DATA, 'prices', `${d}.json`);
    if (fs.existsSync(file)) continue;
    if (unavailable[d] && d < ymd(recentLimit)) {
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
      fs.writeFileSync(file, JSON.stringify(compact));
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

  // 決算・業績修正・配当修正などの開示（財務情報）。開示日ごとに取得。空の日も記録して取り直さない
  const num = (v) => (v === '' || v == null ? null : Number(v));
  status.finsFetchedDays = 0;
  status.finsRows = 0;
  for (const r of cal.slice().reverse()) {
    const d = r.Date;
    if (d > ymd(today)) continue;
    const file = path.join(DATA, 'fins', `${d}.json`);
    if (fs.existsSync(file)) continue;
    if (status.planRange && (d < status.planRange.slice(0, 10) || d > status.planRange.slice(11))) continue;
    if ((Date.now() - started) / 60000 > MAX_MIN) {
      status.stoppedBy = 'time';
      break;
    }
    try {
      const rows = await getAll('/fins/summary', { date: d.replaceAll('-', '') });
      const compact = rows.map((x) => ({
        dd: x.DiscDate, dt: x.DiscTime, c: x.Code, ty: x.DocType, pt: x.CurPerType, fy: x.CurFYEn, nfy: x.NxtFYEn,
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
} catch (e) {
  status.stoppedBy = 'error';
  status.fatal = `${e.status ?? ''} ${e.message}`.trim();
}

fs.writeFileSync(unavailPath, JSON.stringify(unavailable));
writeStatus();
