// 開示（J-Quants /fins/summary を縮めたもの）から売買の材料になるイベントを拾う。
// バックテストと仮想売買の両方で同じ判定を使う。
//   earn_up    : 会社の営業利益予想が、同じ事業年度の前回予想から+10%以上
//   earn_down  : 同じく-10%以下
//   guidance   : 本決算で来期の営業利益予想が今期実績の+20%以上
//   div_up     : 年間配当予想が前回予想から+5%以上、または本決算で来期配当予想が今期実績の+5%以上
//   results    : 決算短信そのもの（比較用）
export function detectEvents(rows) {
  const sorted = rows.slice().sort((a, b) => (a.dd + (a.dt ?? '')).localeCompare(b.dd + (b.dt ?? '')));
  const lastFop = new Map(), lastDiv = new Map();
  const out = [];
  const push = (r, kind, score, detail) => out.push({ c: r.c, dd: r.dd, dt: r.dt ?? '', kind, score, detail });
  for (const r of sorted) {
    const isResults = /FinancialStatements/.test(r.ty ?? '');
    const upd = (fy, v) => {
      if (!fy || v == null) return;
      const k = r.c + '|' + fy;
      const prev = lastFop.get(k);
      lastFop.set(k, v);
      if (prev == null || !(prev > 0)) return;
      const ch = v / prev - 1;
      if (ch >= 0.1) push(r, 'earn_up', ch, { fy, prev, now: v });
      if (ch <= -0.1) push(r, 'earn_down', -ch, { fy, prev, now: v });
    };
    upd(r.fy, r.fop);
    upd(r.nfy, r.nfop);
    if (isResults && r.pt === 'FY' && r.op > 0 && r.nfop != null && r.nfop / r.op - 1 >= 0.2) {
      push(r, 'guidance', r.nfop / r.op - 1, { op: r.op, nfop: r.nfop });
    }
    const updDiv = (fy, v) => {
      if (!fy || v == null) return;
      const k = r.c + '|' + fy;
      const prev = lastDiv.get(k);
      lastDiv.set(k, v);
      if (prev > 0 && v / prev - 1 >= 0.05) push(r, 'div_up', v / prev - 1, { fy, prev, now: v });
    };
    updDiv(r.fy, r.fdiv);
    updDiv(r.nfy, r.nfdiv);
    if (isResults && r.pt === 'FY' && r.div > 0 && r.nfdiv != null && r.nfdiv / r.div - 1 >= 0.05) {
      push(r, 'div_up', r.nfdiv / r.div - 1, { prev: r.div, now: r.nfdiv, nextYear: true });
    }
    if (isResults) push(r, 'results', 0, {});
  }
  return out;
}
