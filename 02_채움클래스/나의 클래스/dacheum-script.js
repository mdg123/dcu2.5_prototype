// 상태 관리
let currentTab = 'created';
let currentDate = new Date(2025, 0, 1);
let detailDate = new Date(2025, 0, 1);

// 데이터
const createdClasses = [
    { id: 1, name: 'SW교육 연구회', members: 32, color: '#3b82f6', badges: { newPost: 3, approval: 1, newMember: 0 } },
    { id: 2, name: '수학교육 혁신반', members: 28, color: '#f59e0b', badges: { newPost: 0, approval: 0, newMember: 2 } },
    { id: 3, name: 'AI 활용 수업연구', members: 45, color: '#10b981', badges: { newPost: 5, approval: 0, newMember: 0 } },
    { id: 4, name: '창의융합 프로젝트', members: 19, color: '#8b5cf6', badges: { newPost: 0, approval: 3, newMember: 1 } },
    { id: 5, name: '독서교육 연구회', members: 24, color: '#ec4899', badges: { newPost: 2, approval: 0, newMember: 0 } },
];

const joinedClasses = [
    { id: 6, name: '충북 교육청 AI 연수', teacher: '김교육', color: '#0ea5e9', badges: { newPost: 2, newClass: 1 } },
    { id: 7, name: '2025 에듀테크 포럼', teacher: '이혁신', color: '#14b8a6', badges: { newPost: 0 } },
    { id: 8, name: '교사 협력 네트워크', teacher: '박연결', color: '#f97316', badges: { newPost: 4 } },
    { id: 9, name: '미래교육 연구회', teacher: '정미래', color: '#a855f7', badges: { newPost: 1 } },
    { id: 10, name: 'STEAM 교육 동아리', teacher: '최융합', color: '#ef4444', badges: { newPost: 0 } },
    { id: 11, name: '교육과정 재구성반', teacher: '강교과', color: '#84cc16', badges: { newPost: 3 } },
    { id: 12, name: '디지털 리터러시', teacher: '한디지', color: '#06b6d4', badges: { newPost: 0 } },
    { id: 13, name: '평가혁신 연구회', teacher: '조평가', color: '#e11d48', badges: { newPost: 1 } },
];

// 일정 데이터
const scheduleData = {
    '2025-01-02': [{ id: 101, type: 'lesson', title: 'OT - 연구회 소개', class: 'SW교육 연구회', submitted: 30, total: 32 }],
    '2025-01-03': [{ id: 1, type: 'lesson', title: 'Python 기초 - 변수와 자료형', class: 'SW교육 연구회', submitted: 28, total: 32 }],
    '2025-01-06': [
        { id: 2, type: 'assignment', title: 'AI 프로젝트 기획서', class: 'AI 활용 수업연구', startDate: '2025-01-06', endDate: '2025-01-08', submitted: 38, total: 45 },
        { id: 102, type: 'lesson', title: '수학 개념 시각화 1차시', class: '수학교육 혁신반', submitted: 26, total: 28 },
    ],
    '2025-01-08': [
        { id: 2, type: 'assignment', title: 'AI 프로젝트 기획서 (마감)', class: 'AI 활용 수업연구', startDate: '2025-01-06', endDate: '2025-01-08', submitted: 38, total: 45 },
        { id: 3, type: 'lesson', title: '수학적 사고력 향상', class: '수학교육 혁신반', submitted: 25, total: 28 },
        { id: 4, type: 'survey', title: '연구회 활동 만족도 조사', class: 'SW교육 연구회', submitted: 20, total: 32 },
    ],
    '2025-01-10': [
        { id: 5, type: 'evaluation', title: 'Python 기초 평가', class: 'SW교육 연구회', submitted: 30, total: 32 },
    ],
    '2025-01-12': [{ id: 6, type: 'lesson', title: '엔트리 블록코딩 실습', class: 'SW교육 연구회', submitted: 31, total: 32 }],
    '2025-01-15': [
        { id: 7, type: 'assignment', title: '수학 문제 풀이 과제', class: '수학교육 혁신반', submitted: 15, total: 28 },
        { id: 8, type: 'lesson', title: 'ChatGPT 프롬프트 작성법', class: 'AI 활용 수업연구', submitted: 42, total: 45 },
        { id: 105, type: 'evaluation', title: '융합 프로젝트 기획 평가', class: '창의융합 프로젝트', submitted: 15, total: 19 },
    ],
    '2025-01-18': [{ id: 9, type: 'survey', title: '2학기 운영 방향 설문', class: 'AI 활용 수업연구', submitted: 35, total: 45 }],
    '2025-01-20': [
        { id: 10, type: 'evaluation', title: '융합 프로젝트 중간평가', class: '창의융합 프로젝트', submitted: 12, total: 19 },
    ],
    '2025-01-22': [
        { id: 11, type: 'lesson', title: '독서 토론 진행법', class: '독서교육 연구회', submitted: 22, total: 24 },
        { id: 107, type: 'lesson', title: 'AI 이미지 생성 실습', class: 'AI 활용 수업연구', submitted: 40, total: 45 },
    ],
    '2025-01-25': [{ id: 12, type: 'assignment', title: '독서 감상문 제출', class: '독서교육 연구회', startDate: '2025-01-25', endDate: '2025-01-31', submitted: 8, total: 24 }],
    '2025-01-27': [{ id: 109, type: 'lesson', title: '데이터 시각화 기초', class: 'SW교육 연구회', submitted: 29, total: 32 }],
    '2025-01-29': [{ id: 110, type: 'evaluation', title: '수학적 사고력 평가', class: '수학교육 혁신반', submitted: 24, total: 28 }],
    '2025-01-31': [
        { id: 12, type: 'assignment', title: '독서 감상문 제출 (마감)', class: '독서교육 연구회', startDate: '2025-01-25', endDate: '2025-01-31', submitted: 8, total: 24 },
        { id: 111, type: 'lesson', title: '월말 정리 및 회고', class: 'SW교육 연구회', submitted: 28, total: 32 },
    ],
};

// 기한없음 일정 데이터
const noDeadlineEvents = [
    { id: 901, type: 'assignment', title: '자유 주제 독서 감상문', class: '독서교육 연구회', submitted: 10, total: 24 },
    { id: 902, type: 'assignment', title: '포트폴리오 자료 업로드', class: 'SW교육 연구회', submitted: 22, total: 32 },
    { id: 903, type: 'survey', title: '연구회 활동 개선 의견 수집', class: '수학교육 혁신반', submitted: 14, total: 28 },
    { id: 904, type: 'assignment', title: 'AI 활용 수업 사례 공유', class: 'AI 활용 수업연구', submitted: 30, total: 45 },
    { id: 905, type: 'assignment', title: '창의 프로젝트 아이디어 제안', class: '창의융합 프로젝트', submitted: 5, total: 19 },
];

