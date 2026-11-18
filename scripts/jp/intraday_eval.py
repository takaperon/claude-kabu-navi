# 増配デイトレを「場中の足」で売り方比べ（2026-11-18〜、オーナーの指示「気配が高まったら売る・買うをできるように」）
# 買い：買う日の最初の足の始値（＝寄り付き）。滑り 0.1%/片道。損切り・逃げの売りは成行なのでさらに 0.5% 不利とする。
# 判断は「足が終わった時点」で行い、次の足の始値で売る（先の値段を見ない）。利益確定の指値は足の高値が届けばその値で売れたとする。
# 同じ足で利確と損切りの両方に届いたら損切りが先（悪い方に倒す）。
# 期間：1時間足は約3年。前の60%を学習、後の40%をテスト。公開は集計値だけ（reports-out/jp-intraday.json）
import json, os, statistics as stt
import logging
logging.disable(logging.CRITICAL)

DIR = 'data-jp-intraday'
SLIP, BAD = 0.001, 0.005
ev = json.load(open('jp-events.json'))['list']
cache = {}
def bars(c, iv):
    if c not in cache:
        p = os.path.join(DIR, c + '.json')
        cache[c] = json.load(open(p)) if os.path.exists(p) else {}
    return cache[c].get(iv, {})

def r4(x):
    return None if x is None else round(x, 4)
