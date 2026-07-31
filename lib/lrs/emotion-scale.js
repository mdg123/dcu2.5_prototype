// lib/lrs/emotion-scale.js
// ─────────────────────────────────────────────────────────────────────────────
// [P0 시스템성] 감정 분류 단일 출처(SSOT).
//   정본: 보고서/LRS_지표_정본사전_v1.md §2-B ("emotion_score 사용 금지, 텍스트 어휘가 정본")
//
// 배경(실측 결함):
//   attendance.emotion_score 는 한 컬럼에 세 스케일이 공존한다(실측 532행).
//     0~1 196행(0.12~1) · 1~3 208행(2~3) · 8.5~9.5 12행
//   쓰기 경로가 3개라서 그렇다:
//     scripts/seed-balance.js → 0~1 · scripts/seed-demo-social.js → 1~3 · routes/growth.js → 1~10
//   같은 감정 코드가 스케일을 넘나든다: happy 0.6~9.5 / calm 0.4~0.91 / great 0.6~0.95
//
//   ☠ 그래서 "score < 1.5 → 부정" 같은 단일 임계 비교는 어느 스케일에도 맞지 않는다.
//     0~1 로 저장된 great·calm·happy·good·excited 가 전부 '부정'으로 뒤집힌다.
//     오분류가 전부 긍정→부정 한 방향이라 부정 그룹이 통째로 오염된다(실측 138/524행 = 26.3%).
//     이것이 교사 화면 "부정 76%" · 위험카드 "부정 비율 90%" · 정서-참여 "적신호 5명" 의 소재다.
//
// 정본 규칙:
//   1순위 attendance.emotion 텍스트 어휘   ← 정본(스케일 문제 없음)
//   2순위 텍스트가 없을 때만 emotion_score 폴백 ← 실데이터 0건 경로(방어적으로만 유지)
//
//   ★ 감정 판정에 emotion_score 임계 비교를 '신규 도입 금지'.
//   ★ 새 감정 어휘 추가 시 반드시 아래 사전에 등록한다.
//     미등록 어휘는 자동 '긍정'이 되어 조용한 오분류가 된다(정본사전 §2-B-3 규칙2).
// ─────────────────────────────────────────────────────────────────────────────

// 정본 어휘 사전(정본사전 §2-B-3 표).
const NEGATIVE_EMOTIONS = new Set(['angry', 'anxious', 'sad', 'frustrated', 'tired', 'bad']);
const NEUTRAL_EMOTIONS = new Set(['neutral', 'ok', 'soso', 'so-so', 'normal', '보통']);

/**
 * 감정 → 그룹 키. 텍스트 우선, 텍스트 없을 때만 score 폴백.
 * @returns {'positive'|'neutral'|'negative'|null} 감정 정보가 아예 없으면 null(집계에서 제외 — 0 채움 금지).
 */
function emotionGroupKey(emotion, emotionScore) {
  const t = String(emotion || '').trim().toLowerCase();
  if (t) {
    if (NEGATIVE_EMOTIONS.has(t)) return 'negative';
    if (NEUTRAL_EMOTIONS.has(t)) return 'neutral';
    return 'positive';
  }
  // 텍스트가 없을 때만 점수 폴백. 실데이터 0건 경로이므로 1~3 가정을 그대로 둔다.
  if (emotionScore != null && Number.isFinite(Number(emotionScore))) {
    const sc = Number(emotionScore);
    if (sc >= 2.5) return 'positive';
    if (sc >= 1.5) return 'neutral';
    return 'negative';
  }
  return null;
}

/**
 * 부정 여부(이진). 감정 정보 없으면 null → 호출부는 분모에서 제외해야 한다.
 * @returns {boolean|null}
 */
function isNegativeEmotion(emotion, emotionScore) {
  const k = emotionGroupKey(emotion, emotionScore);
  return k == null ? null : k === 'negative';
}

/**
 * 부정도 가중치(0~1) — 위험점수 s_emotion 처럼 연속값이 필요한 곳에서 사용.
 *   negative 1 · neutral 0.5 · positive 0
 *   (구 구현의 1~3 스케일 (3-score)/2 매핑과 동일 의미: 1→1, 2→0.5, 3→0)
 * @returns {number|null} 감정 정보 없으면 null(분모 제외).
 */
function emotionNegWeight(emotion, emotionScore) {
  const k = emotionGroupKey(emotion, emotionScore);
  if (k == null) return null;
  if (k === 'negative') return 1;
  if (k === 'neutral') return 0.5;
  return 0;
}

module.exports = {
  NEGATIVE_EMOTIONS, NEUTRAL_EMOTIONS,
  emotionGroupKey, isNegativeEmotion, emotionNegWeight,
};