const mySubmitStatus = {
    '2025-01-06': { submitted: false },
    '2025-01-08': { submitted: true },
    '2025-01-10': { submitted: false },
    '2025-01-15': { submitted: true },
    '2025-01-18': { submitted: true },
    '2025-01-20': { submitted: false },
    '2025-01-24': { submitted: false },
};

// 전체보기용 확장 데이터 (15개)
const newPostsAll = [
    { id: 1, title: 'SW교육 공개수업 일정 안내', class: 'SW교육 연구회', author: '김영수', date: '2025-01-02', views: 45, likes: 8 },
    { id: 2, title: '2025년 1학기 활동 계획 논의', class: '수학교육 혁신반', author: '이수진', date: '2025-01-02', views: 32, likes: 5 },
    { id: 3, title: 'ChatGPT 활용 수업 사례 공유', class: 'AI 활용 수업연구', author: '박지현', date: '2025-01-01', views: 89, likes: 21 },
    { id: 4, title: '겨울방학 독서 추천 도서 목록', class: '독서교육 연구회', author: '정은영', date: '2025-01-01', views: 56, likes: 12 },
    { id: 5, title: '프로젝트 팀 구성 안내', class: '창의융합 프로젝트', author: '최민호', date: '2024-12-30', views: 38, likes: 6 },
    { id: 6, title: 'Python 실습 자료 공유', class: 'SW교육 연구회', author: '김영수', date: '2024-12-29', views: 67, likes: 15 },
    { id: 7, title: '수학 교구 활용 사례', class: '수학교육 혁신반', author: '이수진', date: '2024-12-28', views: 41, likes: 9 },
    { id: 8, title: 'AI 윤리 교육 자료', class: 'AI 활용 수업연구', author: '박지현', date: '2024-12-27', views: 53, likes: 11 },
    { id: 9, title: '독서 토론 주제 선정', class: '독서교육 연구회', author: '정은영', date: '2024-12-26', views: 29, likes: 4 },
    { id: 10, title: '융합 프로젝트 예시 모음', class: '창의융합 프로젝트', author: '최민호', date: '2024-12-25', views: 44, likes: 7 },
    { id: 11, title: '엔트리 활용 수업안', class: 'SW교육 연구회', author: '한소프트', date: '2024-12-24', views: 58, likes: 13 },
    { id: 12, title: '수학 게임 활동지', class: '수학교육 혁신반', author: '강수학', date: '2024-12-23', views: 35, likes: 6 },
    { id: 13, title: 'Gemini vs ChatGPT 비교', class: 'AI 활용 수업연구', author: '조인공', date: '2024-12-22', views: 92, likes: 24 },
    { id: 14, title: '필독서 목록 업데이트', class: '독서교육 연구회', author: '윤독서', date: '2024-12-21', views: 47, likes: 10 },
    { id: 15, title: '메이커 교육 사례', class: '창의융합 프로젝트', author: '임창의', date: '2024-12-20', views: 39, likes: 7 },
];

const popularPostsAll = [
    { id: 1, title: 'AI 이미지 생성 도구 활용법 총정리', class: 'AI 활용 수업연구', author: '박지현', date: '2024-12-15', views: 234, likes: 45 },
    { id: 2, title: '엔트리로 만드는 미로 탈출 게임', class: 'SW교육 연구회', author: '김영수', date: '2024-12-18', views: 189, likes: 38 },
    { id: 3, title: '수학 개념 시각화 자료 모음', class: '수학교육 혁신반', author: '이수진', date: '2024-12-20', views: 156, likes: 32 },
    { id: 4, title: '겨울방학 추천 도서 100선', class: '독서교육 연구회', author: '정은영', date: '2024-12-10', views: 145, likes: 29 },
    { id: 5, title: '융합 프로젝트 우수 사례 발표', class: '창의융합 프로젝트', author: '최민호', date: '2024-12-22', views: 134, likes: 25 },
    { id: 6, title: 'Python으로 만드는 퀴즈 게임', class: 'SW교육 연구회', author: '김영수', date: '2024-12-25', views: 128, likes: 24 },
    { id: 7, title: '인공지능 수업 설계 가이드', class: 'AI 활용 수업연구', author: '조인공', date: '2024-12-28', views: 119, likes: 22 },
    { id: 8, title: '수학 보드게임 제작 방법', class: '수학교육 혁신반', author: '강수학', date: '2024-12-30', views: 112, likes: 21 },
    { id: 9, title: '그림책 활용 수업 사례', class: '독서교육 연구회', author: '윤독서', date: '2025-01-01', views: 108, likes: 20 },
    { id: 10, title: 'STEAM 교육 커리큘럼', class: '창의융합 프로젝트', author: '임창의', date: '2024-12-12', views: 102, likes: 19 },
    { id: 11, title: '스크래치 애니메이션 만들기', class: 'SW교육 연구회', author: '한소프트', date: '2024-12-08', views: 98, likes: 18 },
    { id: 12, title: 'ChatGPT 프롬프트 모음집', class: 'AI 활용 수업연구', author: '박지현', date: '2024-12-05', views: 95, likes: 17 },
    { id: 13, title: '수학 탐구 보고서 양식', class: '수학교육 혁신반', author: '이수진', date: '2024-12-03', views: 89, likes: 16 },
    { id: 14, title: '온라인 독서 토론 방법', class: '독서교육 연구회', author: '정은영', date: '2024-11-28', views: 85, likes: 15 },
    { id: 15, title: '아두이노 프로젝트 가이드', class: '창의융합 프로젝트', author: '최민호', date: '2024-11-25', views: 82, likes: 14 },
];