def summ(a):
    if not a: return {'n': 0}
    s = sorted(a)
    return {'n': len(a), 'avg': r4(sum(a) / len(a)), 'med': r4(s[len(a) // 2]), 'win': r4(sum(1 for x in a if x > 0) / len(a)), 'p10': r4(s[len(a) // 10]), 'p90': r4(s[len(a) * 9 // 10])}

def run(B, rule, dt=None):
    """B: その日の足 [[時刻,o,h,l,c,v],...]。戻り値：損益率（買わなければ None）
    引けまで持つ時は J-Quants の正式な終値（dt から逆算）を使う。Yahoo!の場中の足には15:30の引けの板寄せが入っていないため"""
    o0 = B[0][1]
    CL = o0 * (1 + dt) * (1 + SLIP) / (1 - SLIP) if dt is not None else B[-1][4]
    kind = rule['kind']
    if kind == 'confirm':  # 最初の足が上げて終わった時だけ、次の足の始値で買う
        if len(B) < 2 or not (B[0][4] > B[0][1] * (1 + rule['a'])): return None
        entry = B[1][1] * (1 + SLIP)
        return CL * (1 - SLIP) / entry - 1
    entry = o0 * (1 + SLIP)
    sell = lambda px, bad=False: px * (1 - SLIP) * ((1 - BAD) if bad else 1) / entry - 1
    hi = o0
    for k, (t, o, h, l, c, v) in enumerate(B):
        last = k == len(B) - 1
        if kind == 'base':
            pass
        elif kind == 'tpsl':
            tp, sl = rule.get('tp'), rule.get('sl')
            if sl and l <= o0 * (1 - sl): return sell(min(o, o0 * (1 - sl)), True)
            if tp and h >= o0 * (1 + tp): return sell(max(o, o0 * (1 + tp)))
        elif kind == 'trail':  # 場中の高値から z% 下がったら売る（高値は終わった足まで）
            z = rule['z']
            if l <= hi * (1 - z): return sell(min(o, hi * (1 - z)), True)
            hi = max(hi, h)
        elif kind == 'firstbar':  # 最初の足が a% 以上下げて終わったら、次の足の始値で逃げる
            if k == 0 and c < o0 * (1 - rule['a']) and len(B) > 1: return sell(B[1][1], True)
        elif kind == 'morning':  # 前場の終わり（11時台の足の終値）で売る。onlyUp なら買値より上の時だけ
            if t < '12:00' and (last or B[k + 1][0] >= '12:00'):
                if last: return sell(CL)
                if not rule.get('onlyUp') or c * (1 - SLIP) > entry: return sell(c)
        elif kind == 'fade':  # 一度 +a% まで上げた後、買値まで戻ったら売る（建値の逃げ）
            if hi >= o0 * (1 + rule['a']) and l <= o0: return sell(min(o, o0), True)
            hi = max(hi, h)
        if last: return sell(CL)
    return None

RULES = {'base': {'kind': 'base'}}
for tp in (None, 0.02, 0.03, 0.05, 0.08):
    for sl in (None, 0.02, 0.03, 0.05):
        if tp or sl: RULES[f'tp{int(tp*100) if tp else "-"}_sl{int(sl*100) if sl else "-"}'] = {'kind': 'tpsl', 'tp': tp, 'sl': sl}
for z in (0.02, 0.03, 0.05): RULES[f'trail{int(z*100)}'] = {'kind': 'trail', 'z': z}
for a in (0.0, 0.01, 0.02, 0.03): RULES[f'firstbar_down{a*100:g}'] = {'kind': 'firstbar', 'a': a}
for a in (0.02, 0.03, 0.05): RULES[f'fade{int(a*100)}'] = {'kind': 'fade', 'a': a}
RULES['morning'] = {'kind': 'morning'}
RULES['morning_onlyUp'] = {'kind': 'morning', 'onlyUp': True}
for a in (0.0, 0.01): RULES[f'confirm{a*100:g}'] = {'kind': 'confirm', 'a': a}
NAME = {'base': '寄りで買って引けで売る（今のやり方）', 'morning': '前場の終わりで売る', 'morning_onlyUp': '前場の終わりに買値より上なら売る（下なら引けまで）',
        'confirm0': '最初の1時間が上げて終わった時だけ買う（次の足の始値）', 'confirm1': '最初の1時間が+1%以上で終わった時だけ買う'}

def evaluate(iv):
    rows = []
    for x in ev:
        B = bars(x['c'], iv).get(x['e'])
        if not B or len(B) < 3 or not B[0][1] > 0: continue
        prev = [d for d in sorted(bars(x['c'], iv)) if d < x['e']][-5:]
        pv = [bars(x['c'], iv)[d][0][5] for d in prev if bars(x['c'], iv)[d]]
        rv = B[0][5] / (sum(pv) / len(pv)) if pv and sum(pv) > 0 else None  # 最初の足の出来高 ÷ 前5日の最初の足の平均
        rows.append({'x': x, 'B': B, 'rv': rv})
    rows.sort(key=lambda r: r['x']['e'])
    if not rows: return {'n': 0}
    cut = int(len(rows) * 0.6)
    for k, r in enumerate(rows): r['half'] = 'train' if k < cut else 'test'
    # データの確かめ：場中の足で作った「引けで売る」と、J-Quants の日足の dt との差
    diffs = [abs(run(r['B'], RULES['base'], None) - r['x']['dt']) for r in rows if r['x'].get('dt') is not None]
    res = {'n': len(rows), 'periods': {'train': [rows[0]['x']['e'], rows[cut - 1]['x']['e']] if cut else None, 'test': [rows[cut]['x']['e'], rows[-1]['x']['e']] if cut < len(rows) else None},
           'check': {'note': 'Yahoo!の場中の足の最後の値と、J-Quantsの正式な終値で作った損益率の差（引けの板寄せが足に入っていないため）。比べる時は引けまで持つ分は正式な終値を使う', 'n': len(diffs), 'medAbsDiffVsDaily': r4(stt.median(diffs)) if diffs else None, 'over1pct': r4(sum(1 for d in diffs if d > 0.01) / len(diffs)) if diffs else None},
           'rules': {}}
    for key, rule in RULES.items():
        o = {'name': NAME.get(key)}
        for h in ('train', 'test'):
            got = [run(r['B'], rule, r['x'].get('dt')) for r in rows if r['half'] == h]
            base = [run(r['B'], RULES['base'], r['x'].get('dt')) for r in rows if r['half'] == h]
            traded = [g for g in got if g is not None]
            # 1件あたり（買わなかった件は0として）＝ 同じ件数で今のやり方と比べられる
            per = [g if g is not None else 0.0 for g in got]
            o[h] = {**summ(traded), 'perEvent': r4(sum(per) / len(per)) if per else None, 'vsBase': r4((sum(per) - sum(base)) / len(per)) if per else None, 'tradedRate': r4(len(traded) / len(got)) if got else None}
        res['rules'][key] = o
    # 「気配」：最初の足の出来高の多さ・寄り付きの上げで分けた今のやり方の成績（買う前に分かる・最初の1時間で分かる）
    grp = {}
    for r in rows:
        b = run(r['B'], RULES['base'], r['x'].get('dt'))
        keys = []
        if r['rv'] is not None: keys.append('最初の1時間の出来高 ' + ('3倍以上' if r['rv'] >= 3 else '1.5〜3倍' if r['rv'] >= 1.5 else '1.5倍未満'))
        g = r['x'].get('gap')
        if g is not None: keys.append('寄り付き ' + ('+3%以上' if g >= 0.03 else '0〜+3%' if g >= 0 else 'マイナス'))
        fb = r['B'][0][4] / r['B'][0][1] - 1
        keys.append('最初の1時間 ' + ('+1%以上' if fb >= 0.01 else '-1%以下' if fb <= -0.01 else '±1%以内'))
        # 最初の1時間の後に買った場合とは違い、ここは「寄りで買った人」の成績を最初の1時間の様子で分けたもの。その後（2本目の始値〜引け）の値動きも出す
        rest = (r['B'][0][1] * (1 + r['x']['dt']) * (1 + SLIP) / (1 - SLIP)) / r['B'][1][1] - 1 if len(r['B']) > 1 and r['x'].get('dt') is not None else None
        for k in keys:
            gg = grp.setdefault(k, {'train': [], 'test': [], 'restTrain': [], 'restTest': []})
            gg[r['half']].append(b)
            if rest is not None and k.startswith('最初の1時間'): gg['restTrain' if r['half'] == 'train' else 'restTest'].append(rest - 2 * SLIP)
    res['groups'] = {k: {'train': summ(v['train']), 'test': summ(v['test']), 'after1h_train': summ(v['restTrain']), 'after1h_test': summ(v['restTest'])} for k, v in sorted(grp.items())}
    return res

out = {'ok': True, 'note': '増配の翌営業日に寄りで買う。売り方の比較（場中の足、Yahoo!のデータ）。vsBase＝今のやり方（引けで売る）との1件あたりの差。perEvent は買わなかった件を0として平均', '60m': evaluate('60m'), '5m': evaluate('5m'), 'note5m': '5分足では「最初の足」は最初の5分'}
os.makedirs('reports-out', exist_ok=True)
json.dump(out, open('reports-out/jp-intraday.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps({'ok': True, 'n60m': out['60m'].get('n'), 'n5m': out['5m'].get('n')}))
