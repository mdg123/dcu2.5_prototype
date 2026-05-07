/**
 * 채움클래스 공통 UI 헬퍼 — 토스트(top-center) + 커스텀 확인 모달
 *
 * 사용법:
 *   classToast('저장되었습니다.', 'success');
 *   if (await classConfirm({ title:'삭제 확인', message:'정말 삭제하시겠습니까?', okLabel:'삭제', danger:true })) {
 *     doDelete();
 *   }
 *
 * 토스트 타입: success(녹색) | error(빨강) | warning(주황) | info(파랑)
 */

(function (global) {
  if (global.classToast && global.classConfirm) return; // 중복 로드 방지

  // ─────────────────────────────────────────────
  // 스타일 1회 주입
  // ─────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('class-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'class-ui-styles';
    style.textContent = `
.class-toast {
  position: fixed;
  top: 88px;
  left: 50%;
  transform: translateX(-50%) translateY(-8px);
  padding: 12px 20px;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  z-index: 12000;
  box-shadow: 0 6px 20px rgba(0,0,0,.18);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 480px;
  opacity: 0;
  transition: opacity .2s, transform .2s;
  pointer-events: none;
  white-space: pre-line;
  line-height: 1.5;
}
.class-toast.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.class-toast.success { background: #16a34a; }
.class-toast.error   { background: #dc2626; }
.class-toast.warning { background: #f59e0b; }
.class-toast.info    { background: #2563eb; }

.class-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15,23,42,.55);
  z-index: 12500;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  opacity: 0;
  transition: opacity .15s;
}
.class-confirm-overlay.show { opacity: 1; }
.class-confirm-box {
  background: #fff;
  border-radius: 14px;
  padding: 28px 32px 22px;
  min-width: 360px;
  max-width: 480px;
  box-shadow: 0 20px 60px rgba(0,0,0,.28);
  transform: translateY(8px);
  transition: transform .15s;
}
.class-confirm-overlay.show .class-confirm-box { transform: translateY(0); }
.class-confirm-icon {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #FEE2E2;
  color: #DC2626;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  margin-bottom: 14px;
}
.class-confirm-icon.info { background: #DBEAFE; color: #2563EB; }
.class-confirm-title {
  font-size: 18px;
  font-weight: 700;
  color: #1A1A2E;
  margin-bottom: 8px;
}
.class-confirm-msg {
  font-size: 16px;
  color: #475569;
  line-height: 1.65;
  margin-bottom: 22px;
  white-space: pre-line;
}
.class-confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.class-confirm-btn {
  padding: 10px 20px;
  border-radius: 8px;
  border: 0;
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  transition: background .15s;
}
.class-confirm-btn.cancel { background: #F1F5F9; color: #475569; }
.class-confirm-btn.cancel:hover { background: #E2E8F0; }
.class-confirm-btn.ok { background: #ef4444; color: #fff; }
.class-confirm-btn.ok:hover { background: #dc2626; }
.class-confirm-btn.ok.info { background: #2563EB; }
.class-confirm-btn.ok.info:hover { background: #1D4ED8; }
`;
    document.head.appendChild(style);
  }

  function ensureReady(cb) {
    if (document.body) {
      injectStyles();
      cb();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        injectStyles();
        cb();
      });
    }
  }

  // HTML escape (XSS 방지)
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ─────────────────────────────────────────────
  // 토스트
  // ─────────────────────────────────────────────
  function classToast(msg, type) {
    type = type || 'info';
    ensureReady(() => {
      const t = document.createElement('div');
      t.className = 'class-toast ' + type;
      const iconMap = {
        success: 'check-circle',
        error: 'exclamation-circle',
        warning: 'exclamation-triangle',
        info: 'info-circle'
      };
      const icon = iconMap[type] || 'info-circle';
      t.innerHTML = '<i class="fas fa-' + icon + '"></i> <span>' + esc(msg) + '</span>';
      document.body.appendChild(t);
      requestAnimationFrame(() => t.classList.add('show'));
      setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.remove(), 250);
      }, 2400);
    });
  }

  // ─────────────────────────────────────────────
  // 확인 모달
  // ─────────────────────────────────────────────
  function classConfirm(opts) {
    if (typeof opts === 'string') opts = { message: opts };
    const o = opts || {};
    const title = o.title || '확인';
    const message = o.message || '진행하시겠습니까?';
    const okLabel = o.okLabel || '확인';
    const cancelLabel = o.cancelLabel || '취소';
    const danger = !!o.danger;

    return new Promise(resolve => {
      ensureReady(() => {
        const overlay = document.createElement('div');
        overlay.className = 'class-confirm-overlay';
        overlay.innerHTML =
          '<div class="class-confirm-box" role="dialog" aria-modal="true">' +
            '<div class="class-confirm-icon ' + (danger ? '' : 'info') + '">' +
              '<i class="fas fa-' + (danger ? 'exclamation-triangle' : 'question-circle') + '"></i>' +
            '</div>' +
            '<div class="class-confirm-title">' + esc(title) + '</div>' +
            '<div class="class-confirm-msg">' + esc(message) + '</div>' +
            '<div class="class-confirm-actions">' +
              '<button class="class-confirm-btn cancel" type="button">' + esc(cancelLabel) + '</button>' +
              '<button class="class-confirm-btn ok ' + (danger ? '' : 'info') + '" type="button">' + esc(okLabel) + '</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));

        let settled = false;
        const close = (val) => {
          if (settled) return;
          settled = true;
          overlay.classList.remove('show');
          document.removeEventListener('keydown', onKey);
          setTimeout(() => overlay.remove(), 150);
          resolve(val);
        };
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); close(false); }
          else if (e.key === 'Enter') { e.preventDefault(); close(true); }
        };
        overlay.querySelector('.cancel').onclick = () => close(false);
        overlay.querySelector('.ok').onclick = () => close(true);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
        document.addEventListener('keydown', onKey);
        setTimeout(() => {
          const okBtn = overlay.querySelector('.ok');
          if (okBtn) okBtn.focus();
        }, 50);
      });
    });
  }

  global.classToast = classToast;
  global.classConfirm = classConfirm;
})(window);