const surveysAll = [
    { id: 1, title: '2025년 연구회 활동 희망 조사', class: 'SW교육 연구회', startDate: '2024-12-27', endDate: '2025-01-10', responses: 24, total: 32, status: 'active', submitted: false },
    { id: 2, title: '공개수업 참관 희망 일정', class: '수학교육 혁신반', startDate: '2024-12-25', endDate: '2025-01-08', responses: 18, total: 28, status: 'active', submitted: true },
    { id: 3, title: 'AI 도구 활용 경험 설문', class: 'AI 활용 수업연구', startDate: '2024-12-20', endDate: '2025-01-05', responses: 42, total: 45, status: 'active', submitted: true },
    { id: 4, title: '독서 모임 시간대 조사', class: '독서교육 연구회', startDate: '2024-12-15', endDate: '2024-12-30', responses: 24, total: 24, status: 'closed', submitted: true },
    { id: 5, title: '프로젝트 주제 선호도 조사', class: '창의융합 프로젝트', startDate: '2024-12-14', endDate: '2024-12-28', responses: 19, total: 19, status: 'closed', submitted: true },
    { id: 6, title: '온라인/오프라인 선호도', class: 'SW교육 연구회', startDate: '2024-12-10', endDate: '2024-12-25', responses: 30, total: 32, status: 'closed', submitted: false },
    { id: 7, title: '교구 구매 희망 조사', class: '수학교육 혁신반', startDate: '2024-12-08', endDate: '2024-12-22', responses: 25, total: 28, status: 'closed', submitted: true },
    { id: 8, title: 'AI 연수 만족도 조사', class: 'AI 활용 수업연구', startDate: '2024-12-05', endDate: '2024-12-20', responses: 43, total: 45, status: 'closed', submitted: true },
    { id: 9, title: '추천 도서 투표', class: '독서교육 연구회', startDate: '2024-12-03', endDate: '2024-12-18', responses: 22, total: 24, status: 'closed', submitted: true },
    { id: 10, title: '발표 순서 희망 조사', class: '창의융합 프로젝트', startDate: '2024-12-01', endDate: '2024-12-15', responses: 17, total: 19, status: 'closed', submitted: false },
    { id: 11, title: '2024년 활동 만족도', class: 'SW교육 연구회', startDate: '2024-11-28', endDate: '2024-12-12', responses: 31, total: 32, status: 'closed', submitted: true },
    { id: 12, title: '수업 자료 공유 플랫폼 선호도', class: '수학교육 혁신반', startDate: '2024-11-25', endDate: '2024-12-10', responses: 26, total: 28, status: 'closed', submitted: true },
    { id: 13, title: 'AI 수업 적용 분야 조사', class: 'AI 활용 수업연구', startDate: '2024-11-22', endDate: '2024-12-08', responses: 40, total: 45, status: 'closed', submitted: true },
    { id: 14, title: '독서 장르 선호도', class: '독서교육 연구회', startDate: '2024-11-20', endDate: '2024-12-05', responses: 23, total: 24, status: 'closed', submitted: true },
    { id: 15, title: '융합 수업 주제 투표', class: '창의융합 프로젝트', startDate: '2024-11-18', endDate: '2024-12-02', responses: 18, total: 19, status: 'closed', submitted: false },
];

// 참여 클래스용 통계 데이터
const joinedStatsData = {
    lessons: [
        { title: 'AI 기초 이론', class: '충북 교육청 AI 연수', completed: true, date: '2025-01-05' },
        { title: '에듀테크 트렌드 2025', class: '2025 에듀테크 포럼', completed: true, date: '2025-01-03' },
        { title: '협력 학습 설계', class: '교사 협력 네트워크', completed: false, date: '2025-01-08' },
        { title: '미래 교육 비전', class: '미래교육 연구회', completed: true, date: '2025-01-02' },
        { title: 'STEAM 수업 설계', class: 'STEAM 교육 동아리', completed: false, date: '2025-01-10' },
    ],
    assignments: [
        { title: 'AI 수업 설계안 제출', class: '충북 교육청 AI 연수', submitted: true, dueDate: '2025-01-08' },
        { title: '에듀테크 활용 사례 보고서', class: '2025 에듀테크 포럼', submitted: false, dueDate: '2025-01-12' },
        { title: '협력 수업 계획서', class: '교사 협력 네트워크', submitted: true, dueDate: '2025-01-06' },
        { title: '미래 교육 제안서', class: '미래교육 연구회', submitted: false, dueDate: '2025-01-15' },
    ],
    surveys: [
        { title: '연수 만족도 조사', class: '충북 교육청 AI 연수', participated: true },
        { title: '포럼 주제 선호도', class: '2025 에듀테크 포럼', participated: true },
        { title: '협력 방식 선호도', class: '교사 협력 네트워크', participated: false },
    ]
};

const attendanceData = [
    { name: '김철수', class: 'SW교육 연구회', attendance: 12, total: 12, rate: 100 },
    { name: '이영희', class: 'SW교육 연구회', attendance: 11, total: 12, rate: 92 },
    { name: '박민수', class: '수학교육 혁신반', attendance: 10, total: 12, rate: 83 },
    { name: '정수현', class: 'AI 활용 수업연구', attendance: 8, total: 12, rate: 67 },
    { name: '최지원', class: '창의융합 프로젝트', attendance: 6, total: 12, rate: 50 },
    { name: '한지민', class: 'SW교육 연구회', attendance: 12, total: 12, rate: 100 },
    { name: '오세훈', class: '수학교육 혁신반', attendance: 9, total: 12, rate: 75 },
    { name: '강미래', class: 'AI 활용 수업연구', attendance: 11, total: 12, rate: 92 },
];

// 탭 전환
function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach((btn, i) => {
        btn.classList.toggle('active', (i === 0 && tab === 'created') || (i === 1 && tab === 'joined'));
    });
    document.getElementById('submitFilterChips').style.display = tab === 'joined' ? 'flex' : 'none';
    // 활동 내역 전환
    const createdActivityList = document.getElementById('createdActivityList');
    const joinedActivityList = document.getElementById('joinedActivityList');

    if (tab === 'created') {
        createdActivityList.style.display = 'flex';
        joinedActivityList.style.display = 'none';
    } else {
        createdActivityList.style.display = 'none';
        joinedActivityList.style.display = 'flex';
    }
    renderStatsGrid();
    renderClassList();
    renderCalendar();
    setTimeout(() => { animateCounters(); animateProgressBars(); }, 100);
}

