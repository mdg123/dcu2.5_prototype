// 전역 변수
let isTeacherMode = true;
let subjectChart, trendChart, studentSubjectChart, studentTrendChart;

// DOM 로드 완료 후 초기화
document.addEventListener('DOMContentLoaded', function() {
    initTabs();
    initUserToggle();
    initFilters();
    initCharts();
    updateViewMode();
});

// 탭 초기화
function initTabs() {
    const tabLinks = document.querySelectorAll('.tab-link');
    
    tabLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            
            // 모든 탭 비활성화
            tabLinks.forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            // 클릭된 탭 활성화
            this.classList.add('active');
            const tabId = this.getAttribute('data-tab');
            document.getElementById(tabId).classList.add('active');
        });
    });
}

// 사용자 유형 토글 (교사/학생)
function initUserToggle() {
    const btnTeacher = document.getElementById('btnTeacher');
    const btnStudent = document.getElementById('btnStudent');
    
    btnTeacher.addEventListener('click', function() {
        isTeacherMode = true;
        btnTeacher.classList.add('active');
        btnStudent.classList.remove('active');
        updateViewMode();
    });
    
    btnStudent.addEventListener('click', function() {
        isTeacherMode = false;
        btnStudent.classList.add('active');
        btnTeacher.classList.remove('active');
        updateViewMode();
    });
}

// 화면 모드 업데이트
function updateViewMode() {
    const teacherDashboard = document.getElementById('teacherDashboard');
    const studentDashboard = document.getElementById('studentDashboard');
    const tabAnalysis = document.getElementById('tabAnalysis');
    const studentFilterGroup = document.getElementById('studentFilterGroup');
    const questionStudentFilterGroup = document.getElementById('questionStudentFilterGroup');
    const tagFilterGroup = document.getElementById('tagFilterGroup');
    const btnAddQuestion = document.getElementById('btnAddQuestion');
    const classErrorRate = document.getElementById('classErrorRate');
    const teacherQuestionActions = document.getElementById('teacherQuestionActions');
    const currentUserName = document.getElementById('currentUserName');
    const currentUserRole = document.getElementById('currentUserRole');
    const pageDesc = document.getElementById('pageDesc');
    
    // 태그 관련 요소들
    const tagCols = document.querySelectorAll('.tag-col');
    const tagBtns = document.querySelectorAll('.tag-btn');
    
    if (isTeacherMode) {
        // 교사 모드
        teacherDashboard.style.display = 'block';
        studentDashboard.style.display = 'none';
        tabAnalysis.style.display = 'block';
        studentFilterGroup.style.display = 'flex';
        questionStudentFilterGroup.style.display = 'flex';
        tagFilterGroup.style.display = 'none';
        btnAddQuestion.style.display = 'none';
        classErrorRate.style.display = 'block';
        teacherQuestionActions.style.display = 'flex';
        currentUserName.textContent = '박선생';
        currentUserRole.textContent = '교사';
        pageDesc.textContent = '학생들의 오답 현황을 종합적으로 분석하고 맞춤형 학습을 지원합니다.';
        
        tagCols.forEach(col => col.style.display = 'none');
        tagBtns.forEach(btn => btn.style.display = 'none');
        
        // 차트 초기화
        setTimeout(() => {
            initTeacherCharts();
        }, 100);
    } else {
        // 학생 모드
        teacherDashboard.style.display = 'none';
        studentDashboard.style.display = 'block';
        tabAnalysis.style.display = 'none';
        studentFilterGroup.style.display = 'none';
        questionStudentFilterGroup.style.display = 'none';
        tagFilterGroup.style.display = 'flex';
        btnAddQuestion.style.display = 'inline-flex';
        classErrorRate.style.display = 'none';
        teacherQuestionActions.style.display = 'none';
        currentUserName.textContent = '김하늘';
        currentUserRole.textContent = '학생';
        pageDesc.textContent = '나의 오답을 분석하고 취약한 부분을 집중적으로 학습합니다.';
        
        tagCols.forEach(col => col.style.display = 'table-cell');
        tagBtns.forEach(btn => btn.style.display = 'inline-flex');
        
        // 차트 초기화
        setTimeout(() => {
            initStudentCharts();
        }, 100);
    }
}

// 필터 초기화
function initFilters() {
    const periodFilter = document.getElementById('periodFilter');
    const dateRange = document.getElementById('dateRange');
    
    if (periodFilter) {
        periodFilter.addEventListener('change', function() {
            if (this.value === 'custom') {
                dateRange.style.display = 'flex';
            } else {
                dateRange.style.display = 'none';
            }
        });
    }
}

