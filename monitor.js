const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { sendCancellationEmail, sendCancellationKakao } = require("./notifier");
const { FACILITIES } = require("./config");

const STATE_FILE = path.join(__dirname, "data", "state.json");
const SETTINGS_FILE = path.join(__dirname, "data", "settings.json");
const HISTORY_FILE = path.join(__dirname, "data", "history.json");
const BOARD_FILE = path.join(__dirname, "data", "board.json");

const RESERVATION_URL =
  process.env.RESERVATION_URL ||
  "https://www.campingkorea.or.kr/user/reservation/BD_reservation.do";

// ---------- 파일 기반 저장소 ----------
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
    active: false,
    channels: { email: false, kakao: true },
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
  writeJson(HISTORY_FILE, h.slice(0, 200));
}
function getBoard() {
  return readJson(BOARD_FILE, { updatedAt: null, items: [] });
}
function saveBoard(items) {
  writeJson(BOARD_FILE, { updatedAt: new Date().toISOString(), items });
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
function toYearMonth(dateStr) {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

// ---------------------------------------------------------------
// 아래는 실제 사이트(campingkorea.or.kr) 마크업을 확인해서 만든 셀렉터입니다.
//
// - 시설 탭: <li id="trrsrt_1000"><a onclick="chgTrrsrt('1000')">...</a></li>
// - 월 이동: <a class="prev" onclick="opPrevMonth()">지난 달</a> / <a class="next" onclick="opNextMonth()">다음 달</a>
// - 현재 표시 월: <strong class="dat">2026.07</strong> (div.mDate1 안)
// - 날짜 셀: td 안의 .day .da 가 일자, .lst.forM 안에 a.able 이 있으면 "예약가능"
//   (없으면 예약마감/예약종료 상태)
//
// 캡차(무단예약방지문구)는 "다음" 버튼을 눌러 2단계로 넘어갈 때만 필요하므로,
// 이 달력 조회 단계에서는 캡차가 필요 없습니다.
// ---------------------------------------------------------------

async function getDisplayedYm(page) {
  const text = await page.locator(".mDate1 .dat").innerText();
  const [y, m] = text.trim().split(".");
  return `${y}-${String(m).padStart(2, "0")}`;
}

async function scrapeCurrentMonth(page) {
  const ym = await getDisplayedYm(page);
  const cells = await page.$$eval(".mCalendar1 td", (tds) =>
    tds
      .map((td) => {
        const dayEl = td.querySelector(".day .da");
        const dayText = dayEl ? dayEl.textContent.trim() : "";
        if (!dayText) return null;
        const day = Number(dayText);
        const ableEl = td.querySelector(".lst.forM a.able, .lst.forW a.able");
        return { day, available: !!ableEl };
      })
      .filter(Boolean)
  );

  const [year, month] = ym.split("-");
  const map = {};
  for (const c of cells) {
    map[`${year}-${month}-${String(c.day).padStart(2, "0")}`] = c.available;
  }
  return map;
}

async function goToYearMonth(page, targetYm, maxSteps = 36) {
  for (let i = 0; i < maxSteps; i++) {
    const current = await getDisplayedYm(page);
    if (current === targetYm) return true;
    const goForward = current < targetYm;
    const selector = goForward ? ".mDate1 .next" : ".mDate1 .prev";
    await page.click(selector).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(400);
  }
  return false;
}

async function goToFacility(page, trrsrtCode) {
  const isActive = await page
    .locator(`#trrsrt_${trrsrtCode}`)
    .evaluate((el) => el.classList.contains("active"))
    .catch(() => false);
  if (isActive) return;
  await page.click(`#trrsrt_${trrsrtCode} a`).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForSelector(".mCalendar1", { timeout: 15000 }).catch(() => {});
}

async function runCheckOnce() {
  const settings = getSettings();
  const channels = settings.channels || { email: false, kakao: true };
  const needsEmail = channels.email && !settings.email;
  if (!settings.active || !settings.startDate || !settings.endDate || needsEmail) {
    return { skipped: true, reason: "설정이 완료되지 않았거나 감시가 꺼져 있습니다." };
  }

  const prevState = readJson(STATE_FILE, {});
  const nextState = {};
  const newlyAvailable = [];
  const currentlyAvailable = [];

  const dates = dateRange(settings.startDate, settings.endDate);
  const yearMonths = [...new Set(dates.map(toYearMonth))].sort();
  const facilities = FACILITIES.filter((f) => settings.facilities.includes(f.code));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    for (const facility of facilities) {
      await page.goto(RESERVATION_URL, { waitUntil: "networkidle" });
      await goToFacility(page, facility.code);

      let calendarByDate = {};
      for (const ym of yearMonths) {
        const ok = await goToYearMonth(page, ym);
        if (!ok) continue;
        const map = await scrapeCurrentMonth(page);
        calendarByDate = { ...calendarByDate, ...map };
      }

      for (const dateStr of dates) {
        const key = `${facility.code}__${dateStr}`;
        const isAvailable = calendarByDate[dateStr];
        if (isAvailable === undefined) continue;

        const wasAvailable = prevState[key] ?? false;
        nextState[key] = isAvailable;

        if (isAvailable && !wasAvailable) {
          newlyAvailable.push({ facilityName: facility.name, roomTypeName: "전체", date: dateStr });
        }
        if (isAvailable) {
          currentlyAvailable.push({ facilityName: facility.name, date: dateStr });
        }
      }
    }
  } catch (e) {
    await browser.close();
    throw e;
  }
  await browser.close();

  writeJson(STATE_FILE, nextState);
  currentlyAvailable.sort((a, b) => a.date.localeCompare(b.date) || a.facilityName.localeCompare(b.facilityName));
  saveBoard(currentlyAvailable);

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
  getBoard,
};