// 통계 그리드 렌더링
function renderStatsGrid() {
    const grid = document.getElementById('statsGrid');
    if (currentTab === 'joined') {
        grid.innerHTML = `
            <div class="stat-card" onclick="openJoinedStatModal('classes')">
                <div class="stat-card-header"><span class="stat-card-title">수강 중인 클래스</span><div class="stat-card-icon" style="background:#dbeafe;">📚</div></div>
                <div class="stat-card-value"><span class="count-number" data-target="8">0</span><span class="unit">개</span></div>
                <div class="stat-card-footer"><span>이번 달 활동 중</span></div>
            </div>
            <div class="stat-card" onclick="openJoinedStatModal('lessons')">
                <div class="stat-card-header"><span class="stat-card-title">완료한 수업</span><div class="stat-card-icon" style="background:#d1fae5;">✅</div></div>
                <div class="stat-card-value"><span class="count-number" data-target="24">0</span><span class="unit">개</span></div>
                <div class="progress-bar-container"><div class="progress-bar green" data-width="80"></div></div>
                <div class="stat-card-footer"><span>전체 30개 중</span><span style="color:#10b981;">↑ 12%</span></div>
            </div>
            <div class="stat-card" onclick="openJoinedStatModal('assignments')">
                <div class="stat-card-header"><span class="stat-card-title">제출한 과제</span><div class="stat-card-icon" style="background:#ffedd5;">📄</div></div>
                <div class="stat-card-value"><span class="count-number" data-target="15">0</span><span class="unit">개</span></div>
                <div class="progress-bar-container"><div class="progress-bar orange" data-width="83"></div></div>
                <div class="stat-card-footer"><span>전체 18개 중</span><span style="color:#f59e0b;">3개 미제출</span></div>
            </div>
            <div class="stat-card" onclick="openJoinedStatModal('surveys')">
                <div class="stat-card-header"><span class="stat-card-title">참여한 설문</span><div class="stat-card-icon" style="background:#ede9fe;">📊</div></div>
                <div class="stat-card-value"><span class="count-number" data-target="7">0</span><span class="unit">개</span></div>
                <div class="progress-bar-container"><div class="progress-bar purple" data-width="70"></div></div>
                <div class="stat-card-footer"><span>전체 10개 중</span><span>진행 중 2개</span></div>
            </div>`;
    } else {
        grid.innerHTML = `
            <div class="stat-card" onclick="openStatModal('attendance')">
                <div class="stat-card-header"><span class="stat-card-title">출석현황</span><div class="stat-card-icon" style="background:#dbeafe;">👥</div></div>
                <div class="stat-card-value"><span class="count-number" data-target="87">0</span><span class="unit">%</span></div>
                <div class="progress-bar-container"><div class="progress-bar blue" data-width="87"></div></div>
                <div class="stat-card-footer"><span>참여 156명 / 전체 179명</span><span style="color:#10b981;">↑ 3%</span></div>
            </div>
            <div class="stat-card" onclick="openStatModal('completion')">
                <div class="stat-card-header"><span class="stat-card-title">수업이수율</span><div class="stat-card-icon" style="background:#d1fae5;">✅</div></div>
                <div class="stat-card-value"><span class="count-number" data-target="72">0</span><span class="unit">%</span></div>
                <div class="progress-bar-container"><div class="progress-bar green" data-width="72"></div></div>
                <div class="stat-card-footer"><span>완료 864건 / 전체 1,200건</span><span style="color:#10b981;">↑ 5%</span></div>
            </div>
            <div class="stat-card" onclick="openStatModal('assignment')">
                <div class="stat-card-header"><span class="stat-card-title">과제제출률</span><div class="stat-card-icon" style="background:#ffedd5;">📄</div></div>
                <div class="stat-card-value"><span class="count-number" data-target="64">0</span><span class="unit">%</span></div>
                <div class="progress-bar-container"><div class="progress-bar orange" data-width="64"></div></div>
                <div class="stat-card-footer"><span>제출 89건 / 전체 139건</span><span style="color:#ef4444;">↓ 2%</span></div>
            </div>
            <div class="stat-card" onclick="openStatModal('evaluation')">
                <div class="stat-card-header"><span class="stat-card-title">평가진행률</span><div class="stat-card-icon" style="background:#ede9fe;">⭐</div></div>
                <div class="stat-card-value"><span class="count-number" data-target="58">0</span><span class="unit">%</span></div>
                <div class="progress-bar-container"><div class="progress-bar purple" data-width="58"></div></div>
                <div class="stat-card-footer"><span>완료 42건 / 전체 72건</span><span style="color:#10b981;">↑ 8%</span></div>
            </div>`;
    }
}

// 클래스 목록 렌더링
function renderClassList() {
    const container = document.getElementById('classList');
    const classes = currentTab === 'created' ? createdClasses : joinedClasses;
    container.innerHTML = classes.map(cls => `
        <div class="class-item" onclick="location.href='01_%EA%B0%9C%EB%B3%84%20%ED%81%B4%EB%9E%98%EC%8A%A4%20%ED%99%88/class-home-prototype.html'">
            <div class="class-thumbnail" style="background:linear-gradient(135deg,${cls.color},${adjustColor(cls.color,-40)})">${cls.name.charAt(0)}</div>
            <div class="class-info">
                <div class="class-name">${cls.name}</div>
                <div class="class-meta">${currentTab === 'created' ? `멤버 ${cls.members}명` : `개설자: ${cls.teacher}`}</div>
            </div>
            <div class="class-badges">
                ${cls.badges.newPost > 0 ? `<div class="event-badge new-post tooltip" data-tooltip="새 글 ${cls.badges.newPost}개">📝<span class="count">${cls.badges.newPost}</span></div>` : ''}
                ${cls.badges.approval > 0 ? `<div class="event-badge approval tooltip" data-tooltip="승인 대기 ${cls.badges.approval}건">⏳<span class="count">${cls.badges.approval}</span></div>` : ''}
                ${cls.badges.newMember > 0 ? `<div class="event-badge new-member tooltip" data-tooltip="새 멤버 ${cls.badges.newMember}명">👋<span class="count">${cls.badges.newMember}</span></div>` : ''}
                ${cls.badges.newClass ? `<div class="event-badge new-class tooltip" data-tooltip="새로 가입">🆕</div>` : ''}
            </div>
        </div>
    `).join('');
}

function adjustColor(color, amount) {
    const hex = color.replace('#', '');
    const r = Math.max(0, Math.min(255, parseInt(hex.substr(0, 2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substr(2, 2), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substr(4, 2), 16) + amount));
    return `rgb(${r},${g},${b})`;
}

// 요약 캘린더 렌더링
function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    const monthLabel = document.getElementById('calendarMonth');
    const year = currentDate.getFullYear(), month = currentDate.getMonth();
    monthLabel.textContent = `${year}년 ${month + 1}월`;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    let html = days.map((d, i) => `<div class="calendar-day-header" style="${i === 0 ? 'color:#ef4444' : i === 6 ? 'color:#3b82f6' : ''}">${d}</div>`).join('');
    for (let i = 0; i < firstDay; i++) html += '<div class="calendar-day other-month"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const isToday = year === today.getFullYear() && month === today.getMonth() && d === today.getDate();
        const events = scheduleData[dateStr] || [];
        const submitStatus = mySubmitStatus[dateStr];
        let eventDots = [...new Set(events.map(e => e.type))].slice(0, 4).map(type => `<div class="event-dot ${type}"></div>`).join('');
        let statusIndicator = currentTab === 'joined' && submitStatus ? `<div class="submit-status ${submitStatus.submitted ? 'completed' : 'pending'}">${submitStatus.submitted ? '✓' : '!'}</div>` : '';
        html += `<div class="calendar-day ${isToday ? 'today' : ''}" onclick="openDaySchedule('${dateStr}')">${statusIndicator}<span class="day-number">${d}</span><div class="event-dots">${eventDots}</div></div>`;
    }
    grid.innerHTML = html;
}

function prevMonth() { currentDate.setMonth(currentDate.getMonth() - 1); renderCalendar(); }
function nextMonth() { currentDate.setMonth(currentDate.getMonth() + 1); renderCalendar(); }

// 상세 캘린더
function openDetailCalendar() {
    detailDate = new Date(currentDate);
    renderDetailCalendar();
    document.getElementById('detailCalendarModal').classList.add('active');
}

