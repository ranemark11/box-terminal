// 포켓몬고 이벤트 일정 자동 갱신 스크립트
// 1) ScrapedDuck(LeekDuck 수집 데이터)에서 이벤트 목록을 받는다
// 2) 오늘 기준 진행 중 + 30일 이내 시작 일정만 남긴다
// 3) 한국어 제목: 정해진 형식(레이드·스포트라이트 등)은 도감의 한국어 이름으로 직접 변환,
//    나머지 일정만 Gemini로 번역 (번역 결과는 캐시에 저장해 재사용)
// 4) site/data/events.json 저장, 문제는 site/data/events-report.json 에 기록
//
// 실행: node scripts/update-events.mjs   (Node 20 이상, 외부 패키지 없음)
// 환경변수: GEMINI_API_KEY (선택), GEMINI_MODEL (선택)

import { readFile, writeFile, mkdir } from "node:fs/promises";

const SRC = "https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/events.min.json";
const OUT = "site/data/events.json";
const CACHE = "site/data/translations.json";
const REPORT = "site/data/events-report.json";
const DEX = "site/data/pokedex.json";
const WINDOW_DAYS = 30;
const KST_OFFSET = 9 * 60;
const report = { warnings: [], gemini: [] };

const CAT_MAP = {
  "community-day": "cday", "raid-battles": "raid", "raid-hour": "hour", "raid-day": "raid",
  "raid-weekend": "raid", "elite-raids": "raid", "mega-raids": "mega", "super-mega-raid-day": "mega",
  "pokemon-spotlight-hour": "spot", "max-battles": "max", "max-mondays": "max", "dynamax-event": "max",
  "go-pass": "pass", "ticketed-event": "event", "event": "event", "live-event": "event",
  "research": "event", "research-day": "event"
};
const SKIP_TYPES = new Set(["season", "go-battle-league", "research-breakthrough", "pokestop-showcase"]);
const MONTH_KO = { January: "1월", February: "2월", March: "3월", April: "4월", May: "5월", June: "6월", July: "7월",
  August: "8월", September: "9월", October: "10월", November: "11월", December: "12월" };
const FORME_KO = { Normal: "노말", Defense: "디펜스", Attack: "어택", Speed: "스피드", Incarnate: "화신", Therian: "영물",
  Origin: "오리진", Altered: "어나더", Forme: "폼", Formes: "폼", Form: "폼", and: "", Style: "", Strike: "", Single: "일격", Rapid: "연격" };

function toKst(s) {
  if (!s) return null;
  if (/Z$|[+-]\d\d:?\d\d$/.test(s)) return new Date(new Date(s).getTime() + KST_OFFSET * 60000).toISOString().slice(0, 16);
  return s.slice(0, 16);
}
const asDate = s => new Date(s + ":00+09:00");
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } }

// ---------- 영어 이름 → 한국어 (도감 데이터 이용) ----------
let EN2KO = {};
function koName(raw) {
  let s = raw.trim(), pre = "";
  for (const [en, ko] of [["Shadow ", "그림자 "], ["Dynamax ", "다이맥스 "], ["Gigantamax ", "거다이맥스 "], ["Eternamax ", "무한다이맥스 "]])
    if (s.startsWith(en)) { pre += ko; s = s.slice(en.length); }
  let mega = "";
  const m = s.match(/^(Mega|Primal) (.+?)(?: ([XY]))?$/); if (m) { mega = m[1] === "Mega" ? "메가" : "원시"; s = m[2] + (m[3] ? "\u0000" + m[3] : ""); }
  let suffix = "";
  const paren = s.match(/^(.+?) \((.+)\)$/);
  if (paren) { s = paren[1]; suffix = " (" + paren[2].split(/[ ,]+/).map(w => FORME_KO[w] ?? w).filter(Boolean).join("·").replace(/·폼$/, "폼") + ")"; }
  const [base, xy] = s.split("\u0000");
  const ko = EN2KO[base.toLowerCase()];
  if (!ko) return null;
  return pre + mega + ko + (xy || "") + suffix;
}
// "A, B, and C" / "A and B" → ["A","B","C"]
const splitNames = s => s.replace(/,? and /g, ", ").split(/, (?![^(]*\))/).map(x => x.trim()).filter(Boolean);
function namesKo(s) {
  const parts = splitNames(s).map(koName);
  return parts.every(Boolean) ? parts : null;
}
const baseOf = ko => ko.replace(/^(그림자|다이맥스|거다이맥스|무한다이맥스) /, "").replace(/^(메가|원시)/, "").replace(/[XY]$/, "").replace(/ \(.+\)$/, "");

