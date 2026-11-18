// PYOkemongo 서버 (Cloudflare Worker)
// - /api/* 만 이 코드가 처리하고, 나머지는 site/ 정적 파일(ASSETS)을 그대로 보여 줌
// - 계정: 트레이너 코드(12자리, 그대로 저장) + 비밀번호(PBKDF2-SHA256 해시만 저장, 사람마다 다른 salt)
// - 가입 없음: 관리자가 트레이너 코드를 추가하면 바로 계정이 생김 (초기 비밀번호 INITIAL_PW, 첫 로그인 때 꼭 바꿔야 함)
// - 관리자: users.is_admin = 1 인 특별 계정. 서버 코드에는 관리자 계정 이름을 적지 않음(공개 저장소라서).
//   관리자 계정은 D1 콘솔에서 한 번만 만들고, 첫 로그인 때 비밀번호를 꼭 바꿔야 관리 기능이 열림
// - 세션: 무작위 토큰을 HttpOnly 쿠키로 주고, 서버에는 토큰의 SHA-256 해시만 저장
// - 데이터: 사용자마다 박스(JSON) 1개 (내 박스 + 병뚜껑 후보)
// 필요한 바인딩: DB (D1), ASSETS (정적 파일)

const PBKDF2_ITER = 100000;            // Workers의 PBKDF2 최대 반복 횟수
const SESSION_DAYS = 30, ADMIN_SESSION_H = 12;
const MAX_FAILS = 5, LOCK_MIN = 15;    // 일반: 5번 틀리면 15분 잠금
const ADMIN_FAILS = 3, ADMIN_LOCK_MIN = 60; // 관리자: 3번 틀리면 60분 잠금
const IP_MAX = 30, IP_WINDOW_MIN = 15; // 같은 IP에서 15분에 30번 넘게 실패하면 잠시 막음
const MAX_BODY = 400 * 1024;           // 박스 데이터 최대 400KB
const COOKIE = "pyo_s";
const INITIAL_PW = "hello"; // 관리자가 만든 계정의 첫 비밀번호 (must_change=1 이라 로그인 후 바꾸기 전엔 아무 기능도 못 씀)

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (code TEXT PRIMARY KEY, pw_hash TEXT NOT NULL, salt TEXT NOT NULL, iter INTEGER NOT NULL, created INTEGER NOT NULL, fails INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, code TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS boxes (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ip_fails (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, since INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_log (ts INTEGER NOT NULL, admin TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '')`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const q of SCHEMA) await db.prepare(q).run();
  schemaReady = true;
}

const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const randBytes = n => crypto.getRandomValues(new Uint8Array(n));
const sha256 = async s => b64(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return b64(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
function sameStr(a, b) { // 시간 차이로 값을 추측하지 못하게 끝까지 비교
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const SEC_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin" };
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", ...SEC_HEADERS, ...headers },
});
const fail = (msg, status = 400) => json({ error: msg }, status);
const now = () => Date.now();
const cookieOf = req => (req.headers.get("cookie") || "").split(/;\s*/).map(x => x.split("=")).find(([k]) => k === COOKIE)?.[1] || "";
const setCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function readJson(req) {
  const len = +(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) throw new Error("too_big");
  const t = await req.text();
  if (t.length > MAX_BODY) throw new Error("too_big");
  return t ? JSON.parse(t) : {};
}
async function currentUser(req, db) {
  const tok = cookieOf(req); if (!tok) return null;
  const s = await db.prepare("SELECT code, expires FROM sessions WHERE token_hash = ?").bind(await sha256(tok)).first();
  if (!s || s.expires < now()) return null;
  return await db.prepare("SELECT code, is_admin, must_change FROM users WHERE code = ?").bind(s.code).first();
}
async function newSession(db, code, admin) {
  const token = b64(randBytes(32)).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
  const life = admin ? ADMIN_SESSION_H * 3600e3 : SESSION_DAYS * 864e5;
  await db.prepare("INSERT INTO sessions (token_hash, code, expires) VALUES (?, ?, ?)").bind(await sha256(token), code, now() + life).run();
  await db.prepare("DELETE FROM sessions WHERE expires < ?").bind(now()).run(); // 오래된 세션 정리
  return setCookie(token, Math.floor(life / 1000));
}
async function ipBlocked(db, ip) {
  const r = await db.prepare("SELECT count, since FROM ip_fails WHERE ip = ?").bind(ip).first();
  return r && r.since > now() - IP_WINDOW_MIN * 6e4 && r.count >= IP_MAX;
}
async function ipFail(db, ip) {
  const r = await db.prepare("SELECT count, since FROM ip_fails WHERE ip = ?").bind(ip).first();
  if (!r || r.since < now() - IP_WINDOW_MIN * 6e4) await db.prepare("INSERT OR REPLACE INTO ip_fails (ip, count, since) VALUES (?, 1, ?)").bind(ip, now()).run();
  else await db.prepare("UPDATE ip_fails SET count = count + 1 WHERE ip = ?").bind(ip).run();
}
const validCode = c => /^\d{12}$/.test(c);           // 트레이너 코드
const validLogin = c => /^\d{10,20}$/.test(c);        // 로그인 아이디 (관리자 계정 포함)
const validPw = (p, admin) => typeof p === "string" && p.length >= (admin ? 10 : 8) && p.length <= 128;
const userInfo = u => ({ code: u.code, admin: !!u.is_admin, mustChange: !!u.must_change });
const log = (db, admin, action, target, ip) => db.prepare("INSERT INTO admin_log (ts, admin, action, target, ip) VALUES (?, ?, ?, ?, ?)").bind(now(), admin, action, target || "", ip || "").run();

async function api(req, env, path) {
  const db = env.DB;
  if (!db) return fail("서버 저장소가 아직 설정되지 않았어요.", 503);
  await ensureSchema(db);
  const method = req.method;
  // 다른 사이트에서 몰래 요청하는 것(CSRF) 막기: 쓰기 요청은 같은 주소에서 온 것만 + JSON만
  if (method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && origin !== new URL(req.url).origin) return fail("허용되지 않은 요청이에요.", 403);
    if (!(req.headers.get("content-type") || "").includes("application/json")) return fail("허용되지 않은 요청이에요.", 415);
  }
  const ip = req.headers.get("cf-connecting-ip") || "local";

  if (path === "me" && method === "GET") {
    const u = await currentUser(req, db);
    return json(u ? userInfo(u) : { code: null });
  }

  if (path === "login" && method === "POST") {
    if (await ipBlocked(db, ip)) return fail("잠시 후 다시 시도해 주세요.", 429);
    let b; try { b = await readJson(req); } catch { return fail("잘못된 요청이에요."); }
    const code = String(b.code || "").replace(/\D/g, "");
    const u = validLogin(code) ? await db.prepare("SELECT * FROM users WHERE code = ?").bind(code).first() : null;
    const generic = "아이디나 비밀번호가 맞지 않아요."; // 어느 쪽이 틀렸는지 알려 주지 않음
    if (!u) { await pbkdf2(String(b.password || ""), randBytes(16), PBKDF2_ITER); await ipFail(db, ip); return fail(generic, 401); }
    if (u.lock_until > now()) return fail(`여러 번 틀려서 잠겼어요. ${Math.ceil((u.lock_until - now()) / 6e4)}분 뒤에 다시 해 주세요.`, 429);
    const ok = sameStr(await pbkdf2(String(b.password || ""), unb64(u.salt), u.iter), u.pw_hash);
    if (!ok) {
      const max = u.is_admin ? ADMIN_FAILS : MAX_FAILS, lock = u.is_admin ? ADMIN_LOCK_MIN : LOCK_MIN, fails = u.fails + 1;
      await db.prepare("UPDATE users SET fails = ?, lock_until = ? WHERE code = ?").bind(fails >= max ? 0 : fails, fails >= max ? now() + lock * 6e4 : 0, code).run();
      await ipFail(db, ip);
      if (u.is_admin) await log(db, code, "login_fail", "", ip);
      return fail(generic, 401);
    }
    await db.prepare("UPDATE users SET fails = 0, lock_until = 0 WHERE code = ?").bind(code).run();
    if (u.is_admin) await log(db, code, "login", "", ip);
    return json(userInfo(u), 200, { "set-cookie": await newSession(db, code, !!u.is_admin) });
  }

  if (path === "logout" && method === "POST") {
    const tok = cookieOf(req);
    if (tok) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(tok)).run();
    return json({ ok: true }, 200, { "set-cookie": setCookie("", 0) });
  }

  // 여기부터는 로그인 필요
  const me = await currentUser(req, db);
  if (!me) return fail("로그인이 필요해요.", 401);
  const code = me.code;

  if (path === "password" && method === "POST") { // 비밀번호 바꾸기 (지금 비밀번호 필요) → 다른 기기 세션 모두 로그아웃
    let b; try { b = await readJson(req); } catch { return fail("잘못된 요청이에요."); }
    const u = await db.prepare("SELECT * FROM users WHERE code = ?").bind(code).first();
    if (!sameStr(await pbkdf2(String(b.old || ""), unb64(u.salt), u.iter), u.pw_hash)) return fail("지금 비밀번호가 맞지 않아요.", 401);
    if (!validPw(b.password, u.is_admin)) return fail(u.is_admin ? "관리자 비밀번호는 10~128자예요." : "비밀번호는 8~128자예요.");
    if (b.password === b.old) return fail("지금과 다른 비밀번호로 바꿔 주세요.");
    const salt = randBytes(16);
    await db.prepare("UPDATE users SET pw_hash = ?, salt = ?, iter = ?, must_change = 0 WHERE code = ?").bind(await pbkdf2(b.password, salt, PBKDF2_ITER), b64(salt), PBKDF2_ITER, code).run();
    await db.prepare("DELETE FROM sessions WHERE code = ?").bind(code).run();
    if (u.is_admin) await log(db, code, "password_change", "", ip);
    return json(userInfo({ ...u, must_change: 0 }), 200, { "set-cookie": await newSession(db, code, !!u.is_admin) });
  }
  if (me.must_change) return fail("먼저 비밀번호를 바꿔 주세요.", 403);

  if (path === "box" && method === "GET") {
    const r = await db.prepare("SELECT data, updated FROM boxes WHERE code = ?").bind(code).first();
    return json({ data: r ? JSON.parse(r.data) : null, updated: r?.updated || null });
  }
  if (path === "box" && method === "PUT") {
    let b; try { b = await readJson(req); } catch (e) { return fail(e.message === "too_big" ? "데이터가 너무 커요." : "잘못된 요청이에요.", e.message === "too_big" ? 413 : 400); }
    const data = JSON.stringify({ box: b.box ?? null, caps: Array.isArray(b.caps) ? b.caps : [] });
    const t = now();
    await db.prepare("INSERT INTO boxes (code, data, updated) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated = excluded.updated").bind(code, data, t).run();
    return json({ ok: true, updated: t });
  }
  if (path === "account" && method === "DELETE") { // 탈퇴: 계정·세션·데이터 모두 삭제 (관리자 계정은 탈퇴 불가)
    if (me.is_admin) return fail("관리자 계정은 지울 수 없어요.", 403);
    for (const t of ["boxes", "sessions", "users"]) await db.prepare(`DELETE FROM ${t} WHERE code = ?`).bind(code).run();
    return json({ ok: true }, 200, { "set-cookie": setCookie("", 0) });
  }

  // ---------- 관리자 전용 ----------
  if (path.startsWith("admin/")) {
    if (!me.is_admin) return fail("없는 주소예요.", 404); // 관리자 기능이 있다는 것도 드러내지 않음
    const sub = path.slice(6);
    if (sub === "overview" && method === "GET") {
      const users = (await db.prepare("SELECT u.code, u.created, u.is_admin, u.must_change, b.updated, length(b.data) AS size FROM users u LEFT JOIN boxes b ON b.code = u.code ORDER BY u.created DESC").all()).results;
      const logs = (await db.prepare("SELECT ts, action, target, ip FROM admin_log ORDER BY ts DESC LIMIT 30").all()).results;
      return json({ users, logs });
    }
    let b; try { b = await readJson(req); } catch { return fail("잘못된 요청이에요."); }
    const target = String(b.code || "").replace(/\D/g, "");
    if (sub === "create" && method === "POST") { // 계정 바로 만들기: 비밀번호 INITIAL_PW, 첫 로그인 때 변경 필수
      if (!validCode(target)) return fail("트레이너 코드는 숫자 12자리예요.");
      if (await db.prepare("SELECT 1 FROM users WHERE code = ?").bind(target).first()) return fail("이미 있는 계정이에요.", 409);
      const salt = randBytes(16);
      await db.prepare("INSERT INTO users (code, pw_hash, salt, iter, created, must_change) VALUES (?, ?, ?, ?, ?, 1)")
        .bind(target, await pbkdf2(INITIAL_PW, salt, PBKDF2_ITER), b64(salt), PBKDF2_ITER, now()).run();
      await log(db, code, "create_user", target, ip);
      return json({ ok: true });
    }
    if (sub === "reset" && method === "POST") { // 비밀번호 초기화: 임시 비밀번호를 한 번만 보여 줌, 그 사람의 로그인은 모두 끊김
      const u = await db.prepare("SELECT is_admin FROM users WHERE code = ?").bind(target).first();
      if (!u || u.is_admin) return fail("초기화할 수 없는 계정이에요.");
      const temp = INITIAL_PW;
      const salt = randBytes(16);
      await db.prepare("UPDATE users SET pw_hash = ?, salt = ?, iter = ?, fails = 0, lock_until = 0, must_change = 1 WHERE code = ?").bind(await pbkdf2(temp, salt, PBKDF2_ITER), b64(salt), PBKDF2_ITER, target).run();
      await db.prepare("DELETE FROM sessions WHERE code = ?").bind(target).run();
      await log(db, code, "reset_password", target, ip);
      return json({ ok: true, temp });
    }
    if (sub === "user" && method === "DELETE") {
      const u = await db.prepare("SELECT is_admin FROM users WHERE code = ?").bind(target).first();
      if (!u || u.is_admin) return fail("지울 수 없는 계정이에요.");
      for (const t of ["boxes", "sessions", "users"]) await db.prepare(`DELETE FROM ${t} WHERE code = ?`).bind(target).run();
      await log(db, code, "delete_user", target, ip);
      return json({ ok: true });
    }
  }
  return fail("없는 주소예요.", 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url.pathname.slice(5).replace(/\/$/, "")); }
      catch (e) { return fail("서버 오류가 났어요.", 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
