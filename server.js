require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const path = require("path");
const { FACILITIES } = require("./config");
const { runCheckOnce, getSettings, saveSettings, getHistory, getBoard, getStatus } = require("./monitor");
const kakao = require("./kakao");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({ facilities: FACILITIES });
});

app.get("/api/settings", (req, res) => {
  res.json(getSettings());
});

app.post("/api/settings", (req, res) => {
  const { email, startDate, endDate, facilities, active, channels } = req.body;
  const ch = channels || { email: false, kakao: true };

  if (!startDate || !endDate) {
    return res.status(400).json({ error: "시작일, 종료일은 필수입니다." });
  }
  if (ch.email && !email) {
    return res.status(400).json({ error: "이메일 알림을 사용하려면 이메일 주소가 필요합니다." });
  }
  if (ch.kakao && !kakao.isConnected()) {
    return res.status(400).json({ error: "카카오 알림을 사용하려면 먼저 카카오 연동을 완료해주세요." });
  }

  saveSettings({
    email: email || "",
    startDate,
    endDate,
    facilities: Array.isArray(facilities) && facilities.length ? facilities : FACILITIES.map((f) => f.code),
    active: !!active,
    channels: ch,
  });
  res.json({ ok: true });
});

// ---- 카카오 "나에게 보내기" 연동 ----
app.get("/auth/kakao", (req, res) => {
  res.redirect(kakao.getAuthUrl());
});
app.get("/auth/kakao/callback", async (req, res) => {
  try {
    await kakao.exchangeCodeForToken(req.query.code);
    res.redirect("/?kakao=connected");
  } catch (e) {
    res.status(500).send(`카카오 연동 실패: ${e.message}`);
  }
});
app.get("/api/kakao/status", (req, res) => {
  res.json({ connected: kakao.isConnected() });
});

app.get("/api/history", (req, res) => {
  res.json(getHistory());
});

app.get("/api/board", (req, res) => {
  res.json(getBoard());
});

app.get("/api/status", (req, res) => {
  res.json({ settings: getSettings(), status: getStatus() });
});

// 수동으로 즉시 1회 감시 실행 (테스트용)
app.post("/api/run-now", async (req, res) => {
  try {
    const result = await runCheckOnce();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`망상 빈자리 알림 서버 실행 중: http://localhost:${PORT}`));

// ---- 스케줄러: 기본 10분마다 자동 감시 ----
// 사이트에 부담을 주지 않도록 너무 짧은 주기는 권장하지 않습니다.
const INTERVAL_MIN = Number(process.env.CHECK_INTERVAL_MIN || 10);
cron.schedule(`*/${INTERVAL_MIN} * * * *`, async () => {
  console.log(`[cron] 감시 실행 (${new Date().toLocaleString("ko-KR")})`);
  try {
    await runCheckOnce();
  } catch (e) {
    console.error("[cron] 실행 오류:", e.message);
  }
});
