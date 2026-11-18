# 日本株の場中の足を yfinance（Yahoo!）で集める（2026-11-18〜）
# 1回300銘柄まで（Yahoo!に負担をかけない・止められないように）。1時間足は実際には約3年（2023-11〜）取れたので、買う日が1080日以内のものを集める
# 対象：reports/jp-events.json の増配の「買う日」。1時間足は約3年（730日）まで、5分足は直近60日まで遡れる。
# 保存は data-jp-intraday/{4桁}.json に「買う日から10営業日分」だけ（{'60m': {日付: [[時刻, o,h,l,c,v],...]}, '5m': {...}}）。
# データ本体は暗号化キャッシュだけ（コミットしない）。ログには件数だけ出す
import json, os, sys, time, datetime as dt
import logging
logging.disable(logging.CRITICAL)
import yfinance as yf

DIR = 'data-jp-intraday'
os.makedirs(DIR, exist_ok=True)
MAX = int(os.environ.get('MAX_TICKERS', '300'))
ev = json.load(open('jp-events.json'))['list']
today = dt.date.today()
by = {}
for x in ev:
    by.setdefault(x['c'], []).append(x['e'])

def load(c):
    p = os.path.join(DIR, c + '.json')
    return json.load(open(p)) if os.path.exists(p) else {'60m': {}, '5m': {}, 'done': {}}

def windows(dates, bars):
    # 買う日から10営業日分（足のある日で数える）
    days = sorted(set(bars.keys()))
    keep = set()
    for e in dates:
        after = [d for d in days if d >= e][:10]
        before = [d for d in days if d < e][-5:]  # 前の5日（出来高の比べ用）
        keep.update(after); keep.update(before)
    return {d: bars[d] for d in sorted(keep)}

def fetch(c, iv, per):
    df = yf.Ticker(c + '.T').history(interval=iv, period=per, auto_adjust=False, prepost=False)
    out = {}
    for ts, r in df.iterrows():
        d = str(ts)[:10]
        out.setdefault(d, []).append([str(ts)[11:16], float(r['Open']), float(r['High']), float(r['Low']), float(r['Close']), int(r['Volume'])])
    return out

stat = {'events': len(ev), 'tickers': len(by), 'fetched': 0, 'errors': 0, 'empty': 0, 'skipped': 0}
n = 0
for c, ds in sorted(by.items()):
    st = load(c)
    need60 = [e for e in ds if e not in st['done'].get('60m', []) and e >= (today - dt.timedelta(days=1080)).isoformat() and e <= (today - dt.timedelta(days=16)).isoformat()]
    need5 = [e for e in ds if e not in st['done'].get('5m', []) and e >= (today - dt.timedelta(days=58)).isoformat() and e <= today.isoformat()]
    if not need60 and not need5:
        stat['skipped'] += 1
        continue
    if n >= MAX:
        continue
    n += 1
    try:
        for iv, per, need in (('60m', '730d', need60), ('5m', '60d', need5)):
            if not need:
                continue
            bars = fetch(c, iv, per)
            time.sleep(0.6)
            if not bars:
                stat['empty'] += 1
                st['done'].setdefault(iv, []).extend(need)  # 上場廃止などで取れないものは取り直さない
                continue
            w = windows(need, bars)
            st[iv].update(w)
            # 10営業日分そろった（または5分足なら当日分がある）ものを「取得済み」に
            done = st['done'].setdefault(iv, [])
            for e in need:
                got = [d for d in w if d >= e]
                if iv == '60m' or (iv == '5m' and e in w and e < today.isoformat()):
                    done.append(e)
        json.dump(st, open(os.path.join(DIR, c + '.json'), 'w'))
        stat['fetched'] += 1
    except Exception as ex:
        stat['errors'] += 1
        stat['lastError'] = type(ex).__name__ + ': ' + str(ex)[:100]
        if 'Rate' in type(ex).__name__ or '429' in str(ex):
            stat['rateLimited'] = True
            break
left = 0
for c, ds in by.items():
    st = load(c)
    left += sum(1 for e in ds if e not in st['done'].get('60m', []) and e >= (today - dt.timedelta(days=1080)).isoformat() and e <= (today - dt.timedelta(days=16)).isoformat())
stat['remaining60m'] = left
stat['stored'] = len([f for f in os.listdir(DIR) if f.endswith('.json')])
stat['at'] = dt.datetime.utcnow().isoformat(timespec='seconds') + 'Z'
json.dump(stat, open('jp-collect-status.json', 'w'), ensure_ascii=False)
print(json.dumps(stat, ensure_ascii=False))
