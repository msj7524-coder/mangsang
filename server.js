require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const path = require("path");
const { FACILITIES, ROOM_TYPES, ALL_ROOM_TYPES_CODE } = require("./config");
const { runCheckOnce, getSettings, saveSettings, getHistory, getBoard } = require("./monitor");
const { getHeartbeat, saveHeartbeat, getEvents, pushEvents } = require("./heartbeat");
const kakao = require("./kakao");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({ facilities: FACILITIES, roomTypes: ROOM_TYPES, allCode: ALL_ROOM_TYPES_CODE });
});

app.get("/api/settings", (req, res) => {
  res.json(getSettings());
});

app.post("/api/settings", (req, res) => {
  const { email, startDate, endDate, facilities, roomTypes, active, channels } = req.body;
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
    roomTypes: roomTypes || ALL_ROOM_TYPES_CODE,
    active: !!active,
    channels: ch,
  });
  res.json({ ok: true });
});

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
app.post("/api/run-now", async (req, res) => {
  try {
    const result = await runCheckOnce();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- PC 워처(watcher)가 보내는 실시간 시설별 현황 수신 ----
app.post("/api/heartbeat", (req, res) => {
  const token = req.headers["x-heartbeat-token"];
  if (process.env.HEARTBEAT_TOKEN && token !== process.env.HEARTBEAT_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const body = req.body || {};
  const availableItems = Array.isArray(body.available_items) ? body.available_items : [];
  const cancelingItems = Array.isArray(body.canceling_items) ? body.canceling_items : [];

  saveHeartbeat({
    client: body.client || "",
    status: body.status || "ok",
    received_at: new Date().toISOString(),
    target_dates: body.target_dates || [],
    facilities: body.facilities || [],
    available_items: availableItems,
    canceling_items: cancelingItems,
    available_count: availableItems.length,
    canceling_count: cancelingItems.length,
    message: body.message || "",
  });

  if (Array.isArray(body.events) && body.events.length) {
    pushEvents(body.events.map((e) => ({ ...e, received_at: new Date().toISOString() })));
  }

  res.json({ ok: true });
});

app.get("/api/state", (req, res) => {
  res.json({ heartbeat: getHeartbeat(), events: getEvents() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`망상 빈자리 알림 v2 서버 실행 중: http://localhost:${PORT}`));

const INTERVAL_MIN = Number(process.env.CHECK_INTERVAL_MIN || 5);
cron.schedule(`*/${INTERVAL_MIN} * * * *`, async () => {
  console.log(`[cron] 감시 실행 (${new Date().toLocaleString("ko-KR")})`);
  try {
    await runCheckOnce();
  } catch (e) {
    console.error("[cron] 실행 오류:", e.message);
  }
});
