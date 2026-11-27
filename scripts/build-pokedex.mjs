// 전체 도감 + 티어 데이터 빌드
// 입력
//  - PvPoke gamemaster: 포켓몬 목록, 종족값, 타입, 기술 목록, 진화 가족, 출시 여부, PvP 기술 수치
//  - PvPoke rankings: 리그별 PvP 시뮬레이션 점수
//  - PokeMiners game master: 레이드(PvE) 기술 수치, 다이맥스/거다이맥스 가능 여부
//  - PokeAPI CSV: 한국어 포켓몬·기술 이름
// 출력
//  - site/data/pokedex.json : 사이트가 읽는 도감 + 티어
//  - site/data/pokedex-report.json : 빌드 결과 요약·경고 (문제 확인용)
//
// 실행: node scripts/build-pokedex.mjs   (Node 20+, 외부 패키지 없음)

import { writeFile, mkdir, readFile } from "node:fs/promises";

const URLS = {
  pvpokeGM: "https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/gamemaster.json",
  rank: lg => `https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/rankings/all/overall/rankings-${lg}.json`,
  pokeminers: "https://raw.githubusercontent.com/PokeMiners/game_masters/master/latest/latest.json",
  speciesNames: "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species_names.csv",
  moves: "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/moves.csv",
  moveNames: "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/move_names.csv"
};
const KO = 3; // PokeAPI 한국어 language id

// ---------- 계산 상수 (사이트 설명과 동일) ----------
const CPM40 = 0.7903, BOSS_DEF = 180, SE = 1.6, SURV_K = 900;
// 타입 상성 (공격 → 받는 쪽). 레이드 타입별 점수에 "그 타입에 약한 상대에게 받는 피해"를 넣을 때 씀 (v3.6)
const CH_SE = {normal:[],fire:["grass","ice","bug","steel"],water:["fire","ground","rock"],grass:["water","ground","rock"],electric:["water","flying"],ice:["grass","ground","flying","dragon"],fighting:["normal","ice","rock","dark","steel"],poison:["grass","fairy"],ground:["fire","electric","poison","rock","steel"],flying:["grass","fighting","bug"],psychic:["fighting","poison"],bug:["grass","psychic","dark"],rock:["fire","ice","flying","bug"],ghost:["psychic","ghost"],dragon:["dragon"],dark:["psychic","ghost"],steel:["ice","rock","fairy"],fairy:["fighting","dragon","dark"]};
const CH_NV = {normal:["rock","steel"],fire:["fire","water","rock","dragon"],water:["water","grass","dragon"],grass:["fire","grass","poison","flying","bug","dragon","steel"],electric:["electric","grass","dragon"],ice:["fire","water","ice","steel"],fighting:["poison","flying","psychic","bug","fairy"],poison:["poison","ground","rock","ghost"],ground:["grass","bug"],flying:["electric","rock","steel"],psychic:["psychic","steel"],bug:["fire","fighting","poison","flying","ghost","steel","fairy"],rock:["fighting","ground","steel"],ghost:["dark"],dragon:["steel"],dark:["fighting","dark","fairy"],steel:["fire","water","electric","steel"],fairy:["fire","poison","steel"]};
const CH_IM = {normal:["ghost"],electric:["ground"],fighting:["ghost"],poison:["steel"],ground:["flying"],psychic:["dark"],ghost:["normal"],dragon:["fairy"]};
const effOf = (a, ts) => ts.reduce((m, t) => m * (CH_SE[a].includes(t) ? 1.6 : (CH_IM[a] || []).includes(t) ? 0.390625 : CH_NV[a].includes(t) ? 0.625 : 1), 1);
// t 타입 딜러가 상대할 포켓몬 = t에 약한 타입들. 그 타입 기술이 나에게 주는 배율의 기하평균 (노말은 약한 타입이 없어서 1)
const incAvg = (t, myTypes) => { const foes = CH_SE[t]; if (!foes.length) return 1; return Math.exp(foes.reduce((s, f) => s + Math.log(effOf(f, myTypes)), 0) / foes.length); };
const MAX_POWER = 350, GMAX_POWER = 450;
// 티어 규칙 (v3.5): 타입을 가리지 않는 절대 등급. 모드마다 "모습(포켓몬 + 메가/그림자/거다이맥스)"별 최고 점수로 줄을 세우고
// refRank위(5위) 점수를 100%로 잡아 % 구간으로 S+ ~ C-. (1위는 메가뮤츠Y처럼 혼자 튀어서 기준으로 쓰지 않음)
// 타입별 표의 각 줄도 같은 기준(그 줄 점수 ÷ 기준 점수)으로 등급을 받고, p = 그 타입 1위 대비 %(순위용).
// 배틀은 PvPoke 점수가 촘촘해서 개수(pvpCaps)로만 나눔.
const TIER_RULE = { names: ["S+", "S", "S-", "A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"], minPct: [95, 88, 82, 76, 70, 64, 58, 52, 46, 40, 34, 28],
  refRank: 5, pvpCaps: [3, 3, 4, 5, 5, 5, 5, 5, 5, 0, 0, 0], ref: {} };
const gradeOf = pct => { const i = TIER_RULE.minPct.findIndex(m => pct >= m); return i < 0 ? null : TIER_RULE.names[i]; };
const formKey = r => r.n + "|" + r.tg.filter(x => x !== "p").join();
// lists: {타입: 정렬된 행들}. 반환 = 모습별 최고 행(점수 내림차순, w = 타입)
// tv = 티어용 값(레이드는 받는 상성을 뺀 원래 ER — 받는 상성은 상대 타입에 따라 달라서 순위에만 넣음, v3.6), metric = 순위용 값
function assignAbs(lists, metric, mode, tv = r => r[metric]) {
  const best = new Map();
  for (const [w, rows] of Object.entries(lists)) for (const r of rows) { const k = formKey(r), b = best.get(k); if (!b || tv(r) > tv(b.r)) best.set(k, { r, w }); }
  const all = [...best.values()].sort((a, b) => tv(b.r) - tv(a.r));
  const ref = all.length ? tv(all[Math.min(TIER_RULE.refRank, all.length) - 1].r) : 1;
  TIER_RULE.ref[mode] = ref;
  for (const rows of Object.values(lists)) { const top = rows[0]?.[metric] || 1; for (const r of rows) { r.p = Math.round(r[metric] / top * 100); r.t = gradeOf(tv(r) / ref * 100); } }
  return all.filter(x => x.r.t).map(x => ({ ...x.r, w: x.w }));
}
function assignCount(rows, metric) { // 배틀: 개수 상한만
  let level = 0, n = 0; const R = TIER_RULE, top = rows[0]?.[metric] || 1;
  for (const r of rows) { r.p = Math.round(r[metric] / top * 100); while (level < R.names.length && n >= R.pvpCaps[level]) { level++; n = 0; } r.t = level < R.names.length ? R.names[level] : null; if (r.t) n++; }
}
const TYPES = ["normal","fire","water","grass","electric","ice","fighting","poison","ground","flying","psychic","bug","rock","ghost","dragon","dark","steel","fairy"];
const TYPE_KO = {normal:"노말",fire:"불꽃",water:"물",grass:"풀",electric:"전기",ice:"얼음",fighting:"격투",poison:"독",ground:"땅",flying:"비행",psychic:"에스퍼",bug:"벌레",rock:"바위",ghost:"고스트",dragon:"드래곤",dark:"악",steel:"강철",fairy:"페어리"};
const LEAGUES = [["great", 1500, "슈퍼리그"], ["ultra", 2500, "하이퍼리그"], ["master", 10000, "마스터리그"]];
const LIMIT_RAID = 120, LIMIT_PVP = 40;

