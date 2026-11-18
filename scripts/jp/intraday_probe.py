# 日本株の分足が yfinance（Yahoo!）で取れるかの確認（2026-11-18〜）。値段は出さず、本数・期間・欠けだけを出す
import json, time, collections
import yfinance as yf

TICKERS = ['7203.T', '6758.T', '8306.T', '9984.T', '4755.T', '3197.T', '2702.T', '7172.T']  # 大型〜中小型を混ぜる
TESTS = [('1m', '7d'), ('5m', '60d'), ('15m', '60d'), ('60m', '730d'), ('1d', '5y')]
out = {'tests': []}
for t in TICKERS:
    for iv, per in TESTS:
        r = {'t': t, 'interval': iv, 'period': per}
        try:
            df = yf.Ticker(t).history(interval=iv, period=per, auto_adjust=False, prepost=False)
            r['bars'] = int(len(df))
            if len(df):
                idx = df.index
                r['from'] = str(idx[0])[:16]; r['to'] = str(idx[-1])[:16]
                days = collections.Counter(str(x)[:10] for x in idx)
                r['days'] = len(days)
                r['barsPerDay'] = round(len(df) / len(days), 1)
                r['firstBarTime'] = collections.Counter(str(x)[11:16] for x in idx if True).most_common(1)[0][0] if iv != '1d' else None
                r['times'] = sorted(set(str(x)[11:16] for x in idx))[:3] + ['…'] + sorted(set(str(x)[11:16] for x in idx))[-3:] if iv != '1d' else None
                r['zeroVolume'] = int((df['Volume'] == 0).sum())
        except Exception as e:
            r['error'] = type(e).__name__ + ': ' + str(e)[:120]
        out['tests'].append(r)
        time.sleep(1.5)
ok = sum(1 for r in out['tests'] if r.get('bars'))
out['summary'] = {'ok': ok, 'total': len(out['tests'])}
json.dump(out, open('jp-intraday-probe.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(out['summary']))
for r in out['tests']:
    print(json.dumps({k: r.get(k) for k in ('t', 'interval', 'bars', 'days', 'barsPerDay', 'from', 'to', 'error')}, ensure_ascii=False))