function renderDetailCalendar() {
    const container = document.getElementById('detailCalendar');
    const monthLabel = document.getElementById('detailCalendarMonth');
    const year = detailDate.getFullYear(), month = detailDate.getMonth();
    monthLabel.textContent = `${year}년 ${month + 1}월`;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();
    const today = new Date();
    const days = ['일', '월', '화', '수', '목', '금', '토'];

    // 1) 해당 월의 모든 날짜별 이벤트 맵 구축 (기간 일정 중간일 포함)
    const dateToStr = (y, m, d) => `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayEventMap = {}; // dateStr -> [{event, pos: 'start'|'middle'|'end'|'single'}]
    const rangeEventIds = new Set(); // 기간 일정 id 추적

    // 먼저 기간 일정을 수집
    const rangeEvents = [];
    for (const [dateStr, evts] of Object.entries(scheduleData)) {
        evts.forEach(e => {
            if (e.startDate && e.endDate && e.startDate !== e.endDate && !rangeEventIds.has(e.id)) {
                rangeEventIds.add(e.id);
                rangeEvents.push(e);
            }
        });
    }

    // 기간 일정: 각 날짜에 삽입
    rangeEvents.forEach(e => {
        const start = new Date(e.startDate);
        const end = new Date(e.endDate);
        for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
            const ds = dateToStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
            if (!dayEventMap[ds]) dayEventMap[ds] = [];
            let pos = 'middle';
            if (dt.getTime() === start.getTime()) pos = 'start';
            if (dt.getTime() === end.getTime()) pos = 'end';
            if (e.startDate === e.endDate) pos = 'single';
            dayEventMap[ds].push({ event: e, pos: pos });
        }
    });

    // 단일 일정 추가 (기간 일정이 아닌 것만)
    for (const [dateStr, evts] of Object.entries(scheduleData)) {
        evts.forEach(e => {
            if (!rangeEventIds.has(e.id)) {
                if (!dayEventMap[dateStr]) dayEventMap[dateStr] = [];
                dayEventMap[dateStr].push({ event: e, pos: 'single' });
            }
        });
    }

    // 2) 슬롯 할당: 기간 일정이 동일 행에 유지되도록 전역 슬롯 관리
    const eventSlotMap = {}; // eventId -> slot number (주별)
    function getWeekKey(dateStr) {
        const d = new Date(dateStr);
        const dayOfMonth = d.getDate();
        const fDay = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
        return Math.floor((fDay + dayOfMonth - 1) / 7);
    }

    // 주별 슬롯 사용 현황
    const weekSlots = {}; // weekKey -> Set of used slots per day-of-week

    // 각 날짜의 이벤트에 슬롯 할당
    const dateSlotAssignments = {}; // dateStr -> [{event, pos, slot}]
    const allDateStrs = [];
    for (let d = 1; d <= daysInMonth; d++) {
        allDateStrs.push(dateToStr(year, month, d));
    }

    // 기간 일정 슬롯 먼저 할당 (시작일 기준)
    rangeEvents.sort((a, b) => a.startDate.localeCompare(b.startDate));
    rangeEvents.forEach(e => {
        const start = new Date(e.startDate);
        const end = new Date(e.endDate);
        // 이 이벤트가 걸치는 모든 주를 구하고, 각 주에서 사용 가능한 슬롯 찾기
        for (let dt = new Date(start); dt <= end; ) {
            const weekStart = new Date(dt);
            const wk = getWeekKey(dateToStr(dt.getFullYear(), dt.getMonth(), dt.getDate()));
            if (!weekSlots[wk]) weekSlots[wk] = Array(7).fill(null).map(() => new Set());

            // 이 주에서 이벤트가 차지하는 요일 범위
            const daysInWeek = [];
            while (dt <= end && getWeekKey(dateToStr(dt.getFullYear(), dt.getMonth(), dt.getDate())) === wk) {
                const dow = dt.getDay();
                daysInWeek.push(dow);
                dt.setDate(dt.getDate() + 1);
            }

            // 이 주에서 사용 가능한 최소 슬롯 찾기
            let slot = 0;
            while (true) {
                const conflict = daysInWeek.some(dow => weekSlots[wk][dow].has(slot));
                if (!conflict) break;
                slot++;
            }

            // 슬롯 점유
            daysInWeek.forEach(dow => weekSlots[wk][dow].add(slot));

            // 이 주의 이벤트 슬롯 기록
            if (!eventSlotMap[e.id]) eventSlotMap[e.id] = {};
            eventSlotMap[e.id][wk] = slot;
        }
    });

    // 각 날짜별 이벤트 배열을 슬롯 순으로 정렬하고 빈 슬롯 채우기
    allDateStrs.forEach(dateStr => {
        const items = dayEventMap[dateStr] || [];
        const wk = getWeekKey(dateStr);
        const dow = new Date(dateStr).getDay();
        if (!weekSlots[wk]) weekSlots[wk] = Array(7).fill(null).map(() => new Set());

        // 기간 일정의 슬롯 결정
        const slotted = [];
        items.forEach(item => {
            if (item.pos !== 'single') {
                const s = eventSlotMap[item.event.id]?.[wk] ?? 0;
                slotted.push({ ...item, slot: s });
            }
        });

        // 단일 일정 슬롯 할당
        items.forEach(item => {
            if (item.pos === 'single') {
                let slot = 0;
                const usedSlots = new Set([...slotted.map(s => s.slot), ...weekSlots[wk][dow]]);
                while (usedSlots.has(slot)) slot++;
                slotted.push({ ...item, slot: slot });
                weekSlots[wk][dow].add(slot);
            }
        });

        slotted.sort((a, b) => a.slot - b.slot);
        dateSlotAssignments[dateStr] = slotted;
    });

    // 3) HTML 렌더링
    let html = '<div class="detail-calendar-grid">' + days.map(d => `<div class="detail-day-header">${d}</div>`).join('');
    for (let i = firstDay - 1; i >= 0; i--) html += `<div class="detail-day other-month"><div class="day-num">${prevMonthDays - i}</div></div>`;

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = dateToStr(year, month, d);
        const isToday = year === today.getFullYear() && month === today.getMonth() && d === today.getDate();
        const slotted = dateSlotAssignments[dateStr] || [];

        // 최대 슬롯 수 (빈 슬롯 placeholder 포함)
        const maxSlot = slotted.length > 0 ? Math.max(...slotted.map(s => s.slot)) : -1;
        let eventsHtml = '';
        const maxShow = 3;
        let rendered = 0;

        for (let s = 0; s <= Math.min(maxSlot, maxShow - 1); s++) {
            const item = slotted.find(x => x.slot === s);
            if (item) {
                const e = item.event;
                let rangeClass = '';
                let label = e.title.replace(/ \(마감\)| \(진행중\)/, '');

                if (item.pos === 'start') {
                    rangeClass = 'range-start';
                } else if (item.pos === 'end') {
                    rangeClass = 'range-end';
                    label = '';
                } else if (item.pos === 'middle') {
                    rangeClass = 'range-middle';
                    label = '';
                    // 주 시작(일요일)이면 라벨 다시 표시 + range-cont-start
                    if (new Date(dateStr).getDay() === 0) {
                        rangeClass = 'range-cont-start';
                        label = e.title.replace(/ \(마감\)| \(진행중\)/, '');
                    }
                }

                eventsHtml += `<div class="detail-event ${e.type} ${rangeClass}" onclick="event.stopPropagation();showEventDetail(${e.id})" title="${e.title}">${label}</div>`;
                rendered++;
            } else {
                // 빈 슬롯 placeholder (높이 유지)
                eventsHtml += '<div class="detail-event-placeholder"></div>';
            }
        }

        const totalEvents = slotted.length;
        if (totalEvents > maxShow) {
            eventsHtml += `<div class="more-events" onclick="event.stopPropagation();openDaySchedule('${dateStr}')">+${totalEvents - maxShow}개 더보기</div>`;
        }

        html += `<div class="detail-day ${isToday ? 'today' : ''}" onclick="openDaySchedule('${dateStr}')"><div class="day-num">${d}</div><div class="detail-events-container">${eventsHtml}</div></div>`;
    }

    const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
    for (let d = 1; d <= totalCells - (firstDay + daysInMonth); d++) html += `<div class="detail-day other-month"><div class="day-num">${d}</div></div>`;
    container.innerHTML = html + '</div>';
}

function prevDetailMonth() { detailDate.setMonth(detailDate.getMonth() - 1); renderDetailCalendar(); }
function nextDetailMonth() { detailDate.setMonth(detailDate.getMonth() + 1); renderDetailCalendar(); }
function setCalendarView(view) { document.querySelectorAll('.view-toggle button').forEach(btn => btn.classList.toggle('active', btn.textContent.includes(view === 'month' ? '월간' : '주간'))); }

// 날짜 클릭 시 사이드바
let currentSidebarDate = null;
let currentSidebarFilter = 'all';

function openDaySchedule(dateStr) {
    currentSidebarDate = dateStr;
    currentSidebarFilter = 'all';
    // 필터 버튼 초기화
    document.querySelectorAll('.sidebar-filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === 'all'));
    renderDaySchedule(dateStr, 'all');
    document.getElementById('scheduleSidebar').classList.add('active');
}

function filterDaySchedule(filter) {
    currentSidebarFilter = filter;
    document.querySelectorAll('.sidebar-filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === filter));
    renderDaySchedule(currentSidebarDate, filter);
}

function isEventCompleted(e, dateStr) {
    if (currentTab === 'created') {
        return e.submitted >= e.total;
    } else {
        return mySubmitStatus[dateStr]?.submitted === true;
    }
}

function renderDaySchedule(dateStr, filter) {
    const body = document.getElementById('sidebarBody');
    const date = new Date(dateStr);
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    document.getElementById('sidebarDate').textContent = `${date.getMonth() + 1}월 ${date.getDate()}일 (${dayNames[date.getDay()]})`;
    const allEvents = scheduleData[dateStr] || [];

    // 필터 적용
    let events = allEvents;
    if (filter === 'completed') {
        events = allEvents.filter(e => isEventCompleted(e, dateStr));
    } else if (filter === 'incomplete') {
        events = allEvents.filter(e => !isEventCompleted(e, dateStr));
    }

    // 필터 카운트 업데이트
    const completedCount = allEvents.filter(e => isEventCompleted(e, dateStr)).length;
    const incompleteCount = allEvents.length - completedCount;
    document.querySelectorAll('.sidebar-filter-btn').forEach(btn => {
        const f = btn.dataset.filter;
        if (f === 'all') btn.textContent = '전체 ' + allEvents.length;
        else if (f === 'completed') btn.textContent = '완료 ' + completedCount;
        else if (f === 'incomplete') btn.textContent = '미완료 ' + incompleteCount;
    });

    if (allEvents.length === 0) {
        body.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:2rem;">이 날짜에 예정된 일정이 없습니다.</div>';
        return;
    }

    if (events.length === 0) {
        const filterLabel = filter === 'completed' ? '완료된' : '미완료';
        body.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:2rem;">${filterLabel} 일정이 없습니다.</div>`;
        return;
    }

    const typeLabels = { lesson: '수업', assignment: '과제', evaluation: '평가', survey: '설문' };
    body.innerHTML = events.map(e => {
        const completed = isEventCompleted(e, dateStr);
        const statusIcon = completed ? '<span style="color:#10b981;font-size:0.75rem;margin-left:auto;">✓ 완료</span>' : '<span style="color:#f59e0b;font-size:0.75rem;margin-left:auto;">진행중</span>';
        return `
        <div class="schedule-item" onclick="showEventDetail(${e.id})">
            <div class="schedule-item-header"><span class="schedule-type-badge ${e.type}">${typeLabels[e.type]}</span><span style="font-size:0.8125rem;color:var(--text-muted);">${e.class}</span>${statusIcon}</div>
            <div class="schedule-item-title">${e.title.replace(/ \(마감\)| \(진행중\)/,'')}</div>
            ${e.startDate && e.endDate ? `<div class="schedule-item-meta">📅 ${e.startDate} ~ ${e.endDate}</div>` : ''}
            ${currentTab === 'created' ? `
                <div class="schedule-submit-status"><span>제출 현황</span><span class="submit-count" onclick="event.stopPropagation();toggleSubmitDetail(${e.id})">${e.submitted}/${e.total}명</span></div>
                <div class="submit-detail" id="submitDetail-${e.id}" style="display:none;">
                    <div class="submit-tabs"><button class="submit-tab active">제출자 (${e.submitted})</button><button class="submit-tab">미제출자 (${e.total - e.submitted})</button></div>
                    <div class="submit-list">${generateSubmitList(e.submitted)}</div>
                </div>
            ` : `<div class="schedule-submit-status"><span>나의 제출 상태</span><span class="status-badge ${mySubmitStatus[dateStr]?.submitted ? 'success' : 'danger'}">${mySubmitStatus[dateStr]?.submitted ? '✓ 제출 완료' : '! 미제출'}</span></div>`}
        </div>
    `}).join('');
}