// 차트 초기화
function initCharts() {
    initTeacherCharts();
}

// 교사용 차트 초기화
function initTeacherCharts() {
    // 기존 차트 제거
    if (subjectChart) subjectChart.destroy();
    if (trendChart) trendChart.destroy();
    
    // 과목별 오답 분포 차트
    const subjectCtx = document.getElementById('subjectChart');
    if (subjectCtx) {
        subjectChart = new Chart(subjectCtx, {
            type: 'doughnut',
            data: {
                labels: ['수학', '사회', '영어', '과학', '국어'],
                datasets: [{
                    data: [35, 25, 20, 12, 8],
                    backgroundColor: [
                        '#3b82f6',
                        '#f59e0b',
                        '#10b981',
                        '#8b5cf6',
                        '#ec4899'
                    ],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            usePointStyle: true,
                            padding: 20
                        }
                    }
                }
            }
        });
    }
    
    // 오답 해결 추이 차트
    const trendCtx = document.getElementById('trendChart');
    if (trendCtx) {
        trendChart = new Chart(trendCtx, {
            type: 'line',
            data: {
                labels: ['1주차', '2주차', '3주차', '4주차'],
                datasets: [
                    {
                        label: '발생 오답',
                        data: [45, 52, 38, 41],
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        tension: 0.4,
                        fill: true
                    },
                    {
                        label: '해결 오답',
                        data: [30, 45, 35, 48],
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        tension: 0.4,
                        fill: true
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    }
}

// 학생용 차트 초기화
function initStudentCharts() {
    // 기존 차트 제거
    if (studentSubjectChart) studentSubjectChart.destroy();
    if (studentTrendChart) studentTrendChart.destroy();
    
    // 나의 과목별 오답 분포 차트
    const studentSubjectCtx = document.getElementById('studentSubjectChart');
    if (studentSubjectCtx) {
        studentSubjectChart = new Chart(studentSubjectCtx, {
            type: 'doughnut',
            data: {
                labels: ['수학', '사회', '영어'],
                datasets: [{
                    data: [45, 35, 20],
                    backgroundColor: [
                        '#3b82f6',
                        '#f59e0b',
                        '#10b981'
                    ],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            usePointStyle: true,
                            padding: 20
                        }
                    }
                }
            }
        });
    }
    
    // 나의 해결 추이 차트
    const studentTrendCtx = document.getElementById('studentTrendChart');
    if (studentTrendCtx) {
        studentTrendChart = new Chart(studentTrendCtx, {
            type: 'bar',
            data: {
                labels: ['1주차', '2주차', '3주차', '4주차'],
                datasets: [
                    {
                        label: '미해결',
                        data: [8, 6, 5, 3],
                        backgroundColor: '#fee2e2',
                        borderColor: '#ef4444',
                        borderWidth: 1
                    },
                    {
                        label: '해결',
                        data: [5, 8, 10, 12],
                        backgroundColor: '#d1fae5',
                        borderColor: '#10b981',
                        borderWidth: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top'
                    }
                },
                scales: {
                    x: {
                        stacked: true
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true
                    }
                }
            }
        });
    }
}

// 모달 열기
function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

// 모달 닫기
function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// 결과 팝업 표시
function showResultPopup() {
    openModal('resultModal');
}

// 문항 상세 보기
function showQuestionDetail() {
    showToast('문항 상세 화면으로 이동합니다.');
}

// 오답 학생 목록 표시
function showWrongStudents() {
    openModal('wrongStudentsModal');
}

// 추천 콘텐츠 연결 팝업
function showRecommendPopup() {
    openModal('recommendModal');
}

// 태그 팝업 표시
function showTagPopup(btn) {
    openModal('tagModal');
}

// 태그 저장
function saveTag() {
    closeModal('tagModal');
    showToast('태그가 저장되었습니다.');
}

// 필수 복습 지정
function setRequiredReview() {
    showToast('필수 복습 문항으로 지정되었습니다.');
}

// 학생 상세 보기
function showStudentDetail(studentId) {
    showToast('학생 상세 화면으로 이동합니다.');
}

// 취약 영역 필터링
function filterByWeakness(subject) {
    // 탭 전환
    document.querySelectorAll('.tab-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    document.querySelector('[data-tab="byQuestion"]').classList.add('active');
    document.getElementById('byQuestion').classList.add('active');
    
    showToast('취약 영역 문항을 필터링합니다.');
}

// 토스트 메시지 표시
function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// 모달 외부 클릭시 닫기
document.addEventListener('click', function(e) {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('active');
    }
});

// 키보드 ESC로 모달 닫기
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal.active').forEach(modal => {
            modal.classList.remove('active');
        });
    }
});
