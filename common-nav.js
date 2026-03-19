/**
 * 다채움 공통 네비게이션(GNB) 스크립트
 * 모든 프로토타입 HTML에서 공유하는 네비게이션 컴포넌트
 */
(function () {
    'use strict';

    // ─── 페이지 → 파일 경로 매핑 (프로젝트 루트 기준) ───
    var PAGES = {
        portal:           '01_다채움 포털/dacheum-portal-v4 (4).html',
        hallOfFame:       '01_다채움 포털/hall-of-fame.html',
        // 채움클래스
        myClass:          '02_채움클래스/나의 클래스/dacheum.html',
        classHome:        '02_채움클래스/나의 클래스/01_개별 클래스 홈/class-home-prototype.html',
        classLessonBoard: '02_채움클래스/나의 클래스/02_수업/lesson-board.html',
        classLesson:      '02_채움클래스/나의 클래스/02_수업/dacheum-lesson-player (4).html',
        classLessonCreate:'02_채움클래스/나의 클래스/02_수업/lesson-create.html',
        classHomework:    '02_채움클래스/나의 클래스/03_과제/homework-prototype (1).html',
        classEval:        '02_채움클래스/나의 클래스/04_평가/채움클래스_평가기능_통합_프로토타입.html',
        classNotice:      '02_채움클래스/나의 클래스/05_알림장/다채움_알림장_프로토타입 (2).html',
        classAttend:      '02_채움클래스/나의 클래스/06_출석부/채움클래스_출석부_프로토타입 (3).html',
        classBoard:       '02_채움클래스/나의 클래스/07_일반게시판/class-board.html',
        classMessage:     '02_채움클래스/나의 클래스/08_소통쪽지/class-message.html',
        classSurvey:      '02_채움클래스/나의 클래스/09_설문/class-survey.html',
        classManage:      '02_채움클래스/클래스 관리/class-manage-v2 (1).html',
        classFind:        '02_채움클래스/클래스 찾기/class-find-v2.html',
        classAnalytics:   '02_채움클래스/클래스별 학습분석/class-analytics-improved.html',
        // 채움콘텐츠
        contentsBrowse:   '03_채움콘텐츠/채움콘텐츠_프로토타입_v2 (1).html',
        studentGallery:   '03_채움콘텐츠/나도예술가/student-gallery.html',
        // 스스로채움
        aiLearning:       '04_스스로채움/AI 맞춤 학습/learning_map (4).html',
        todayLearning:    '04_스스로채움/오늘의 학습/today-learning-prototype (3).html',
        wrongNote:        '04_스스로채움/오답노트/index.html',
        // 우리반 성장기록
        growthDashboard:  '05_우리반 성장기록/class-growth-dashboard.html',
        growthReport:     '05_우리반 성장기록/student-growth-report (1).html',
        portfolio:        '05_우리반 성장기록/학생 포트폴리오 예시안/student-portfolio (1).html',
        portfolioDetail:  '05_우리반 성장기록/학생 포트폴리오 예시안/Portfolid.html',
        // 채움CBT
        cbtService:       '06_채움CBT/채움CBT_전체서비스_프로토타입_v2 (3).html',
        cbtPlayer:        '06_채움CBT/채움CBT_평가지플레이어_프로토타입.html',
        // LRS 학습분석
        lrsDashboard:     '07_LRS 대시보드/lrs-dashboard.html'
    };

    // ─── 메뉴 구조 정의 ───
    var MENU = [
        {
            id: 'chaeumClass',
            label: '채움클래스',
            sub: [
                { id: 'myClass',        label: '나의 클래스',       page: 'myClass' },
                { id: 'classManage',    label: '클래스 관리',       page: 'classManage' },
                { id: 'classFind',      label: '클래스 찾기',       page: 'classFind' },
                { id: 'classAnalytics', label: '클래스별 학습분석', page: 'classAnalytics' }
            ]
        },
        {
            id: 'chaeumContents',
            label: '채움콘텐츠',
            sub: [
                { id: 'contentsPublic',    label: '공개콘텐츠',           page: 'contentsBrowse', hash: 'public' },
                { id: 'contentsRecommend', label: '추천콘텐츠',           page: 'contentsBrowse', hash: 'recommend' },
                { id: 'contentsSearchStd', label: '성취기준별 콘텐츠 찾기', page: 'contentsBrowse', hash: 'search-std' },
                { id: 'contentsArchive',   label: '나의 보관함',           page: 'contentsBrowse', hash: 'dashboard' }
            ]
        },
        {
            id: 'selfChaeum',
            label: '스스로채움',
            sub: [
                { id: 'todayLearning', label: '오늘의 학습',    page: 'todayLearning' },
                { id: 'aiLearning',    label: 'AI 맞춤 학습',   page: 'aiLearning' },
                { id: 'wrongNote',     label: '오답노트',       page: 'wrongNote' }
            ]
        },
        {
            id: 'growthRecord',
            label: '우리반 성장기록',
            sub: [
                { id: 'growthDashboard', label: '학습분석 대시보드', page: 'growthDashboard' },
                { id: 'growthReport',    label: '학생 성장 리포트',  page: 'growthReport' },
                { id: 'portfolio',       label: '학생 포트폴리오',   page: 'portfolio' }
            ]
        },
        {
            id: 'chaeumGrowth',
            label: '채움성장',
            sub: [
                { id: 'studentGallery', label: '나도 예술가', page: 'studentGallery' }
            ]
        },
        {
            id: 'chaeumCBT',
            label: '채움CBT',
            sub: [
                { id: 'cbtBoard',   label: 'CBT 목록',     page: 'cbtService', hash: 'cbt-list' },
                { id: 'cbtArchive', label: '나의 보관함',   page: 'cbtService', hash: 'my-exams' }
            ]
        },
        {
            id: 'lrsAnalytics',
            label: 'LRS 학습분석',
            sub: [
                { id: 'lrsDashboard', label: '학습분석 대시보드', page: 'lrsDashboard' }
            ]
        }
    ];

    // 클래스 홈 내부 탭 (나의 클래스 하위 페이지)
    var CLASS_HOME_TABS = [
        { id: 'classHome',     label: '클래스 홈', page: 'classHome' },
        { id: 'classLessonBoard', label: '수업',    page: 'classLessonBoard' },
        { id: 'classHomework', label: '과제',      page: 'classHomework' },
        { id: 'classEval',     label: '평가',      page: 'classEval' },
        { id: 'classNotice',   label: '알림장',    page: 'classNotice' },
        { id: 'classAttend',   label: '출석부',    page: 'classAttend' },
        { id: 'classBoard',    label: '게시판',    page: 'classBoard' },
        { id: 'classMessage',  label: '소통쪽지',  page: 'classMessage' },
        { id: 'classSurvey',   label: '설문',      page: 'classSurvey' }
    ];

    // 클래스 홈 탭 별칭 (하위 페이지 → 탭 ID 매핑)
    // 수업 플레이어는 수업 게시판 탭으로 표시
    var CLASS_HOME_ALIASES = {
        'classLesson': 'classLessonBoard',
        'classLessonCreate': 'classLessonBoard'
    };

    // 채움콘텐츠 나의 보관함 3차 탭
    var CONTENTS_ARCHIVE_TABS = [
        { id: 'contentsDashboard',     label: '콘텐츠 대시보드', hash: 'dashboard' },
        { id: 'contentsMydata',        label: '내자료',      hash: 'mydata' },
        { id: 'contentsSaved',         label: '담은자료',    hash: 'saved' },
        { id: 'contentsSubscriptions', label: '구독 채널',   hash: 'subscriptions' },
        { id: 'contentsChannel',       label: '내 채널 관리', hash: 'mychannel' }
    ];

    // 나의 보관함에 해당하는 해시 목록
    var ARCHIVE_HASHES = ['dashboard', 'mydata', 'saved', 'subscriptions', 'mychannel'];

    // 채움CBT 나의 보관함 3차 탭
    var CBT_ARCHIVE_TABS = [
        { id: 'cbtMyExams',   label: '평가지 관리',    hash: 'my-exams' },
        { id: 'cbtMyResults', label: '내 응시결과',     hash: 'my-results' }
    ];

    // CBT 나의 보관함에 해당하는 해시 목록
    var CBT_ARCHIVE_HASHES = ['my-exams', 'my-results', 'teacher-result'];

    // ─── 현재 페이지 식별 ───
    var currentPageId = document.body.getAttribute('data-gnb-page') || '';
    var currentHash = window.location.hash.replace('#', '');

    // 현재 페이지가 어느 메인 메뉴에 속하는지 판별
    function getActiveMainMenu() {
        if (currentPageId === 'portal') return 'portal';
        if (isClassHomeTab()) return 'chaeumClass';
        if (currentPageId === 'contentsBrowse') return 'chaeumContents';
        if (currentPageId === 'cbtService' || currentPageId === 'cbtPlayer') return 'chaeumCBT';
        for (var i = 0; i < MENU.length; i++) {
            var group = MENU[i];
            for (var j = 0; j < group.sub.length; j++) {
                if (group.sub[j].id === currentPageId) return group.id;
            }
        }
        if (currentPageId === 'portfolioDetail') return 'growthRecord';
        return '';
    }

    // 현재 페이지가 어느 서브메뉴에 속하는지 판별
    function getActiveSubMenu() {
        if (isClassHomeTab()) return 'myClass';
        if (currentPageId === 'contentsBrowse') {
            if (currentHash === 'recommend') return 'contentsRecommend';
            if (currentHash === 'public') return 'contentsPublic';
            if (currentHash === 'search-std') return 'contentsSearchStd';
            return 'contentsPublic';
        }
        if (currentPageId === 'cbtService' || currentPageId === 'cbtPlayer') {
            if (currentHash === 'my-exams' || currentHash === 'my-results' || currentHash === 'teacher-result') return 'cbtArchive';
            return 'cbtBoard';
        }
        return currentPageId;
    }

    function isClassHomeTab() {
        var classHomeTabs = CLASS_HOME_TABS.map(function(t){ return t.id; });
        return classHomeTabs.indexOf(currentPageId) !== -1 || !!CLASS_HOME_ALIASES[currentPageId];
    }

    // 클래스 홈 탭에서 활성 탭 ID 반환
    function getActiveClassTab() {
        return CLASS_HOME_ALIASES[currentPageId] || currentPageId;
    }

    function isContentsArchive() {
        return currentPageId === 'contentsBrowse' &&
            (ARCHIVE_HASHES.indexOf(currentHash) !== -1);
    }

    function isCbtArchive() {
        return currentPageId === 'cbtService' &&
            (CBT_ARCHIVE_HASHES.indexOf(currentHash) !== -1);
    }

    // ─── 상대 경로 계산 ───
    function getRelativePath(targetPage) {
        var targetPath = PAGES[targetPage];
        if (!targetPath) return '#';
        var basePath = document.body.getAttribute('data-gnb-base') || '';
        if (!basePath) return encodePathSegments(targetPath);
        return basePath + encodePathSegments(targetPath);
    }

    function encodePathSegments(path) {
        return path.split('/').map(function(seg) {
            return encodeURIComponent(seg);
        }).join('/');
    }

    // ─── 토스트 알림 ───
    function showToast(msg) {
        var existing = document.querySelector('.gnb-toast');
        if (existing) existing.remove();
        var toast = document.createElement('div');
        toast.className = 'gnb-toast';
        toast.textContent = msg;
        document.body.appendChild(toast);
        requestAnimationFrame(function() {
            toast.classList.add('show');
        });
        setTimeout(function() {
            toast.classList.remove('show');
            setTimeout(function() { toast.remove(); }, 300);
        }, 2000);
    }

    // ─── HTML 생성 ───
    function buildGNB() {
        var wrapper = document.createElement('div');
        wrapper.id = 'dacheum-gnb-wrapper';

        var activeMain = getActiveMainMenu();
        var activeSub = getActiveSubMenu();

        // === 메인 헤더 ===
        var header = document.createElement('div');
        header.className = 'gnb-header';

        // 로고
        var logoLink = document.createElement('a');
        logoLink.className = 'gnb-logo';
        logoLink.href = getRelativePath('portal');
        logoLink.innerHTML = '<svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="14" fill="#2563eb"/><text x="16" y="21" text-anchor="middle" fill="white" font-size="14" font-weight="700" font-family="Pretendard,sans-serif">D</text></svg>다채움';
        header.appendChild(logoLink);

        // 메인 메뉴
        var mainNav = document.createElement('nav');
        mainNav.className = 'gnb-main-nav';

        // === 서브 메뉴 컨테이너 (동적) ===
        var subNavContainer = document.createElement('div');
        subNavContainer.id = 'gnb-sub-container';

        // 포털인지 하위 페이지인지 판별
        var isPortal = (!activeMain || activeMain === 'portal');

        // 바디 패딩 업데이트
        function updateBodyPadding() {
            document.body.classList.remove('gnb-has-header', 'gnb-has-sub', 'gnb-has-sub-multi');
            var count = subNavContainer.querySelectorAll('.gnb-sub-nav.visible').length;
            if (count >= 1) {
                var totalHeight = 56 + 44 * count;
                document.body.style.setProperty('--gnb-total-height', totalHeight + 'px');
                document.body.classList.add('gnb-has-sub');
            } else {
                document.body.classList.add('gnb-has-header');
            }
        }

        if (isPortal) {
            // ═══ 포털: 1차 메뉴를 헤더에 표시 ═══
            MENU.forEach(function(group) {
                var item = document.createElement('div');
                item.className = 'gnb-main-item';

                var label = document.createElement('span');
                label.textContent = group.label;
                item.appendChild(label);

                item.addEventListener('click', function() {
                    var firstSub = group.sub[0];
                    if (firstSub && firstSub.page) {
                        var href = getRelativePath(firstSub.page);
                        if (firstSub.hash) href += '#' + firstSub.hash;
                        window.location.href = href;
                    }
                });

                mainNav.appendChild(item);
            });
        } else {
            // ═══ 하위 페이지: 2차 메뉴를 헤더(1차 자리)에 표시 ═══
            var activeGroup = null;
            for (var gi = 0; gi < MENU.length; gi++) {
                if (MENU[gi].id === activeMain) { activeGroup = MENU[gi]; break; }
            }

            if (activeGroup) {
                var curActiveSub = getActiveSubMenu();
                var showClassTabs = isClassHomeTab();
                var showArchiveTabs = isContentsArchive();
                var showCbtArchiveTabs = isCbtArchive();

                // 2차 메뉴를 헤더 nav에 삽입 (1차 메뉴 자리)
                activeGroup.sub.forEach(function(sub) {
                    var item = document.createElement('div');
                    item.className = 'gnb-main-item';
                    // 활성 상태 판별
                    if (showClassTabs && sub.id === 'myClass') item.className += ' active';
                    else if (showArchiveTabs && sub.id === 'contentsArchive') item.className += ' active';
                    else if (showCbtArchiveTabs && sub.id === 'cbtArchive') item.className += ' active';
                    else if (!showClassTabs && !showArchiveTabs && !showCbtArchiveTabs && sub.id === curActiveSub) item.className += ' active';

                    var label = document.createElement('span');
                    label.textContent = sub.label;
                    item.appendChild(label);

                    if (sub.page) {
                        item.addEventListener('click', (function(s) {
                            return function() {
                                var href = getRelativePath(s.page);
                                if (s.hash) href += '#' + s.hash;
                                window.location.href = href;
                            };
                        })(sub));
                    } else {
                        item.classList.add('disabled');
                        item.addEventListener('click', function(e) { e.preventDefault(); showToast('준비 중입니다'); });
                    }

                    mainNav.appendChild(item);
                });

                // 3차 메뉴를 서브 컨테이너에 삽입 (2차 자리)
                if (showClassTabs) {
                    var tabNav = document.createElement('div');
                    tabNav.className = 'gnb-sub-nav visible';
                    CLASS_HOME_TABS.forEach(function(tab) {
                        var a = document.createElement('a');
                        a.className = 'gnb-sub-item' + (tab.id === getActiveClassTab() ? ' active' : '');
                        a.textContent = tab.label;
                        a.href = getRelativePath(tab.page);
                        tabNav.appendChild(a);
                    });
                    subNavContainer.appendChild(tabNav);
                }

                if (showArchiveTabs) {
                    var archiveNav = document.createElement('div');
                    archiveNav.className = 'gnb-sub-nav visible';
                    CONTENTS_ARCHIVE_TABS.forEach(function(tab) {
                        var a = document.createElement('a');
                        var tabActive = (tab.hash === currentHash) || (!currentHash && tab.hash === 'dashboard');
                        a.className = 'gnb-sub-item' + (tabActive ? ' active' : '');
                        a.textContent = tab.label;
                        a.href = '#' + tab.hash;
                        archiveNav.appendChild(a);
                    });
                    subNavContainer.appendChild(archiveNav);
                }

                if (showCbtArchiveTabs) {
                    var cbtArchiveNav = document.createElement('div');
                    cbtArchiveNav.className = 'gnb-sub-nav visible';
                    CBT_ARCHIVE_TABS.forEach(function(tab) {
                        var tabActive = (tab.hash === currentHash) || (currentHash === 'teacher-result' && tab.hash === 'my-exams');
                        var a = document.createElement('a');
                        a.className = 'gnb-sub-item' + (tabActive ? ' active' : '');
                        a.textContent = tab.label;
                        a.href = '#' + tab.hash;
                        cbtArchiveNav.appendChild(a);
                    });
                    subNavContainer.appendChild(cbtArchiveNav);
                }
            }
        }

        header.appendChild(mainNav);

        // 우측 유틸
        var util = document.createElement('div');
        util.className = 'gnb-util';

        var hamburger = document.createElement('button');
        hamburger.className = 'gnb-hamburger';
        if (!isPortal) hamburger.style.display = 'flex'; // 하위 페이지에서 항상 표시
        hamburger.innerHTML = '<span></span>';
        hamburger.setAttribute('aria-label', '메뉴');
        util.appendChild(hamburger);

        var user = document.createElement('div');
        user.className = 'gnb-user';
        user.innerHTML = '<span>문 선생님</span><div class="gnb-user-avatar">문</div>';
        util.appendChild(user);

        header.appendChild(util);
        wrapper.appendChild(header);

        // 서브메뉴 컨테이너 삽입
        wrapper.appendChild(subNavContainer);

        // 바디 패딩 업데이트
        updateBodyPadding();

        // === 모바일 메뉴 패널 ===
        var mobilePanel = document.createElement('div');
        mobilePanel.className = 'gnb-mobile-panel';

        var portalSection = document.createElement('div');
        portalSection.className = 'gnb-mobile-section';
        var portalLink = document.createElement('a');
        portalLink.className = 'gnb-mobile-sub-item' + (currentPageId === 'portal' ? ' active' : '');
        portalLink.href = getRelativePath('portal');
        portalLink.textContent = '다채움 포털';
        portalLink.style.paddingLeft = '20px';
        portalLink.style.fontWeight = '600';
        portalLink.style.fontSize = '15px';
        portalSection.appendChild(portalLink);
        mobilePanel.appendChild(portalSection);

        MENU.forEach(function(group) {
            var section = document.createElement('div');
            section.className = 'gnb-mobile-section';

            var title = document.createElement('div');
            title.className = 'gnb-mobile-section-title' + (activeMain === group.id ? ' active' : '');
            title.innerHTML = '<span>' + group.label + '</span><span class="arrow">▼</span>';

            var subList = document.createElement('div');
            subList.className = 'gnb-mobile-sub-list' + (activeMain === group.id ? ' open' : '');

            if (activeMain === group.id) {
                title.classList.add('expanded');
            }

            group.sub.forEach(function(sub) {
                var a = document.createElement('a');
                a.className = 'gnb-mobile-sub-item' + (activeSub === sub.id ? ' active' : '');
                a.textContent = sub.label;
                if (sub.page) {
                    var href = getRelativePath(sub.page);
                    if (sub.hash) href += '#' + sub.hash;
                    a.href = href;
                } else {
                    a.className += ' disabled';
                    a.href = '#';
                    a.onclick = function(e) { e.preventDefault(); showToast('준비 중입니다'); };
                }
                subList.appendChild(a);
            });

            title.addEventListener('click', function() {
                var isOpen = subList.classList.contains('open');
                mobilePanel.querySelectorAll('.gnb-mobile-sub-list').forEach(function(el) { el.classList.remove('open'); });
                mobilePanel.querySelectorAll('.gnb-mobile-section-title').forEach(function(el) { el.classList.remove('expanded'); });
                if (!isOpen) {
                    subList.classList.add('open');
                    title.classList.add('expanded');
                }
            });

            section.appendChild(title);
            section.appendChild(subList);
            mobilePanel.appendChild(section);
        });

        wrapper.appendChild(mobilePanel);

        // === 오버레이 ===
        var overlay = document.createElement('div');
        overlay.className = 'gnb-overlay';
        wrapper.appendChild(overlay);

        // === 햄버거 토글 ===
        hamburger.addEventListener('click', function() {
            var isOpen = mobilePanel.classList.contains('open');
            mobilePanel.classList.toggle('open');
            overlay.classList.toggle('open');
            hamburger.classList.toggle('open');
            document.body.style.overflow = isOpen ? '' : 'hidden';
        });

        overlay.addEventListener('click', function() {
            mobilePanel.classList.remove('open');
            overlay.classList.remove('open');
            hamburger.classList.remove('open');
            document.body.style.overflow = '';
        });

        // === 채움콘텐츠 SPA: 해시 변경 시 서브메뉴 업데이트 ===
        if (currentPageId === 'contentsBrowse') {
            window.addEventListener('hashchange', function() {
                currentHash = window.location.hash.replace('#', '');
                // 헤더(2차) active 갱신
                var newActiveSub = getActiveSubMenu();
                var items = mainNav.querySelectorAll('.gnb-main-item');
                var activeGroup = null;
                for (var i = 0; i < MENU.length; i++) { if (MENU[i].id === 'chaeumContents') { activeGroup = MENU[i]; break; } }
                if (activeGroup) {
                    items.forEach(function(el, idx) {
                        el.classList.remove('active');
                        if (activeGroup.sub[idx] && activeGroup.sub[idx].id === newActiveSub) el.classList.add('active');
                        // 나의 보관함 활성 (archive 해시)
                        if (activeGroup.sub[idx] && activeGroup.sub[idx].id === 'contentsArchive' && ARCHIVE_HASHES.indexOf(currentHash) !== -1) el.classList.add('active');
                    });
                }
                // 3차 메뉴 갱신
                subNavContainer.innerHTML = '';
                if (ARCHIVE_HASHES.indexOf(currentHash) !== -1) {
                    var archiveNav = document.createElement('div');
                    archiveNav.className = 'gnb-sub-nav visible';
                    CONTENTS_ARCHIVE_TABS.forEach(function(tab) {
                        var a = document.createElement('a');
                        var tabActive = (tab.hash === currentHash) || (!currentHash && tab.hash === 'dashboard');
                        a.className = 'gnb-sub-item' + (tabActive ? ' active' : '');
                        a.textContent = tab.label;
                        a.href = '#' + tab.hash;
                        archiveNav.appendChild(a);
                    });
                    subNavContainer.appendChild(archiveNav);
                }
                updateBodyPadding();
            });
        }

        // === 채움CBT SPA: 해시 변경 시 서브메뉴 업데이트 ===
        if (currentPageId === 'cbtService') {
            window.addEventListener('hashchange', function() {
                currentHash = window.location.hash.replace('#', '');
                var newActiveSub = getActiveSubMenu();
                var items = mainNav.querySelectorAll('.gnb-main-item');
                var activeGroup = null;
                for (var i = 0; i < MENU.length; i++) { if (MENU[i].id === 'chaeumCBT') { activeGroup = MENU[i]; break; } }
                if (activeGroup) {
                    items.forEach(function(el, idx) {
                        el.classList.remove('active');
                        if (activeGroup.sub[idx] && activeGroup.sub[idx].id === newActiveSub) el.classList.add('active');
                        if (activeGroup.sub[idx] && activeGroup.sub[idx].id === 'cbtArchive' && CBT_ARCHIVE_HASHES.indexOf(currentHash) !== -1) el.classList.add('active');
                    });
                }
                subNavContainer.innerHTML = '';
                if (CBT_ARCHIVE_HASHES.indexOf(currentHash) !== -1) {
                    var cbtArchiveNav = document.createElement('div');
                    cbtArchiveNav.className = 'gnb-sub-nav visible';
                    CBT_ARCHIVE_TABS.forEach(function(tab) {
                        var tabActive = (tab.hash === currentHash) || (currentHash === 'teacher-result' && tab.hash === 'my-exams');
                        var a = document.createElement('a');
                        a.className = 'gnb-sub-item' + (tabActive ? ' active' : '');
                        a.textContent = tab.label;
                        a.href = '#' + tab.hash;
                        cbtArchiveNav.appendChild(a);
                    });
                    subNavContainer.appendChild(cbtArchiveNav);
                }
                updateBodyPadding();
            });
        }

        return wrapper;
    }

    // ─── GNB 삽입 ───
    function initGNB() {
        if (document.getElementById('dacheum-gnb-wrapper')) return;

        var gnb = buildGNB();
        document.body.insertBefore(gnb, document.body.firstChild);

        // 기존 헤더의 position: fixed 재조정
        var adjustHeader = document.body.getAttribute('data-gnb-adjust-header');
        if (adjustHeader) {
            var subNavCount = gnb.querySelectorAll('.gnb-sub-nav.visible').length;
            var gnbHeight = subNavCount >= 2 ? (56 + 44 * subNavCount) : (subNavCount === 1 ? 100 : 56);
            var selectors2 = adjustHeader.split(',');
            selectors2.forEach(function(sel) {
                var el = document.querySelector(sel.trim());
                if (el) {
                    var currentTop = parseInt(getComputedStyle(el).top) || 0;
                    el.style.top = (currentTop + gnbHeight) + 'px';
                }
            });
            var fixedElements = document.querySelectorAll('.sidebar, .lesson-sidebar, .main-content');
            fixedElements.forEach(function(el) {
                var style = getComputedStyle(el);
                if (style.position === 'fixed' || style.position === 'absolute') {
                    var currentTop = parseInt(style.top) || 0;
                    el.style.top = (currentTop + gnbHeight) + 'px';
                }
                if (style.height && style.height.indexOf('calc') !== -1) {
                    el.style.height = 'calc(' + style.height + ' - ' + gnbHeight + 'px)';
                }
            });
        }
    }

    // DOM 준비되면 실행
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGNB);
    } else {
        initGNB();
    }
})();