// 형식이 정해진 일정 제목은 직접 변환
const RULES = [
  [/^(.+) in 5-star Raid Battles$/, "raid", n => `5성 레이드: ${n}`],
  [/^(.+) in Mega Raids$/, "mega", n => `메가 레이드: ${n}`],
  [/^(.+) in Shadow Raids$/, "shadow", n => `그림자 레이드: ${n}`],
  [/^(.+) in Max Battles$/, "max", n => `맥스배틀: ${n}`],
  [/^(.+) Raid Hour$/, "hour", n => `레이드 아워: ${n}`],
  [/^(.+) Spotlight Hour$/, "spot", n => `스포트라이트 아워: ${n}`],
  [/^(.+) Community Day(?: Classic)?$/, "cday", n => `커뮤니티 데이: ${n}`],
  [/^(.+) Super Mega Raid Day$/, "mega", n => `슈퍼 메가 레이드 데이: 메가${n}`],
  [/^(.+) Raid Day$/, "raid", n => `레이드 데이: ${n}`],
  [/^(.+) during Max Monday$/, "max", n => `맥스 먼데이: ${n}`],
  [/^(.+) Returns$/, null, n => `${n} 재등장`],
  [/^(.+) Max Battle Day$/, "max", n => `맥스배틀 데이: ${n}`]
];
const FIXED = { "Max Battle Day": ["max", "맥스배틀 데이"], "Raid Day": ["raid", "레이드 데이"], "Dynamax Trails": ["max", "다이맥스 트레일"],
  "Twilight Wishes": ["event", "Twilight Wishes"] };
function ruleTitle(e) {
  const name = e.name.trim();
  if (FIXED[name]) return { cat: FIXED[name][0], title: FIXED[name][1], pokemon: [] };
  const pass = name.match(/^GO Pass: (\w+)$/); if (pass && MONTH_KO[pass[1]]) return { cat: "pass", title: `GO 패스: ${MONTH_KO[pass[1]]}`, pokemon: [] };
  const mcd = name.match(/^(\w+) Community Day$/); if (mcd && MONTH_KO[mcd[1]]) return { cat: "cday", title: `커뮤니티 데이 (${MONTH_KO[mcd[1]]})`, pokemon: [] };
  for (const [re, cat, fmt] of RULES) {
    const m = name.match(re); if (!m) continue;
    const ko = namesKo(m[1]); if (!ko) return null;
    return { cat: cat || fixCat(CAT_MAP[e.eventType] || "event", name), title: fmt(ko.join(" · ")), pokemon: [...new Set(ko.map(baseOf))] };
  }
  return null;
}
// 분류 보정: LeekDuck은 메가·그림자 레이드도 raid-battles로 분류함
function fixCat(cat, name) {
  if (cat === "raid" && /\bMega\b|Primal/.test(name)) return "mega";
  if (cat === "raid" && /\bShadow\b/.test(name)) return "shadow";
  if (/Max Monday|Max Battle|Dynamax|Gigantamax/.test(name) && cat === "event") return "max";
  return cat;
}

// ---------- Gemini (규칙으로 못 바꾼 일정만) ----------
// 일정 제목에 들어 있는 포켓몬의 공식 한국어 이름을 함께 넘겨 오역 방지
function glossary(items) {
  const text = items.map(i => [i.name, ...(i.bosses || [])].join(" ")).join(" ").toLowerCase();
  const g = {};
  for (const [en, ko] of Object.entries(EN2KO)) if (en.length > 2 && new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) g[en] = ko;
  return g;
}
async function translate(items) {
  const key = process.env.GEMINI_API_KEY;
  if (!items.length) return {};
  if (!key) { report.gemini.push("API 키 없음 — 원문 유지"); return {}; }
  // 구형 모델은 신규 키에서 막힘(404) → 최신 별칭·모델 순서로 시도, 혼잡(503/429)은 잠시 후 1회 재시도
  const models = [...new Set([process.env.GEMINI_MODEL, "gemini-3.8-flash", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"].filter(Boolean))];
  const prompt = `다음은 포켓몬고 이벤트 목록(JSON)이다. 각 항목을 한국어로 옮겨라.
규칙:
- 포켓몬 이름은 반드시 한국 공식 명칭
- title: 짧은 한국어 제목 (고유한 이벤트 이름은 자연스럽게 번역하거나 원문 유지)
- desc: 핵심 내용 한 줄 (없으면 빈 문자열)
- pokemon: 일정의 주요 포켓몬 한국어 기본 이름 배열 (메가/그림자 접두어 없이)
- 아래 "이름표"에 있는 포켓몬은 반드시 이름표의 한국어 이름을 그대로 사용
- 출력은 JSON 배열만: [{"id":..., "title":..., "desc":..., "pokemon":[...]}]
이름표: ${JSON.stringify(glossary(items))}
입력:
${JSON.stringify(items)}`;
  const attempts = models.flatMap(m => [m, m]);
  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i], retry = i % 2 === 1;
    if (retry && !/: (503|429|500)/.test(report.gemini.at(-1) || "")) continue;
    if (retry) await new Promise(r => setTimeout(r, 8000));
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } })
      });
      const body = await res.text();
      if (!res.ok) { report.gemini.push(`${model}: ${res.status} ${body.slice(0, 200)}`); continue; }
      const text = JSON.parse(body)?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "[]";
      const arr = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      report.gemini.push(`${model}: 성공 ${arr.length}개`);
      return Object.fromEntries(arr.map(x => [x.id, x]));
    } catch (err) { report.gemini.push(`${model}: ${String(err).slice(0, 200)}`); }
  }
  return {};
}

