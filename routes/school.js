// routes/school.js
// ─────────────────────────────────────────────────────────────────────────────
// 학교 관리자 대시보드(교장·교감) — /api/school/* (P0-2~8).
//
//   기획서: 작업지시서/학교관리자_대시보드_기획서.md (§3 역할/스코프/개인정보, §4 지표, §7 P0)
//   권한·스코프: middleware/auth.requireSchoolScope
//     - principal: 자기 school_name 학교만(req.schoolScope 주입). 타 학교 차단(스코프 고정).
//     - admin    : 전체 거시(?school=NAME 으로 점검 가능). 비principal/비admin → 403.
//
//   개인정보(§3-2):
//     - 기본 집계·익명. 위기/미달 "명단"은 실명 허용(principal=자기학교 / admin 거버넌스).
//     - 교과×학급 n<10 교차드릴은 카운트만(개별 미노출) — db/lrs-school 이 crossMasked 플래그.
//     - principal 이 실명 명단을 연 경우 audit 로그 1건(learning_logs) 적재.
//
//   집계는 전부 db/lrs-school(기존 mastery/analytics 재사용). 라우트는 권한·실명·audit·HTTP 만.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { requireAuth, requireSchoolScope } = require('../middleware/auth');
const school = require('../db/lrs-school');
const { logLearningActivity } = require('../db/learning-log-helper');

// 기간 파서(거시 단순) — period=7d|30d|90d → 일수.
function daysOf(req, def = 30) {
  const raw = String(req.query.period || `${def}d`).replace('d', '');
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return def;
  return Math.min(n, 365);
}

// 실명 열람 권한: principal(자기학교) 또는 admin. 위기/미달 명단에만 적용.
//   학교 전체/학년 집계는 표본이 커 마스킹 불요(수치) — 명단 카드에서만 실명 게이트.
function canSeeNames(req) {
  if (!req.user) return false;
  return req.user.role === 'principal' || req.user.role === 'admin';
}

// 익명 라벨("학생 A"…) — 마스킹 시 일관 라벨.
function maskLabel(i) { return `학생 ${String.fromCharCode(65 + (i % 26))}`; }

// principal 실명 명단 열람 audit — learning_logs 1건(거버넌스 추적). best-effort(실패 무시).
function auditNameAccess(req, kind, count) {
  try {
    logLearningActivity({
      userId: req.user.id,
      activityType: 'governance',
      verb: 'viewed',
      targetType: 'school-roster',
      targetId: String(req.schoolScope && req.schoolScope.schoolName || ''),
      objectType: 'roster',
      objectId: kind,
      sourceService: 'lrs',
      metadata: { kind, count, school: req.schoolScope && req.schoolScope.schoolName, role: req.user.role },
    });
  } catch (_) { /* audit 실패는 응답을 막지 않는다 */ }
}

// 공통 스코프 메타(응답 헤더부) — FE 가 "우리 학교 / 전체" 라벨·표본을 표기.
function scopeMeta(req) {
  const s = req.schoolScope || {};
  return {
    school: s.schoolName || null,
    isAdminMacro: !!s.isAdmin && !s.schoolName,
    studentCount: s.studentCount || 0,
    staffCount: s.staffCount || 0,
  };
}