const report = { warnings: [], counts: {}, probe: {} };
const warn = m => { report.warnings.push(m); console.warn("⚠", m); };

async function get(url, kind = "json") {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return kind === "json" ? r.json() : r.text();
}
function csv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return lines.map(line => {
    const out = []; let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, out[i]]));
  });
}

// ---------- 한국어 폼 이름 ----------
const FORM_KO = {
  "Alolan":"알로라","Galarian":"가라르","Hisuian":"히스이","Paldean":"팔데아","Origin":"오리진폼","Altered":"어나더폼",
  "Therian":"영물폼","Incarnate":"화신폼","Attack":"어택폼","Defense":"디펜스폼","Speed":"스피드폼","Normal":"노말폼",
  "Crowned Sword":"검왕","Crowned Shield":"방패왕","Hero":"역전의 용사","Black":"블랙","White":"화이트",
  "Dusk Mane":"황혼의 갈기","Dawn Wings":"새벽의 날개","Ultra":"울트라","Unbound":"굴레를 벗어난 모습","Confined":"굴레에 빠진 모습",
  "Sunny":"태양의 모습","Rainy":"빗방울의 모습","Snowy":"설운의 모습","Aria":"보이스폼","Pirouette":"스텝폼",
  "Land":"랜드폼","Sky":"스카이폼","Plant":"초목도롱","Sandy":"모래땅도롱","Trash":"슈레도롱","Ordinary":"평상시","Resolute":"각오의 모습",
  "Male":"수컷","Female":"암컷","Zen":"달마모드","Galarian Zen":"가라르 달마모드","Galarian Standard":"가라르",
  "Average":"보통 사이즈","Small":"작은 사이즈","Large":"큰 사이즈","Super":"특대 사이즈",
  "Midday":"한낮의 모습","Midnight":"한밤중의 모습","Dusk":"황혼의 모습","Single Strike":"일격의 태세","Rapid Strike":"연격의 태세",
  "Ice Rider":"백마 탄 모습","Shadow Rider":"흑마 탄 모습","Complete":"퍼펙트폼","10% Forme":"10%폼","50% Forme":"50%폼","10%":"10%폼","50%":"50%폼",
  "Hangry":"배고픈 모양","Full Belly":"배부른 모양","Armored":"아머드","Combat":"컴뱃종","Blaze":"블레이즈종","Aqua":"워터종",
  "Zero":"나이브폼","Wellspring":"우물의 가면","Hearthflame":"화덕의 가면","Cornerstone":"주춧돌의 가면","Teal":"벽록의 가면",
  "Terastal":"테라스탈폼","Stellar":"스텔라폼","Burn":"번드라이브","Chill":"프리즈드라이브","Douse":"아쿠아드라이브","Shock":"번개드라이브",
  "Fan":"스핀폼","Frost":"프로스트폼","Heat":"히트폼","Mow":"커트폼","Wash":"워시폼","Overcast":"네거폼","Sunshine":"포지폼",
  "East Sea":"동쪽바다","West Sea":"서쪽바다","Baile":"이글이글스타일","Pom-Pom":"파칙파칙스타일","Pa'u":"훌라훌라스타일","Sensu":"하늘하늘스타일",
  "Dawn":"새벽","Eternamax":"무한다이맥스","Standard":"노말모드","Complete Forme":"퍼펙트폼","Core":"코어","Shield":"실드폼",
  "Curly":"젖힌 모습","Droopy":"늘어진 모습","Stretchy":"뻗은 모습","Flying":"날으는","Libre":"마스크드","Pop Star":"팝스타","Rock Star":"록스타",
  "Horizons":"호라이즌","Jr":"주니어","Kariyushi":"카리유시","5th Anniversary":"5주년","Shaymin Scarf":"쉐이미 스카프","Family of Three":"세 식구","Family of Four":"네 식구"
};

