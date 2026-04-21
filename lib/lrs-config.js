// lib/lrs-config.js
// 다채움 LRS 관련 튜닝 가능한 상수 집합. 매직넘버를 한 곳에서 관리한다.

'use strict';

const LRS_CONFIG = {
  // /api/lrs/insights 스냅샷 — 학생 주간 학습 목표(분)
  weeklyTargetMin: 300,
  // 경고 카드 — 최근 N일 학습 기록이 없으면 no_data 라벨 처리
  inactiveWarnDays: 3,
  // CSV export 한도
  csvExportLimit: 10000,
  // session_id 생성 시 bytes (hex 문자열 길이 = 2 * bytes)
  //   - VARCHAR(40) 스키마에 충분, 16 bytes(32 hex) 권장
  sessionIdBytes: 16,
};

module.exports = { LRS_CONFIG };