function generateSubmitList(count) {
    const names = ['김철수', '이영희', '박민수', '정수현', '최지원', '한지민', '오세훈', '강미래', '조현우', '신예진'];
    return names.slice(0, Math.min(count, 10)).map(n => `<div class="submit-list-item"><div class="avatar">${n.charAt(0)}</div><span>${n}</span></div>`).join('');
}

function toggleSubmitDetail(eventId) {
    const detail = document.getElementById(`submitDetail-${eventId}`);
    if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
}

function closeSidebar() { document.getElementById('scheduleSidebar').classList.remove('active'); }
function showEventDetail(eventId) { alert(`일정 ID ${eventId}의 상세 페이지로 이동합니다.`); }

// 기한없음 일정 팝업
function openNoDeadlinePopup() {
    renderNoDeadlineList();
    document.getElementById('noDeadlinePopup').classList.add('active');
}

function closeNoDeadlinePopup() {
    document.getElementById('noDeadlinePopup').classList.remove('active');
}

function renderNoDeadlineList() {
    const container = document.getElementById('noDeadlineList');
    const typeLabels = { lesson: '수업', assignment: '과제', evaluation: '평가', survey: '설문' };
    if (noDeadlineEvents.length === 0) {
        container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:2rem;">기한없음 일정이 없습니다.</div>';
        return;
    }
    container.innerHTML = noDeadlineEvents.map(e => {
        const rate = Math.round(e.submitted / e.total * 100);
        const barColor = rate >= 80 ? '#10b981' : rate >= 50 ? '#f59e0b' : '#ef4444';
        return `
        <div class="no-deadline-item" onclick="showEventDetail(${e.id})">
            <div class="no-deadline-item-header">
                <span class="schedule-type-badge ${e.type}">${typeLabels[e.type]}</span>
                <span style="font-size:0.8125rem;color:var(--text-muted);">${e.class}</span>
            </div>
            <div class="no-deadline-item-title">${e.title}</div>
            ${currentTab === 'created' ? `
                <div class="no-deadline-progress">
                    <div class="no-deadline-progress-info">
                        <span>제출 현황</span>
                        <span style="font-weight:600;color:${barColor};">${e.submitted}/${e.total}명 (${rate}%)</span>
                    </div>
                    <div class="no-deadline-progress-bar">
                        <div class="no-deadline-progress-fill" style="width:${rate}%;background:${barColor};"></div>
                    </div>
                </div>
            ` : `
                <div class="no-deadline-progress">
                    <span>나의 제출 상태</span>
                    <span class="status-badge danger">! 미제출</span>
                </div>
            `}
        </div>`;
    }).join('');
}

