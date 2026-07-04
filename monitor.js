const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { sendCancellationEmail, sendCancellationKakao } = require("./notifier");
const { FACILITIES, ROOM_TYPES, ALL_ROOM_TYPES_CODE } = require("./config");

const STATE_FILE = path.join(__dirname, "data", "state.json");
const SETTINGS_FILE = path.join(__dirname, "data", "settings.json");
const HISTORY_FILE = path.join(__dirname, "data", "history.json");

const RESERVATION_URL =
  process.env.RESERVATION_URL ||
  "https://www.campingkorea.or.kr/user/reservation/BD_reservation.do";

// ---------- 파일 기반 저장소 (간단한 JSON, 별도 DB 불필요) ----------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getSettings() {
  return readJson(SETTINGS_FILE, {
    email: "",
    startDate: "",
    endDate: "",
    facilities: FACILITIES.map((f) => f.code), // 기본: 전체 시설
    roomTypes: ALL_ROOM_TYPES_CODE, // 기본: 전체 숙소유형 포함
    active: false,
    channels: { email: false, kakao: true }, // 알림 채널: 기본은 카카오
  });
}
function saveSettings(settings) {
  writeJson(SETTINGS_FILE, settings);
}
function getHistory() {
  return readJson(HISTORY_FILE, []);
}
function pushHistory(entry) {
  const h = getHistory();
  h.unshift({ time: new Date().toISOString(), ...entry });
  writeJson(HISTORY_FILE, h.slice(0, 200)); // 최근 200건만 보관
}