async function main() {
  const dex = await readJson(DEX, { cards: [] });
  for (const c of dex.cards) if (!/[()]/.test(c.en)) EN2KO[c.en.toLowerCase()] ||= c.ko;
  // 폼만 있는 포켓몬(예: Tornadus (Incarnate))은 기본 이름으로도 찾을 수 있게
  for (const c of dex.cards) { const b = c.en.replace(/ \(.+\)$/, "").toLowerCase(); if (b && !EN2KO[b]) EN2KO[b] = c.ko.replace(/\(.+\)$/, ""); }
  report.dexNames = Object.keys(EN2KO).length;

  const res = await fetch(SRC);
  if (!res.ok) throw new Error("ScrapedDuck 응답 오류 " + res.status);
  const raw = await res.json();

  const now = new Date(), limit = new Date(now.getTime() + WINDOW_DAYS * 864e5);
  const picked = raw.filter(e => !SKIP_TYPES.has(e.eventType))
    .map(e => ({ ...e, s: toKst(e.start), en: toKst(e.end) || toKst(e.start) }))
    .filter(e => e.s && asDate(e.en) > now && asDate(e.s) <= limit);

  const cache = await readJson(CACHE, {});
  const ruled = Object.fromEntries(picked.map(e => [e.eventID, ruleTitle(e)]));
  const todo = picked.filter(e => !ruled[e.eventID] && !cache[e.eventID]).map(e => ({
    id: e.eventID, name: e.name, type: e.eventType, heading: e.heading,
    bosses: (e.extraData?.raidbattles?.bosses || []).map(b => b.name)
  }));
  Object.assign(cache, await translate(todo));

  const events = picked.sort((a, b) => asDate(a.s) - asDate(b.s)).map(e => {
    const r = ruled[e.eventID], tr = cache[e.eventID];
    const cat = r?.cat || fixCat(CAT_MAP[e.eventType] || "event", e.name);
    if (!r && !tr) report.warnings.push(`번역 안 됨: ${e.name}`);
    return [cat, r?.title || tr?.title || e.name, e.s, e.en, tr?.desc || "", r?.pokemon || tr?.pokemon || []];
  });

  await mkdir("site/data", { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache, null, 1));
  await writeFile(OUT, JSON.stringify({ updated: now.toISOString().slice(0, 10), source: "LeekDuck (ScrapedDuck)", events }, null, 1));
  report.counts = { events: events.length, byRule: Object.values(ruled).filter(Boolean).length, gemini: todo.length };
  await updateRocket(now);
  await writeFile(REPORT, JSON.stringify(report, null, 1));
  console.log(`일정 ${events.length}개 저장 (규칙 변환 ${report.counts.byRule}개, AI 번역 대상 ${todo.length}개)`);
}

// GO 로켓단 출전 포켓몬 (ScrapedDuck rocketLineups) → site/data/rocket.json. 실패해도 일정 저장은 그대로.
const ROCKET_SRC = "https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/rocketLineups.min.json";
const ROCKET_OUT = "site/data/rocket.json";
export function rocketSlim(raw) {
  return raw.map(g => {
    const nm = g.name || "", lead = ["Cliff", "Arlo", "Sierra", "Giovanni"].find(x => x === nm);
    const k = lead ? lead.toLowerCase() : g.type ? g.type : /Decoy/.test(nm) ? "decoy" : /Female/.test(nm) ? "female" : "male";
    return { k, g: /Female/.test(nm) ? "f" : /Male/.test(nm) ? "m" : "", s: [g.firstPokemon, g.secondPokemon, g.thirdPokemon].map(sl => (sl || []).map(p => [p.name, p.isEncounter ? 1 : 0])) };
  }).filter(g => g.s.some(sl => sl.length));
}
async function updateRocket(now) {
  try {
    const res = await fetch(ROCKET_SRC);
    if (!res.ok) throw new Error("응답 오류 " + res.status);
    const list = rocketSlim(await res.json());
    if (list.length < 10) throw new Error("목록이 너무 적음: " + list.length);
    await writeFile(ROCKET_OUT, JSON.stringify({ updated: now.toISOString().slice(0, 10), source: "LeekDuck (ScrapedDuck)", list }));
    report.rocket = { groups: list.length };
  } catch (e) { report.warnings.push("로켓단 갱신 실패: " + (e.message || e)); }
}

main().catch(async err => {
  console.error(err);
  report.fatal = String(err.stack || err);
  await mkdir("site/data", { recursive: true });
  await writeFile(REPORT, JSON.stringify(report, null, 1));
  process.exit(0);
});
