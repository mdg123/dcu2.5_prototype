const db = require('./index');
const bcrypt = require('bcryptjs');

function initSchema() {
  db.exec(`
    -- ============ 사용자 ============
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT DEFAULT 'student',
      school_name TEXT,
      grade INTEGER,
      class_number INTEGER,
      email TEXT,
      phone TEXT,
      status TEXT DEFAULT 'active',
      profile_image_url TEXT,
      bio TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME,
      CHECK(role IN ('student', 'teacher', 'parent', 'staff', 'admin')),
      CHECK(status IN ('active', 'inactive', 'suspended', 'deleted'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      link TEXT,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

    -- ============ 클래스 ============
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      owner_id INTEGER NOT NULL,
      class_type TEXT DEFAULT '기타',
      subject TEXT,
      school_name TEXT,
      grade INTEGER,
      class_number INTEGER,
      semester INTEGER,
      academic_year INTEGER,
      status TEXT DEFAULT 'active',
      is_public INTEGER DEFAULT 1,
      cover_image_url TEXT,
      settings TEXT,
      enabled_tabs TEXT DEFAULT NULL,
      member_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id),
      CHECK(status IN ('active', 'archived', 'deleted'))
    );

    CREATE INDEX IF NOT EXISTS idx_classes_code ON classes(code);
    CREATE INDEX IF NOT EXISTS idx_classes_owner ON classes(owner_id);
    CREATE INDEX IF NOT EXISTS idx_classes_status ON classes(status);

    CREATE TABLE IF NOT EXISTS class_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT DEFAULT 'student',
      status TEXT DEFAULT 'active',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(class_id, user_id),
      CHECK(role IN ('owner', 'member')),
      CHECK(status IN ('active', 'invited', 'left', 'removed'))
    );

    CREATE INDEX IF NOT EXISTS idx_class_members_class ON class_members(class_id);
    CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(user_id);

    -- ============ 수업 ============
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      teacher_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      content TEXT,
      lesson_date DATE,
      lesson_order INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      view_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (teacher_id) REFERENCES users(id),
      CHECK(status IN ('draft', 'published', 'archived'))
    );

    CREATE INDEX IF NOT EXISTS idx_lessons_class ON lessons(class_id, status);

    CREATE TABLE IF NOT EXISTS lesson_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      file_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
    );

    -- ============ 과제 ============
    CREATE TABLE IF NOT EXISTS homework (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      teacher_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      content TEXT,
      due_date DATETIME,
      max_score INTEGER DEFAULT 100,
      status TEXT DEFAULT 'draft',
      allow_late INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (teacher_id) REFERENCES users(id),
      CHECK(status IN ('draft', 'published', 'closed', 'archived'))
    );

    CREATE INDEX IF NOT EXISTS idx_homework_class ON homework(class_id, status);

    CREATE TABLE IF NOT EXISTS homework_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      homework_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      content TEXT,
      file_path TEXT,
      file_name TEXT,
      score INTEGER,
      feedback TEXT,
      status TEXT DEFAULT 'submitted',
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      graded_at DATETIME,
      FOREIGN KEY (homework_id) REFERENCES homework(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(homework_id, student_id),
      CHECK(status IN ('submitted', 'graded', 'returned', 'resubmitted'))
    );

    CREATE INDEX IF NOT EXISTS idx_hw_sub_homework ON homework_submissions(homework_id);
    CREATE INDEX IF NOT EXISTS idx_hw_sub_student ON homework_submissions(student_id);

    -- ============ 평가/CBT ============
    CREATE TABLE IF NOT EXISTS exams (
      id TEXT PRIMARY KEY,
      class_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      pdf_file TEXT,
      answers TEXT NOT NULL,
      question_count INTEGER DEFAULT 10,
      status TEXT DEFAULT 'waiting',
      owner_id INTEGER NOT NULL,
      time_limit INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      ended_at DATETIME,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_exams_class ON exams(class_id);
    CREATE INDEX IF NOT EXISTS idx_exams_owner ON exams(owner_id);

    CREATE TABLE IF NOT EXISTS exam_students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT DEFAULT 'waiting',
      answers TEXT,
      tab_switch_count INTEGER DEFAULT 0,
      total_leave_time INTEGER DEFAULT 0,
      current_focus INTEGER DEFAULT 1,
      score INTEGER,
      submitted_at DATETIME,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(exam_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_es_exam_status ON exam_students(exam_id, status);

    -- ============ 출석부 ============
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      attendance_date DATE NOT NULL,
      status TEXT DEFAULT 'present',
      comment TEXT,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(class_id, user_id, attendance_date),
      CHECK(status IN ('present', 'absent', 'late', 'excused'))
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_class_date ON attendance(class_id, attendance_date);
    CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id);

    CREATE TABLE IF NOT EXISTS attendance_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER UNIQUE NOT NULL,
      is_public INTEGER DEFAULT 1,
      show_ranking INTEGER DEFAULT 1,
      allow_comments INTEGER DEFAULT 1,
      include_weekends INTEGER DEFAULT 0,
      class_goal TEXT,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attendance_badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      badge_type TEXT NOT NULL,
      badge_name TEXT NOT NULL,
      earned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ============ 알림장 ============
    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      is_pinned INTEGER DEFAULT 0,
      theme TEXT DEFAULT 'classic',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_notices_class ON notices(class_id);

    CREATE TABLE IF NOT EXISTS notice_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notice_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(notice_id, user_id)
    );

    -- ============ 게시판 ============
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      image_url TEXT,
      category TEXT DEFAULT 'general',
      is_pinned INTEGER DEFAULT 0,
      is_anonymous INTEGER DEFAULT 0,
      allow_comments INTEGER DEFAULT 1,
      view_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_posts_class ON posts(class_id);

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER,
      notice_id INTEGER,
      author_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      parent_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id),
      FOREIGN KEY (parent_id) REFERENCES comments(id)
    );

    -- ============ 소통쪽지 ============
    CREATE TABLE IF NOT EXISTS message_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER,
      name TEXT,
      type TEXT DEFAULT 'direct',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      CHECK(type IN ('direct', 'group'))
    );

    CREATE TABLE IF NOT EXISTS message_room_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES message_rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES message_rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);

    -- ============ 설문 ============
    CREATE TABLE IF NOT EXISTS surveys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      questions TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      start_date DATETIME,
      end_date DATETIME,
      is_anonymous INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id),
      CHECK(status IN ('draft', 'active', 'closed', 'archived'))
    );

    CREATE TABLE IF NOT EXISTS survey_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      survey_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      answers TEXT NOT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(survey_id, user_id)
    );

    -- ============ 콘텐츠 ============
    CREATE TABLE IF NOT EXISTS contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      content_type TEXT DEFAULT 'document',
      content_url TEXT,
      file_path TEXT,
      thumbnail_url TEXT,
      subject TEXT,
      grade INTEGER,
      tags TEXT,
      is_public INTEGER DEFAULT 0,
      status TEXT DEFAULT 'approved',
      reject_reason TEXT,
      view_count INTEGER DEFAULT 0,
      like_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(id),
      -- content_type: document, video, image, link, quiz, assessment, activity, bundle, recipe
      CHECK(status IN ('draft', 'pending', 'review', 'hold', 'approved', 'rejected'))
    );

    CREATE TABLE IF NOT EXISTS content_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content_id INTEGER NOT NULL,
      folder_name TEXT DEFAULT '기본 보관함',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
      UNIQUE(user_id, content_id)
    );

    -- ============ 채널 ============
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      subscriber_count INTEGER DEFAULT 0,
      content_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS channel_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      subscriber_id INTEGER NOT NULL,
      subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (subscriber_id) REFERENCES users(id),
      UNIQUE(channel_id, subscriber_id)
    );

    -- ============ 학습 기록 (LRS) ============
    CREATE TABLE IF NOT EXISTS learning_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      class_id INTEGER,
      activity_type TEXT NOT NULL,
      activity_id INTEGER,
      verb TEXT NOT NULL,
      object_type TEXT,
      object_id TEXT,
      result TEXT,
      duration INTEGER,
      metadata TEXT,
      -- xAPI 확장 (Phase 1)
      target_type VARCHAR(50),
      target_id VARCHAR(200),
      result_score REAL,
      result_success INTEGER,
      result_duration VARCHAR(30),
      context_registration VARCHAR(100),
      source_service VARCHAR(30),
      achievement_code VARCHAR(50),
      statement_json TEXT,
      -- Phase 2 확장 (세션/디바이스/성취수준/교과)
      session_id VARCHAR(40),
      duration_sec INTEGER,
      device_type VARCHAR(20),
      platform VARCHAR(30),
      retry_count INTEGER DEFAULT 0,
      correct_count INTEGER,
      total_items INTEGER,
      achievement_level VARCHAR(10),
      parent_statement_id INTEGER,
      subject_code VARCHAR(20),
      grade_group INTEGER,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_learning_logs_user ON learning_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_learning_logs_class ON learning_logs(class_id);
    CREATE INDEX IF NOT EXISTS idx_learning_logs_type ON learning_logs(activity_type);
    CREATE INDEX IF NOT EXISTS idx_learning_logs_date ON learning_logs(created_at);

    -- ============ LRS 집계 테이블 ============

    -- 1. 일별 전체 통계
    CREATE TABLE IF NOT EXISTS lrs_daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stat_date TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      source_service TEXT NOT NULL DEFAULT '',
      class_id INTEGER NOT NULL DEFAULT 0,
      activity_count INTEGER DEFAULT 0,
      unique_users INTEGER DEFAULT 0,
      avg_score REAL,
      total_duration INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(stat_date, activity_type, source_service, class_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lrs_daily_date ON lrs_daily_stats(stat_date);

    -- 2. 사용자별 누적 통계
    CREATE TABLE IF NOT EXISTS lrs_user_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      activity_type TEXT NOT NULL,
      total_count INTEGER DEFAULT 0,
      total_duration INTEGER DEFAULT 0,
      avg_score REAL,
      last_activity_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, activity_type),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 3. 콘텐츠별 통계
    CREATE TABLE IF NOT EXISTS lrs_content_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      view_count INTEGER DEFAULT 0,
      complete_count INTEGER DEFAULT 0,
      unique_users INTEGER DEFAULT 0,
      avg_score REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(target_type, target_id)
    );

    -- 4. 클래스별 통계
    CREATE TABLE IF NOT EXISTS lrs_class_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      activity_type TEXT NOT NULL,
      total_count INTEGER DEFAULT 0,
      unique_users INTEGER DEFAULT 0,
      avg_score REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(class_id, activity_type),
      FOREIGN KEY (class_id) REFERENCES classes(id)
    );

    -- 5. 서비스별 누적 통계
    CREATE TABLE IF NOT EXISTS lrs_service_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_service TEXT NOT NULL,
      verb TEXT NOT NULL,
      total_count INTEGER DEFAULT 0,
      unique_users INTEGER DEFAULT 0,
      avg_score REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_service, verb)
    );

    -- ============ 포트폴리오 ============
    CREATE TABLE IF NOT EXISTS portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'general',
      content TEXT,
      file_path TEXT,
      thumbnail_url TEXT,
      is_public INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES users(id),
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL
    );

    -- ============ 오답노트 ============
    CREATE TABLE IF NOT EXISTS wrong_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      exam_id TEXT,
      question_number INTEGER,
      question_text TEXT,
      student_answer TEXT,
      correct_answer TEXT,
      explanation TEXT,
      subject TEXT,
      is_resolved INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_wrong_answers_student ON wrong_answers(student_id);

    -- ============ 오늘의 학습 ============
    CREATE TABLE IF NOT EXISTS daily_learning (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      learning_date DATE NOT NULL,
      goals TEXT,
      progress_percent REAL DEFAULT 0.0,
      actual_time_minutes INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, learning_date)
    );

    -- ============ AI 학습맵 (SFR-029 확장) ============
    CREATE TABLE IF NOT EXISTS learning_map_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id VARCHAR(50) UNIQUE NOT NULL,
      subject VARCHAR(20) NOT NULL,
      grade_level VARCHAR(10) NOT NULL,
      grade INTEGER NOT NULL,
      semester INTEGER,
      area VARCHAR(100),
      unit_name VARCHAR(200),
      lesson_name VARCHAR(200),
      achievement_code VARCHAR(50),
      achievement_text TEXT,
      node_level INTEGER DEFAULT 1,
      parent_node_id VARCHAR(50),
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS learning_map_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_node_id VARCHAR(50) NOT NULL,
      to_node_id VARCHAR(50) NOT NULL,
      edge_type VARCHAR(20) DEFAULT 'prerequisite',
      UNIQUE(from_node_id, to_node_id)
    );

    CREATE TABLE IF NOT EXISTS node_contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id VARCHAR(50) NOT NULL,
      content_id INTEGER NOT NULL,
      content_role VARCHAR(20) DEFAULT 'learn',
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (content_id) REFERENCES contents(id)
    );

    CREATE TABLE IF NOT EXISTS user_node_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      node_id VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'not_started',
      diagnosis_result VARCHAR(20),
      correct_rate REAL,
      last_accessed_at TIMESTAMP,
      completed_at TIMESTAMP,
      UNIQUE(user_id, node_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS diagnosis_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      target_node_id VARCHAR(50) NOT NULL,
      diagnosis_type VARCHAR(20) DEFAULT 'standard',
      status VARCHAR(20) DEFAULT 'in_progress',
      total_questions INTEGER DEFAULT 0,
      correct_count INTEGER DEFAULT 0,
      result VARCHAR(20),
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS diagnosis_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      node_id VARCHAR(50) NOT NULL,
      content_id INTEGER NOT NULL,
      user_answer TEXT,
      is_correct INTEGER DEFAULT 0,
      answered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES diagnosis_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id)
    );

    CREATE TABLE IF NOT EXISTS learning_paths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      target_node_id VARCHAR(50) NOT NULL,
      path_nodes TEXT NOT NULL,
      current_index INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ============ 감정출석부 확장 (SFR-031) ============
    CREATE TABLE IF NOT EXISTS emotion_reflections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      reflection_type VARCHAR(10) NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      question TEXT,
      answer TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (class_id) REFERENCES classes(id)
    );

    CREATE TABLE IF NOT EXISTS emotion_feedbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      attendance_id INTEGER,
      feedback_text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (teacher_id) REFERENCES users(id),
      FOREIGN KEY (student_id) REFERENCES users(id)
    );

    -- ============ 포트폴리오 확장 (SFR-033) ============
    CREATE TABLE IF NOT EXISTS portfolio_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_type VARCHAR(30) NOT NULL,
      source_id INTEGER,
      class_id INTEGER,
      class_name VARCHAR(200),
      activity_name VARCHAR(300) NOT NULL,
      subject VARCHAR(50),
      activity_date DATE,
      teacher_name VARCHAR(100),
      score VARCHAR(50),
      result_type VARCHAR(20),
      activity_type VARCHAR(30),
      is_life_task INTEGER DEFAULT 0,
      is_public INTEGER DEFAULT 1,
      competency_tags TEXT,
      reflection TEXT,
      grade_year VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS portfolio_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_item_id INTEGER NOT NULL,
      file_name VARCHAR(300),
      file_url VARCHAR(500),
      file_size INTEGER DEFAULT 0,
      FOREIGN KEY (portfolio_item_id) REFERENCES portfolio_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS growth_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      goal_type VARCHAR(30) NOT NULL,
      target_count INTEGER NOT NULL,
      current_count INTEGER DEFAULT 0,
      period VARCHAR(20) DEFAULT 'semester',
      period_label VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ============ 성장보고서 (SFR-034) ============
    CREATE TABLE IF NOT EXISTS teacher_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      observation_text TEXT NOT NULL,
      tags TEXT,
      observation_date DATE DEFAULT (DATE('now')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (teacher_id) REFERENCES users(id),
      FOREIGN KEY (student_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS reading_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      book_title VARCHAR(300) NOT NULL,
      author VARCHAR(200),
      read_date DATE,
      rating INTEGER,
      review TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ============ 진로탐색 기록 ============
    CREATE TABLE IF NOT EXISTS career_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      activity_type VARCHAR(50) NOT NULL,
      title VARCHAR(300) NOT NULL,
      description TEXT,
      interest_area VARCHAR(100),
      reflection TEXT,
      activity_date DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS report_visibility (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      show_summary INTEGER DEFAULT 1,
      show_emotion INTEGER DEFAULT 1,
      show_academics INTEGER DEFAULT 1,
      show_teacher_comment INTEGER DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(teacher_id, student_id, class_id)
    );

    -- ============ 오늘의 학습 확장 (SFR-028) ============
    CREATE TABLE IF NOT EXISTS daily_learning_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER,
      teacher_id INTEGER NOT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      target_date DATE NOT NULL,
      target_grade INTEGER,
      target_subject VARCHAR(50),
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (teacher_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS daily_learning_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id INTEGER NOT NULL,
      source_type VARCHAR(20) NOT NULL,
      content_id INTEGER,
      external_url VARCHAR(500),
      external_title VARCHAR(200),
      node_id VARCHAR(50),
      item_title VARCHAR(200) NOT NULL,
      item_description TEXT,
      sort_order INTEGER DEFAULT 0,
      estimated_minutes INTEGER DEFAULT 10,
      point_value INTEGER DEFAULT 10,
      FOREIGN KEY (set_id) REFERENCES daily_learning_sets(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id)
    );

    CREATE TABLE IF NOT EXISTS daily_learning_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      set_id INTEGER NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      score REAL,
      time_spent_seconds INTEGER DEFAULT 0,
      UNIQUE(user_id, item_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (item_id) REFERENCES daily_learning_items(id)
    );

    -- ============ 나만의 문제집 (스스로채움) ============
    CREATE TABLE IF NOT EXISTS problem_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      subject VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS problem_set_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_set_id INTEGER NOT NULL,
      content_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (problem_set_id) REFERENCES problem_sets(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id),
      UNIQUE(problem_set_id, content_id)
    );

    CREATE TABLE IF NOT EXISTS problem_set_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_set_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      total_questions INTEGER DEFAULT 0,
      correct_count INTEGER DEFAULT 0,
      score_percent REAL DEFAULT 0,
      answers TEXT,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP,
      FOREIGN KEY (problem_set_id) REFERENCES problem_sets(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ============ 콘텐츠 풀이 시도 기록 (문항/평가지 플레이어) ============
    CREATE TABLE IF NOT EXISTS content_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      total_questions INTEGER DEFAULT 0,
      correct_count INTEGER DEFAULT 0,
      score_percent REAL DEFAULT 0,
      answers TEXT,
      attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (content_id) REFERENCES contents(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_content_attempts_user ON content_attempts(user_id, content_id);

    -- ============ CBT 확장 (SFR-032) ============
    CREATE TABLE IF NOT EXISTS exam_autosaves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      answers TEXT NOT NULL,
      saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exam_id, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS exam_delegates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id TEXT NOT NULL,
      delegator_id INTEGER NOT NULL,
      delegate_id INTEGER NOT NULL,
      scope VARCHAR(20) DEFAULT 'all',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exam_id, delegate_id),
      FOREIGN KEY (delegator_id) REFERENCES users(id),
      FOREIGN KEY (delegate_id) REFERENCES users(id)
    );

    -- ============ 포인트/게이미피케이션 ============
    CREATE TABLE IF NOT EXISTS user_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      points INTEGER DEFAULT 0,
      source VARCHAR(30) NOT NULL,
      source_id INTEGER,
      description VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      description VARCHAR(300),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ============ 학습 목표 ============
    CREATE TABLE IF NOT EXISTS learning_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      start_date DATE,
      end_date DATE,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- ============ 교사 학습 배포 ============
    CREATE TABLE IF NOT EXISTS daily_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      teacher_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      goals TEXT,
      assign_date DATE NOT NULL,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes(id),
      FOREIGN KEY (teacher_id) REFERENCES users(id)
    );

    -- ============ 수업-콘텐츠 연결 ============
    CREATE TABLE IF NOT EXISTS lesson_contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id INTEGER NOT NULL,
      content_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
      UNIQUE(lesson_id, content_id)
    );

    CREATE INDEX IF NOT EXISTS idx_lesson_contents_lesson ON lesson_contents(lesson_id);

    -- ============ 학습 진도 (콘텐츠 열람 추적) ============
    CREATE TABLE IF NOT EXISTS content_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content_id INTEGER NOT NULL,
      lesson_id INTEGER,
      progress_percent REAL DEFAULT 0.0,
      completed INTEGER DEFAULT 0,
      last_position TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
      FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE SET NULL,
      UNIQUE(user_id, content_id, lesson_id)
    );

    CREATE INDEX IF NOT EXISTS idx_content_progress_user ON content_progress(user_id, content_id);

    -- ============ 수업꾸러미 구성 콘텐츠 ============
    CREATE TABLE IF NOT EXISTS package_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      content_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (package_id) REFERENCES contents(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_package_items_pkg ON package_items(package_id);

    -- ============ 나도예술가 (갤러리) ============
    CREATE TABLE IF NOT EXISTS student_gallery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      image_url TEXT NOT NULL,
      category TEXT DEFAULT 'art',
      like_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS gallery_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gallery_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (gallery_id) REFERENCES student_gallery(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_comments_gallery ON gallery_comments(gallery_id);

    CREATE TABLE IF NOT EXISTS gallery_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gallery_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(gallery_id, user_id),
      FOREIGN KEY (gallery_id) REFERENCES student_gallery(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_likes_gallery ON gallery_likes(gallery_id);

    CREATE TABLE IF NOT EXISTS gallery_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gallery_id INTEGER NOT NULL,
      user_id INTEGER,
      view_date TEXT NOT NULL,
      UNIQUE(gallery_id, user_id, view_date)
    );

    CREATE TABLE IF NOT EXISTS gallery_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gallery_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (gallery_id) REFERENCES student_gallery(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_reports_gallery ON gallery_reports(gallery_id);
  `);

  // 마이그레이션: gallery_reports 중복 제거 후 UNIQUE INDEX 부여
  try {
    db.exec(`
      DELETE FROM gallery_reports
      WHERE id NOT IN (
        SELECT MIN(id) FROM gallery_reports GROUP BY gallery_id, user_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_reports_unique ON gallery_reports(gallery_id, user_id);
    `);
  } catch (e) {
    console.error('[다채움] gallery_reports UNIQUE 마이그레이션 실패:', e.message);
  }

  // 마이그레이션: attendance 테이블에 감정 컬럼 추가 (SFR-031)
  try {
    const attCols = db.prepare("PRAGMA table_info(attendance)").all().map(c => c.name);
    if (!attCols.includes('emotion')) {
      db.exec("ALTER TABLE attendance ADD COLUMN emotion VARCHAR(30)");
    }
    if (!attCols.includes('emotion_reason')) {
      db.exec("ALTER TABLE attendance ADD COLUMN emotion_reason TEXT");
    }
    if (!attCols.includes('emotion_reason_type')) {
      db.exec("ALTER TABLE attendance ADD COLUMN emotion_reason_type VARCHAR(10) DEFAULT 'text'");
    }
    if (!attCols.includes('emotion_score')) {
      db.exec("ALTER TABLE attendance ADD COLUMN emotion_score REAL");
    }
    if (!attCols.includes('checkin_source')) {
      db.exec("ALTER TABLE attendance ADD COLUMN checkin_source TEXT");
    }
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 마이그레이션: users 테이블에 parent_id 컬럼 추가 (M-1: LRS 학부모 digest)
  try {
    const uCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    if (!uCols.includes('parent_id')) {
      db.exec("ALTER TABLE users ADD COLUMN parent_id INTEGER");
      db.exec("CREATE INDEX IF NOT EXISTS idx_users_parent ON users(parent_id);");
    }
  } catch (e) { /* 무시 */ }

  // 마이그레이션: wrong_answers 테이블 확장
  try {
    const waCols = db.prepare("PRAGMA table_info(wrong_answers)").all().map(c => c.name);
    if (!waCols.includes('unit_name')) {
      db.exec("ALTER TABLE wrong_answers ADD COLUMN unit_name VARCHAR(200)");
    }
    if (!waCols.includes('achievement_code')) {
      db.exec("ALTER TABLE wrong_answers ADD COLUMN achievement_code VARCHAR(50)");
    }
    if (!waCols.includes('attempt_count')) {
      db.exec("ALTER TABLE wrong_answers ADD COLUMN attempt_count INTEGER DEFAULT 1");
    }
    if (!waCols.includes('is_manual')) {
      db.exec("ALTER TABLE wrong_answers ADD COLUMN is_manual INTEGER DEFAULT 0");
    }
    if (!waCols.includes('tags')) {
      db.exec("ALTER TABLE wrong_answers ADD COLUMN tags TEXT");
    }
    if (!waCols.includes('source')) {
      db.exec("ALTER TABLE wrong_answers ADD COLUMN source VARCHAR(20) DEFAULT 'auto'");
    }
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 마이그레이션: learning_logs 테이블 xAPI 확장
  try {
    const llCols = db.prepare("PRAGMA table_info(learning_logs)").all().map(c => c.name);
    if (!llCols.includes('target_type')) {
      db.exec("ALTER TABLE learning_logs ADD COLUMN target_type VARCHAR(50)");
    }
    if (!llCols.includes('target_id')) {
      db.exec("ALTER TABLE learning_logs ADD COLUMN target_id VARCHAR(200)");
    }
    if (!llCols.includes('result_score')) {
      db.exec("ALTER TABLE learning_logs ADD COLUMN result_score REAL");
    }
    if (!llCols.includes('result_success')) {
      db.exec("ALTER TABLE learning_logs ADD COLUMN result_success INTEGER");
    }
    if (!llCols.includes('result_duration')) {
      db.exec("ALTER TABLE learning_logs ADD COLUMN result_duration VARCHAR(30)");
    }
    if (!llCols.includes('context_registration')) {
      db.exec("ALTER TABLE learning_logs ADD COLUMN context_registration VARCHAR(100)");
    }
    if (!llCols.includes('source_service')) {
      db.exec("ALTER TABLE learning_logs ADD COLUMN source_service VARCHAR(30)");
    }
    if (!llCols.includes('achievement_code')) {
      db.exec("ALTER TABLE learning_logs ADD COLUMN achievement_code VARCHAR(50)");
    }
    if (!llCols.includes('statement_json')) {
      db.exec("ALTER TABLE learning_logs ADD COLUMN statement_json TEXT");
    }
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 마이그레이션: learning_logs Phase 2 확장 (세션/디바이스/성취수준/교과)
  try {
    const llCols2 = db.prepare("PRAGMA table_info(learning_logs)").all().map(c => c.name);
    const addCol = (name, sql) => {
      if (!llCols2.includes(name)) {
        try { db.exec(sql); } catch (_) {}
      }
    };
    addCol('session_id',            "ALTER TABLE learning_logs ADD COLUMN session_id VARCHAR(40)");
    addCol('duration_sec',          "ALTER TABLE learning_logs ADD COLUMN duration_sec INTEGER");
    addCol('device_type',           "ALTER TABLE learning_logs ADD COLUMN device_type VARCHAR(20)");
    addCol('platform',              "ALTER TABLE learning_logs ADD COLUMN platform VARCHAR(30)");
    addCol('retry_count',           "ALTER TABLE learning_logs ADD COLUMN retry_count INTEGER DEFAULT 0");
    addCol('correct_count',         "ALTER TABLE learning_logs ADD COLUMN correct_count INTEGER");
    addCol('total_items',           "ALTER TABLE learning_logs ADD COLUMN total_items INTEGER");
    addCol('achievement_level',     "ALTER TABLE learning_logs ADD COLUMN achievement_level VARCHAR(10)");
    addCol('parent_statement_id',   "ALTER TABLE learning_logs ADD COLUMN parent_statement_id INTEGER");
    addCol('subject_code',          "ALTER TABLE learning_logs ADD COLUMN subject_code VARCHAR(20)");
    addCol('grade_group',           "ALTER TABLE learning_logs ADD COLUMN grade_group INTEGER");
    addCol('metadata_json',         "ALTER TABLE learning_logs ADD COLUMN metadata_json TEXT");
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 마이그레이션: Phase 2 신규 집계 3종
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lrs_achievement_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        achievement_code VARCHAR(50) NOT NULL,
        subject_code VARCHAR(20),
        attempt_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        avg_score REAL,
        last_level VARCHAR(10),
        last_attempt_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, achievement_code)
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_las_user ON lrs_achievement_stats(user_id);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_las_code ON lrs_achievement_stats(achievement_code);");

    db.exec(`
      CREATE TABLE IF NOT EXISTS lrs_session_stats (
        session_id VARCHAR(40) PRIMARY KEY,
        user_id INTEGER NOT NULL,
        class_id INTEGER,
        started_at DATETIME,
        ended_at DATETIME,
        duration_sec INTEGER,
        activity_count INTEGER DEFAULT 0,
        services_touched TEXT,
        device_type VARCHAR(20),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_lss_user_date ON lrs_session_stats(user_id, started_at);");

    db.exec(`
      CREATE TABLE IF NOT EXISTS lrs_user_daily (
        user_id INTEGER NOT NULL,
        stat_date TEXT NOT NULL,
        activity_count INTEGER DEFAULT 0,
        duration_sec INTEGER DEFAULT 0,
        avg_score REAL,
        subjects_touched TEXT,
        PRIMARY KEY(user_id, stat_date)
      );
    `);
  } catch (e) { console.error('[DB] Phase 2 LRS 집계 테이블 생성 실패:', e.message); }

  // 마이그레이션: Phase 2 learning_logs 신규 인덱스 6개
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_ll_user_date     ON learning_logs(user_id, created_at DESC);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ll_achv          ON learning_logs(achievement_code, result_success);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ll_subject_date  ON learning_logs(subject_code, created_at);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ll_session       ON learning_logs(session_id);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ll_class_date    ON learning_logs(class_id, created_at);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ll_service_verb  ON learning_logs(source_service, verb);");
  } catch (e) { /* 무시 */ }

  // 마이그레이션: 기존 learning_logs(result_success=1) → portfolio_items 일괄 추가
  try {
    const portfolioCount = db.prepare('SELECT COUNT(*) as cnt FROM portfolio_items').get().cnt;
    if (portfolioCount === 0) {
      const completedLogs = db.prepare(`
        SELECT id, user_id, class_id, activity_type, object_type,
               result_score, result_success, source_service, created_at
        FROM learning_logs
        WHERE result_success = 1
      `).all();

      if (completedLogs.length > 0) {
        const insertPortfolio = db.prepare(`
          INSERT OR IGNORE INTO portfolio_items
          (user_id, source_type, source_id, class_id, activity_name, subject,
           activity_date, score, result_type, activity_type, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)
        `);

        const migrateAll = db.transaction((logs) => {
          for (const log of logs) {
            insertPortfolio.run(
              log.user_id,
              log.source_service || 'learning',
              log.id,
              log.class_id || null,
              log.object_type || '학습 활동',
              null,
              log.created_at ? log.created_at.split('T')[0].split(' ')[0] : new Date().toISOString().split('T')[0],
              log.result_score != null ? String(log.result_score) : null,
              log.activity_type || 'activity',
              log.created_at || new Date().toISOString()
            );
          }
        });

        migrateAll(completedLogs);
        console.log(`[DB] 기존 learning_logs ${completedLogs.length}건을 portfolio_items로 마이그레이션 완료`);
      }
    }
  } catch (e) {
    console.error('[DB] portfolio_items 마이그레이션 실패:', e.message);
  }

  // 마이그레이션: contents 테이블 확장
  try {
    const ctCols = db.prepare("PRAGMA table_info(contents)").all().map(c => c.name);
    if (!ctCols.includes('achievement_code')) {
      db.exec("ALTER TABLE contents ADD COLUMN achievement_code VARCHAR(50)");
    }
    if (!ctCols.includes('unit_name')) {
      db.exec("ALTER TABLE contents ADD COLUMN unit_name VARCHAR(200)");
    }
    if (!ctCols.includes('school_level')) {
      db.exec("ALTER TABLE contents ADD COLUMN school_level VARCHAR(10)");
    }
    if (!ctCols.includes('difficulty')) {
      db.exec("ALTER TABLE contents ADD COLUMN difficulty VARCHAR(10) DEFAULT 'medium'");
    }
    if (!ctCols.includes('estimated_minutes')) {
      db.exec("ALTER TABLE contents ADD COLUMN estimated_minutes INTEGER DEFAULT 10");
    }
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 마이그레이션: exams 테이블 확장
  try {
    const exCols = db.prepare("PRAGMA table_info(exams)").all().map(c => c.name);
    if (!exCols.includes('show_answers')) {
      db.exec("ALTER TABLE exams ADD COLUMN show_answers INTEGER DEFAULT 0");
    }
    if (!exCols.includes('explanations')) {
      db.exec("ALTER TABLE exams ADD COLUMN explanations TEXT");
    }
    if (!exCols.includes('source_content_id')) {
      db.exec("ALTER TABLE exams ADD COLUMN source_content_id INTEGER");
    }
    if (!exCols.includes('description')) {
      db.exec("ALTER TABLE exams ADD COLUMN description TEXT");
    }
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 마이그레이션: lessons, homework, exams에 교과 메타 컬럼 추가
  try {
    const lsCols = db.prepare("PRAGMA table_info(lessons)").all().map(c => c.name);
    if (!lsCols.includes('subject_code')) {
      db.exec("ALTER TABLE lessons ADD COLUMN subject_code VARCHAR(20)");
    }
    if (!lsCols.includes('grade_group')) {
      db.exec("ALTER TABLE lessons ADD COLUMN grade_group INTEGER");
    }
    if (!lsCols.includes('achievement_code')) {
      db.exec("ALTER TABLE lessons ADD COLUMN achievement_code VARCHAR(50)");
    }
    if (!lsCols.includes('school_level')) {
      db.exec("ALTER TABLE lessons ADD COLUMN school_level VARCHAR(20)");
    }
    if (!lsCols.includes('tags')) {
      db.exec("ALTER TABLE lessons ADD COLUMN tags TEXT");
    }
    if (!lsCols.includes('theme')) {
      db.exec("ALTER TABLE lessons ADD COLUMN theme TEXT");
    }
    if (!lsCols.includes('classify_mode')) {
      db.exec("ALTER TABLE lessons ADD COLUMN classify_mode VARCHAR(20) DEFAULT 'curriculum'");
    }
  } catch (e) {}

  try {
    const hwCols = db.prepare("PRAGMA table_info(homework)").all().map(c => c.name);
    if (!hwCols.includes('subject_code')) {
      db.exec("ALTER TABLE homework ADD COLUMN subject_code VARCHAR(20)");
    }
    if (!hwCols.includes('grade_group')) {
      db.exec("ALTER TABLE homework ADD COLUMN grade_group INTEGER");
    }
    if (!hwCols.includes('achievement_code')) {
      db.exec("ALTER TABLE homework ADD COLUMN achievement_code VARCHAR(50)");
    }
    if (!hwCols.includes('public_submissions')) {
      db.exec("ALTER TABLE homework ADD COLUMN public_submissions INTEGER DEFAULT 0");
    }
  } catch (e) {}

  // 과제 피드백 (교사-학생 1:1 채팅) 테이블
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS homework_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id INTEGER NOT NULL,
        author_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (submission_id) REFERENCES homework_submissions(id) ON DELETE CASCADE,
        FOREIGN KEY (author_id) REFERENCES users(id)
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_hw_feedback_sub ON homework_feedback(submission_id, created_at);');
  } catch (e) {}

  try {
    const exCols2 = db.prepare("PRAGMA table_info(exams)").all().map(c => c.name);
    if (!exCols2.includes('subject_code')) {
      db.exec("ALTER TABLE exams ADD COLUMN subject_code VARCHAR(20)");
    }
    if (!exCols2.includes('grade_group')) {
      db.exec("ALTER TABLE exams ADD COLUMN grade_group INTEGER");
    }
    if (!exCols2.includes('achievement_code')) {
      db.exec("ALTER TABLE exams ADD COLUMN achievement_code VARCHAR(50)");
    }
    if (!exCols2.includes('start_date')) {
      db.exec("ALTER TABLE exams ADD COLUMN start_date DATE");
    }
    if (!exCols2.includes('end_date')) {
      db.exec("ALTER TABLE exams ADD COLUMN end_date DATE");
    }
    if (!exCols2.includes('exam_mode')) {
      db.exec("ALTER TABLE exams ADD COLUMN exam_mode TEXT DEFAULT 'text'");
    }
    if (!exCols2.includes('start_mode')) {
      db.exec("ALTER TABLE exams ADD COLUMN start_mode TEXT DEFAULT 'direct'");
    }
    if (!exCols2.includes('tab_detection')) {
      db.exec("ALTER TABLE exams ADD COLUMN tab_detection INTEGER DEFAULT 1");
    }
    if (!exCols2.includes('allow_retry')) {
      db.exec("ALTER TABLE exams ADD COLUMN allow_retry INTEGER DEFAULT 0");
    }
  } catch (e) {}

  // 마이그레이션: exam_students 테이블에 tab_events 컬럼 추가
  try {
    const esCols = db.prepare("PRAGMA table_info(exam_students)").all().map(c => c.name);
    if (!esCols.includes('tab_events')) {
      db.exec("ALTER TABLE exam_students ADD COLUMN tab_events TEXT DEFAULT '[]'");
    }
  } catch (e) {}

  // 마이그레이션: 기존 learning_map_nodes 테이블이 구버전이면 교체
  try {
    const mapCols = db.prepare("PRAGMA table_info(learning_map_nodes)").all().map(c => c.name);
    if (mapCols.length > 0 && !mapCols.includes('node_id')) {
      console.log('[DB] learning_map_nodes 구버전 감지, 테이블 교체 중...');
      db.exec("DROP TABLE IF EXISTS learning_map_progress");
      db.exec("DROP TABLE IF EXISTS learning_map_nodes");
      db.exec(`
        CREATE TABLE learning_map_nodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id VARCHAR(50) UNIQUE NOT NULL,
          subject VARCHAR(20) NOT NULL,
          grade_level VARCHAR(10) NOT NULL,
          grade INTEGER NOT NULL,
          semester INTEGER,
          area VARCHAR(100),
          unit_name VARCHAR(200),
          lesson_name VARCHAR(200),
          achievement_code VARCHAR(50),
          achievement_text TEXT,
          node_level INTEGER DEFAULT 1,
          parent_node_id VARCHAR(50),
          sort_order INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('[DB] learning_map_nodes 테이블 교체 완료');
    }
  } catch (e) { /* 무시 */ }

  // 마이그레이션: classes 테이블에 class_type 컬럼 추가
  try {
    const classCols = db.prepare("PRAGMA table_info(classes)").all().map(c => c.name);
    if (!classCols.includes('class_type')) {
      db.exec("ALTER TABLE classes ADD COLUMN class_type TEXT DEFAULT '기타'");
    }
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 마이그레이션: classes 테이블에 enabled_tabs 컬럼 추가
  try {
    const classCols2 = db.prepare("PRAGMA table_info(classes)").all().map(c => c.name);
    if (!classCols2.includes('enabled_tabs')) {
      db.exec("ALTER TABLE classes ADD COLUMN enabled_tabs TEXT DEFAULT NULL");
    }
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 마이그레이션: posts 테이블에 image_url, is_anonymous, allow_comments 컬럼 추가
  try {
    const cols = db.prepare("PRAGMA table_info(posts)").all().map(c => c.name);
    if (!cols.includes('image_url')) {
      db.exec("ALTER TABLE posts ADD COLUMN image_url TEXT");
    }
    if (!cols.includes('is_anonymous')) {
      db.exec("ALTER TABLE posts ADD COLUMN is_anonymous INTEGER DEFAULT 0");
    }
    if (!cols.includes('allow_comments')) {
      db.exec("ALTER TABLE posts ADD COLUMN allow_comments INTEGER DEFAULT 1");
    }
    if (!cols.includes('approval_status')) {
      db.exec("ALTER TABLE posts ADD COLUMN approval_status TEXT DEFAULT 'approved'");
    }
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 마이그레이션: class_boards 테이블 생성 (다중 게시판 지원)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS class_boards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '게시판',
        board_type TEXT NOT NULL DEFAULT 'general',
        requires_approval INTEGER DEFAULT 0,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
      )
    `);
    // 기존 클래스에 기본 게시판 생성
    const classes = db.prepare('SELECT id FROM classes').all();
    const boardCheck = db.prepare('SELECT COUNT(*) as cnt FROM class_boards WHERE class_id = ?');
    const insertBoard = db.prepare(`
      INSERT INTO class_boards (class_id, name, board_type, requires_approval, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const cls of classes) {
      if (boardCheck.get(cls.id).cnt === 0) {
        insertBoard.run(cls.id, '일반 게시판', 'general', 0, 0);
        insertBoard.run(cls.id, '갤러리 게시판', 'gallery', 1, 1);
      }
    }
  } catch (e) { /* 이미 존재하면 무시 */ }

  // 마이그레이션: posts 테이블에 board_id 컬럼 추가
  try {
    const postCols2 = db.prepare("PRAGMA table_info(posts)").all().map(c => c.name);
    if (!postCols2.includes('board_id')) {
      db.exec("ALTER TABLE posts ADD COLUMN board_id INTEGER");
    }
  } catch (e) { /* 무시 */ }

  // 마이그레이션: student_gallery 테이블에 승인 관련 컬럼 추가
  try {
    const sgCols = db.prepare("PRAGMA table_info(student_gallery)").all().map(c => c.name);
    if (!sgCols.includes('approval_status')) {
      db.exec("ALTER TABLE student_gallery ADD COLUMN approval_status TEXT DEFAULT 'pending'");
    }
    if (!sgCols.includes('source_post_id')) {
      db.exec("ALTER TABLE student_gallery ADD COLUMN source_post_id INTEGER");
    }
    if (!sgCols.includes('approved_by')) {
      db.exec("ALTER TABLE student_gallery ADD COLUMN approved_by INTEGER");
    }
    if (!sgCols.includes('approved_at')) {
      db.exec("ALTER TABLE student_gallery ADD COLUMN approved_at DATETIME");
    }
    if (!sgCols.includes('type')) db.exec("ALTER TABLE student_gallery ADD COLUMN type TEXT DEFAULT 'image'");
    if (!sgCols.includes('tags')) db.exec("ALTER TABLE student_gallery ADD COLUMN tags TEXT");
    if (!sgCols.includes('view_count')) db.exec("ALTER TABLE student_gallery ADD COLUMN view_count INTEGER DEFAULT 0");
    if (!sgCols.includes('reject_reason')) db.exec("ALTER TABLE student_gallery ADD COLUMN reject_reason TEXT");
    if (!sgCols.includes('media_url')) db.exec("ALTER TABLE student_gallery ADD COLUMN media_url TEXT");
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 갤러리 이벤트 게시판
  db.exec(`
    CREATE TABLE IF NOT EXISTS gallery_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT CHECK(category IN ('art','music','video','literature','etc')) DEFAULT 'etc',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      location TEXT,
      host_user_id INTEGER NOT NULL,
      thumbnail_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (host_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_events_dates ON gallery_events(start_date, end_date);

    CREATE TABLE IF NOT EXISTS gallery_event_participants (
      event_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, user_id),
      FOREIGN KEY (event_id) REFERENCES gallery_events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // 갤러리 이벤트 시드 (비어있을 때만)
  try {
    const evCount = db.prepare('SELECT COUNT(*) AS cnt FROM gallery_events').get().cnt;
    if (evCount === 0) {
      const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1").get();
      const hostId = admin ? admin.id : 1;
      const insEv = db.prepare(`INSERT INTO gallery_events (title, description, category, start_date, end_date, location, host_user_id, thumbnail_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      // 날짜는 오늘 기준 상대값(동적 계산)으로 삽입 — 데모 시나리오에서 '참여가능' 필터에 정상 노출되도록
      const d = (days) => { const t = new Date(); t.setDate(t.getDate() + days); return t.toISOString().slice(0, 10); };
      insEv.run('전국 학생 사생대회', '전국의 초·중학생이 참여하는 야외 사생대회입니다. 자연을 주제로 자유롭게 그려보세요.', 'art', d(14), d(14), '올림픽공원', hostId, null);
      insEv.run('청소년 음악제', '학생들이 갈고닦은 음악 실력을 뽐내는 음악제. 독주·합주·성악 부문.', 'music', d(33), d(33), '예술의전당', hostId, null);
      insEv.run('학생 영상 예술제', '짧은 영상으로 이야기하는 예술제. 창의적인 영상 작품을 기다립니다.', 'video', d(27), d(27), '상암DMC', hostId, null);
      insEv.run('전국 미술 공모전', '회화·조소·디자인 전 분야를 아우르는 전국 공모전.', 'art', d(50), d(50), '국립현대미술관', hostId, null);
      insEv.run('청소년 문학상', '시·소설·수필 부문의 글쓰기 대회. 청소년의 빛나는 문장을 기다립니다.', 'literature', d(45), d(45), '국립중앙도서관', hostId, null);
      console.log('[DB] gallery_events 시드 5건 삽입 완료');
    }
  } catch (e) { console.error('[DB] gallery_events 시드 실패:', e.message); }

  // 마이그레이션: 기존 시드의 과거 날짜를 오늘 기준 미래로 이동 (한 번만)
  try {
    const past = db.prepare("SELECT id, title FROM gallery_events WHERE end_date < date('now') AND title IN ('전국 학생 사생대회','청소년 음악제','학생 영상 예술제','전국 미술 공모전','청소년 문학상')").all();
    if (past.length > 0) {
      const d = (days) => { const t = new Date(); t.setDate(t.getDate() + days); return t.toISOString().slice(0, 10); };
      const offsets = { '전국 학생 사생대회': 14, '학생 영상 예술제': 27, '청소년 음악제': 33, '청소년 문학상': 45, '전국 미술 공모전': 50 };
      const upd = db.prepare('UPDATE gallery_events SET start_date=?, end_date=? WHERE id=?');
      for (const ev of past) {
        const off = offsets[ev.title];
        if (off != null) upd.run(d(off), d(off), ev.id);
      }
      console.log(`[DB] gallery_events 시드 날짜 현재 기준으로 이동: ${past.length}건`);
    }
  } catch (e) { console.error('[DB] gallery_events 날짜 마이그레이션 실패:', e.message); }

  // ============ v4: gallery_events 확장 마이그레이션 (idempotent) ============
  try {
    const geCols = db.prepare("PRAGMA table_info(gallery_events)").all().map(c => c.name);
    if (!geCols.includes('event_type')) {
      db.exec("ALTER TABLE gallery_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'apply'");
    }
    if (!geCols.includes('submission_visibility')) {
      db.exec("ALTER TABLE gallery_events ADD COLUMN submission_visibility TEXT");
    }
    if (!geCols.includes('target_school_levels')) {
      db.exec("ALTER TABLE gallery_events ADD COLUMN target_school_levels TEXT");
    }
    if (!geCols.includes('target_school_only')) {
      db.exec("ALTER TABLE gallery_events ADD COLUMN target_school_only INTEGER NOT NULL DEFAULT 0");
    }
    if (!geCols.includes('target_grades')) {
      db.exec("ALTER TABLE gallery_events ADD COLUMN target_grades TEXT");
    }
    if (!geCols.includes('host_school_name')) {
      // users 테이블에 school_id가 없으므로 school_name을 주최 학교 식별자로 사용
      db.exec("ALTER TABLE gallery_events ADD COLUMN host_school_name TEXT");
    }
    if (!geCols.includes('publish_to_gallery')) {
      db.exec("ALTER TABLE gallery_events ADD COLUMN publish_to_gallery INTEGER NOT NULL DEFAULT 1");
    }
    if (!geCols.includes('closed_at')) {
      db.exec("ALTER TABLE gallery_events ADD COLUMN closed_at DATETIME");
    }
    if (!geCols.includes('closed_by_user_id')) {
      db.exec("ALTER TABLE gallery_events ADD COLUMN closed_by_user_id INTEGER");
    }
  } catch (e) { console.error('[DB] gallery_events v4 마이그레이션 실패:', e.message); }

  // gallery_event_submissions 신규 테이블 + 인덱스
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gallery_event_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        image_url TEXT,
        is_published_to_gallery INTEGER NOT NULL DEFAULT 0,
        gallery_item_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (event_id) REFERENCES gallery_events(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (gallery_item_id) REFERENCES student_gallery(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ges_event ON gallery_event_submissions(event_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ges_user ON gallery_event_submissions(user_id);
    `);
  } catch (e) { console.error('[DB] gallery_event_submissions 생성 실패:', e.message); }

  // student_gallery에 source 컬럼 (이벤트 출처 구분) 추가
  try {
    const sgCols2 = db.prepare("PRAGMA table_info(student_gallery)").all().map(c => c.name);
    if (!sgCols2.includes('source')) {
      db.exec("ALTER TABLE student_gallery ADD COLUMN source TEXT");
    }
  } catch (e) { /* 무시 */ }

  // 콘텐츠 댓글 테이블
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      parent_id INTEGER DEFAULT NULL,
      text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 마이그레이션: contents 테이블 CHECK 제약 제거 (새 콘텐츠 유형 지원)
  try {
    // 기존 CHECK 제약이 있으면 테스트 삽입으로 감지 후 재생성
    const testStmt = db.prepare("INSERT INTO contents (creator_id, title, content_type) VALUES (?, ?, ?)");
    try {
      db.exec("SAVEPOINT check_test");
      testStmt.run(1, '__type_test__', 'bundle');
      db.exec("ROLLBACK TO check_test");
      db.exec("RELEASE check_test");
    } catch (checkErr) {
      db.exec("ROLLBACK TO check_test");
      db.exec("RELEASE check_test");
      if (checkErr.message.includes('CHECK')) {
        console.log('[DB] contents 테이블 CHECK 제약 재생성 중...');
        db.exec(`
          CREATE TABLE IF NOT EXISTS contents_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            creator_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            content_type TEXT DEFAULT 'document',
            content_url TEXT,
            file_path TEXT,
            thumbnail_url TEXT,
            subject TEXT,
            grade INTEGER,
            tags TEXT,
            is_public INTEGER DEFAULT 0,
            status TEXT DEFAULT 'approved',
            reject_reason TEXT,
            view_count INTEGER DEFAULT 0,
            like_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (creator_id) REFERENCES users(id),
            CHECK(status IN ('draft', 'pending', 'review', 'hold', 'approved', 'rejected'))
          );
          INSERT INTO contents_new SELECT * FROM contents;
          DROP TABLE contents;
          ALTER TABLE contents_new RENAME TO contents;
          CREATE INDEX IF NOT EXISTS idx_contents_creator ON contents(creator_id);
          CREATE INDEX IF NOT EXISTS idx_contents_public ON contents(is_public, status);
        `);
        console.log('[DB] contents 테이블 재생성 완료 (확장된 콘텐츠 유형 지원)');
      }
    }
  } catch (e) { /* 테이블이 아직 없으면 무시 */ }

  // 마이그레이션: contents status CHECK에 'hold','review' 추가
  try {
    db.exec("SAVEPOINT status_check_test");
    db.prepare("INSERT INTO contents (creator_id, title, status) VALUES (?, ?, ?)").run(1, '__status_test__', 'hold');
    db.exec("ROLLBACK TO status_check_test");
    db.exec("RELEASE status_check_test");
  } catch (statusErr) {
    try { db.exec("ROLLBACK TO status_check_test"); db.exec("RELEASE status_check_test"); } catch(e2){}
    if (statusErr.message.includes('CHECK')) {
      console.log('[DB] contents status CHECK 확장 중 (hold, review 추가)...');
      const existingCols = db.prepare("PRAGMA table_info(contents)").all().map(c => c.name);
      const colDefs = existingCols.map(col => {
        if (col === 'id') return 'id INTEGER PRIMARY KEY AUTOINCREMENT';
        if (col === 'creator_id') return 'creator_id INTEGER NOT NULL';
        if (col === 'title') return 'title TEXT NOT NULL';
        if (col === 'status') return "status TEXT DEFAULT 'approved'";
        return `${col} TEXT`;
      }).join(',\n');
      db.pragma('foreign_keys = OFF');
      db.exec(`CREATE TABLE IF NOT EXISTS contents_status_fix (${colDefs}, CHECK(status IN ('draft','pending','review','hold','approved','rejected')))`);
      db.exec(`INSERT INTO contents_status_fix SELECT ${existingCols.join(',')} FROM contents`);
      db.exec(`DROP TABLE contents`);
      db.exec(`ALTER TABLE contents_status_fix RENAME TO contents`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_contents_creator ON contents(creator_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_contents_public ON contents(is_public, status)`);
      db.pragma('foreign_keys = ON');
      console.log('[DB] contents status CHECK 확장 완료');
    }
  }

  // 마이그레이션: teacher_observations에 area 컬럼 추가
  try { db.exec("ALTER TABLE teacher_observations ADD COLUMN area VARCHAR(50) DEFAULT ''"); } catch(e) {}

  // 마이그레이션: class_members에 last_visited_at 추가
  try { db.exec('ALTER TABLE class_members ADD COLUMN last_visited_at DATETIME'); } catch(e) {}

  // 마이그레이션: content_questions 테이블 (문항은행)
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER NOT NULL,
      question_number INTEGER DEFAULT 1,
      question_text TEXT NOT NULL,
      question_type TEXT DEFAULT 'multiple_choice',
      options TEXT,
      answer_index INTEGER DEFAULT 0,
      explanation TEXT,
      difficulty INTEGER DEFAULT 3,
      points INTEGER DEFAULT 10,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE
    )
  `);

  // quiz/exam 콘텐츠에 샘플 문항 시딩
  const qCount = db.prepare('SELECT COUNT(*) as cnt FROM content_questions').get().cnt;
  if (qCount === 0) {
    const quizContents = db.prepare("SELECT id, title FROM contents WHERE content_type IN ('quiz','exam')").all();
    const sampleQuestions = {
      '분수': [
        { q: '1/2 + 1/3의 값은?', opts: ['2/5','5/6','3/5','1/6'], ans: 1, exp: '통분하면 3/6 + 2/6 = 5/6' },
        { q: '3/4 - 1/4의 값은?', opts: ['1/2','2/4','1/4','3/4'], ans: 0, exp: '3/4 - 1/4 = 2/4 = 1/2' },
        { q: '2/5 + 1/5의 값은?', opts: ['1/5','2/5','3/5','4/5'], ans: 2, exp: '분모가 같으면 분자끼리 더함' },
        { q: '5/8 - 3/8의 값은?', opts: ['2/8','1/4','3/8','2/16'], ans: 1, exp: '5/8 - 3/8 = 2/8 = 1/4' },
        { q: '1/3 + 2/3의 값은?', opts: ['1','3/3','2/3','3/6'], ans: 0, exp: '1/3 + 2/3 = 3/3 = 1' }
      ],
      '곱셈': [
        { q: '곱셈구구 7×8의 값은?', opts: ['54','56','63','48'], ans: 1, exp: '7×8 = 56' },
        { q: '곱셈구구 9×6의 값은?', opts: ['45','54','63','56'], ans: 1, exp: '9×6 = 54' },
        { q: '곱셈구구 6×7의 값은?', opts: ['36','42','48','35'], ans: 1, exp: '6×7 = 42' }
      ],
      '받아쓰기': [
        { q: '"사과"의 올바른 표기는?', opts: ['사과','싸과','사꽈','싸꽈'], ans: 0, exp: '사과가 올바른 표기' },
        { q: '"학교"의 올바른 표기는?', opts: ['학꾜','학교','핰교','학괴'], ans: 1, exp: '학교가 올바른 표기' },
        { q: '"선생님"의 올바른 표기는?', opts: ['선생님','선쌩님','썬생님','선생늠'], ans: 0, exp: '선생님이 올바른 표기' }
      ],
      '수학': [
        { q: '4학년 1학기 수학: 큰 수의 덧셈 7,258 + 3,462의 값은?', opts: ['10,720','10,710','10,620','10,820'], ans: 0, exp: '7258+3462=10720' },
        { q: '각도기로 재었을 때 직각은 몇 도인가?', opts: ['45도','60도','90도','180도'], ans: 2, exp: '직각=90도' },
        { q: '삼각형의 내각의 합은?', opts: ['90도','180도','270도','360도'], ans: 1, exp: '삼각형 내각의 합은 180도' },
        { q: '1km는 몇 m인가?', opts: ['10m','100m','1000m','10000m'], ans: 2, exp: '1km = 1000m' },
        { q: '소수 0.5를 분수로 나타내면?', opts: ['1/2','1/5','5/10','1/3'], ans: 0, exp: '0.5 = 5/10 = 1/2' }
      ],
      '다채움': [
        { q: '다채움의 주요 서비스가 아닌 것은?', opts: ['채움클래스','채움콘텐츠','채움게임','스스로채움'], ans: 2, exp: '채움게임은 없는 서비스' },
        { q: '다채움에서 학습 기록을 분석하는 서비스는?', opts: ['채움CBT','LRS 학습분석','성장기록','채움더하기'], ans: 1, exp: 'LRS 학습분석이 학습 기록 분석 서비스' }
      ]
    };
    const insertQ = db.prepare('INSERT INTO content_questions (content_id, question_number, question_text, options, answer_index, explanation, difficulty) VALUES (?,?,?,?,?,?,?)');
    for (const content of quizContents) {
      let matched = false;
      for (const [keyword, questions] of Object.entries(sampleQuestions)) {
        if (content.title.includes(keyword)) {
          questions.forEach((q, i) => {
            insertQ.run(content.id, i+1, q.q, JSON.stringify(q.opts), q.ans, q.exp, Math.floor(Math.random()*3)+2);
          });
          matched = true;
          break;
        }
      }
      if (!matched) {
        // 매칭 안 되면 수학 기본 문항
        sampleQuestions['수학'].forEach((q, i) => {
          insertQ.run(content.id, i+1, q.q, JSON.stringify(q.opts), q.ans, q.exp, 3);
        });
      }
    }
    console.log('[DB] content_questions 문항 시딩 완료');
  }

  // 마이그레이션: content_questions 확장 (지시사항, 지문, 미디어, 해설, 난이도 등)
  try { db.exec('ALTER TABLE content_questions ADD COLUMN instruction TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE content_questions ADD COLUMN passage TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE content_questions ADD COLUMN media_url TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE content_questions ADD COLUMN media_type TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE content_questions ADD COLUMN difficulty INTEGER DEFAULT 3'); } catch(e) {}
  try { db.exec('ALTER TABLE content_questions ADD COLUMN points INTEGER DEFAULT 10'); } catch(e) {}
  // answer 컬럼 (answer_index 외에 텍스트 정답 저장용) — 이미 있으면 무시
  try { db.exec('ALTER TABLE content_questions ADD COLUMN answer TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE content_questions ADD COLUMN explanation TEXT'); } catch(e) {}

  // 마이그레이션: daily_learning_sets.difficulty 추가 ('쉬움'/'보통'/'어려움')
  try { db.exec("ALTER TABLE daily_learning_sets ADD COLUMN difficulty VARCHAR(10) DEFAULT '보통'"); } catch(e) {}

  // 마이그레이션: daily_learning_progress 정오답 상세 저장 (per-question review용)
  try { db.exec("ALTER TABLE daily_learning_progress ADD COLUMN answers_json TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE daily_learning_progress ADD COLUMN correct_count INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE daily_learning_progress ADD COLUMN total_questions INTEGER"); } catch(e) {}

  // 마이그레이션 플래그 테이블
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (DATETIME('now')))`);

  // 마이그레이션: content_questions answer 0-based 통일
  // UI에서 생성된 문항은 1-based(1,2,3,4)로 저장됨 → 0-based(0,1,2,3)로 변환
  // 시드 데이터는 이미 0-based이며 INTEGER 타입으로 저장됨 (typeof='integer')
  // UI 데이터는 TEXT 타입으로 저장됨 (typeof='text'), 값이 "1","2","3","4" 형태
  try {
    const migDone = db.prepare("SELECT 1 FROM _migrations WHERE name = 'answer_0based'").get();
    if (!migDone) {
      const affected = db.prepare(
        "SELECT COUNT(*) as cnt FROM content_questions WHERE answer IS NOT NULL AND answer != '' AND typeof(answer) = 'text' AND CAST(answer AS INTEGER) >= 1 AND answer NOT LIKE '%.%'"
      ).get();
      if (affected && affected.cnt > 0) {
        console.log(`[DB] content_questions answer 1-based → 0-based 마이그레이션 (${affected.cnt}건)`);
        db.exec(
          "UPDATE content_questions SET answer = CAST(CAST(answer AS INTEGER) - 1 AS TEXT) WHERE answer IS NOT NULL AND answer != '' AND typeof(answer) = 'text' AND CAST(answer AS INTEGER) >= 1 AND answer NOT LIKE '%.%'"
        );
      }
      // exams.answers JSON 내 answer도 0-based로 변환
      try {
        const exams = db.prepare("SELECT id, answers FROM exams WHERE answers IS NOT NULL").all();
        let examFixed = 0;
        for (const exam of exams) {
          try {
            const questions = JSON.parse(exam.answers);
            let changed = false;
            for (const q of questions) {
              if (q.answer !== undefined && q.answer !== null && q.options && q.options.length > 0) {
                const num = Number(q.answer);
                if (!isNaN(num) && num >= 1 && Number.isInteger(num) && !String(q.answer).includes('.')) {
                  q.answer = num - 1;
                  changed = true;
                }
              }
            }
            if (changed) {
              db.prepare("UPDATE exams SET answers = ? WHERE id = ?").run(JSON.stringify(questions), exam.id);
              examFixed++;
            }
          } catch(e2) {}
        }
        if (examFixed > 0) console.log(`[DB] class_exams answer 마이그레이션 (${examFixed}건)`);
      } catch(e2) { console.error('[DB] exam answer migration error:', e2.message); }

      db.prepare("INSERT INTO _migrations (name) VALUES ('answer_0based')").run();
      console.log('[DB] answer_0based 마이그레이션 완료');
    }
  } catch(e) { console.error('[DB] answer migration error:', e.message); }

  // 마이그레이션: exams.answers JSON 내 answer 0-based 변환 (별도 마이그레이션)
  try {
    const migDone2 = db.prepare("SELECT 1 FROM _migrations WHERE name = 'exam_answer_0based'").get();
    if (!migDone2) {
      const exams = db.prepare("SELECT id, answers FROM exams WHERE answers IS NOT NULL").all();
      let examFixed = 0;
      for (const exam of exams) {
        try {
          const questions = JSON.parse(exam.answers);
          let changed = false;
          for (const q of questions) {
            if (q.answer !== undefined && q.answer !== null && q.options && q.options.length > 0) {
              const num = Number(q.answer);
              if (!isNaN(num) && num >= 1 && Number.isInteger(num) && !String(q.answer).includes('.')) {
                q.answer = num - 1;
                changed = true;
              }
            }
          }
          if (changed) {
            db.prepare("UPDATE exams SET answers = ? WHERE id = ?").run(JSON.stringify(questions), exam.id);
            examFixed++;
          }
        } catch(e2) {}
      }
      if (examFixed > 0) console.log(`[DB] exams answer 0-based 마이그레이션 (${examFixed}건)`);
      db.prepare("INSERT INTO _migrations (name) VALUES ('exam_answer_0based')").run();
      console.log('[DB] exam_answer_0based 마이그레이션 완료');
    }
  } catch(e) { console.error('[DB] exam answer migration error:', e.message); }

  // 마이그레이션: lessons 테이블 확장 (시작일/종료일, 예상시간, status 확장)
  try { db.exec('ALTER TABLE lessons ADD COLUMN start_date DATE'); } catch(e) {}
  try { db.exec('ALTER TABLE lessons ADD COLUMN end_date DATE'); } catch(e) {}
  try { db.exec('ALTER TABLE lessons ADD COLUMN estimated_minutes INTEGER DEFAULT 0'); } catch(e) {}

  // lessons status CHECK 제약 확장 (draft, published, archived → + scheduled)
  try {
    db.exec("SAVEPOINT lesson_check");
    db.prepare("INSERT INTO lessons (class_id, teacher_id, title, status) VALUES (?, ?, ?, ?)").run(1, 1, '__test__', 'scheduled');
    db.exec("ROLLBACK TO lesson_check");
    db.exec("RELEASE lesson_check");
  } catch (checkErr) {
    db.exec("ROLLBACK TO lesson_check");
    db.exec("RELEASE lesson_check");
    if (checkErr.message.includes('CHECK')) {
      console.log('[DB] lessons 테이블 CHECK 제약 재생성 중...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS lessons_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          class_id INTEGER NOT NULL,
          teacher_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          content TEXT,
          lesson_date DATE,
          start_date DATE,
          end_date DATE,
          estimated_minutes INTEGER DEFAULT 0,
          lesson_order INTEGER DEFAULT 0,
          status TEXT DEFAULT 'draft',
          view_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          subject_code VARCHAR(20),
          grade_group INTEGER,
          achievement_code VARCHAR(50),
          FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
          FOREIGN KEY (teacher_id) REFERENCES users(id),
          CHECK(status IN ('draft', 'published', 'archived', 'scheduled'))
        );
        INSERT INTO lessons_new (id, class_id, teacher_id, title, description, content, lesson_date, lesson_order, status, view_count, created_at, updated_at)
          SELECT id, class_id, teacher_id, title, description, content, lesson_date, lesson_order, status, view_count, created_at, updated_at FROM lessons;
        DROP TABLE lessons;
        ALTER TABLE lessons_new RENAME TO lessons;
        CREATE INDEX IF NOT EXISTS idx_lessons_class ON lessons(class_id);
      `);
      console.log('[DB] lessons 테이블 재생성 완료 (status 확장 + 날짜/시간 컬럼)');
    }
  }

  // lessons status CHECK 제약 확장 (pending, rejected 추가)
  try {
    db.exec("SAVEPOINT lesson_pending_check");
    db.prepare("INSERT INTO lessons (class_id, teacher_id, title, status) VALUES (?, ?, ?, ?)").run(1, 1, '__test_pending__', 'pending');
    db.exec("ROLLBACK TO lesson_pending_check");
    db.exec("RELEASE lesson_pending_check");
  } catch (checkErr2) {
    db.exec("ROLLBACK TO lesson_pending_check");
    db.exec("RELEASE lesson_pending_check");
    if (checkErr2.message.includes('CHECK')) {
      console.log('[DB] lessons 테이블 CHECK 제약 재생성 중 (pending/rejected 추가)...');
      const cols = db.prepare("PRAGMA table_info(lessons)").all().map(c => c.name);
      const colList = cols.join(', ');
      db.exec(`
        CREATE TABLE IF NOT EXISTS lessons_pending (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          class_id INTEGER NOT NULL,
          teacher_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          content TEXT,
          lesson_date DATE,
          start_date DATE,
          end_date DATE,
          estimated_minutes INTEGER DEFAULT 0,
          lesson_order INTEGER DEFAULT 0,
          status TEXT DEFAULT 'draft',
          view_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          subject_code VARCHAR(20),
          grade_group INTEGER,
          achievement_code VARCHAR(50),
          school_level VARCHAR(20),
          tags TEXT,
          theme TEXT,
          classify_mode VARCHAR(20) DEFAULT 'curriculum',
          FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
          FOREIGN KEY (teacher_id) REFERENCES users(id),
          CHECK(status IN ('draft', 'published', 'archived', 'scheduled', 'pending', 'rejected'))
        );
        INSERT INTO lessons_pending (${colList})
          SELECT ${colList} FROM lessons;
        DROP TABLE lessons;
        ALTER TABLE lessons_pending RENAME TO lessons;
        CREATE INDEX IF NOT EXISTS idx_lessons_class ON lessons(class_id, status);
      `);
      console.log('[DB] lessons 테이블 재생성 완료 (pending/rejected 추가)');
    }
  }

  // 관리자 기본 계정
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    // Phase 5 P2: 문서와 코드 통일 — admin 기본 비밀번호는 1234 (qa-report / expert-review 합의)
    const hash = bcrypt.hashSync('1234', 10);
    db.prepare(
      'INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)'
    ).run('admin', hash, '관리자', 'admin');
    console.log('[DB] 관리자 기본 계정 생성 (admin / 1234)');
  }

  // 더미 사용자 계정 (개발용)
  const teacher = db.prepare('SELECT id FROM users WHERE username = ?').get('teacher1');
  if (!teacher) {
    const hash = bcrypt.hashSync('1234', 10);
    db.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)').run('teacher1', hash, '김선생', 'teacher');
    db.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)').run('student1', hash, '이학생', 'student');
    db.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)').run('student2', hash, '박학생', 'student');
    db.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)').run('student3', hash, '최학생', 'student');
    db.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)').run('parent1', hash, '이학부모', 'parent');
    db.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)').run('staff1', hash, '정교직원', 'staff');
    console.log('[DB] 더미 사용자 생성 (teacher1, student1~3, parent1, staff1 / 1234)');
  }

  // 더미 클래스 및 데이터 시딩
  const existingClass = db.prepare('SELECT id FROM classes WHERE id = 1').get();
  if (!existingClass) {
    seedDummyData(db);
  }
}

function seedDummyData(db) {
  const teacherId = db.prepare("SELECT id FROM users WHERE username='teacher1'").get()?.id;
  const student1Id = db.prepare("SELECT id FROM users WHERE username='student1'").get()?.id;
  const student2Id = db.prepare("SELECT id FROM users WHERE username='student2'").get()?.id;
  const student3Id = db.prepare("SELECT id FROM users WHERE username='student3'").get()?.id;
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get()?.id;
  if (!teacherId || !student1Id) return;

  // 클래스 생성
  const classCode = 'ABC123';
  db.prepare(`INSERT INTO classes (code, name, description, owner_id, class_type, subject, school_name, grade, class_number, semester, academic_year, is_public, member_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    classCode, '3학년 1반', '금성초등학교 3학년 1반 클래스입니다.', teacherId,
    '학년/반', '국어', '금성초등학교', 3, 1, 1, '2026', 1, 4
  );
  // 멤버 등록
  db.prepare('INSERT INTO class_members (class_id, user_id, role) VALUES (1, ?, ?), (1, ?, ?), (1, ?, ?), (1, ?, ?)').run(
    teacherId, 'owner', student1Id, 'member', student2Id, 'member', student3Id, 'member'
  );

  // 수업 시딩
  const lessons = [
    { title: '1단원. 문학의 갈래와 특성', content: '문학의 다양한 갈래(시, 소설, 수필, 희곡)의 특성을 이해하고 각 갈래의 대표 작품을 감상합니다.\n\n학습 목표:\n1. 문학의 4가지 갈래를 구분할 수 있다.\n2. 각 갈래의 대표적 특성을 설명할 수 있다.', date: '2026-03-10', status: 'published' },
    { title: '2단원. 음악의 리듬과 표현', content: '음악에서 리듬의 개념과 다양한 표현 방법을 배웁니다.\n\n1. 리듬의 정의\n리듬이란 소리의 길고 짧음이 규칙적으로 반복되는 것입니다.\n\n2. 리듬의 종류\n- 규칙적 리듬\n- 불규칙적 리듬', date: '2026-03-12', status: 'published' },
    { title: '3단원. 분수의 덧셈과 뺄셈', content: '분모가 같은 분수와 다른 분수의 덧셈과 뺄셈을 학습합니다.', date: '2026-03-17', status: 'draft' }
  ];
  const insertLesson = db.prepare('INSERT INTO lessons (class_id, teacher_id, title, content, lesson_date, status) VALUES (1, ?, ?, ?, ?, ?)');
  lessons.forEach(l => insertLesson.run(teacherId, l.title, l.content, l.date, l.status));

  // 과제 시딩
  const homeworks = [
    { title: '리듬이 있는 글 작성하기', desc: '반복이나 운율을 활용하여 리듬감 있는 글 1편을 작성하세요.', due: '2026-03-20', score: 100, status: 'published' },
    { title: '문학 갈래별 작품 감상문', desc: '시, 소설, 수필 중 하나를 골라 감상문을 A4 1장 분량으로 작성하세요.', due: '2026-03-25', score: 100, status: 'published' }
  ];
  const insertHw = db.prepare('INSERT INTO homework (class_id, teacher_id, title, description, due_date, max_score, status) VALUES (1, ?, ?, ?, ?, ?, ?)');
  homeworks.forEach(h => insertHw.run(teacherId, h.title, h.desc, h.due, h.score, h.status));

  // 과제 제출 더미
  db.prepare('INSERT INTO homework_submissions (homework_id, student_id, content, status, submitted_at) VALUES (1, ?, ?, ?, ?)').run(
    student1Id, '리듬감 있는 시를 작성해보았습니다.\n\n봄바람이 불어오면\n꽃잎이 춤을 추고\n나비가 날아오르면\n세상이 환해지네', 'submitted', '2026-03-18 14:30:00'
  );

  // 평가 시딩
  const examId = require('crypto').randomUUID();
  const examAnswers = JSON.stringify([
    { question: '리듬이란 무엇인가?', options: ['색채의 반복', '소리의 규칙적 반복', '그림의 구도', '단어의 뜻'], answer: 1 },
    { question: '규칙적 리듬에 해당하는 것은?', options: ['자유로운 흐름', '점차적 변화', '같은 박자 반복', '감정의 표현'], answer: 2 },
    { question: '다음 중 문학의 갈래가 아닌 것은?', options: ['시', '소설', '보고서', '희곡'], answer: 2 },
    { question: '수필의 특징으로 옳은 것은?', options: ['운문 형식', '대화 중심', '자유로운 형식의 산문', '무대 공연용'], answer: 2 },
    { question: '분수 2/5 + 1/5의 값은?', options: ['1/5', '2/5', '3/5', '4/5'], answer: 2 }
  ]);
  db.prepare('INSERT INTO exams (id, class_id, title, answers, question_count, status, owner_id, time_limit) VALUES (?, 1, ?, ?, 5, ?, ?, ?)').run(
    examId, '3월 종합평가', examAnswers, 'active', teacherId, 15
  );

  // 알림장 시딩
  const insertNotice = db.prepare('INSERT INTO notices (class_id, author_id, title, content, is_pinned) VALUES (1, ?, ?, ?, ?)');
  insertNotice.run(teacherId, '내일 현장학습 안내', '내일 오전 9시까지 학교 운동장에 집합합니다.\n\n준비물: 도시락, 물통, 모자, 필기도구\n복장: 체육복\n\n우천 시 일정이 변경될 수 있습니다.', 1);
  insertNotice.run(teacherId, '3월 독서기록장 제출 안내', '3월 독서기록장을 25일(화)까지 제출해 주세요.\n최소 2권 이상의 독서 기록이 필요합니다.', 0);
  insertNotice.run(teacherId, '수학 보충학습 안내', '분수 단원 보충학습이 필요한 학생은 방과후 수학교실에 참가해 주세요.\n일시: 매주 화, 목 15:00~16:00', 0);

  // 게시판 시딩
  const insertPost = db.prepare('INSERT INTO posts (class_id, author_id, title, content, image_url, category) VALUES (1, ?, ?, ?, ?, ?)');
  insertPost.run(student1Id, '문학 갈래 정리 노트 공유합니다', '시, 소설, 수필, 희곡의 특징을 정리해봤어요.\n\n시 - 운문, 비유와 상징\n소설 - 서사, 인물/사건/배경\n수필 - 자유 형식 산문\n희곡 - 대사와 지시문\n\n도움이 되면 좋겠습니다!', null, 'general');
  insertPost.run(student2Id, '현장학습 때 뭐 먹을까요?', '내일 도시락 뭐 싸가세요? 저는 김밥이랑 과일 가져갈 생각이에요.', null, 'general');
  insertPost.run(teacherId, '이번 주 우수 학습자 발표', '이번 주 수업 참여도와 과제 제출 우수 학생을 발표합니다.\n\n1등: 이학생 - 모든 과제 기한 내 제출, 수업 참여 우수\n2등: 박학생 - 과제 품질 우수', null, 'general');
  // 갤러리형 게시글 (이미지 포함)
  insertPost.run(student1Id, '미술 시간에 그린 풍경화', '오늘 미술 시간에 수채화로 풍경을 그렸어요. 학교 뒤 산을 보고 그렸습니다!', '/images/placeholder-art.png', 'gallery');
  insertPost.run(student2Id, '독서감상문 표지 디자인', '국어 시간 독서감상문 표지를 직접 디자인했어요. 어떤가요?', '/images/placeholder-art.png', 'gallery');

  // 설문 시딩
  const surveyQuestions = JSON.stringify([
    { question: '이번 달 수업 중 가장 재미있었던 단원은?', type: 'choice', options: ['문학의 갈래', '음악의 리듬', '분수의 계산', '기타'] },
    { question: '수업 난이도는 어땠나요?', type: 'scale', max: 5 },
    { question: '수업에서 개선되었으면 하는 점이 있나요?', type: 'text' }
  ]);
  db.prepare('INSERT INTO surveys (class_id, author_id, title, description, questions, status) VALUES (1, ?, ?, ?, ?, ?)').run(
    teacherId, '3월 수업 만족도 조사', '3월 한 달간 수업에 대한 의견을 알려주세요.', surveyQuestions, 'active'
  );

  // 오늘의 학습 시딩
  const goals = JSON.stringify([
    { text: '국어: 운율 개념 분석하기', completed: false },
    { text: '수학: 분수의 덧셈 연습', completed: false }
  ]);
  const insertDaily = db.prepare('INSERT OR IGNORE INTO daily_learning (user_id, learning_date, goals) VALUES (?, ?, ?)');
  insertDaily.run(student1Id, '2026-03-15', goals);
  insertDaily.run(student2Id, '2026-03-15', goals);

  // 오늘의 학습 배포 (관리자)
  db.prepare('INSERT INTO daily_assignments (class_id, teacher_id, title, description, goals, assign_date) VALUES (1, ?, ?, ?, ?, ?)').run(
    adminId, '3월 15일 오늘의 학습', '음악의 리듬과 표현을 학습합니다.', goals, '2026-03-15'
  );

  // 채움콘텐츠: 더미 데이터 없음 (사용자가 직접 등록)

  // === AI 맞춤학습 더미 데이터 ===
  const mapNodes = [
    // 초4 수학
    { node_id: 'M-E4-1-01', subject: '수학', grade_level: '초', grade: 4, semester: 1, area: '수와 연산', unit_name: '큰 수', lesson_name: '만 단위의 수', achievement_code: '[4수01-01]', node_level: 2, sort_order: 1 },
    { node_id: 'M-E4-1-02', subject: '수학', grade_level: '초', grade: 4, semester: 1, area: '수와 연산', unit_name: '큰 수', lesson_name: '억과 조', achievement_code: '[4수01-02]', node_level: 2, sort_order: 2 },
    { node_id: 'M-E4-1-03', subject: '수학', grade_level: '초', grade: 4, semester: 1, area: '수와 연산', unit_name: '곱셈과 나눗셈', lesson_name: '세 자리 수의 곱셈', achievement_code: '[4수01-03]', node_level: 2, sort_order: 3 },
    { node_id: 'M-E4-1-04', subject: '수학', grade_level: '초', grade: 4, semester: 1, area: '수와 연산', unit_name: '곱셈과 나눗셈', lesson_name: '세 자리 수의 나눗셈', achievement_code: '[4수01-04]', node_level: 2, sort_order: 4 },
    { node_id: 'M-E4-1-05', subject: '수학', grade_level: '초', grade: 4, semester: 1, area: '도형', unit_name: '각도', lesson_name: '각도의 이해', achievement_code: '[4수02-01]', node_level: 2, sort_order: 5 },
    { node_id: 'M-E4-1-06', subject: '수학', grade_level: '초', grade: 4, semester: 1, area: '도형', unit_name: '각도', lesson_name: '각도의 합과 차', achievement_code: '[4수02-02]', node_level: 2, sort_order: 6 },
    { node_id: 'M-E4-1-07', subject: '수학', grade_level: '초', grade: 4, semester: 1, area: '규칙성', unit_name: '규칙 찾기', lesson_name: '수의 배열에서 규칙 찾기', achievement_code: '[4수05-01]', node_level: 2, sort_order: 7 },
    // 초5 수학
    { node_id: 'M-E5-1-01', subject: '수학', grade_level: '초', grade: 5, semester: 1, area: '수와 연산', unit_name: '자연수의 혼합 계산', lesson_name: '덧셈과 뺄셈의 혼합', achievement_code: '[5수01-01]', node_level: 2, sort_order: 1 },
    { node_id: 'M-E5-1-02', subject: '수학', grade_level: '초', grade: 5, semester: 1, area: '수와 연산', unit_name: '약수와 배수', lesson_name: '약수와 배수의 관계', achievement_code: '[5수01-02]', node_level: 2, sort_order: 2 },
    { node_id: 'M-E5-1-03', subject: '수학', grade_level: '초', grade: 5, semester: 1, area: '수와 연산', unit_name: '약수와 배수', lesson_name: '최대공약수와 최소공배수', achievement_code: '[5수01-03]', node_level: 2, sort_order: 3 },
    { node_id: 'M-E5-1-04', subject: '수학', grade_level: '초', grade: 5, semester: 1, area: '수와 연산', unit_name: '분수의 덧셈과 뺄셈', lesson_name: '약분과 통분', achievement_code: '[5수01-04]', node_level: 2, sort_order: 4 },
    { node_id: 'M-E5-1-05', subject: '수학', grade_level: '초', grade: 5, semester: 1, area: '도형', unit_name: '다각형의 넓이', lesson_name: '평행사변형의 넓이', achievement_code: '[5수02-01]', node_level: 2, sort_order: 5 },
    // 초6 수학
    { node_id: 'M-E6-1-01', subject: '수학', grade_level: '초', grade: 6, semester: 1, area: '수와 연산', unit_name: '분수의 나눗셈', lesson_name: '분수÷자연수', achievement_code: '[6수01-01]', node_level: 2, sort_order: 1 },
    { node_id: 'M-E6-1-02', subject: '수학', grade_level: '초', grade: 6, semester: 1, area: '수와 연산', unit_name: '소수의 나눗셈', lesson_name: '소수÷자연수', achievement_code: '[6수01-02]', node_level: 2, sort_order: 2 },
    { node_id: 'M-E6-1-03', subject: '수학', grade_level: '초', grade: 6, semester: 1, area: '도형', unit_name: '원의 넓이', lesson_name: '원주율과 원의 넓이', achievement_code: '[6수02-01]', node_level: 2, sort_order: 3 },
    { node_id: 'M-E6-1-04', subject: '수학', grade_level: '초', grade: 6, semester: 1, area: '측정', unit_name: '비와 비율', lesson_name: '비의 개념', achievement_code: '[6수04-01]', node_level: 2, sort_order: 4 },
    { node_id: 'M-E6-1-05', subject: '수학', grade_level: '초', grade: 6, semester: 1, area: '측정', unit_name: '비와 비율', lesson_name: '백분율', achievement_code: '[6수04-02]', node_level: 2, sort_order: 5 },
    // 단원 레벨 노드
    { node_id: 'M-E4-1-U01', subject: '수학', grade_level: '초', grade: 4, semester: 1, area: '수와 연산', unit_name: '큰 수', lesson_name: null, achievement_code: null, node_level: 1, sort_order: 0 },
    { node_id: 'M-E4-1-U02', subject: '수학', grade_level: '초', grade: 4, semester: 1, area: '수와 연산', unit_name: '곱셈과 나눗셈', lesson_name: null, achievement_code: null, node_level: 1, sort_order: 0 },
    { node_id: 'M-E5-1-U01', subject: '수학', grade_level: '초', grade: 5, semester: 1, area: '수와 연산', unit_name: '자연수의 혼합 계산', lesson_name: null, achievement_code: null, node_level: 1, sort_order: 0 },
  ];

  const insertNode = db.prepare(`
    INSERT OR IGNORE INTO learning_map_nodes (node_id, subject, grade_level, grade, semester, area, unit_name, lesson_name, achievement_code, achievement_text, node_level, parent_node_id, sort_order)
    VALUES (@node_id, @subject, @grade_level, @grade, @semester, @area, @unit_name, @lesson_name, @achievement_code, @achievement_text, @node_level, @parent_node_id, @sort_order)
  `);
  for (const node of mapNodes) {
    insertNode.run({ ...node, achievement_text: null, parent_node_id: null });
  }

  // 노드 간 선후관계 (간선)
  const edges = [
    { from: 'M-E4-1-01', to: 'M-E4-1-02' },
    { from: 'M-E4-1-02', to: 'M-E4-1-03' },
    { from: 'M-E4-1-03', to: 'M-E4-1-04' },
    { from: 'M-E4-1-04', to: 'M-E5-1-01' },
    { from: 'M-E4-1-05', to: 'M-E4-1-06' },
    { from: 'M-E5-1-01', to: 'M-E5-1-02' },
    { from: 'M-E5-1-02', to: 'M-E5-1-03' },
    { from: 'M-E5-1-03', to: 'M-E5-1-04' },
    { from: 'M-E5-1-04', to: 'M-E6-1-01' },
    { from: 'M-E5-1-05', to: 'M-E6-1-03' },
    { from: 'M-E6-1-01', to: 'M-E6-1-02' },
    { from: 'M-E6-1-04', to: 'M-E6-1-05' },
    { from: 'M-E4-1-03', to: 'M-E5-1-02' },
    { from: 'M-E5-1-04', to: 'M-E6-1-01' },
    { from: 'M-E4-1-06', to: 'M-E5-1-05' },
  ];
  const insertEdge = db.prepare('INSERT OR IGNORE INTO learning_map_edges (from_node_id, to_node_id) VALUES (?, ?)');
  for (const e of edges) { insertEdge.run(e.from, e.to); }

  // 오늘의 학습 세트 더미 데이터
  db.exec(`
    INSERT OR IGNORE INTO daily_learning_sets (id, class_id, teacher_id, title, description, target_date, target_grade, target_subject, is_active)
    VALUES
      (1, 1, ${teacherId}, '3월 17일 수학 학습', '큰 수 단원 복습', '2026-03-17', 4, '수학', 1),
      (2, 1, ${teacherId}, '3월 17일 국어 학습', '읽기 전략 연습', '2026-03-17', 4, '국어', 1),
      (3, NULL, ${teacherId}, '자기주도 학습 과제', '자유 선택 학습', '2026-03-17', NULL, NULL, 1);
  `);

  // 시스템 설정 기본값
  db.exec(`
    INSERT OR IGNORE INTO system_settings (key, value, description) VALUES
      ('wrong_note_daily_point_limit', '50', '오답노트 일일 포인트 적립 한도'),
      ('wrong_note_resolve_point', '5', '오답 해결 시 포인트'),
      ('wrong_note_streak_bonus', '10', '연속 해결 보너스 포인트'),
      ('attendance_point', '5', '출석 시 포인트'),
      ('daily_learning_complete_point', '10', '오늘의 학습 완료 포인트'),
      ('daily_learning_streak_bonus', '20', '연속 학습 보너스 포인트');
  `);

  // === 독서 기록 시드 데이터 ===
  const insertReading = db.prepare('INSERT OR IGNORE INTO reading_logs (id, user_id, book_title, author, read_date, rating, review) VALUES (?, ?, ?, ?, ?, ?, ?)');
  // student1 (이학생) - 3권
  insertReading.run(1, student1Id, '어린 왕자', '생텍쥐페리', '2026-03-01', 5, '사막에서 만난 어린 왕자의 이야기가 감동적이었습니다.');
  insertReading.run(2, student1Id, '마당을 나온 암탉', '황선미', '2026-03-08', 4, '잎싹이의 용기가 대단했어요.');
  insertReading.run(3, student1Id, '그리스 로마 신화', '이광수', '2026-03-15', 4, '제우스와 올림포스 신들의 이야기가 재미있었습니다.');
  // student2 (최학생) - 2권
  insertReading.run(4, student2Id, '샬롯의 거미줄', 'E.B. 화이트', '2026-03-05', 5, '샬롯과 윌버의 우정이 정말 감동이었어요.');
  insertReading.run(5, student2Id, '나미야 잡화점의 기적', '히가시노 게이고', '2026-03-12', 3, '편지를 통해 연결되는 이야기가 신기했습니다.');
  // student3 (박학생) - 1권
  if (student3Id) insertReading.run(6, student3Id, '해리포터와 마법사의 돌', 'J.K. 롤링', '2026-03-10', 5, '마법 세계가 너무 재미있었어요!');

  // === 진로탐색 시드 데이터 ===
  const insertCareer = db.prepare('INSERT OR IGNORE INTO career_logs (id, user_id, activity_type, title, description, interest_area, reflection, activity_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  // student1
  insertCareer.run(1, student1Id, '직업탐구', '과학자가 하는 일', '과학자의 하루 일과를 알아보았습니다.', '과학/연구', '실험을 하는 것이 재미있을 것 같아요.', '2026-03-05');
  insertCareer.run(2, student1Id, '체험활동', '코딩 체험교실', '스크래치로 간단한 게임을 만들었습니다.', 'IT/프로그래밍', '코딩으로 게임을 만들 수 있어서 신기했어요.', '2026-03-12');
  // student2
  insertCareer.run(3, student2Id, '직업탐구', '수의사가 하는 일', '동물병원에서 수의사가 하는 일을 조사했습니다.', '동물/의료', '아픈 동물을 치료해주는 일을 하고 싶어요.', '2026-03-07');
  // student3
  if (student3Id) insertCareer.run(4, student3Id, '체험활동', '요리 체험학습', '제과제빵 체험을 했습니다.', '요리/식품', '빵 만들기가 정말 재미있었어요!', '2026-03-10');

  console.log('[DB] 더미 클래스 및 교육 데이터 시딩 완료');
}

module.exports = { initSchema, init: initSchema };