async function main() {
  console.log("데이터 받는 중…");
  const [gm, pm, speciesCsv, movesCsv, moveNamesCsv, ...ranks] = await Promise.all([
    get(URLS.pvpokeGM),
    get(URLS.pokeminers).catch(e => { warn("PokeMiners game master 실패: " + e.message); return []; }),
    get(URLS.speciesNames, "text"), get(URLS.moves, "text"), get(URLS.moveNames, "text"),
    ...LEAGUES.map(([, cp]) => get(URLS.rank(cp)).catch(e => { warn("PvPoke 랭킹 실패 " + cp + ": " + e.message); return []; }))
  ]);

  // ---- 한국어 이름 ----
  const koSpecies = {};
  for (const r of csv(speciesCsv)) if (+r.local_language_id === KO) koSpecies[+r.pokemon_species_id] = r.name;
  const moveIdent = {}; for (const r of csv(movesCsv)) moveIdent[r.identifier] = +r.id;
  const koMove = {}; for (const r of csv(moveNamesCsv)) if (+r.local_language_id === KO) koMove[+r.move_id] = r.name;

  // ---- PvE 기술 (PokeMiners) ----
  const pve = {};      // moveId(PvPoke 형식) -> {type, power, energy, dur}
  const pmPokemon = {}; // 폼 키 -> pokemonSettings
  const breadKeys = new Set();
  // 플러스 기술은 메가레벨마다 위력 +10% (Lv1 ×1.0 … Lv4 ×1.3). 티어리스트는 풀강(메가레벨 4) 기준
  const PLUS_MAX = 1.3;
  const plusPve = {}; // 메가 speciesId -> 플러스 기술 레이드 수치 (위력은 풀강 기준)
  for (const t of pm) {
    const d = t.data || {};
    const vm = t.templateId.match(/^VM_MOVE_TEMP_EVOLUTION_MEGA(?:_([XY]))?_V\d+_POKEMON_(\w+)$/);
    if (vm && d.moveSettings) {
      const ms = d.moveSettings;
      plusPve[vm[2].toLowerCase() + "_mega" + (vm[1] ? "_" + vm[1].toLowerCase() : "")] = {
        type: (ms.pokemonType || "").replace("POKEMON_TYPE_", "").toLowerCase(),
        power: (ms.power || 0) * PLUS_MAX, basePower: ms.power || 0, energy: Math.abs(ms.energyDelta || 0), dur: (ms.durationMs || 1000) / 1000 };
      continue;
    }
    if (d.moveSettings) {
      const ms = d.moveSettings;
      let id = typeof ms.movementId === "string" ? ms.movementId : t.templateId.replace(/^V\d+_MOVE_/, "");
      id = id.replace(/_FAST$/, "");
      pve[id] = {
        type: (ms.pokemonType || "").replace("POKEMON_TYPE_", "").toLowerCase(),
        power: ms.power || 0, energy: Math.abs(ms.energyDelta || 0), dur: (ms.durationMs || 1000) / 1000
      };
    }
    if (d.pokemonSettings) {
      const ps = d.pokemonSettings;
      const key = String(ps.form || ps.pokemonId || "").replace(/_NORMAL$/, "").toLowerCase();
      pmPokemon[key] = ps;
      for (const k of Object.keys(ps)) if (/bread|dmax|dynamax|gmax|giganta/i.test(k)) breadKeys.add(k);
    }
  }
  // 다이맥스 관련 템플릿 탐색 (필드 이름 확인용)
  const dm = pm.filter(t => /BREAD|SOURDOUGH|DYNAMAX|GIGANTAMAX|DMAX|GMAX|MAX_BATTLE/i.test(t.templateId));
  // GO 내부 이름과 PvPoke 이름이 다른 기술 보정
  if (pve.FUTURESIGHT && !pve.FUTURE_SIGHT) pve.FUTURE_SIGHT = pve.FUTURESIGHT;
  if (pve.HIDDEN_POWER) for (const t of TYPES) pve["HIDDEN_POWER_" + t.toUpperCase()] ||= { ...pve.HIDDEN_POWER, type: t };
  for (const [k, v] of Object.entries(pve)) { const m = k.match(/^TECHNO_BLAST_(\w+)$/); if (m) pve["TECHNO_BLAST_" + m[1]] = v; }
  if (pve.PYROBALL) pve.PYRO_BALL ||= pve.PYROBALL;
  if (pve.TECHNO_BLAST_WATER) pve.TECHNO_BLAST_DOUSE ||= pve.TECHNO_BLAST_WATER;
  report.probe.techno = Object.keys(pve).filter(k => /TECHNO|PYRO|HIDDEN/.test(k));
  report.probe.dmaxTemplates = dm.slice(0, 60).map(t => t.templateId);
  report.probe.dmaxTemplateCount = dm.length;
  report.probe.dmaxSamples = dm.slice(0, 6).map(t => JSON.stringify(t.data).slice(0, 700));
  const dataKeys = new Set(); pm.forEach(t => Object.keys(t.data || {}).forEach(k => dataKeys.add(k)));
  report.probe.dataKeys = [...dataKeys].filter(k => /bread|sourdough|max|dough/i.test(k));
  report.probe.pvpokeTags = [...new Set((gm.pokemon || []).flatMap(p => p.tags || []))];
  report.probe.pveMoves = Object.keys(pve).length;
  // 플러스 기술(메가 전용 "+") 탐색: 게임 데이터·PvPoke 양쪽에서 이름·필드 확인
  {
    report.probe.pvePlus = Object.fromEntries(Object.entries(pve).filter(([k]) => /_PLUS/.test(k)));
    const linkPM = [];
    for (const t of pm) { const js = JSON.stringify(t.data || {}); if (/_PLUS"/.test(js) && !/MOVE_.*_PLUS/.test(t.templateId) && !/PLUS_POINTS|AVATAR|PLUSLE/.test(t.templateId)) linkPM.push({ id: t.templateId, hit: (js.match(/.{0,200}_PLUS".{0,200}/) || [""])[0] }); }
    report.probe.pmPlusLinks = linkPM.slice(0, 40);
    const linkPV = [];
    for (const p of gm.pokemon || []) { const js = JSON.stringify(p); if (/_PLUS/.test(js)) linkPV.push({ id: p.speciesId, hit: (js.match(/.{0,120}_PLUS.{0,120}/) || [""])[0] }); }
    report.probe.pvpokePlusLinks = linkPV.slice(0, 40);
    report.probe.pvpokeTopKeys = Object.keys(gm);
    // 플러스 대상 기술 이름이 들어간 모든 템플릿 (레이드 수치가 다른 이름으로 있는지)
    const names = /OUTRAGE|VOLT_TACKLE|ZAP_CANNON|DRILL_PECK|SEED_BOMB|MYSTICAL_FIRE|BRICK_BREAK|LIQUIDATION|ACID_SPRAY|PSYBEAM/;
    report.probe.plusNameTemplates = pm.filter(t => names.test(t.templateId)).map(t => ({ id: t.templateId, keys: Object.keys(t.data || {}).join(","), data: JSON.stringify(t.data).slice(0, 350) }));
    // 메가 관련 설정 템플릿 (메가레벨·추가 기술 설정 위치 찾기)
    const megaT = pm.filter(t => /MEGA|TEMP_EVO|TEMPORARY_EVO/i.test(t.templateId) && !/AVATAR|STICKER|BADGE|N_DISPLAY|BUNDLE|SKU|PASS|LOOT|ITEM_MEGA/i.test(t.templateId));
    report.probe.megaTemplates = megaT.slice(0, 60).map(t => ({ id: t.templateId, keys: Object.keys(t.data || {}).join(","), data: JSON.stringify(t.data).slice(0, 500) }));
    // 템플릿 전체에서 "PLUS" 기술 이름이 값으로 등장하는 곳
    const vals = [];
    for (const t of pm) { const js = JSON.stringify(t.data || {}); const m = js.match(/"(OUTRAGE|VOLT_TACKLE|ZAP_CANNON|DRILL_PECK)_PLUS[^"]*"/); if (m && !/^COMBAT_/.test(t.templateId)) vals.push({ id: t.templateId, hit: js.slice(Math.max(0, js.indexOf(m[0]) - 300), js.indexOf(m[0]) + 200) }); }
    report.probe.plusValueTemplates = vals.slice(0, 20);
    report.probe.vmMoves = pm.filter(t => /^VM_MOVE_TEMP_EVOLUTION/.test(t.templateId)).map(t => ({ id: t.templateId, data: JSON.stringify(t.data).slice(0, 700) }));
    report.probe.megaLevelGeneric = pm.filter(t => /^MEGA_EVOLUTION_LEVEL_\d+$/.test(t.templateId)).map(t => ({ id: t.templateId, data: JSON.stringify(t.data) }));
    report.probe.megaLevelDragonite = pm.filter(t => /^MEGA_EVOLUTION_LEVEL_\d+_V0149_POKEMON_DRAGONITE$/.test(t.templateId)).map(t => ({ id: t.templateId, data: JSON.stringify(t.data) }));
    report.probe.pvpokePlusMoves = (gm.moves || []).filter(m => /_PLUS/.test(m.moveId)).map(m => ({ id: m.moveId, name: m.name, type: m.type, power: m.power, energy: m.energy, ext: Object.keys(m).join(",") }));
  }

  report.probe.dynamaxKeys = [...breadKeys];
  report.probe.samplePokemonKeys = Object.keys(pmPokemon["charizard"] || {});
  report.probe.charizardBread = Object.fromEntries([...breadKeys].map(k => [k, (pmPokemon["charizard"] || {})[k]]));

  // ---- PvP 기술 (PvPoke) ----
  const pvpMove = Object.fromEntries((gm.moves || []).map(m => [m.moveId, m]));
  const moveKo = id => {
    if (/_PLUS$/.test(id)) return moveKo(id.replace(/_PLUS$/, "")) + "+";
    const m = pvpMove[id];
    const base = id.replace(/^(HIDDEN_POWER|WEATHER_BALL|TECHNO_BLAST|AURA_WHEEL|REVELATION_DANCE|MULTI_ATTACK)_.*/, "$1");
    const ident = base.toLowerCase().replace(/_/g, "-").replace("futuresight", "future-sight").replace("vice-grip", "vise-grip").replace("vise-grip", "vice-grip").replace("super-power", "superpower");
    const ko = koMove[moveIdent[ident]];
    if (!ko) return m?.name || id;
    return base !== id && m?.type ? `${ko}(${TYPE_KO[m.type] || m.type})` : ko;
  };
  const moveType = id => pvpMove[id]?.type || pve[id]?.type;

  // ---- 포켓몬 ----
  // scripts/manual-plus.json: 게임 데이터에 아직 없는 플러스 기술 임시 수치 + "release": true면 PvPoke가 아직 미출시로 둔 메가도 미리 넣음(출시 당일 대비)
  const manualPlus = JSON.parse(await readFile(new URL("./manual-plus.json", import.meta.url), "utf8").catch(() => "{}"));
  const mons = (gm.pokemon || []).filter(p => (p.released !== false || manualPlus[p.speciesId]?.release) && !(p.tags || []).includes("duplicate"));
  const byId = Object.fromEntries(mons.map(p => [p.speciesId, p]));
  const isShadow = p => p.speciesId.endsWith("_shadow");
  const isMega = p => /_(mega|mega_x|mega_y|primal)$/.test(p.speciesId);
  const baseIdOf = p => p.speciesId.replace(/_shadow$/, "").replace(/_(mega|mega_x|mega_y|primal)$/, "");
  const types = p => (p.types || []).filter(t => t && t !== "none");

  function koName(p) {
    const base = koSpecies[p.dex] || p.speciesName;
    const m = p.speciesName.match(/\(([^)]+)\)/);
    let form = m ? m[1].replace(/\s*Shadow\s*/i, "").trim() : "";
    if (/^Mega/i.test(form)) return "메가" + base + form.replace(/^Mega\s*/i, "");
    if (/^Primal/i.test(form)) return "원시" + base;
    if (!form) return base;
    if (/^(Alolan|Galarian|Hisuian|Paldean)$/.test(form)) return FORM_KO[form] + " " + base;
    return `${base}(${FORM_KO[form] || form})`;
  }

  // 카드(검색 단위) = 그림자·메가가 아닌 기본 엔트리
  const cards = {};
  for (const p of mons) if (!isShadow(p) && !isMega(p)) {
    cards[p.speciesId] = { id: p.speciesId, dex: p.dex, ko: koName(p), en: p.speciesName, types: types(p),
      stats: [p.baseStats.atk, p.baseStats.def, p.baseStats.hp], fam: p.family?.id || null,
      legendary: (p.tags || []).some(t => /legendary|mythical/.test(t)) || undefined,
      shadow: !!byId[p.speciesId + "_shadow"] || undefined, megas: [], tiers: {} };
  }
  for (const p of mons) if (isMega(p) && cards[baseIdOf(p)]) cards[baseIdOf(p)].megas.push(p.speciesId);

  // 진화 단계 (가족 id 기준 트리)
  const famMembers = {};
  for (const c of Object.values(cards)) if (c.fam) (famMembers[c.fam] ||= []).push(c.id);
  for (const c of Object.values(cards)) {
    const ids = c.fam ? famMembers[c.fam] : [c.id];
    const parentOf = id => { const par = byId[id]?.family?.parent; return par && ids.includes(par) ? par : null; };
    // 같은 지역폼끼리 묶기: 이 카드와 같은 접미사(알로라 등)를 가진 줄기만
    const suffix = c.id.match(/_(alolan|galarian|hisuian|paldean)/)?.[1];
    const sameLine = id => !suffix || id.includes(suffix) || !parentOf(id) || byId[id]?.family?.evolutions?.some(e => e.includes(suffix));
    const roots = ids.filter(id => !parentOf(id) && !/_(alolan|galarian|hisuian|paldean)/.test(id) || (!parentOf(id) && suffix && id.includes(suffix)));
    const stages = []; let level = roots.length ? roots : [c.id]; const seen = new Set();
    while (level.length && stages.length < 4) {
      let cur = level.filter(id => !seen.has(id) && cards[id]); cur.forEach(id => seen.add(id));
      // 코스튬 변형(예: pikachu_horizons)은 진화 단계에서 숨김. 지역폼·현재 카드는 유지
      cur = cur.filter(id => id === c.id || !cur.some(o => o !== id && id.startsWith(o + "_") && !/_(alolan|galarian|hisuian|paldean)/.test(id.slice(o.length))));
      if (cur.length) stages.push(cur);
      level = ids.filter(id => cur.includes(parentOf(id)));
    }
    c.evo = stages.some(s => s.includes(c.id)) ? stages : [[c.id]];
  }

  // ---- 진화 방법 (PokeMiners pokemonSettings.evolutionBranch) ----
  // 결과: 진화 후 카드에 how = [{from, c(사탕), x:[조건...]}]
  try {
    const ITEM_KO = { ITEM_SUN_STONE: "태양의돌", ITEM_KINGS_ROCK: "왕의징표석", ITEM_METAL_COAT: "금속코트", ITEM_DRAGON_SCALE: "용의비늘",
      ITEM_UP_GRADE: "업그레이드", ITEM_GEN4_EVOLUTION_STONE: "신오의돌", ITEM_GEN5_EVOLUTION_STONE: "하나의돌",
      ITEM_OTHER_EVOLUTION_STONE_A: "코인 999개", ITEM_BEANS: "지가르데 셀",
      ITEM_OTHER_EVOLUTION_STONE_MAPLE_A: "달콤한사과", ITEM_OTHER_EVOLUTION_STONE_MAPLE_B: "새콤한사과", ITEM_OTHER_EVOLUTION_STONE_MAPLE_C: "꿀맛사과", ITEM_TROY_DISK_GLACIAL: "빙하 루어", ITEM_TROY_DISK_MOSSY: "이끼 루어",
      ITEM_TROY_DISK_MAGNETIC: "마그넷 루어", ITEM_TROY_DISK_RAINY: "레이니 루어", ITEM_TROY_DISK_SPARKLY: "반짝반짝 루어" };
    const REGION_KW = c => (c.id.match(/_(alolan|galarian|hisuian|paldean)/) || [])[1] || "";
    const nameDex = {};
    for (const t of pm) { const m = t.templateId.match(/^V(\d{4})_POKEMON_/); const ps = t.data?.pokemonSettings; if (m && ps?.pokemonId) nameDex[ps.pokemonId] = +m[1]; }
    const byDex = {}; for (const c of Object.values(cards)) (byDex[c.dex] ||= []).push(c);
    // 게임 데이터 (포켓몬, 폼) → 카드
    const cardOf = (pid, form) => {
      const list = byDex[nameDex[pid]] || []; if (!list.length) return null;
      const suf = String(form || "").replace(pid, "").replace(/^_/, "").toLowerCase();
      if (suf && suf !== "normal") {
        const kw = suf.slice(0, 5), hit = list.filter(c => c.id.includes(kw));
        if (hit.length) return hit.sort((a, b) => a.id.length - b.id.length)[0];
        if (/alola|galar|hisui|palde/.test(kw)) return null; // 지역폼인데 카드가 없음
      }
      const plain = list.filter(c => !REGION_KW(c)).sort((a, b) => a.id.length - b.id.length);
      return plain[0] || null;
    };
    const unknownItems = new Set(); let edges = 0, miss = 0; const seen = new Set();
    for (const t of pm) {
      const ps = t.data?.pokemonSettings; if (!ps?.evolutionBranch || !/^V\d{4}_POKEMON_/.test(t.templateId)) continue;
      const from = cardOf(ps.pokemonId, ps.form); if (!from) continue;
      for (const br of ps.evolutionBranch) {
        if (!br.evolution || br.temporaryEvolution) continue;
        const to = br.form ? cardOf(br.evolution, br.form)
          : (REGION_KW(from) && cardOf(br.evolution, br.evolution + "_" + String(ps.form).split("_").pop())) || cardOf(br.evolution, "");
        if (!to) { miss++; continue; }
        if (from.id === to.id) continue;
        const key = from.id + ">" + to.id; if (seen.has(key)) continue; seen.add(key);
        const x = [];
        for (const k of ["evolutionItemRequirement", "lureItemRequirement"]) if (br[k]) { if (!ITEM_KO[br[k]]) unknownItems.add(br[k]); x.push(ITEM_KO[br[k]] || br[k].replace(/^ITEM_/, "").toLowerCase()); }
        if (br.genderRequirement) x.push(/FEMALE/.test(br.genderRequirement) ? "암컷만" : "수컷만");
        if (br.onlyDaytime) x.push("낮에만");
        if (br.onlyNighttime) x.push("밤에만");
        if (br.kmBuddyDistanceRequirement) x.push(`파트너로 ${br.kmBuddyDistanceRequirement}km`);
        else if (br.mustBeBuddy) x.push("파트너일 때");
        if (br.onlyUpsideDown) x.push("기기를 뒤집어서");
        if (br.questDisplay?.length && !br.kmBuddyDistanceRequirement) x.push("특별 미션");
        if (br.noCandyCostViaTrade) x.push("교환하면 사탕 0");
        (to.how ||= []).push({ from: from.id, c: br.candyCost || 0, x });
        edges++;
      }
    }
    report.evolution = { edges, missingTarget: miss, unknownItems: [...unknownItems] };
    if (!edges) warn("진화 방법 데이터를 하나도 찾지 못함");
  } catch (e) { warn("진화 방법 처리 실패: " + e.message); }

  // ---- 레이드 ----
  const stab = (t, p) => types(p).includes(t) ? 1.2 : 1;
  // T(공격 타입)를 주면 그 타입 기술만 효과굉장(1.6), 다른 타입 기술은 1배로 계산 (노말기·스페셜어택 타입이 섞인 조합용)
  const hit = (power, atk, mt, p, T) => Math.floor(0.5 * power * atk / BOSS_DEF * stab(mt, p) * (T && mt !== T ? 1 : SE)) + 1;
  function raidCalc(p, f, c, shadow, T) {
    const F = pve[f], C = pve[c]; if (!F || !C || !F.energy || !C.energy) return null;
    const atk = (p.baseStats.atk + 15) * CPM40 * (shadow ? 1.2 : 1);
    const def = (p.baseStats.def + 15) * CPM40 * (shadow ? 5 / 6 : 1);
    const hp = Math.floor((p.baseStats.hp + 15) * CPM40);
    const FD = hit(F.power, atk, F.type, p, T), CD = hit(C.power, atk, C.type, p, T);
    // 맞으면서 얻는 에너지 포함 (GamePress 방식): 상대에게 받는 초당 피해 y = 900/방어, 잃은 체력 1당 에너지 0.5,
    // 쓰러질 때 남아 버려지는 에너지 x = (스페셜 에너지 + 노말 에너지)/2
    const FDPS = FD / F.dur, FEPS = F.energy / F.dur, CDPS = CD / C.dur, CEPS = C.energy / C.dur;
    const dps0 = (FDPS * CEPS + CDPS * FEPS) / (CEPS + FEPS);
    const y = SURV_K / def, x = 0.5 * C.energy + 0.5 * F.energy;
    const dps = Math.max(FDPS, dps0 + (CDPS - FDPS) / (CEPS + FEPS) * (0.5 - x / hp) * y);
    const tdo = dps * hp / y; // = DPS × 체력 × 방어 / 900
    return { dps, tdo, er: Math.pow(dps ** 3 * tdo, 0.25), fs: FDPS * CEPS / (FDPS * CEPS + CDPS * FEPS) };
  }
  // 기술 조합 후보: 둘 다 t 타입이거나, (노말기만 다른 타입이고) 스페셜어택이 t 타입이면서 포켓몬 자신도 t 타입(자속)일 때.
  // 예: 두드리짱(페어리·강철) 요정의바람 + 거대해머 → 강철 딜러. 뮤츠 + 화염방사처럼 자속이 아닌 조합은 넣지 않음(범용 딜러가 타입 목록을 덮지 않게).
  // 잠재파워는 개체마다 타입이 무작위라 t 타입일 때만 씀
  const mixOk = (f, c, t, p) => moveType(c) === t && (moveType(f) === t || (types(p).includes(t) && !/^HIDDEN_POWER/.test(f)));
  const elite = p => new Set([...(p.eliteMoves || []), ...(p.legacyMoves || [])]);
  const mvName = (p, id) => moveKo(id) + (elite(p).has(id) ? "*" : "");
  const raid = Object.fromEntries(TYPES.map(t => [t, []]));
  // 게임 데이터에 아직 없는 플러스 기술 → scripts/manual-plus.json의 임시(예측) 수치 사용
  const plusEst = [];
  for (const [id, v] of Object.entries(manualPlus)) {
    if (id.startsWith("_") || plusPve[id]) continue;
    plusPve[id] = { type: v.type, power: v.power * 1.3, basePower: v.power, energy: v.energy, dur: v.dur, est: true };
    const mp = (gm.pokemon || []).find(p => p.speciesId === id); if (mp) plusEst.push(koName(mp));
  }
  if (plusEst.length) report.counts.plusEstimated = plusEst;
  let missingPve = new Set();
  const plusUsed = {};
  for (const p of mons) {
    const shadow = isShadow(p);
    const card = cards[baseIdOf(p)]; if (!card) continue;
    // 메가 전용 플러스 기술 (PvPoke extraChargedMoves + 게임 데이터 레이드 수치가 둘 다 있을 때만)
    const plusId = isMega(p) && (p.extraChargedMoves || []).find(m => /_PLUS$/.test(m) && plusPve[p.speciesId]);
    if (plusId) { pve[plusId] = plusPve[p.speciesId]; plusUsed[p.speciesId] = plusId; }
    for (const t of TYPES) {
      // 후보 조건은 mixOk (다른 타입 노말기는 1배로 계산)
      const fs = p.fastMoves || [];
      const pick = cs => { let best = null;
        for (const f of fs) for (const c of cs) {
          if (!mixOk(f, c, t, p)) continue;
          if (moveType(f) === t) { if (!pve[f]) missingPve.add(f); if (!pve[c]) missingPve.add(c); }
          const r = raidCalc(p, f, c, shadow, t); if (r && (!best || r.er > best.er)) best = { ...r, f, c };
        } return best; };
      // 받는 상성(v3.6): t에 약한 상대에게 맞는 평균 배율 inc → TDO ÷ inc, ER × (1/inc)^¼ (dk = 곱한 값, 사이트가 상대별 계산 때 되돌림)
      const inc = incAvg(t, types(p)), dk = Math.pow(1 / inc, 0.25);
      const row = (best, plus) => ({ id: card.id, n: isMega(p) ? koName(p) : card.ko,
        tg: [isMega(p) ? "m" : "", shadow ? "s" : "", plus ? "p" : ""].filter(Boolean),
        mv: `${mvName(p, best.f)} · ${mvName(p, best.c)}`, er: +(best.er * dk).toFixed(2), dps: +best.dps.toFixed(2), tdo: +(best.tdo / inc).toFixed(1), ...(Math.abs(dk - 1) > 0.0005 ? { dk: +dk.toFixed(4) } : {}),
        // 노말기 타입이 다른(섞인) 조합: ft = 노말기 타입, fs = 전체 데미지 중 노말기 몫 → 사이트가 상대별 상성을 기술마다 따로 곱함
        ...(moveType(best.f) !== t ? { ft: moveType(best.f), fs: +best.fs.toFixed(2) } : {}) });
      const cs = p.chargedMoves || [];
      const best = pick(cs);
      if (best) raid[t].push(row(best, false));
      if (plusId && plusPve[p.speciesId].type === t) {
        const bp = pick([...cs, plusId]);
        if (bp && bp.c === plusId) raid[t].push(row(bp, true));
      }
    }
  }
  report.counts.plusMoves = plusUsed;
  report.counts.plusMissingRaidData = (gm.pokemon || []).filter(p => isMega(p) && (p.extraChargedMoves || []).some(m => /_PLUS$/.test(m)) && !plusPve[p.speciesId]).map(p => p.speciesId);
  if (missingPve.size) warn(`PvE 수치 없는 기술 ${missingPve.size}개: ${[...missingPve].slice(0, 30).join(", ")}`);

  // ---- 다이맥스 ----
  const dmax = Object.fromEntries(TYPES.map(t => [t, []]));
  let dmaxCount = 0;
  // 출시 목록(scripts/dynamax.json)과 PvPoke 엔트리 연결
  const dmList = JSON.parse(await readFile(new URL("./dynamax.json", import.meta.url), "utf8"));
  const pick = ([dex, kw]) => {
    const c = mons.filter(p => p.dex === dex && !isShadow(p) && !isMega(p));
    if (kw) { const hit = c.find(p => p.speciesName.toLowerCase().includes(kw.toLowerCase())); if (hit || c.length > 1) return hit; }
    return c.find(p => !p.speciesName.includes("(")) || c.find(p => /\((Normal|Standard|Altered|Incarnate)/i.test(p.speciesName)) || c[0];
  };
  const dmSet = new Map(), unmatched = [];
  for (const [kind, arr] of [["d", dmList.dynamax], ["g", dmList.gigantamax]]) for (const e of arr) {
    const key = Array.isArray(e) ? e : [e]; const p = pick(key);
    if (!p) { unmatched.push(kind + ":" + key.join(" ")); continue; }
    const cur = dmSet.get(p.speciesId) || { p, d: false, g: false }; cur[kind] = true; dmSet.set(p.speciesId, cur);
  }
  // 다이맥스는 못 하지만 맥스배틀에 쓰는 포켓몬: 맥스기 타입·이름 고정 (검왕 자시안, 방패왕 자마젠타, 무한다이노)
  // 5번째 값 = 맥스기 위력(최대 레벨). 없으면 일반 맥스기(350). 다이맥스포는 거다이맥스급(450)
  for (const [dex, kw, mt, mname, power] of dmList.special || []) {
    const p = pick(kw ? [dex, kw] : [dex]);
    if (!p) { unmatched.push("s:" + dex + " " + (kw || "")); continue; }
    dmSet.set(p.speciesId, { p, d: true, g: false, fixed: { type: mt, name: mname, power: power || MAX_POWER } });
  }
  if (unmatched.length) warn("다이맥스 목록 중 매칭 실패: " + unmatched.join(", "));
  // 카드에 다이맥스 가능 표시 (진화 전 포함) → 사이트에서 "어떤 포켓몬을 잡아야 하는지" 안내
  for (const { p } of dmSet.values()) if (cards[p.speciesId]) cards[p.speciesId].dmx = 1;
  // 일정의 맥스배틀 포켓몬인데 다이맥스 목록에 없는 것 → 경고 (dynamax.json 갱신 필요)
  try {
    const ev = JSON.parse(await readFile("site/data/events.json", "utf8"));
    const list = Array.isArray(ev) ? ev : ev.events || [];
    const koId = {}; for (const c of Object.values(cards)) { koId[c.ko] ??= c.id; koId[c.ko.replace(/\(.+\)$/, "")] ??= c.id; }
    const miss = new Set();
    for (const e of list) if (e[0] === "max") for (const n of e[5] || []) {
      // 제목에 지역 이름이 있으면(예: "다이맥스 알로라 모래두지") 그 지역 모습으로 확인
      const rg = (String((e[1] || "") + " " + (e[4] || "")).match(/(알로라|가라르|히스이|팔데아)/) || [])[1];
      const id = (rg && (koId[rg + " " + n] || koId[rg + n])) || koId[n] || koId[String(n).replace(/\s/g, "")]; if (id && !cards[id].dmx) miss.add(rg ? rg + " " + n : n); }
    report.dynamaxNotListed = [...miss];
    if (miss.size) warn("일정의 맥스배틀 포켓몬 중 다이맥스 목록(dynamax.json)에 없는 것: " + [...miss].join(", "));
  } catch (e) { warn("일정 확인 생략: " + e.message); }
  for (const { p, d, g: gOK, fixed } of dmSet.values()) {
    const canG = gOK, onlyG = gOK && !d;
    const atk = (p.baseStats.atk + 15) * CPM40, def = (p.baseStats.def + 15) * CPM40, hp = Math.floor((p.baseStats.hp + 15) * CPM40);
    for (const g of onlyG ? [true] : canG ? [false, true] : [false]) for (const f of p.fastMoves || []) {
      const F = pve[f]; if (!F) continue;
      const FD = hit(F.power, atk, F.type, p), fdps = FD / F.dur;
      const mType = fixed ? fixed.type : F.type;
      const max = hit(g ? GMAX_POWER : fixed ? fixed.power : MAX_POWER, atk, mType, p);
      const row = { id: p.speciesId, n: (g ? "거다이맥스 " : "") + cards[p.speciesId]?.ko, tg: g ? ["g"] : [],
        mv: `${mvName(p, f)} → ${fixed ? fixed.name : "맥스" + (TYPE_KO[F.type] || "")}`, score: max, // 딜러 티어 = 맥스기 한 방 데미지
        max, fdps: +fdps.toFixed(2), bulk: Math.round(hp * def / 100) };
      const list = dmax[mType]; if (!list) continue;
      const dup = list.find(r => r.id === row.id && r.tg.join() === row.tg.join());
      if (!dup) list.push(row); else if (row.score > dup.score || (row.score === dup.score && row.fdps > dup.fdps)) Object.assign(dup, row);
    }
  }
  dmaxCount = dmSet.size; report.counts.dynamaxPokemon = dmaxCount;
  if (!dmaxCount) warn("다이맥스 가능 포켓몬을 찾지 못함 — probe.dynamaxKeys 확인 필요");

  // ---- 최종진화 여부 ----
  const isFinal = id => !!cards[id] && cards[id].evo[cards[id].evo.length - 1].includes(id);
  for (const c of Object.values(cards)) c.final = isFinal(c.id);

  // ---- 배틀 (PvPoke 랭킹 점수, 리그당 상위 40, 개수 상한만) ----
  const pvp = {};
  LEAGUES.forEach(([lg], i) => {
    pvp[lg] = (ranks[i] || []).filter(r => cards[r.speciesId.replace(/_shadow$/, "")] && byId[r.speciesId]).map(r => {
      const p = byId[r.speciesId], card = cards[r.speciesId.replace(/_shadow$/, "")];
      const ms = r.moveset || [];
      return { id: card.id, n: card.ko, tg: isShadow(p) ? ["s"] : [], mv: ms.map(m => mvName(p, m)).join(" · "),
        score: +(+r.score).toFixed(1), sp: r.stats?.product ? Math.round(r.stats.product) : null, rating: r.rating ?? null };
    }).sort((a, b) => b.score - a.score).slice(0, LIMIT_PVP);
    assignCount(pvp[lg], "score");
  });

  // ---- 레이드·다이맥스: 최종진화만, 정렬, 티어(절대 등급) ----
  for (const t of TYPES) {
    raid[t] = raid[t].filter(r => isFinal(r.id)).sort((a, b) => b.er - a.er);
    dmax[t] = dmax[t].filter(r => isFinal(r.id)).sort((a, b) => b.score - a.score || b.fdps - a.fdps);
  }
  // 전체 티어리스트(모습별 한 줄, 가장 잘하는 타입 기준)
  const slim = ({ p, ft, fs, ...r }) => r;
  const tl = { raid: assignAbs(raid, "er", "raid", r => r.er / (r.dk || 1)).map(slim), dmax: assignAbs(dmax, "score", "dmax").map(slim) };

  // ---- 카드별 티어 (n: 일반+메가, s: 그림자) ----
  const ORDER = Object.fromEntries(TIER_RULE.names.map((n, i) => [n, i]));
  function attach(mode, lists, whereOf, formOf) {
    for (const [key, rows] of Object.entries(lists)) rows.forEach((r, i) => {
      const c = cards[r.id]; if (!c || !r.t) return;
      const side = r.tg.includes("s") ? "s" : "n", form = formOf(r, key);
      const arr = ((c.tiers[mode] ||= {})[side] ||= []);
      const e = { f: form, t: r.t, p: r.p, w: whereOf(key), r: i + 1 }, v = r.er != null ? r.er / (r.dk || 1) : r.score;
      Object.defineProperty(e, "_v", { value: v, writable: true, enumerable: false }); // 같은 모습이면 점수가 가장 높은 타입 하나만
      const ex = arr.find(x => x.f === form);
      if (!ex) arr.push(e); else if (v > ex._v) { Object.assign(ex, e); ex._v = v; }
    });
  }
  attach("raid", raid, k => TYPE_KO[k], r => r.tg.includes("m") ? r.n + (r.tg.includes("p") ? " (플러스 기술)" : "") : r.tg.includes("s") ? "그림자" : "일반");
  attach("dmax", dmax, k => TYPE_KO[k], r => r.tg.includes("g") ? "거다이맥스" : "다이맥스");
  attach("pvp", pvp, k => LEAGUES.find(l => l[0] === k)[2], (r, k) => LEAGUES.find(l => l[0] === k)[2]);
  for (const c of Object.values(cards)) for (const m in c.tiers) for (const side in c.tiers[m])
    c.tiers[m][side].sort((a, b) => ORDER[a.t] - ORDER[b.t] || (m === "pvp" ? b.p - a.p : b._v - a._v));
  // 카드 티어를 붙인 뒤에 타입별 표를 자름 (표에는 상위 LIMIT_RAID + 기본 포켓몬 상위 LIMIT_RAID)
  for (const t of TYPES) {
    const base = raid[t].filter(r => !r.tg.length).slice(0, LIMIT_RAID);
    raid[t] = [...new Map([...raid[t].slice(0, LIMIT_RAID), ...base].map(r => [r.id + r.tg.join() + r.n, r])).values()];
  }

  // ---- 기술 추천 (최종 진화형 카드) ----
  // 레이드 최고 티어의 타입 기준. 일반 기술머신으로 배우는 조합 / 레거시·이벤트(대단한 기술머신) 포함 최고 조합 / 메가 플러스 기술
  const KO2TYPE = Object.fromEntries(Object.entries(TYPE_KO).map(([k, v]) => [v, k]));
  const bestCombo = (p, T, allowElite) => {
    const el = elite(p), ok = m => allowElite || !el.has(m);
    let best = null;
    for (const f of (p.fastMoves || []).filter(ok))
      for (const c of (p.chargedMoves || []).filter(ok)) {
        if (!mixOk(f, c, T, p)) continue;
        const r = raidCalc(p, f, c, false, T); if (r && (!best || r.er > best.er)) best = { f, c, er: r.er };
      }
    return best;
  };
  for (const c of Object.values(cards)) {
    if (!c.final) continue;
    const p = byId[c.id]; if (!p) continue;
    const top = c.tiers.raid?.n?.[0] || c.tiers.raid?.s?.[0];
    let T = top ? KO2TYPE[top.w] : null;
    if (!T) { // 순위권 밖이면 이 포켓몬이 가장 강한 타입
      let bestEr = 0; for (const t of TYPES) { const b = bestCombo(p, t, true); if (b && b.er > bestEr) { bestEr = b.er; T = t; } }
    }
    if (!T) continue;
    const n = bestCombo(p, T, false), e = bestCombo(p, T, true);
    const el = elite(p);
    const fmt = b => b && { f: moveKo(b.f), c: moveKo(b.c), er: +b.er.toFixed(1), ef: el.has(b.f), ec: el.has(b.c) };
    const plus = c.megas.map(id => byId[id]).filter(Boolean).flatMap(m => (m.extraChargedMoves || []).filter(x => /_PLUS$/.test(x))
      .map(x => ({ mega: koName(m), move: moveKo(x), type: moveType(x) || plusPve[m.speciesId]?.type || null, raid: !!plusPve[m.speciesId] })));
    // 2번째 스페셜어택(추가 해방): 주력 노말기는 그대로 두고, 주력과 다른 타입의 스페셜어택 중 가장 강한 것
    let s2;
    const mainFast = (n || e)?.f;
    if (mainFast) {
      const bestC = allowElite => { let b = null;
        for (const cm of (p.chargedMoves || [])) { const mt = moveType(cm); if (!mt || mt === T || (!allowElite && el.has(cm))) continue;
          const r = raidCalc(p, mainFast, cm, false); if (r && (!b || r.er > b.er)) b = { c: cm, t: mt, er: r.er }; }
        return b; };
      const sn = bestC(false), se = bestC(true);
      const f2 = b => b && { c: moveKo(b.c), t: b.t, ec: el.has(b.c) };
      if (sn || se) s2 = { n: f2(sn), e: se && (!sn || se.c !== sn.c) ? f2(se) : null };
    }
    c.rec = { t: T, n: fmt(n), e: e && (!n || e.f !== n.f || e.c !== n.c) ? fmt(e) : null, plus: plus.length ? plus : undefined, s2 };
  }

  // ---- 배틀(로켓단 추천)용 기술 요약: pv = [[노말기: 타입번호, 턴당 위력, 턴당 에너지], [스페셜어택: 타입번호, 위력, 에너지]] ----
  for (const c of Object.values(cards)) {
    const p = byId[c.id]; if (!p) continue;
    const ti = id => TYPES.indexOf(moveType(id));
    const f = (p.fastMoves || []).map(id => { const m = pvpMove[id]; const turns = m && (m.turns || Math.round((m.cooldown || 500) / 500)); return m && ti(id) >= 0 && turns ? [ti(id), +(m.power / turns).toFixed(2), +(m.energyGain / turns).toFixed(2)] : null; }).filter(Boolean);
    const ch = (p.chargedMoves || []).map(id => { const m = pvpMove[id]; return m && ti(id) >= 0 && m.energy > 0 ? [ti(id), m.power, m.energy] : null; }).filter(Boolean);
    if (f.length && ch.length) c.pv = [f, ch];
  }

  const out = {
    updated: new Date().toISOString().slice(0, 10),
    sources: "PvPoke gamemaster·rankings, PokeMiners game master, PokeAPI (한국어 이름)",
    tierRule: TIER_RULE, plusEst, cards: Object.values(cards), tl, raid, dmax, pvp
  };
  report.tierCounts = Object.fromEntries(Object.entries({ raid, dmax, pvp }).map(([m, lists]) => [m,
    Object.fromEntries(Object.entries(lists).map(([k, rows]) => [k, TIER_RULE.names.map(n => rows.filter(r => r.t === n).length).join("/")]))]));
  report.counts.cards = out.cards.length;
  report.counts.raidRows = Object.values(raid).reduce((a, b) => a + b.length, 0);
  report.counts.pvpRows = Object.fromEntries(Object.entries(pvp).map(([k, v]) => [k, v.length]));
  report.counts.koNamesMissing = out.cards.filter(c => !koSpecies[c.dex]).length;
  report.sample = { tyranitar: cards.tyranitar, raidDragonTop5: raid.dragon.slice(0, 5), dmaxFireTop3: dmax.fire.slice(0, 3), greatTop3: pvp.great.slice(0, 3) };

  await mkdir("site/data", { recursive: true });
  // 지난번 도감과 내용이 같으면(날짜만 다르면) 파일을 그대로 둠 → 매일 돌아도 쓸데없는 커밋이 안 생김
  const prevDex = await readFile("site/data/pokedex.json", "utf8").then(JSON.parse).catch(() => null);
  if (prevDex && JSON.stringify({ ...prevDex, updated: 0 }) === JSON.stringify({ ...out, updated: 0 })) out.updated = prevDex.updated;

  // ---- 바뀐 점 찾기 (업데이트 페이지 · 알림용) ----
  const snap = {
    mons: Object.fromEntries(mons.filter(p => !isShadow(p)).map(p => [p.speciesId, koName(p)])),
    moves: Object.fromEntries(Object.keys(pvpMove).map(id => [id, { n: moveKo(id), t: moveType(id) || "", pvp: [pvpMove[id].power, pvpMove[id].energy || pvpMove[id].energyGain || 0],
      raid: pve[id] ? [pve[id].power, pve[id].energy, pve[id].dur] : null }])),
    learn: Object.fromEntries(mons.filter(p => !isShadow(p)).map(p => [p.speciesId, { f: p.fastMoves || [], c: p.chargedMoves || [], e: p.eliteMoves || [], x: (p.extraChargedMoves || []).filter(m => /_PLUS$/.test(m)) }])),
    plusRaid: Object.fromEntries(Object.entries(plusPve).filter(([, v]) => !v.est).map(([k, v]) => [k, v.basePower]))
  };
  const prevSnap = await readFile("scripts/state/snapshot.json", "utf8").then(JSON.parse).catch(() => null);
  const items = [], TK = t => TYPE_KO[t] || t;
  const mn = id => snap.mons[id] || prevSnap?.mons?.[id] || id;
  const mv = id => snap.moves[id]?.n || prevSnap?.moves?.[id]?.n || moveKo(id);
  if (prevSnap) {
    for (const id of Object.keys(snap.mons)) if (!prevSnap.mons[id]) items.push({ k: "mon", id: cards[id] ? id : baseIdOf({ speciesId: id }), txt: `새 포켓몬: ${mn(id)}` });
    for (const [id, m] of Object.entries(snap.moves)) {
      const o = prevSnap.moves[id];
      if (!o) { items.push({ k: "move", txt: `새 기술: ${m.n}${m.t ? ` (${TK(m.t)})` : ""}${m.raid ? "" : " · 레이드 수치 아직 없음"}` }); continue; }
      const ch = [];
      const diff = (lab, a, b, names, unit = []) => { const d = names.map((nm, i) => a[i] !== b[i] ? `${nm} ${a[i]}→${b[i]}${unit[i] || ""}` : null).filter(Boolean); if (d.length) ch.push(`${lab} ${d.join(", ")}`); };
      if (o.raid && m.raid) diff("레이드", o.raid, m.raid, ["위력", "에너지", "시간"], ["", "", "초"]);
      if (!o.raid && m.raid) ch.push(`레이드 수치 생김 (위력 ${m.raid[0]})`);
      diff("배틀", o.pvp, m.pvp, ["위력", "에너지"]);
      if (ch.length) items.push({ k: "num", txt: `기술 수치 변경: ${m.n} — ${ch.join(" · ")}` });
    }
    for (const [id, l] of Object.entries(snap.learn)) {
      const o = prevSnap.learn[id]; if (!o) continue;
      const all = x => [...x.f, ...x.c], before = new Set(all(o)), now = new Set(all(l));
      const add = [...now].filter(m => !before.has(m)), del = [...before].filter(m => !now.has(m));
      const cid = cards[id] ? id : baseIdOf({ speciesId: id });
      if (add.length) items.push({ k: "learn", id: cid, txt: `${mn(id)}: 새로 배우는 기술 ${add.map(m => mv(m) + (l.e.includes(m) ? "(레거시)" : "")).join(", ")}` });
      if (del.length) items.push({ k: "learn", id: cid, txt: `${mn(id)}: 못 배우게 된 기술 ${del.map(mv).join(", ")}` });
      const px = l.x.filter(m => !o.x.includes(m));
      if (px.length) items.push({ k: "plus", id: cid, txt: `${mn(id)}: 메가 플러스 기술 ${px.map(mv).join(", ")} 추가${snap.plusRaid[id] ? "" : " · 레이드 수치 아직 없음"}` });
    }
    for (const [id, pw] of Object.entries(snap.plusRaid)) if (prevSnap.plusRaid[id] === undefined && snap.learn[id]?.x?.length)
      items.push({ k: "ready", id: baseIdOf({ speciesId: id }), txt: `${mn(id)} ${snap.learn[id].x.map(mv).join(", ")}: 레이드 수치가 생겨서 티어에 반영됐어요` });
  }
  // 티어 변동 (전체 티어리스트, 모습별)
  if (prevDex?.tl) for (const [mode, label] of [["raid", "레이드"], ["dmax", "다이맥스"]]) {
    const key = r => [r.n, ...(r.tg || [])].join("|");
    const before = Object.fromEntries((prevDex.tl[mode] || []).map(r => [key(r), r.t]));
    const tv = [];
    for (const r of tl[mode] || []) { const b = before[key(r)]; if (b !== r.t && (b || r.t)) tv.push({ k: "tier", id: r.id, txt: `${label} ${(r.tg || []).includes("s") ? "그림자 " : ""}${r.n}${(r.tg || []).includes("p") ? " (+기술MAX)" : ""}: ${b || "—"} → ${r.t || "—"}` }); }
    items.push(...tv.slice(0, 40));
    if (tv.length > 40) items.push({ k: "tier", txt: `${label} 티어 변동 ${tv.length - 40}개 더` });
  }
  const today = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
  const prevChg = await readFile("site/data/changes.json", "utf8").then(JSON.parse).catch(() => ({ log: [] }));
  const log = prevChg.log || [];
  if (!prevSnap) log.unshift({ d: today, items: [{ k: "start", txt: "게임 데이터 변경 추적을 시작했어요" }] });
  else if (items.length) { if (log[0]?.d === today) log[0].items.push(...items); else log.unshift({ d: today, items }); }
  const waiting = (gm.pokemon || []).filter(p => isMega(p) && (p.extraChargedMoves || []).some(m => /_PLUS$/.test(m)) && (!plusPve[p.speciesId] || plusPve[p.speciesId].est))
    .map(p => ({ n: koName(p), m: p.extraChargedMoves.filter(m => /_PLUS$/.test(m)).map(mv).join(", ") + (plusPve[p.speciesId]?.est ? " · 지금은 예측 수치로 티어 반영 중" : "") }));
  // 일반 기술도: 배우는 포켓몬은 있는데 레이드 수치가 없는 것 (예: 대도각참 도각참)
  for (const id of missingPve) { const who = mons.filter(p => !isShadow(p) && !isMega(p) && [...(p.fastMoves || []), ...(p.chargedMoves || [])].includes(id)).map(koName);
    if (who.length) waiting.push({ n: who.slice(0, 3).join(", ") + (who.length > 3 ? ` 외 ${who.length - 3}` : ""), m: mv(id) }); }
  await writeFile("site/data/changes.json", JSON.stringify({ checked: today, waiting, log: log.slice(0, 60) }, null, 1));
  await mkdir("scripts/state", { recursive: true });
  await writeFile("scripts/state/snapshot.json", JSON.stringify(snap));
  report.changes = items.length;
  // 알림용 글 (Actions가 GitHub 이슈로 올림; 티어 변동만 있으면 알림 안 함)
  const notable = items.filter(i => i.k !== "tier");
  if (notable.length && process.env.RUNNER_TEMP)
    await writeFile(process.env.RUNNER_TEMP + "/pyo-changes.md", `${today} 게임 데이터에서 바뀐 점이에요. 사이트 업데이트 페이지: https://pogo.hhhpyo.cloud/#updates\n\n` + items.map(i => "- " + i.txt).join("\n") + "\n");

  const json = JSON.stringify(out);
  await writeFile("site/data/pokedex.json", json);
  report.bytes = json.length;
  await writeFile("site/data/pokedex-report.json", JSON.stringify(report, null, 1));
  console.log(`완료: 카드 ${out.cards.length}개, ${(json.length / 1024).toFixed(0)}KB`);
}

main().catch(async e => {
  console.error(e);
  report.fatal = String(e.stack || e);
  await mkdir("site/data", { recursive: true });
  await writeFile("site/data/pokedex-report.json", JSON.stringify(report, null, 1));
  process.exit(0); // 리포트를 커밋할 수 있도록 성공 처리
});