// 콘텐츠 목록 렌더링
function renderContentLists() {
    document.getElementById('newPostsList').innerHTML = newPostsAll.slice(0, 4).map(p => `<div class="content-item" onclick="openPostDetail(${p.id},'new')"><div class="content-item-title">${p.title}</div><div class="content-item-meta"><span>${p.class}</span><span>${p.date}</span><span>👁 ${p.views}</span><span>❤️ ${p.likes}</span></div></div>`).join('');
    document.getElementById('popularPostsList').innerHTML = popularPostsAll.slice(0, 4).map(p => `<div class="content-item" onclick="openPostDetail(${p.id},'popular')"><div class="content-item-title">${p.title}</div><div class="content-item-meta"><span>${p.class}</span><span>${p.date}</span><span>👁 ${p.views}</span><span>❤️ ${p.likes}</span></div></div>`).join('');
    document.getElementById('surveysList').innerHTML = surveysAll.slice(0, 4).map(s => `<div class="content-item" onclick="openPostDetail(${s.id},'survey')"><div class="content-item-title">${s.title}</div><div class="content-item-meta"><span>📅 ${s.startDate} ~ ${s.endDate}</span><span class="status-badge ${s.submitted ? 'success' : 'danger'}" style="font-size:11px;padding:2px 6px">${s.submitted ? '✓ 제출' : '미제출'}</span><span class="status-badge ${s.status === 'active' ? 'success' : 'warning'}">${s.status === 'active' ? '진행중' : '마감'}</span></div></div>`).join('');
}

// 애니메이션
function animateCounters() {
    document.querySelectorAll('.count-number').forEach(counter => {
        const target = parseInt(counter.dataset.target);
        let current = 0;
        const step = target / 90;
        const update = () => { current += step; if (current < target) { counter.textContent = Math.floor(current); requestAnimationFrame(update); } else { counter.textContent = target; } };
        update();
    });
}

function animateProgressBars() {
    document.querySelectorAll('.progress-bar').forEach(bar => {
        const width = bar.dataset.width;
        if (width) setTimeout(() => bar.style.width = width + '%', 100);
    });
}

function applyFilters() {
    document.querySelectorAll('.count-number').forEach(el => el.textContent = '0');
    document.querySelectorAll('.progress-bar').forEach(el => el.style.width = '0');
    setTimeout(() => { animateCounters(); animateProgressBars(); }, 100);
}

function filterBySubmit(status) {
    document.querySelectorAll('.filter-chip').forEach(chip => chip.classList.toggle('active', chip.textContent.includes(status === 'all' ? '전체' : status === 'completed' ? '제출 완료' : '미제출')));
    renderCalendar();
}

// 개설 클래스 통계 모달
function openStatModal(type) {
    const titles = { attendance: '출석현황 상세', completion: '수업이수율 상세', assignment: '과제제출률 상세', evaluation: '평가진행률 상세' };
    document.getElementById('statModalTitle').textContent = titles[type];
    document.getElementById('statModalBody').innerHTML = `
        <div class="modal-tabs"><button class="modal-tab active">전체 명단</button><button class="modal-tab">참여자</button><button class="modal-tab">미참여자</button></div>
        <table class="data-table"><thead><tr><th>이름</th><th>클래스</th><th>참여</th><th>참여율</th><th>상태</th></tr></thead>
        <tbody>${attendanceData.map(r => `<tr><td>${r.name}</td><td>${r.class}</td><td>${r.attendance}/${r.total}</td><td>${r.rate}%</td><td><span class="status-badge ${r.rate >= 80 ? 'success' : r.rate >= 60 ? 'warning' : 'danger'}">${r.rate >= 80 ? '양호' : r.rate >= 60 ? '주의' : '경고'}</span></td></tr>`).join('')}</tbody></table>`;
    document.getElementById('statModal').classList.add('active');
}

