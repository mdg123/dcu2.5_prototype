// lib/analytics/regression.js
// ─────────────────────────────────────────────────────────────────────────────
// 순수 함수 통계 유틸 — 간이 최소제곱(OLS) 1차 선형회귀.
//   기획서: 작업지시서/LRS_분석예측_강화_기획서.md §B-2(추세)·§C-3.
//   "가짜 ML 금지(P1)" — 결정론·설명가능한 회귀만. 외부 의존 0 · 테스트 박제 용이.
//
//   ols(points) : [{x,y}] (또는 [[x,y]]) → { slope, intercept, r2, n }
//     slope     : 단위 x 당 y 변화량(%p/주 등). 분산 0(점 1개·동일 x)면 0.
//     intercept : y 절편.
//     r2        : 결정계수 0~1 (총변동 0이면 1로 본다 — 완전 적합/변동 없음).
//     n         : 사용된 유효 점 수.
//   predict(model, x) : 회귀선 외삽값.
// ─────────────────────────────────────────────────────────────────────────────

/** 입력 정규화: {x,y} 또는 [x,y] 배열을 받아 유한수 점만 추린다. */
function _normalize(points) {
  const out = [];
  if (!Array.isArray(points)) return out;
  for (const p of points) {
    let x, y;
    if (Array.isArray(p)) { x = p[0]; y = p[1]; }
    else if (p && typeof p === 'object') { x = p.x; y = p.y; }
    else continue;
    x = Number(x); y = Number(y);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/**
 * 최소제곱 1차 회귀.
 * @param {Array} points [{x,y}] 또는 [[x,y]]
 * @returns {{slope:number,intercept:number,r2:number,n:number}}
 */
function ols(points) {
  const pts = _normalize(points);
  const n = pts.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0, n: 0 };
  if (n === 1) return { slope: 0, intercept: pts[0][1], r2: 0, n: 1 };

  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  const mx = sx / n, my = sy / n;

  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    const dx = x - mx, dy = y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }

  // x 분산 0 (모든 x 동일) → 기울기 정의 불가 → slope 0, 절편=ȳ.
  if (sxx === 0) return { slope: 0, intercept: my, r2: 0, n };

  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  // R² = 1 - SS_res/SS_tot. 총변동(syy)=0 이면 모든 y 동일 → 변동 없음 → R²=1.
  let r2;
  if (syy === 0) {
    r2 = 1;
  } else {
    let ssRes = 0;
    for (const [x, y] of pts) {
      const yhat = slope * x + intercept;
      const e = y - yhat;
      ssRes += e * e;
    }
    r2 = 1 - ssRes / syy;
    if (!Number.isFinite(r2)) r2 = 0;
    if (r2 < 0) r2 = 0;       // 수치 오차로 약간 음수면 0 클램프
    if (r2 > 1) r2 = 1;
  }

  return { slope, intercept, r2, n };
}

/** 회귀 모델로 x 지점 외삽(예측)값. */
function predict(model, x) {
  if (!model || !Number.isFinite(Number(x))) return null;
  const v = model.slope * Number(x) + model.intercept;
  return Number.isFinite(v) ? v : null;
}

module.exports = { ols, predict };