// admin 전체 거시(school 미지정)에서 학교 스코프가 필요한 엔드포인트 가드.
//   전국을 학교 1장에 욱여넣지 않는다 — admin 은 ?school= 로 학교를 지정해야 학교 화면을 본다.
function needSchool(req, res) {
  const s = req.schoolScope || {};
  if (!s.schoolName) {
    res.status(400).json({
      success: false,
      message: 'admin 은 ?school=학교명 을 지정해야 학교 단위 화면을 볼 수 있습니다. (전체 거시는 /api/lrs/stats/* 사용)',
      hint: 'principal 계정은 자동으로 자기 학교 스코프가 적용됩니다.',
    });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-2 GET /api/school/overview — 한눈요약 KPI + 규칙기반 자동 인사이트.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/overview', requireAuth, requireSchoolScope, (req, res) => {
  try {
    if (!needSchool(req, res)) return;
    const scope = req.schoolScope;
    const overview = school.getOverviewKpis(scope);
    const achievement = school.getAchievement(scope);
    const safety = school.getSafety(scope);
    const insights = school.buildInsights({ overview, achievement, safety });

    res.json({
      success: true,
      scope: scopeMeta(req),
      overview,
      insights,
      footnote: '"이용자수"는 활동 발생 기준입니다(로그인 세션 로그 보강 전). 출석·정서는 표본이 작아 참고용입니다.',
    });
  } catch (err) {
    console.error('[SCHOOL] /overview error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-3a GET /api/school/enrollment — 가입자수(role·grade별).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/enrollment', requireAuth, requireSchoolScope, (req, res) => {
  try {
    const data = school.getEnrollment(req.schoolScope);
    res.json({ success: true, scope: scopeMeta(req), ...data,
      note: data.byRole.parent ? null : '학부모 가입 데이터는 적재 전입니다(준비 중).' });
  } catch (err) {
    console.error('[SCHOOL] /enrollment error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-3b GET /api/school/access — 일자별 이용자(활동기준)·DAU/WAU/MAU·시간대.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/access', requireAuth, requireSchoolScope, (req, res) => {
  try {
    if (!needSchool(req, res)) return;
    const data = school.getAccess(req.schoolScope, { days: daysOf(req, 30) });
    res.json({ success: true, scope: scopeMeta(req), ...data,
      label: '이용자수(활동 기준)' });
  } catch (err) {
    console.error('[SCHOOL] /access error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-4 GET /api/school/pages — 페이지(서비스)별 접속. 내부7 / 외부4(external).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pages', requireAuth, requireSchoolScope, (req, res) => {
  try {
    if (!needSchool(req, res)) return;
    const data = school.getPages(req.schoolScope, { days: daysOf(req, 30) });
    res.json({ success: true, scope: scopeMeta(req), ...data });
  } catch (err) {
    console.error('[SCHOOL] /pages error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-5 GET /api/school/achievement — 학년×교과 도달률·취약Top10·추세·격차·미도달자수.
//   교과×학급 n<10 교차드릴 셀은 crossMasked=true → reachedRate 만, 개별 비노출(카운트만).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/achievement', requireAuth, requireSchoolScope, (req, res) => {
  try {
    if (!needSchool(req, res)) return;
    const data = school.getAchievement(req.schoolScope);
    // n<10 교차 셀: 도달률은 분포 통계로 유지하되, 개별 식별 가능한 정보는 본래 없으므로 플래그만 전달.
    res.json({ success: true, scope: scopeMeta(req), ...data,
      privacyNote: `교과×학급 표본 ${school.MIN_CROSS_N}명 미만 셀(crossMasked)은 비율만 참고용입니다.`,
      basicLiteracyNote: '플랫폼 학습데이터 기반 기초학력 도달 현황입니다(외부 기초학력 진단시스템과 별도).' });
  } catch (err) {
    console.error('[SCHOOL] /achievement error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-6 GET /api/school/safety — 안전망: 위험군(학년별) + 미도달/위기 명단(실명) + 정서·출결.
//   명단은 principal(자기학교)/admin 만 실명. 그 외 진입 자체가 403(미들웨어). audit 1건.
//   ?names=0 으로 마스킹 미리보기 가능(실명 audit 회피).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/safety', requireAuth, requireSchoolScope, (req, res) => {
  try {
    if (!needSchool(req, res)) return;
    const data = school.getSafety(req.schoolScope);
    const wantNames = canSeeNames(req) && String(req.query.names || '1') !== '0';

    let watchlist = data.watchlist;
    if (wantNames) {
      // 실명 노출 — audit 1건(거버넌스). 명단 비었으면 audit 생략.
      if (watchlist.length) auditNameAccess(req, 'safety-watchlist', watchlist.length);
    } else {
      // 익명화(미리보기/권한 외 방어) — id 유지·이름만 마스킹.
      watchlist = watchlist.map((w, i) => ({ ...w, name: maskLabel(i) }));
    }

    res.json({
      success: true, scope: scopeMeta(req),
      riskSummary: data.riskSummary,
      riskByGrade: data.riskByGrade,
      watchlist,
      named: wantNames,
      emotionTrend: data.emotionTrend,
      attendance: data.attendance,
      inactive: data.inactive,
      privacyNote: '위기·미도달 명단은 학교 책임자의 지도 목적 실명 열람입니다. 열람 이력은 기록됩니다.',
    });
  } catch (err) {
    console.error('[SCHOOL] /safety error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-7 GET /api/school/staff — 교직원 활동량 + 클래스 건강도(활성/휴면) + 콘텐츠 비중.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/staff', requireAuth, requireSchoolScope, (req, res) => {
  try {
    if (!needSchool(req, res)) return;
    const data = school.getStaffOps(req.schoolScope);
    res.json({ success: true, scope: scopeMeta(req), ...data });
  } catch (err) {
    console.error('[SCHOOL] /staff error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-8 GET /api/school/benchmark — 학교 vs 학교급/지역 평균(macro 재사용) + 전월 대비.
//   거시 평균은 기존 lrs.js /stats/macro-drill 과 동일 산식을 학교 1행으로 비교.
//   region/school_level 은 principal school_name 의 대표 메타(학생 다수결)로 도출.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/benchmark', requireAuth, requireSchoolScope, (req, res) => {
  try {
    if (!needSchool(req, res)) return;
    const scope = req.schoolScope;
    const db = require('../db/index');
    const schoolName = scope.schoolName;

    // 학교 대표 메타(지역·학교급) — 학생 다수결.
    const meta = db.prepare(`
      SELECT region, school_level, COUNT(*) c FROM users
      WHERE school_name = ? AND role='student'
      GROUP BY region, school_level ORDER BY c DESC LIMIT 1
    `).get(schoolName) || {};
    const region = meta.region || null;
    const schoolLevel = meta.school_level || null;

    // 우리 학교 지표(활동량·1인 평균학습시간·평균성취) — 학생 ID 기준.
    const ids = scope.studentIds;
    const days = daysOf(req, 90);
    const fromDay = `-${days - 1} days`;
    const ours = _unitMetrics(db, ids, fromDay);

    // 학교급 평균 / 지역 평균 — 학교 단위 평균(같은 학교급/지역 학교들의 평균).
    const levelAvg = schoolLevel ? _peerSchoolAvg(db, { school_level: schoolLevel }, fromDay) : null;
    const regionAvg = region ? _peerSchoolAvg(db, { region }, fromDay) : null;

    // 전월 대비 — 우리 학교 평균성취(이번 30일 vs 직전 30일 활동의 평균 점수 근사).
    const monthCompare = _monthOverMonth(db, ids);

    res.json({
      success: true, scope: scopeMeta(req),
      region, schoolLevel, period: `${days}d`,
      ours,
      levelAvg, regionAvg,
      monthCompare,
      note: '학교급/지역 평균은 같은 학교급·지역 학교들의 학교 단위 평균입니다. 전년 대비는 데이터 누적 후 제공됩니다(현재 전월 대비만).',
    });
  } catch (err) {
    console.error('[SCHOOL] /benchmark error:', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// 단위(학생 ID 집합) 지표: 활동량·1인 평균학습시간(분)·평균성취(도달률).
function _unitMetrics(db, ids, fromDay) {
  const school = require('../db/lrs-school');
  if (!ids.length) return { students: 0, acts: 0, avgLearnMin: 0, reachedRate: null };
  const ph = ids.map(() => '?').join(',');
  let log = { acts: 0, durSec: 0 };
  try {
    log = db.prepare(`
      SELECT COUNT(*) acts,
             COALESCE(SUM(COALESCE(duration_sec,
               CAST(REPLACE(REPLACE(COALESCE(result_duration,''),'PT',''),'S','') AS INTEGER),0)),0) durSec
      FROM learning_logs
      WHERE user_id IN (${ph}) AND DATE(created_at) >= DATE('now','localtime', ?)
    `).get(...ids, fromDay);
  } catch (_) {}
  const roll = school._schoolAchievementRollup(ids);
  return {
    students: ids.length,
    acts: log.acts || 0,
    avgActsPerStudent: ids.length ? Math.round((log.acts / ids.length) * 10) / 10 : 0,
    avgLearnMin: ids.length ? Math.round((log.durSec / ids.length) / 60) : 0,
    reachedRate: roll.reachedRate,
  };
}

// 동일 학교급/지역 "다른 학교들"의 학교 단위 평균(우리 학교 비교 기준선).
function _peerSchoolAvg(db, filter, fromDay) {
  const school = require('../db/lrs-school');
  const where = []; const params = [];
  if (filter.school_level) { where.push('school_level = ?'); params.push(filter.school_level); }
  if (filter.region) { where.push('region = ?'); params.push(filter.region); }
  where.push("role='student'");
  where.push("school_name IS NOT NULL AND school_name <> ''");
  let schools = [];
  try {
    schools = db.prepare(`
      SELECT school_name, COUNT(*) c FROM users WHERE ${where.join(' AND ')}
      GROUP BY school_name HAVING c >= 1
    `).all(...params).map(r => r.school_name);
  } catch (_) { schools = []; }
  if (!schools.length) return { schools: 0, avgReachedRate: null, avgLearnMin: null, avgActsPerStudent: null };

  const reached = [], learn = [], acts = [];
  for (const sn of schools) {
    let sids = [];
    try { sids = db.prepare("SELECT id FROM users WHERE school_name=? AND role='student'").all(sn).map(r => r.id); }
    catch (_) { sids = []; }
    if (!sids.length) continue;
    const m = _unitMetrics(db, sids, fromDay);
    if (m.reachedRate != null) reached.push(m.reachedRate);
    learn.push(m.avgLearnMin);
    acts.push(m.avgActsPerStudent);
  }
  const mean = (a) => a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 10) / 10 : null;
  return {
    schools: schools.length,
    avgReachedRate: mean(reached),
    avgLearnMin: mean(learn),
    avgActsPerStudent: mean(acts),
  };
}

// 전월 대비(우리 학교 활동 점수 평균) — 최근 30일 vs 직전 30일.
function _monthOverMonth(db, ids) {
  if (!ids.length) return { current: null, previous: null, deltaPP: null };
  const ph = ids.map(() => '?').join(',');
  const q = (fromExpr, toExpr) => {
    try {
      const row = db.prepare(`
        SELECT AVG(result_score) s, COUNT(result_score) n FROM learning_logs
        WHERE user_id IN (${ph}) AND result_score IS NOT NULL
          AND DATE(created_at) >= DATE('now','localtime', ?) ${toExpr ? "AND DATE(created_at) < DATE('now','localtime', ?)" : ''}
      `).get(...ids, fromExpr, ...(toExpr ? [toExpr] : []));
      if (!row || row.n === 0 || row.s == null) return null;
      const v = Number(row.s) > 1 ? Number(row.s) : Number(row.s) * 100;
      return Math.round(v * 10) / 10;
    } catch (_) { return null; }
  };
  const current = q('-29 days', null);
  const previous = q('-59 days', '-29 days');
  const deltaPP = (current != null && previous != null) ? Math.round((current - previous) * 10) / 10 : null;
  return { current, previous, deltaPP };
}

module.exports = router;
