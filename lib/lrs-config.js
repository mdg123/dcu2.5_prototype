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
  // 개인정보 보호 게이트 — 평가/반 학생 표본이 이 값 미만이면 거시뷰에서 학생 식별 마스킹.
  //   ★ 정책(2026-06): 마스킹은 "소유 교사가 아닌" 관점(관리자 비소유·타반 교차뷰)에만 적용한다.
  //     담임/담당 교사(owner/teacher/co_teacher 멤버)는 자기 반 학생을 n 과 무관하게 실명으로 본다.
  //     → 실제 반이 8명이라 담임이 위험 학생을 못 보던 문제(기능 무력화) 해소.
  minSampleN: 10,
};

module.exports = { LRS_CONFIG };
