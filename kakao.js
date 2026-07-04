const fs = require("fs");
const path = require("path");

const TOKEN_FILE = path.join(__dirname, "data", "kakao_token.json");
const REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const REDIRECT_URI = process.env.KAKAO_REDIRECT_URI; // 예: https://your-app.onrender.com/auth/kakao/callback

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
  } catch {
    return null;
  }
}
function saveToken(data) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: REST_API_KEY,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "talk_message", // 나에게 메시지 보내기 권한
  });
  return `https://kauth.kakao.com/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: REST_API_KEY,
    redirect_uri: REDIRECT_URI,
    code,
  });
  const res = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await res.json();
  if (data.error) throw new Error(`카카오 토큰 발급 실패: ${data.error_description || data.error}`);
  saveToken({ ...data, obtained_at: Date.now() });
  return data;
}

async function refreshAccessToken() {
  const token = readToken();
  if (!token || !token.refresh_token) throw new Error("카카오 연동이 되어있지 않습니다. 먼저 /auth/kakao 로 연동해주세요.");

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: REST_API_KEY,
    refresh_token: token.refresh_token,
  });
  const res = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await res.json();
  if (data.error) throw new Error(`카카오 토큰 갱신 실패: ${data.error_description || data.error}`);

  const merged = {
    ...token,
    access_token: data.access_token,
    // refresh_token 이 갱신되어 내려올 때만 교체
    refresh_token: data.refresh_token || token.refresh_token,
    obtained_at: Date.now(),
  };
  saveToken(merged);
  return merged;
}

async function getValidAccessToken() {
  const token = readToken();
  if (!token) throw new Error("카카오 연동이 되어있지 않습니다. 먼저 /auth/kakao 로 연동해주세요.");

  const ageSec = (Date.now() - (token.obtained_at || 0)) / 1000;
  // 만료 임박(5분 이내)하면 미리 갱신
  if (!token.expires_in || ageSec > token.expires_in - 300) {
    const refreshed = await refreshAccessToken();
    return refreshed.access_token;
  }
  return token.access_token;
}

function isConnected() {
  return !!readToken();
}

async function sendMemoToMe(text, linkUrl) {
  const accessToken = await getValidAccessToken();

  const templateObject = {
    object_type: "text",
    text,
    link: { web_url: linkUrl, mobile_web_url: linkUrl },
    button_title: "예약하러 가기",
  };

  const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ template_object: JSON.stringify(templateObject) }),
  });
  const data = await res.json();
  if (data.result_code !== 0 && !res.ok) {
    throw new Error(`카카오 메시지 발송 실패: ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = { getAuthUrl, exchangeCodeForToken, sendMemoToMe, isConnected };
