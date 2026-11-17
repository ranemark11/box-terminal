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
const MAX_POWER = 350, GMAX_POWER = 450;
// 티어 규칙: ER(점수) 순으로 내려가며, 남은 자리(티어별 상한)가 있고 최소 %를 넘는 가장 높은 티어.
// 바로 앞 포켓몬과 1% 이내로 거의 같으면 같은 티어(상한 초과 허용). 나머지는 순위권 밖(null).
const TIER_RULE = { names: ["SS", "S", "A", "B", "C"], caps: [3, 4, 5, 10, 18], minPct: [95, 88, 80, 70, 55], tie: 0.01 };
function assignTiers(rows, metric, usePct = true) {
  // usePct=false(배틀): % 조건·동점 규칙 없이 개수 상한만
  const R = TIER_RULE; if (!rows.length) return;
  const top = rows[0][metric]; let level = 0, n = 0, boundary = null;
  for (const r of rows) {
    const v = r[metric], pct = v / top * 100;
    r.p = Math.round(pct);
    // 동점 규칙: 상한이 찼지만 이 티어 마지막 포켓몬과 1% 이내면 같은 티어
    if (usePct && level < 5 && n >= R.caps[level] && boundary != null && v >= boundary * (1 - R.tie) && pct >= R.minPct[level]) { r.t = R.names[level]; n++; continue; }
    while (level < 5 && (n >= R.caps[level] || (usePct && pct < R.minPct[level]))) { level++; n = 0; boundary = null; }
    r.t = level < 5 ? R.names[level] : null;
    if (r.t) { n++; boundary = v; }
  }
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
  const plusPve = {}; // 메가 speciesId -> 플러스 기술 레이드 수치
  for (const t of pm) {
    const d = t.data || {};
    const vm = t.templateId.match(/^VM_MOVE_TEMP_EVOLUTION_MEGA(?:_([XY]))?_V\d+_POKEMON_(\w+)$/);
    if (vm && d.moveSettings) {
      const ms = d.moveSettings;
      plusPve[vm[2].toLowerCase() + "_mega" + (vm[1] ? "_" + vm[1].toLowerCase() : "")] = {
        type: (ms.pokemonType || "").replace("POKEMON_TYPE_", "").toLowerCase(),
        power: ms.power || 0, energy: Math.abs(ms.energyDelta || 0), dur: (ms.durationMs || 1000) / 1000 };
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
  const mons = (gm.pokemon || []).filter(p => p.released !== false && !(p.tags || []).includes("duplicate"));
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
  const hit = (power, atk, mt, p) => Math.floor(0.5 * power * atk / BOSS_DEF * stab(mt, p) * SE) + 1;
  function raidCalc(p, f, c, shadow) {
    const F = pve[f], C = pve[c]; if (!F || !C || !F.energy || !C.energy) return null;
    const atk = (p.baseStats.atk + 15) * CPM40 * (shadow ? 1.2 : 1);
    const def = (p.baseStats.def + 15) * CPM40 * (shadow ? 5 / 6 : 1);
    const hp = Math.floor((p.baseStats.hp + 15) * CPM40);
    const FD = hit(F.power, atk, F.type, p), CD = hit(C.power, atk, C.type, p);
    const dps = (FD * C.energy + CD * F.energy) / (C.energy * F.dur + F.energy * C.dur);
    const tdo = dps * hp * def / SURV_K;
    return { dps, tdo, er: Math.pow(dps ** 3 * tdo, 0.25) };
  }
  const elite = p => new Set([...(p.eliteMoves || []), ...(p.legacyMoves || [])]);
  const mvName = (p, id) => moveKo(id) + (elite(p).has(id) ? "*" : "");
  const raid = Object.fromEntries(TYPES.map(t => [t, []]));
  let missingPve = new Set();
  const plusUsed = {};
  for (const p of mons) {
    const shadow = isShadow(p);
    const card = cards[baseIdOf(p)]; if (!card) continue;
    // 메가 전용 플러스 기술 (PvPoke extraChargedMoves + 게임 데이터 레이드 수치가 둘 다 있을 때만)
    const plusId = isMega(p) && (p.extraChargedMoves || []).find(m => /_PLUS$/.test(m) && plusPve[p.speciesId]);
    if (plusId) { pve[plusId] = plusPve[p.speciesId]; plusUsed[p.speciesId] = plusId; }
    for (const t of TYPES) {
      const fs = (p.fastMoves || []).filter(m => moveType(m) === t);
      const pick = cs => { let best = null;
        for (const f of fs) for (const c of cs) {
          if (!pve[f]) missingPve.add(f); if (!pve[c]) missingPve.add(c);
          const r = raidCalc(p, f, c, shadow); if (r && (!best || r.er > best.er)) best = { ...r, f, c };
        } return best; };
      const row = (best, plus) => ({ id: card.id, n: isMega(p) ? koName(p) : card.ko,
        tg: [isMega(p) ? "m" : "", shadow ? "s" : "", plus ? "p" : ""].filter(Boolean),
        mv: `${mvName(p, best.f)} · ${mvName(p, best.c)}`, er: +best.er.toFixed(2), dps: +best.dps.toFixed(2), tdo: +best.tdo.toFixed(1) });
      const cs = (p.chargedMoves || []).filter(m => moveType(m) === t);
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
  for (const [dex, kw, mt, mname] of dmList.special || []) {
    const p = pick(kw ? [dex, kw] : [dex]);
    if (!p) { unmatched.push("s:" + dex + " " + (kw || "")); continue; }
    dmSet.set(p.speciesId, { p, d: true, g: false, fixed: { type: mt, name: mname } });
  }
  if (unmatched.length) warn("다이맥스 목록 중 매칭 실패: " + unmatched.join(", "));
  for (const { p, d, g: gOK, fixed } of dmSet.values()) {
    const canG = gOK, onlyG = gOK && !d;
    const atk = (p.baseStats.atk + 15) * CPM40, def = (p.baseStats.def + 15) * CPM40, hp = Math.floor((p.baseStats.hp + 15) * CPM40);
    for (const g of onlyG ? [true] : canG ? [false, true] : [false]) for (const f of p.fastMoves || []) {
      const F = pve[f]; if (!F) continue;
      const FD = hit(F.power, atk, F.type, p), fdps = FD / F.dur;
      const mType = fixed ? fixed.type : F.type;
      const max = hit(g ? GMAX_POWER : MAX_POWER, atk, mType, p);
      const row = { id: p.speciesId, n: (g ? "거다이맥스 " : "") + cards[p.speciesId]?.ko, tg: g ? ["g"] : [],
        mv: `${mvName(p, f)} → ${fixed ? fixed.name : "맥스" + (TYPE_KO[F.type] || "")}`, score: +Math.pow(max ** 3 * fdps, 0.25).toFixed(2),
        max, fdps: +fdps.toFixed(2), bulk: Math.round(hp * def / 100) };
      const list = dmax[mType]; if (!list) continue;
      const dup = list.find(r => r.id === row.id && r.tg.join() === row.tg.join());
      if (!dup) list.push(row); else if (row.score > dup.score) Object.assign(dup, row);
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
    assignTiers(pvp[lg], "score", false);
  });

  // ---- 레이드·다이맥스: 최종진화만, 정렬, 티어 ----
  for (const t of TYPES) {
    raid[t] = raid[t].filter(r => isFinal(r.id)).sort((a, b) => b.er - a.er);
    assignTiers(raid[t], "er");
    const base = raid[t].filter(r => !r.tg.length).slice(0, LIMIT_RAID);
    raid[t] = [...new Map([...raid[t].slice(0, LIMIT_RAID), ...base].map(r => [r.id + r.tg.join() + r.n, r])).values()];
    dmax[t] = dmax[t].filter(r => isFinal(r.id)).sort((a, b) => b.score - a.score);
    assignTiers(dmax[t], "score");
  }

  // ---- 카드별 티어 (n: 일반+메가, s: 그림자) ----
  const ORDER = Object.fromEntries(TIER_RULE.names.map((n, i) => [n, i]));
  function attach(mode, lists, whereOf, formOf) {
    for (const [key, rows] of Object.entries(lists)) rows.forEach((r, i) => {
      const c = cards[r.id]; if (!c || !r.t) return;
      const side = r.tg.includes("s") ? "s" : "n", form = formOf(r, key);
      const arr = ((c.tiers[mode] ||= {})[side] ||= []);
      const e = { f: form, t: r.t, p: r.p, w: whereOf(key), r: i + 1 };
      const ex = arr.find(x => x.f === form);
      if (!ex) arr.push(e); else if (ORDER[e.t] < ORDER[ex.t] || (e.t === ex.t && e.p > ex.p)) Object.assign(ex, e);
    });
  }
  attach("raid", raid, k => TYPE_KO[k], r => r.tg.includes("m") ? r.n + (r.tg.includes("p") ? " (플러스 기술)" : "") : r.tg.includes("s") ? "그림자" : "일반");
  attach("dmax", dmax, k => TYPE_KO[k], r => r.tg.includes("g") ? "거다이맥스" : "다이맥스");
  attach("pvp", pvp, k => LEAGUES.find(l => l[0] === k)[2], (r, k) => LEAGUES.find(l => l[0] === k)[2]);
  for (const c of Object.values(cards)) for (const m in c.tiers) for (const side in c.tiers[m])
    c.tiers[m][side].sort((a, b) => ORDER[a.t] - ORDER[b.t] || b.p - a.p);

  // ---- 기술 추천 (최종 진화형 카드) ----
  // 레이드 최고 티어의 타입 기준. 일반 기술머신으로 배우는 조합 / 레거시·이벤트(대단한 기술머신) 포함 최고 조합 / 메가 플러스 기술
  const KO2TYPE = Object.fromEntries(Object.entries(TYPE_KO).map(([k, v]) => [v, k]));
  const bestCombo = (p, T, allowElite) => {
    const el = elite(p), ok = m => allowElite || !el.has(m);
    let best = null;
    for (const f of (p.fastMoves || []).filter(m => moveType(m) === T && ok(m)))
      for (const c of (p.chargedMoves || []).filter(m => moveType(m) === T && ok(m))) {
        const r = raidCalc(p, f, c, false); if (r && (!best || r.er > best.er)) best = { f, c, er: r.er };
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
    c.rec = { t: T, n: fmt(n), e: e && (!n || e.f !== n.f || e.c !== n.c) ? fmt(e) : null, plus: plus.length ? plus : undefined };
  }

  const out = {
    updated: new Date().toISOString().slice(0, 10),
    sources: "PvPoke gamemaster·rankings, PokeMiners game master, PokeAPI (한국어 이름)",
    tierRule: TIER_RULE, cards: Object.values(cards), raid, dmax, pvp
  };
  report.tierCounts = Object.fromEntries(Object.entries({ raid, dmax, pvp }).map(([m, lists]) => [m,
    Object.fromEntries(Object.entries(lists).map(([k, rows]) => [k, TIER_RULE.names.map(n => rows.filter(r => r.t === n).length).join("/")]))]));
  report.counts.cards = out.cards.length;
  report.counts.raidRows = Object.values(raid).reduce((a, b) => a + b.length, 0);
  report.counts.pvpRows = Object.fromEntries(Object.entries(pvp).map(([k, v]) => [k, v.length]));
  report.counts.koNamesMissing = out.cards.filter(c => !koSpecies[c.dex]).length;
  report.sample = { tyranitar: cards.tyranitar, raidDragonTop5: raid.dragon.slice(0, 5), dmaxFireTop3: dmax.fire.slice(0, 3), greatTop3: pvp.great.slice(0, 3) };

  await mkdir("site/data", { recursive: true });
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
