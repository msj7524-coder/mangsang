const nodemailer = require("nodemailer");
const kakao = require("./kakao");

function buildTransport() {
  // Gmail 앱 비밀번호 방식 (가장 간단, 무료)
  // .env 에 GMAIL_USER / GMAIL_APP_PASSWORD 설정
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }

  // 커스텀 SMTP 를 쓰고 싶다면 .env 에 SMTP_* 값을 채우세요
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  return null;
}

async function sendCancellationEmail({ to, items }) {
  const transporter = buildTransport();
  if (!transporter) {
    console.warn("[notifier] 메일 설정이 없어 발송을 건너뜁니다. .env를 확인하세요.");
    return { skipped: true };
  }

  const listHtml = items
    .map(
      (it) =>
        `<li><b>${it.facilityName}</b> · ${it.roomTypeName} · ${it.date} — <span style="color:#d92626">취소 발생(예약가능)</span></li>`
    )
    .join("");

  const from = process.env.GMAIL_USER || process.env.SMTP_USER;

  await transporter.sendMail({
    from: `"망상 빈자리 알림" <${from}>`,
    to,
    subject: `🏕️ 취소 발생! 예약 가능한 자리가 생겼어요 (${items.length}건)`,
    html: `
      <div style="font-family:sans-serif;line-height:1.6">
        <h2>취소 자리 발생 알림</h2>
        <p>등록하신 조건에 맞는 취소(빈자리)가 감지되었습니다. 서두르세요!</p>
        <ul>${listHtml}</ul>
        <p><a href="https://www.campingkorea.or.kr/user/reservation/BD_reservation.do" target="_blank">지금 예약하러 가기 →</a></p>
        <hr/>
        <p style="color:#888;font-size:12px">본 메일은 자동 감시 시스템에 의해 발송되었습니다.</p>
      </div>
    `,
  });

  return { skipped: false };
}

async function sendCancellationKakao({ items }) {
  if (!kakao.isConnected()) {
    console.warn("[notifier] 카카오 연동이 안 되어 있어 발송을 건너뜁니다. /auth/kakao 로 연동하세요.");
    return { skipped: true };
  }

  const lines = items
    .map((it) => `• ${it.facilityName} ${it.roomTypeName} ${it.date}`)
    .join("\n");

  const text = `🏕️ 취소 자리 발생!\n\n${lines}\n\n서두르세요, 지금 예약 가능해요.`;

  await kakao.sendMemoToMe(
    text,
    "https://www.campingkorea.or.kr/user/reservation/BD_reservation.do"
  );
  return { skipped: false };
}

module.exports = { sendCancellationEmail, sendCancellationKakao };
