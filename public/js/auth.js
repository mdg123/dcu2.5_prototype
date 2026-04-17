// 현재 사용자 정보를 확인하고, 미인증 시 로그인 페이지로 리다이렉트
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.success && data.user) {
      return data.user;
    }
  } catch (e) {
    // ignore
  }
  window.location.href = '/login.html';
  return null;
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}
