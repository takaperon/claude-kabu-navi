# 状況ごとの売買ルール（日米共通の部品。2026-11-18 オーナー「機械的じゃなく、もっと細分化してルールを細かく」）
# rows: [{'half': 'train'|'test', 'A': {動き方: 損益率}, 'F': {特徴: 値}}]
# 「その時に分かること」（F）で状況を3分位×最大2つの組み合わせに分け、状況ごとに一番よかった動き方を【前半だけ】で選ぶ。
# 後半で「今のやり方（base）」と「全部同じ動き方で前半一番だったもの（oneRule）」より良いかを確かめる。
# stage1 の特徴（買う前に分かる）だけなら全部の動き方から、stage2 の特徴（買った後に分かる）を使う時は stage2 の動き方からだけ選ぶ。
# 前半で MINN 件未満の状況は選ばず base のまま。

def r4(x):
    return None if x is None else round(x, 4)

def playbook(rows, stage1, stage2, stage2_actions, minn=40, top_k=5, base='base'):
    tr = [r for r in rows if r['half'] == 'train']; te = [r for r in rows if r['half'] == 'test']
    if len(tr) < minn * 3 or not te:
        return {'n': {'train': len(tr), 'test': len(te)}, 'reason': '件数が足りない'}
    names = {**stage1, **stage2}
    allA = list(rows[0]['A'])

    def cuts(f):
        v = sorted(r['F'][f] for r in tr if r['F'].get(f) is not None)
        return (v[len(v) // 3], v[len(v) * 2 // 3]) if len(v) >= minn * 3 else None
    C = {f: cuts(f) for f in names}

    def cell(r, f):
        c, v = C.get(f), r['F'].get(f)
        if c is None or v is None: return None
        return 0 if v < c[0] else 1 if v < c[1] else 2

    def key_of(r, fs):
        return tuple(cell(r, f) for f in fs)

    def fit(fs, acts):
        g = {}
        for r in tr:
            k = key_of(r, fs)
            if None in k: continue
            g.setdefault(k, []).append(r)
        pick = {}
        for k, rs in g.items():
            if len(rs) < minn: continue
            pick[k] = max(acts, key=lambda a: sum(r['A'][a] for r in rs) / len(rs))
        return pick

    def apply(rs, fs, pick):
        out = []
        for r in rs:
            k = key_of(r, fs)
            out.append(r['A'][pick.get(k, base)] if None not in k else r['A'][base])
        return out

    cands = []
    feats = [f for f in names if C.get(f)]
    for i, f1 in enumerate(feats):
        for f2 in [None] + feats[i + 1:]:
            fs = (f1,) if f2 is None else (f1, f2)
            acts = stage2_actions if any(f in stage2 for f in fs) else allA
            pick = fit(fs, acts)
            a = apply(tr, fs, pick)
            cands.append((sum(a) / len(a), fs, pick))
    cands.sort(key=lambda c: -c[0])

    lv = ['低い', '中くらい', '高い']
    def desc(fs, pick):
        out = []
        for k in sorted(pick):
            a = pick[k]
            rt = [r for r in tr if key_of(r, fs) == k]; rs = [r for r in te if key_of(r, fs) == k]
            avg = lambda xs, act: r4(sum(r['A'][act] for r in xs) / len(xs)) if xs else None
            out.append({'state': '・'.join(f'{names[f]}が{lv[c]}' for f, c in zip(fs, k)), 'action': a,
                        'train': {'n': len(rt), 'avg': avg(rt, a), 'base': avg(rt, base)}, 'test': {'n': len(rs), 'avg': avg(rs, a), 'base': avg(rs, base)}})
        return out

    one = max(allA, key=lambda a: sum(r['A'][a] for r in tr))
    mean = lambda xs: r4(sum(xs) / len(xs)) if xs else None
    top = []
    for avg_tr, fs, pick in cands[:top_k]:
        a_te = apply(te, fs, pick)
        wins = [v for v in a_te if v > 0]; loss = [v for v in a_te if v <= 0]
        top.append({'features': [names[f] for f in fs], 'train': r4(avg_tr), 'test': mean(a_te), 'testWin': r4(len(wins) / len(a_te)),
                    'testAvgWin': mean(wins), 'testAvgLoss': mean(loss), 'cells': desc(fs, pick)})
    bte = [r['A'][base] for r in te]
    return {'note': '状況ごとに前半で一番よかった動き方を選び、後半で確かめる。前半の成績が良い順に上位（後半で選び直していない）。数字は1件あたりの平均損益率',
            'n': {'train': len(tr), 'test': len(te)}, 'minn': minn,
            'base': {'train': mean([r['A'][base] for r in tr]), 'test': mean(bte), 'testAvgWin': mean([v for v in bte if v > 0]), 'testAvgLoss': mean([v for v in bte if v <= 0])},
            'oneRule': {'action': one, 'train': mean([r['A'][one] for r in tr]), 'test': mean([r['A'][one] for r in te])},
            'cuts': {f: [r4(c[0]), r4(c[1])] for f, c in C.items() if c}, 'top': top}
