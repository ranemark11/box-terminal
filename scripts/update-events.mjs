// 포켓몬고 이벤트 일정 자동 갱신 스크립트
// 1) ScrapedDuck(LeekDuck 수집 데이터)에서 이벤트 목록을 받는다
// 2) 오늘 기준 진행 중 + 30일 이내 시작 일정만 남긴다
// 3) 새로 생긴 일정만 Gemini로 한국어 번역 (번역 결과는 캐시에 저장해 재사용)
// 4) site/data/events.json 으로 저장 → 사이트 홈 화면이 이 파일을 읽는다
//
// 실행: node scripts/update-events.mjs   (Node 20 이상, 외부 패키지 없음)
// 환경변수: GEMINI_API_KEY (없으면 영어 원문 그대로 저장), GEMINI_MODEL (기본 gemini-2.5-flash)

import { readFile, writeFile, mkdir } from "node:fs/promises";

const SRC = "https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/events.min.json";
const OUT = "site/data/events.json";
const CACHE = "site/data/translations.json";
const WINDOW_DAYS = 30;
const KST_OFFSET = 9 * 60; // 분

// LeekDuck eventType → 사이트 분류
const CAT_MAP = {
  "community-day": "cday", "raid-battles": "raid", "raid-hour": "hour", "raid-day": "raid",
  "raid-weekend": "raid", "elite-raids": "raid", "mega-raids": "mega", "super-mega-raid-day": "mega",
  "pokemon-spotlight-hour": "spot", "max-battles": "max", "max-mondays": "max", "dynamax-event": "max",
  "go-pass": "pass", "ticketed-event": "event", "event": "event", "live-event": "event",
  "go-battle-league": "event", "research": "event", "research-day": "event", "season": "event"
};
const SKIP_TYPES = new Set(["season", "go-battle-league", "research-breakthrough", "pokestop-showcase"]);

// "2026-11-21T14:00:00.000" (현지시간) 또는 "...Z"(UTC) → 한국 시간 "YYYY-MM-DDTHH:MM"
function toKst(s) {
  if (!s) return null;
  if (/Z$|[+-]\d\d:?\d\d$/.test(s)) {
    const d = new Date(new Date(s).getTime() + KST_OFFSET * 60000);
    return d.toISOString().slice(0, 16);
  }
  return s.slice(0, 16); // 현지시간 이벤트는 한국에서도 같은 시각
}
const asDate = s => new Date(s + ":00+09:00");

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function translate(items) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !items.length) return {};
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const prompt = `다음은 포켓몬고 이벤트 목록(JSON)이다. 각 항목을 한국어로 옮겨라.
규칙:
- 포켓몬 이름은 반드시 한국 공식 명칭 (예: Pawniard→자망칼, Mega Banette→메가다크펫, Deoxys→테오키스)
- title: 짧은 한국어 제목. 형식 예) "커뮤니티 데이: 자망칼", "5성 레이드: 크레세리아 · 다크라이"
- desc: 핵심 보너스나 등장 포켓몬을 한 줄로 (없으면 빈 문자열)
- pokemon: 일정에 등장하는 주요 포켓몬의 한국어 이름 배열 (메가/그림자 접두어 없이 기본 이름)
- 출력은 JSON 배열만: [{"id":..., "title":..., "desc":..., "pokemon":[...]}]
입력:
${JSON.stringify(items)}`;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
    })
  });
  if (!res.ok) { console.warn("번역 실패:", res.status, await res.text()); return {}; }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  const arr = JSON.parse(text);
  return Object.fromEntries(arr.map(x => [x.id, x]));
}

async function main() {
  const res = await fetch(SRC);
  if (!res.ok) throw new Error("ScrapedDuck 응답 오류 " + res.status);
  const raw = await res.json();

  const now = new Date();
  const limit = new Date(now.getTime() + WINDOW_DAYS * 864e5);
  const picked = raw
    .filter(e => !SKIP_TYPES.has(e.eventType))
    .map(e => ({ ...e, s: toKst(e.start), en: toKst(e.end) || toKst(e.start) }))
    .filter(e => e.s && asDate(e.en) > now && asDate(e.s) <= limit);

  const cache = await readJson(CACHE, {});
  const todo = picked.filter(e => !cache[e.eventID]).map(e => ({
    id: e.eventID, name: e.name, type: e.eventType, heading: e.heading,
    bosses: (e.extraData?.raidbattles?.bosses || []).map(b => b.name),
    spotlight: e.extraData?.spotlight?.name || undefined
  }));
  Object.assign(cache, await translate(todo));

  const events = picked
    .sort((a, b) => asDate(a.s) - asDate(b.s))
    .map(e => {
      const tr = cache[e.eventID];
      return [CAT_MAP[e.eventType] || "event", tr?.title || e.name, e.s, e.en, tr?.desc || "", tr?.pokemon || []];
    });

  await mkdir("site/data", { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache, null, 1));
  await writeFile(OUT, JSON.stringify({
    updated: now.toISOString().slice(0, 10),
    source: "LeekDuck (ScrapedDuck)" + (process.env.GEMINI_API_KEY ? " · Gemini 번역" : ""),
    events
  }, null, 1));
  console.log(`일정 ${events.length}개 저장 (번역 대상 ${todo.length}개${process.env.GEMINI_API_KEY ? "" : ", API 키 없음 → 원문 유지"})`);
}

main().catch(err => { console.error(err); process.exit(1); });
