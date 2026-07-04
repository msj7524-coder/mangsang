// 감시 대상 시설 목록 (동해시 통합예약시스템 campingkorea.or.kr 기준)
// facilityCode 는 실제 사이트의 시설 코드로 배포 후 반드시 확인/수정하세요.
// (사이트 예약 페이지 URL의 파라미터를 개발자도구 Network 탭에서 확인)
const FACILITIES = [
  { code: "ms_resort", name: "망상오토캠핑리조트" },
  { code: "ms_camp2", name: "망상제2오토캠핑장" },
  { code: "mureung", name: "무릉힐링캠프장" },
  { code: "chuam", name: "추암오토캠핑장" },
];

// 숙소 유형 (스크린샷에서 확인된 망상오토캠핑리조트 2단계 시설선택 버튼 기준)
// 시설마다 실제 제공 유형이 다르므로(예: 캠핑장은 오토캠핑만 있을 수 있음)
// 배포 후 다른 시설도 확인해서 필요시 조정하세요.
const ROOM_TYPES = [
  { code: "hanok", name: "전통한옥" },
  { code: "cabin", name: "캐빈하우스" },
  { code: "deunbada", name: "든바다" },
  { code: "nanbada", name: "난바다" },
  { code: "heoheobada", name: "허허바다" },
  { code: "auto", name: "자동차캠핑장" },
  { code: "caravan", name: "캐라반" },
  { code: "glamping4", name: "글램핑(4인)" },
  { code: "glamping2", name: "글램핑(2인)" },
];

const ALL_ROOM_TYPES_CODE = "ALL"; // "전체 포함" 선택 시 사용

module.exports = { FACILITIES, ROOM_TYPES, ALL_ROOM_TYPES_CODE };