// 참여 클래스 통계 모달
function openJoinedStatModal(type) {
    const titles = { classes: '수강 중인 클래스', lessons: '수업 이수 현황', assignments: '과제 제출 현황', surveys: '설문 참여 현황' };
    document.getElementById('statModalTitle').textContent = titles[type];
    let content = '';
    if (type === 'classes') {
        content = `<div class="modal-tabs"><button class="modal-tab active">전체 (8)</button><button class="modal-tab">활동 중 (6)</button><button class="modal-tab">완료 (2)</button></div>
            <table class="data-table"><thead><tr><th>클래스명</th><th>개설자</th><th>가입일</th><th>상태</th></tr></thead>
            <tbody>${joinedClasses.map(c => `<tr><td>${c.name}</td><td>${c.teacher}</td><td>2024-12-${10 + c.id}</td><td><span class="status-badge success">활동 중</span></td></tr>`).join('')}</tbody></table>`;
    } else if (type === 'lessons') {
        content = `<div class="modal-tabs"><button class="modal-tab active">전체 (30)</button><button class="modal-tab">완료 (24)</button><button class="modal-tab">미완료 (6)</button></div>
            <table class="data-table"><thead><tr><th>수업명</th><th>클래스</th><th>날짜</th><th>상태</th></tr></thead>
            <tbody>${joinedStatsData.lessons.map(i => `<tr><td>${i.title}</td><td>${i.class}</td><td>${i.date}</td><td><span class="status-badge ${i.completed ? 'success' : 'danger'}">${i.completed ? '✓ 완료' : '미완료'}</span></td></tr>`).join('')}</tbody></table>`;
    } else if (type === 'assignments') {
        content = `<div class="modal-tabs"><button class="modal-tab active">전체 (18)</button><button class="modal-tab">제출 완료 (15)</button><button class="modal-tab">미제출 (3)</button></div>
            <table class="data-table"><thead><tr><th>과제명</th><th>클래스</th><th>마감일</th><th>상태</th></tr></thead>
            <tbody>${joinedStatsData.assignments.map(i => `<tr><td>${i.title}</td><td>${i.class}</td><td>${i.dueDate}</td><td><span class="status-badge ${i.submitted ? 'success' : 'danger'}">${i.submitted ? '✓ 제출' : '! 미제출'}</span></td></tr>`).join('')}</tbody></table>`;
    } else {
        content = `<div class="modal-tabs"><button class="modal-tab active">전체 (10)</button><button class="modal-tab">참여 (7)</button><button class="modal-tab">미참여 (3)</button></div>
            <table class="data-table"><thead><tr><th>설문명</th><th>클래스</th><th>상태</th></tr></thead>
            <tbody>${joinedStatsData.surveys.map(i => `<tr><td>${i.title}</td><td>${i.class}</td><td><span class="status-badge ${i.participated ? 'success' : 'warning'}">${i.participated ? '✓ 참여' : '미참여'}</span></td></tr>`).join('')}</tbody></table>`;
    }
    document.getElementById('statModalBody').innerHTML = content;
    document.getElementById('statModal').classList.add('active');
}

// 목록 모달 (15개 - 스크롤)
function openListModal(type) {
    const titles = { 'new-posts': '새로 올라온 글 전체', 'popular-posts': '인기글 전체', 'surveys': '설문 전체' };
    document.getElementById('listModalTitle').textContent = titles[type];
    const data = type === 'new-posts' ? newPostsAll : type === 'popular-posts' ? popularPostsAll : surveysAll;
    document.getElementById('listModalBody').innerHTML = `<div class="list-modal-content">${data.map(item => `
        <div class="content-item" onclick="openPostDetail(${item.id},'${type}')" style="padding:1rem 1.25rem;">
            <div class="content-item-title" style="font-size:1rem;margin-bottom:0.375rem;">${item.title}</div>
            <div class="content-item-meta">
                <span>📁 ${item.class}</span>
                ${item.author ? `<span>✍️ ${item.author}</span>` : ''}
                ${item.date ? `<span>📅 ${item.date}</span>` : ''}
                ${item.views ? `<span>👁 ${item.views}</span>` : ''}
                ${item.likes ? `<span>❤️ ${item.likes}</span>` : ''}
                ${item.responses !== undefined ? `<span>응답 ${item.responses}/${item.total}</span>` : ''}
                ${item.status ? `<span class="status-badge ${item.status === 'active' ? 'success' : 'warning'}">${item.status === 'active' ? '진행중' : '마감'}</span>` : ''}
            </div>
        </div>`).join('')}</div>`;
    document.getElementById('listModal').classList.add('active');
}

function openPostDetail(id, type) {
    const data = type === 'new-posts' || type === 'new' ? newPostsAll : type === 'popular-posts' || type === 'popular' ? popularPostsAll : surveysAll;
    const item = data.find(p => p.id === id) || { title: '글 제목', class: '클래스명', author: '작성자', date: '2025-01-02' };
    document.getElementById('postModalBody').innerHTML = `
        <div style="padding:0.5rem;">
            <h2 style="margin-bottom:1rem;font-size:1.375rem;">${item.title}</h2>
            <div style="display:flex;gap:1rem;color:var(--text-muted);font-size:0.875rem;margin-bottom:1.5rem;flex-wrap:wrap;">
                <span>📁 ${item.class}</span>${item.author ? `<span>✍️ ${item.author}</span>` : ''}${item.date ? `<span>📅 ${item.date}</span>` : ''}${item.views ? `<span>👁 ${item.views}</span>` : ''}
            </div>
            <div style="line-height:1.8;">
                <p>안녕하세요, ${item.class} 회원 여러분!</p><br>
                <p>${item.title}에 대한 상세 내용입니다.</p><br>
                <p>이 글은 프로토타입 예시로 작성되었습니다. 실제 서비스에서는 이 영역에 글의 전체 내용이 표시되며, 댓글, 첨부파일, 좋아요 등의 기능이 함께 제공됩니다.</p><br>
                <p>많은 관심과 참여 부탁드립니다.</p><br><p>감사합니다.</p>
            </div>
        </div>`;
    document.getElementById('postModal').classList.add('active');
}

function closeModal(modalId) { document.getElementById(modalId).classList.remove('active'); }

// 초기화
document.addEventListener('DOMContentLoaded', () => {
    renderStatsGrid();
    renderClassList();
    renderCalendar();
    renderContentLists();
    // 기한없음 일정 건수 초기화
    document.getElementById('noDeadlineCount').textContent = noDeadlineEvents.length;
    document.getElementById('noDeadlinePopupCount').textContent = noDeadlineEvents.length + '건';
    document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('active'); }));

    // 사이드바 바깥 클릭 시 닫기
    document.addEventListener('click', function(e) {
        const sidebar = document.getElementById('scheduleSidebar');
        if (!sidebar || !sidebar.classList.contains('active')) return;
        // 사이드바 내부 클릭이면 무시
        if (sidebar.contains(e.target)) return;
        // 캘린더 날짜 셀 클릭이면 무시 (새로운 날짜 열기이므로 openDaySchedule이 처리)
        if (e.target.closest('.calendar-day') || e.target.closest('.detail-day')) return;
        closeSidebar();
    });

    // fixed 툴팁 (overflow:hidden 부모에서도 잘림 없음)
    const tooltipEl = document.createElement('div');
    tooltipEl.className = 'tooltip-popup';
    document.body.appendChild(tooltipEl);

    document.addEventListener('mouseover', function(e) {
        const target = e.target.closest('.tooltip[data-tooltip]');
        if (!target) return;
        const text = target.getAttribute('data-tooltip');
        if (!text) return;
        tooltipEl.textContent = text;
        tooltipEl.classList.add('visible');
        const rect = target.getBoundingClientRect();
        tooltipEl.style.left = (rect.left + rect.width / 2 - tooltipEl.offsetWidth / 2) + 'px';
        tooltipEl.style.top = (rect.top - tooltipEl.offsetHeight - 8) + 'px';
    });
    document.addEventListener('mouseout', function(e) {
        const target = e.target.closest('.tooltip[data-tooltip]');
        if (target) tooltipEl.classList.remove('visible');
    });

    const observer = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { animateCounters(); animateProgressBars(); observer.unobserve(e.target); } }), { threshold: 0.1 });
    observer.observe(document.getElementById('statsGrid'));
});
