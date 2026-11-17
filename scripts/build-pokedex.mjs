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

import { writeFile, mkdir } from "node:fs/promises";

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
const TIERS = [["SS", 95], ["S", 90], ["A", 80], ["B", 70], ["C", 50], ["D", 0]];
const tierOf = p => TIERS.find(([, m]) => p >= m)[0];
const TYPES = ["normal","fire","water","grass","electric","ice","fighting","poison","ground","flying","psychic","bug","rock","ghost","dragon","dark","steel","fairy"];
const TYPE_KO = {normal:"노말",fire:"불꽃",water:"물",grass:"풀",electric:"전기",ice:"얼음",fighting:"격투",poison:"독",ground:"땅",flying:"비행",psychic:"에스퍼",bug:"벌레",rock:"바위",ghost:"고스트",dragon:"드래곤",dark:"악",steel:"강철",fairy:"페어리"};
const LEAGUES = [["great", 1500, "슈퍼리그"], ["ultra", 2500, "하이퍼리그"], ["master", 10000, "마스터리그"]];
const LIMIT_RAID = 150, LIMIT_PVP = 200;

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
  "Dawn":"새벽","Eternamax":"무한다이맥스","Family of Three":"세 식구","Family of Four":"네 식구"
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
  for (const t of pm) {
    const d = t.data || {};
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
  report.probe.pveMoves = Object.keys(pve).length;
  report.probe.dynamaxKeys = [...breadKeys];
  report.probe.samplePokemonKeys = Object.keys(pmPokemon["charizard"] || {});
  report.probe.charizardBread = Object.fromEntries([...breadKeys].map(k => [k, (pmPokemon["charizard"] || {})[k]]));

  // ---- PvP 기술 (PvPoke) ----
  const pvpMove = Object.fromEntries((gm.moves || []).map(m => [m.moveId, m]));
  const moveKo = id => {
    const m = pvpMove[id];
    const base = id.replace(/^(HIDDEN_POWER|WEATHER_BALL|TECHNO_BLAST|AURA_WHEEL|REVELATION_DANCE|MULTI_ATTACK)_.*/, "$1");
    const ident = base.toLowerCase().replace(/_/g, "-").replace("futuresight", "future-sight").replace("vice-grip", "vise-grip");
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
      const cur = level.filter(id => !seen.has(id) && cards[id]); cur.forEach(id => seen.add(id));
      if (cur.length) stages.push(cur);
      level = ids.filter(id => cur.includes(parentOf(id)));
    }
    c.evo = stages.some(s => s.includes(c.id)) ? stages : [[c.id]];
  }

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
  for (const p of mons) {
    const shadow = isShadow(p);
    const card = cards[baseIdOf(p)]; if (!card) continue;
    for (const t of TYPES) {
      const fs = (p.fastMoves || []).filter(m => moveType(m) === t);
      const cs = (p.chargedMoves || []).filter(m => moveType(m) === t);
      let best = null;
      for (const f of fs) for (const c of cs) {
        if (!pve[f]) missingPve.add(f); if (!pve[c]) missingPve.add(c);
        const r = raidCalc(p, f, c, shadow); if (r && (!best || r.er > best.er)) best = { ...r, f, c };
      }
      if (best) raid[t].push({ id: card.id, n: isMega(p) ? koName(p) : card.ko, tg: [isMega(p) ? "m" : "", shadow ? "s" : ""].filter(Boolean),
        mv: `${mvName(p, best.f)} · ${mvName(p, best.c)}`, er: +best.er.toFixed(2), dps: +best.dps.toFixed(2), tdo: +best.tdo.toFixed(1) });
    }
  }
  if (missingPve.size) warn(`PvE 수치 없는 기술 ${missingPve.size}개: ${[...missingPve].slice(0, 30).join(", ")}`);

  // ---- 다이맥스 ----
  const dmax = Object.fromEntries(TYPES.map(t => [t, []]));
  let dmaxCount = 0;
  for (const p of mons) {
    if (isShadow(p) || isMega(p)) continue;
    const ps = pmPokemon[p.speciesId] || pmPokemon[p.speciesId.split("_")[0]];
    const s = JSON.stringify(Object.fromEntries([...breadKeys].map(k => [k, ps?.[k]])));
    if (!ps || s === "{}" || !/BREAD|true|\{/.test(s)) continue;
    const canG = /DOUGH|GIGANTAMAX|GMAX/i.test(s);
    dmaxCount++;
    const atk = (p.baseStats.atk + 15) * CPM40, def = (p.baseStats.def + 15) * CPM40, hp = Math.floor((p.baseStats.hp + 15) * CPM40);
    for (const g of canG ? [false, true] : [false]) for (const f of p.fastMoves || []) {
      const F = pve[f]; if (!F) continue;
      const FD = hit(F.power, atk, F.type, p), fdps = FD / F.dur;
      const max = hit(g ? GMAX_POWER : MAX_POWER, atk, F.type, p);
      const row = { id: p.speciesId, n: (g ? "거다이맥스 " : "") + cards[p.speciesId]?.ko, tg: g ? ["g"] : [],
        mv: `${mvName(p, f)} → 맥스${TYPE_KO[F.type] || ""}`, score: +Math.pow(max ** 3 * fdps, 0.25).toFixed(2),
        max, fdps: +fdps.toFixed(2), bulk: Math.round(hp * def / 100) };
      const list = dmax[F.type]; if (!list) continue;
      const dup = list.find(r => r.id === row.id && r.tg.join() === row.tg.join());
      if (!dup) list.push(row); else if (row.score > dup.score) Object.assign(dup, row);
    }
  }
  report.counts.dynamaxPokemon = dmaxCount;
  if (!dmaxCount) warn("다이맥스 가능 포켓몬을 찾지 못함 — probe.dynamaxKeys 확인 필요");

  // ---- 배틀 (PvPoke 랭킹 점수) ----
  const pvp = {};
  LEAGUES.forEach(([lg], i) => {
    pvp[lg] = (ranks[i] || []).filter(r => cards[r.speciesId.replace(/_shadow$/, "")] && byId[r.speciesId]).map(r => {
      const p = byId[r.speciesId], card = cards[r.speciesId.replace(/_shadow$/, "")];
      const ms = r.moveset || [];
      return { id: card.id, n: card.ko, tg: isShadow(p) ? ["s"] : [], mv: ms.map(m => mvName(p, m)).join(" · "),
        score: +(+r.score).toFixed(1), sp: r.stats?.product ? Math.round(r.stats.product / 1000) : null, rating: r.rating ?? null };
    }).slice(0, LIMIT_PVP);
  });

  // ---- 카드별 티어 요약 ----
  function attach(mode, lists, metric, whereOf, formOf) {
    for (const [key, rows] of Object.entries(lists)) {
      if (!rows.length) continue;
      const top = Math.max(...rows.map(r => r[metric]));
      for (const r of rows) {
        const c = cards[r.id]; if (!c) continue;
        const pct = r[metric] / top * 100, form = formOf(r);
        const arr = (c.tiers[mode] ||= []);
        const ex = arr.find(x => x.f === form);
        if (!ex || pct > ex.p) { if (ex) arr.splice(arr.indexOf(ex), 1); arr.push({ f: form, t: tierOf(pct), p: Math.round(pct), w: whereOf(key) }); }
      }
    }
  }
  attach("raid", raid, "er", k => TYPE_KO[k], r => r.tg.includes("m") ? r.n : r.tg.includes("s") ? "그림자" : "일반");
  attach("dmax", dmax, "score", k => TYPE_KO[k], r => r.tg.includes("g") ? "거다이맥스" : "다이맥스");
  attach("pvp", pvp, "score", k => LEAGUES.find(l => l[0] === k)[2], r => (r.tg.includes("s") ? "그림자 · " : "") + LEAGUES.find(l => pvp[l[0]].includes(r))[2]);
  for (const c of Object.values(cards)) for (const m in c.tiers) c.tiers[m].sort((a, b) => b.p - a.p);

  // ---- 정렬·자르기 ----
  for (const t of TYPES) {
    raid[t].sort((a, b) => b.er - a.er);
    const base = raid[t].filter(r => !r.tg.length).slice(0, LIMIT_RAID);
    raid[t] = [...new Map([...raid[t].slice(0, LIMIT_RAID), ...base].map(r => [r.id + r.tg.join() + r.n, r])).values()];
    dmax[t].sort((a, b) => b.score - a.score);
  }

  const out = {
    updated: new Date().toISOString().slice(0, 10),
    sources: "PvPoke gamemaster·rankings, PokeMiners game master, PokeAPI (한국어 이름)",
    tiers: TIERS, cards: Object.values(cards), raid, dmax, pvp
  };
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