function dateRange(start, end) {
  const dates = [];
  let d = new Date(start);
  const last = new Date(end);
  while (d <= last) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// ---------------------------------------------------------------
// ⚠️ 아래 셀렉터들은 실제 화면 구조(스크린샷)를 바탕으로 만들었지만,
// 정확한 class/속성명까지는 확인이 안 된 부분이라 배포 후
// 한 번은 검증/조정이 필요할 수 있습니다.
//
// 실제 화면 구조 (사용자 확인 기반):
// - 1단계 달력: 날짜별로 ✅(예약가능) / ❌(마감) 아이콘이 그리드로 표시됨
// - 2단계(시설선택): 활성 날짜로 진입하면 숙소유형 버튼들(전통한옥/캐빈하우스/
//   든바다/난바다/허허바다/자동차캠핑장/캐라반/글램핑(4인)/글램핑(2인))이 표시됨
//
// 전략:
// 1) 매 주기마다 달력 화면만 불러와서(가벼움) 날짜별 ✅/❌ 상태를 비교
// 2) "전체 포함" 설정이면 여기서 바로 취소감지 완료
// 3) 특정 숙소유형만 원하는 경우에만, 상태가 바뀐 날짜에 한해 2단계까지
//    들어가서 어떤 유형이 열렸는지 추가로 확인 (달력만 보는 것보다 느리므로
//    변경 감지된 날짜에 대해서만 실행 = 효율적)
// ---------------------------------------------------------------

const CALENDAR_ICON_SELECTOR = ".calendar td, .day-cell, td.day"; // 날짜 1칸(그리드 셀)
const AVAILABLE_ICON_HINT = /가능|possible|ok|check/i; // 아이콘 alt/class/이미지 파일명 힌트
const FULL_ICON_HINT = /마감|불가|impossible|no|close/i;

const ROOM_TYPE_BUTTON_SELECTOR = ".facility-btn, .room-type-btn, .site-btn, button, a.btn"; // 2단계 숙소유형 버튼

function toYearMonth(dateStr) {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

// 1단계: 달력 한 화면에서 날짜별 예약가능(✅)/마감(❌) 상태를 읽어옴
async function scrapeCalendarMonth(page, facilityCode, yearMonth) {
  const url = `${RESERVATION_URL}?facility=${facilityCode}&ym=${yearMonth}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

  const cells = await page.$$eval(CALENDAR_ICON_SELECTOR, (nodes, hints) => {
    const availRe = new RegExp(hints.avail, "i");
    const fullRe = new RegExp(hints.full, "i");
    return nodes
      .map((n) => {
        const dayText = n.querySelector(".date, .day-num")?.textContent?.trim() || n.textContent.trim();
        const dayMatch = dayText.match(/^\d{1,2}/);
        if (!dayMatch) return null;

        const icon = n.querySelector("img, .icon, .status-icon");
        const iconClue = [
          icon?.getAttribute("alt") || "",
          icon?.getAttribute("src") || "",
          icon?.className || "",
          n.className || "",
        ].join(" ");

        let available = null;
        if (availRe.test(iconClue)) available = true;
        else if (fullRe.test(iconClue)) available = false;

        return { day: Number(dayMatch[0]), available };
      })
      .filter((x) => x && x.available !== null);
  }, { avail: AVAILABLE_ICON_HINT.source, full: FULL_ICON_HINT.source });

  const [year, month] = yearMonth.split("-");
  const result = {};
  for (const c of cells) {
    const dateStr = `${year}-${month}-${String(c.day).padStart(2, "0")}`;
    result[dateStr] = c.available;
  }
  return result;
}

// 2단계: 특정 날짜의 숙소유형별 활성/비활성 버튼을 읽어옴 (필요할 때만 호출)
async function scrapeRoomTypesForDate(page, facilityCode, dateStr) {
  const url = `${RESERVATION_URL}?facility=${facilityCode}&checkin=${dateStr}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

  return page.$$eval(ROOM_TYPE_BUTTON_SELECTOR, (nodes) =>
    nodes
      .map((n) => ({
        name: n.textContent.trim(),
        disabled:
          n.hasAttribute("disabled") ||
          n.classList.contains("disabled") ||
          n.classList.contains("off") ||
          n.getAttribute("aria-disabled") === "true",
      }))
      .filter((r) => r.name)
  ).then((rows) => rows.map((r) => ({ roomTypeName: r.name, available: !r.disabled })));
}

function matchRoomType(roomTypeName, wanted) {
  if (wanted === ALL_ROOM_TYPES_CODE) return true;
  const wantedNames = ROOM_TYPES.filter((rt) => wanted.includes(rt.code)).map((rt) => rt.name);
  return wantedNames.some((n) => roomTypeName.includes(n));
}

async function runCheckOnce() {
  const settings = getSettings();
  const channels = settings.channels || { email: false, kakao: true };
  const needsEmail = channels.email && !settings.email;
  if (!settings.active || !settings.startDate || !settings.endDate || needsEmail) {
    return { skipped: true, reason: "설정이 완료되지 않았거나 감시가 꺼져 있습니다." };
  }

  const wantsAllRoomTypes = settings.roomTypes === ALL_ROOM_TYPES_CODE;
  const prevState = readJson(STATE_FILE, {});
  const nextState = {};
  const newlyAvailable = [];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const dates = dateRange(settings.startDate, settings.endDate);
    const yearMonths = [...new Set(dates.map(toYearMonth))];
    const facilities = FACILITIES.filter((f) => settings.facilities.includes(f.code));

    for (const facility of facilities) {
      // 1) 달력 단위로 월별 상태를 한 번에 확인 (가볍고 빠름)
      let calendarByDate = {};
      for (const ym of yearMonths) {
        try {
          const monthMap = await scrapeCalendarMonth(page, facility.code, ym);
          calendarByDate = { ...calendarByDate, ...monthMap };
        } catch (e) {
          console.error(`[monitor] ${facility.name} ${ym} 달력 조회 실패:`, e.message);
        }
      }

      for (const dateStr of dates) {
        const key = `${facility.code}__${dateStr}`;
        const isAvailable = calendarByDate[dateStr];
        if (isAvailable === undefined) continue; // 범위 밖이거나 조회 실패

        const wasAvailable = prevState[key]?.dateAvailable ?? false;
        nextState[key] = { dateAvailable: isAvailable, roomTypes: prevState[key]?.roomTypes || [] };

        // 날짜 단위로 마감→가능 전환 감지
        if (isAvailable && !wasAvailable) {
          if (wantsAllRoomTypes) {
            newlyAvailable.push({ facilityName: facility.name, roomTypeName: "전체", date: dateStr });
          } else {
            // 2) 특정 숙소유형만 원하면, 바뀐 날짜에 한해서만 2단계까지 들어가 확인
            try {
              const roomRows = await scrapeRoomTypesForDate(page, facility.code, dateStr);
              nextState[key].roomTypes = roomRows;
              const matched = roomRows.filter((r) => r.available && matchRoomType(r.roomTypeName, settings.roomTypes));
              matched.forEach((m) =>
                newlyAvailable.push({ facilityName: facility.name, roomTypeName: m.roomTypeName, date: dateStr })
              );
            } catch (e) {
              console.error(`[monitor] ${facility.name} ${dateStr} 숙소유형 조회 실패:`, e.message);
            }
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  writeJson(STATE_FILE, nextState);

  if (newlyAvailable.length > 0) {
    pushHistory({ type: "취소감지", status: "취소 발생", items: newlyAvailable });
    if (channels.kakao) {
      try {
        await sendCancellationKakao({ items: newlyAvailable });
      } catch (e) {
        console.error("[notifier] 카카오 발송 실패:", e.message);
      }
    }
    if (channels.email && settings.email) {
      try {
        await sendCancellationEmail({ to: settings.email, items: newlyAvailable });
      } catch (e) {
        console.error("[notifier] 이메일 발송 실패:", e.message);
      }
    }
  } else {
    pushHistory({ type: "정기감시", status: "변동없음", items: [] });
  }

  return { skipped: false, found: newlyAvailable.length };
}

module.exports = {
  runCheckOnce,
  getSettings,
  saveSettings,
  getHistory,
};
