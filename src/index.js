import DEFAULT_TEMPLATE from "../templates/default-quotation.html";

/* --------------------------------------------------------------------------
   Challenger Quotation Platform - Cloudflare Worker
   - Auth: one shared passcode (settings table) + stateless HMAC session cookie
   - Data: D1 (companies, templates, quote_sequences, quotations, audit_events)
   - Print: hydrated HTML snapshot + A4 bilingual sheet, printed by the browser
   -------------------------------------------------------------------------- */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SESSION_COOKIE = "q_session";
const DEFAULT_SESSION_HOURS = 12;
const PBKDF2_ITERATIONS = 100000;
const MIN_PASSCODE_LENGTH = 6;
const MAX_PASSCODE_LENGTH = 200;
const MAX_TEMPLATE_BYTES = 200000;
const LETTERHEAD_URL = "/letterhead_background.png";
const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_PREFIX = "logos/";
/* A template may print {{logo_url}} even when the company has no logo. Pointing at a
   1x1 transparent GIF keeps the sheet clean instead of showing a broken-image icon. */
const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
/** Accepted logo formats — the declared type must also match the file signature. */
const LOGO_TYPES = [
  { mime: "image/png", ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/webp", ext: "webp",
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];
const AUTOPRINT_SCRIPT = 'window.addEventListener("load",function(){setTimeout(function(){window.print()},400)});';

const enc = new TextEncoder();
const dec = new TextDecoder();

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (text) => {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

const randomToken = (n = 32) => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
};

const parseCookie = (request, name) =>
  (request.headers.get("Cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + "="))
    ?.slice(name.length + 1);

const bodyJson = async (request) => {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
};

const slugify = (value) =>
  String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);

const cleanName = (value) => {
  const name = typeof value === "string" ? value.trim().slice(0, 60) : "";
  return name || "Shared user";
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Replace flat {{token}} placeholders. Unknown tokens render empty. */
const renderQuote = (html, fields) =>
  String(html).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => escapeHtml(fields[key] ?? ""));

const numberWords = (n) => {
  const ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const under1000 = (x) => {
    const out = [];
    if (x >= 100) { out.push(ones[Math.floor(x / 100)], "hundred"); x %= 100; }
    if (x >= 20) {
      const unit = x % 10;
      out.push(unit ? `${tens[Math.floor(x / 10)]}-${ones[unit]}` : tens[Math.floor(x / 10)]);
    }
    else if (x > 0) out.push(ones[x]);
    return out.join(" ");
  };
  if (!Number.isSafeInteger(n) || n < 0 || n > 999999999) return "amount not available";
  if (n === 0) return "zero";
  const parts = [];
  /** @type {[number, string][]} */
  const scales = [[1000000, "million"], [1000, "thousand"], [1, ""]];
  for (const [value, label] of scales) {
    const q = Math.floor(n / value);
    if (q) { parts.push(under1000(q) + (label ? " " + label : "")); n %= value; }
  }
  return parts.join(" ");
};

/** 543210 -> "5,432.10" (en-US grouping, no Intl dependency). */
const formatMoney = (cents) => {
  const safe = Math.round(Number(cents) || 0);
  const sign = safe < 0 ? "-" : "";
  const abs = Math.abs(safe);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + whole + "." + String(abs % 100).padStart(2, "0");
};

const amountWordsFromCents = (cents) => {
  const abs = Math.abs(Math.round(Number(cents) || 0));
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  return numberWords(whole) + (fraction ? " and " + numberWords(fraction) + " fils" : "");
};

/** "2026-11-05" -> "05/11/2026" (calendar-safe, no timezone drift). */
const formatDateDMY = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(iso || "");
};

const validIsoDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const todayIso = () => new Date().toISOString().slice(0, 10);

/** "12,345.60" | "12345.6" -> 1234560 cents, or null when invalid. */
const parseAmountToCents = (value) => {
  const raw = typeof value === "number" ? String(value) : String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 99999999.99) return null;
  return Math.round(amount * 100);
};

const parseJson = (text) => {
  try { return JSON.parse(text || "{}"); } catch { return {}; }
};

const fail = (status, code, details = {}) => Object.assign(new Error(code), { status, code, details });

/* ============================== auth ============================== */

const settingsRead = async (env, key) => {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return row ? row.value : null;
};

const settingsWrite = (env, key, value) =>
  env.DB.prepare(
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP"
  ).bind(key, value).run();

/**
 * PBKDF2-SHA256. 100,000 iterations is the ceiling of the Workers runtime;
 * 210,000 (the previous default) throws and surfaced as an opaque 500.
 */
const stretchPasscode = async (passcode, salt, iterations = PBKDF2_ITERATIONS) => {
  const key = await crypto.subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations, hash: "SHA-256" }, key, 256);
  return b64url(bits);
};

/** @returns {Promise<{salt:string,hash:string,iterations:number,updated_at:string}|null>} */
const readAuth = async (env) => {
  const raw = await settingsRead(env, "auth_passcode");
  if (!raw) return null;
  const parsed = parseJson(raw);
  return parsed && parsed.salt && parsed.hash ? parsed : null;
};

const writeAuth = (env, record) => settingsWrite(env, "auth_passcode", JSON.stringify(record));

const hmacKey = (authHash) =>
  crypto.subtle.importKey("raw", enc.encode("q_session.v1:" + authHash), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

/** @returns {Promise<string>} `v1.<payload>.<signature>` */
const signSession = async (claims, key) => {
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `v1.${payload}.${b64url(signature)}`;
};

/** @returns {Promise<{name:string,exp:number}|null>} */
const verifySession = async (token, key) => {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", key, fromB64url(parts[2]), enc.encode(parts[1]));
  } catch {
    return null;
  }
  if (!valid) return null;
  const claims = parseJson(dec.decode(fromB64url(parts[1])));
  if (!claims || typeof claims.exp !== "number") return null;
  if (claims.exp * 1000 <= Date.now()) return null;
  return { name: typeof claims.n === "string" ? claims.n : "Shared user", exp: claims.exp };
};

const sessionHours = (env) => {
  const hours = Number(env?.SESSION_HOURS);
  return Number.isFinite(hours) && hours > 0 && hours <= 720 ? hours : DEFAULT_SESSION_HOURS;
};

const sessionExpiry = (env) => Math.floor(Date.now() / 1000) + sessionHours(env) * 3600;

const isHttps = (request) => new URL(request.url).protocol === "https:";

const sessionCookie = (token, request, env) => {
  const parts = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${sessionHours(env) * 3600}`];
  if (isHttps(request)) parts.push("Secure");
  return parts.join("; ");
};

const clearedCookie = (request) => {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (isHttps(request)) parts.push("Secure");
  return parts.join("; ");
};

/** @returns {Promise<{name:string,exp:number}|null>} */
const currentSession = async (request, env) => {
  const token = parseCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const auth = await readAuth(env);
  if (!auth) return null;
  return verifySession(token, await hmacKey(auth.hash));
};

const safeEqual = (a, b) => {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.byteLength !== y.byteLength) return false;
  const timingSafe = crypto.subtle.timingSafeEqual;
  if (typeof timingSafe === "function") {
    try { return timingSafe.call(crypto.subtle, x, y); } catch { return false; }
  }
  let diff = 0;
  for (let i = 0; i < x.byteLength; i++) diff |= x[i] ^ y[i];
  return diff === 0;
};

/** Best-effort in-isolate throttle: 8 failed attempts per IP per 10 minutes. */
const loginAttempts = new Map();
const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const THROTTLE_MAX_ATTEMPTS = 8;

const throttleFor = (ip) => {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.reset) {
    const fresh = { count: 0, reset: now + THROTTLE_WINDOW_MS };
    loginAttempts.set(ip, fresh);
    return fresh;
  }
  return record;
};

const writeAuditRow = (env, actor, action, entity, entityId, details) =>
  env.DB.prepare("INSERT INTO audit_events(id,actor,action,entity,entity_id,details_json) VALUES(?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), String(actor || "shared"), action, entity, entityId || null, JSON.stringify(details || {}))
    .run();

/** Fire-and-forget audit write; never blocks or breaks the request. */
const audit = (env, ctx, actor, action, entity, entityId, details = {}) => {
  const run = writeAuditRow(env, actor, action, entity, entityId, details).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run);
  return run;
};

let scriptHashCache = null;
const scriptHash = async () => {
  if (!scriptHashCache) scriptHashCache = b64url(await crypto.subtle.digest("SHA-256", enc.encode(AUTOPRINT_SCRIPT)));
  return scriptHashCache;
};

const authStatus = async (request, env) => {
  const auth = await readAuth(env);
  const session = auth ? await currentSession(request, env) : null;
  return json({
    setup: !!auth,
    signed_in: !!session,
    name: session?.name || null,
    session_hours: sessionHours(env),
    /* the passcode is global (one settings row), so this timestamp is global too */
    passcode_updated_at: auth?.updated_at || null,
  });
};

const handleSetup = async (request, env, ctx) => {
  if (await readAuth(env)) return json({ error: "already_configured" }, 409);
  const body = await bodyJson(request);
  const passcode = typeof body?.passcode === "string" ? body.passcode : "";
  if (passcode.length < MIN_PASSCODE_LENGTH || passcode.length > MAX_PASSCODE_LENGTH) {
    return json({ error: "passcode_too_short", min_length: MIN_PASSCODE_LENGTH }, 400);
  }
  const salt = randomToken(16);
  const hash = await stretchPasscode(passcode, salt);
  await writeAuth(env, { salt, hash, iterations: PBKDF2_ITERATIONS, updated_at: new Date().toISOString() });
  const actor = cleanName(body?.name);
  const company = await seedCompany(env);
  audit(env, ctx, actor, "auth.setup", "settings", "auth_passcode", { seeded_company: company?.id || null });
  const token = await signSession({ n: actor, exp: sessionExpiry(env) }, await hmacKey(hash));
  return json({ signed_in: true, name: actor, company }, 200, { "set-cookie": sessionCookie(token, request, env) });
};

const handleLogin = async (request, env) => {
  const body = await bodyJson(request);
  const passcode = typeof body?.passcode === "string" ? body.passcode : "";
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const throttle = throttleFor(ip);
  if (throttle.count >= THROTTLE_MAX_ATTEMPTS) {
    return json({ error: "too_many_attempts", retry_after_seconds: Math.ceil((throttle.reset - Date.now()) / 1000) }, 429);
  }
  if (!passcode) return json({ error: "passcode_required" }, 400);
  const auth = await readAuth(env);
  if (!auth) return json({ error: "setup_required" }, 409);
  const candidate = await stretchPasscode(passcode, auth.salt, auth.iterations || PBKDF2_ITERATIONS);
  if (!safeEqual(candidate, auth.hash)) {
    throttle.count += 1;
    return json({ error: "invalid_passcode", attempts_remaining: Math.max(THROTTLE_MAX_ATTEMPTS - throttle.count, 0) }, 401);
  }
  throttle.count = 0;
  const actor = cleanName(body?.name);
  const token = await signSession({ n: actor, exp: sessionExpiry(env) }, await hmacKey(auth.hash));
  return json({ signed_in: true, name: actor }, 200, { "set-cookie": sessionCookie(token, request, env) });
};

const handleLogout = (request) => json({ signed_in: false }, 200, { "set-cookie": clearedCookie(request) });

const handleRotatePasscode = async (request, env, ctx, session) => {
  const body = await bodyJson(request);
  const current = typeof body?.current === "string" ? body.current : "";
  const next = typeof body?.next === "string" ? body.next : "";
  if (next.length < MIN_PASSCODE_LENGTH || next.length > MAX_PASSCODE_LENGTH) {
    return json({ error: "passcode_too_short", min_length: MIN_PASSCODE_LENGTH }, 400);
  }
  const auth = await readAuth(env);
  if (!auth) return json({ error: "setup_required" }, 409);
  const candidate = await stretchPasscode(current, auth.salt, auth.iterations || PBKDF2_ITERATIONS);
  if (!safeEqual(candidate, auth.hash)) return json({ error: "invalid_current_passcode" }, 401);
  const salt = randomToken(16);
  const hash = await stretchPasscode(next, salt);
  const rotatedAt = new Date().toISOString();
  /* one row for the whole desk — every company and every person shares this code */
  await writeAuth(env, { salt, hash, iterations: PBKDF2_ITERATIONS, updated_at: rotatedAt });
  audit(env, ctx, session.name, "auth.passcode_rotated", "settings", "auth_passcode", {});
  const token = await signSession({ n: session.name, exp: sessionExpiry(env) }, await hmacKey(hash));
  return json({ rotated: true, rotated_at: rotatedAt }, 200, { "set-cookie": sessionCookie(token, request, env) });
};

/* ============================ companies ============================ */

const COMPANY_COLUMNS =
  "id,name,slug,legal_name,phone,email,address,quotation_prefix,currency,logo_key,letterhead_key,font_name,active,created_at";

/**
 * Public path of a company's uploaded logo, or null when it has none.
 * The version query only busts caches after a re-upload; the Worker always serves
 * the logo currently referenced by companies.logo_key.
 */
const logoUrlFor = (company) => {
  if (!company || !company.logo_key) return null;
  const version = String(company.logo_key).split("/").pop();
  return `/api/companies/${company.id}/logo?v=${encodeURIComponent(version)}`;
};

/** Company rows leave the Worker with a ready-to-use logo URL. */
const withLogoUrl = (row) => (row ? { ...row, logo_url: logoUrlFor(row) } : row);

/** Seeds "Challenger Cars" (with an active template) when no company exists yet. */
const seedCompany = async (env) => {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM companies").first();
  if (count && Number(count.n) > 0) return null;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO companies(id,name,slug,legal_name,phone,email,address,quotation_prefix,currency) VALUES(?,?,?,?,?,?,?,?,?)"
  ).bind(id, "Challenger Cars", "challenger-cars", "Challenger Cars", "", "", "", "QA-", "AED").run();
  await env.DB.prepare("INSERT INTO templates(id,company_id,name,version,html,active) VALUES(?,?,?,1,?,1)")
    .bind(crypto.randomUUID(), id, "Default A4 quotation", DEFAULT_TEMPLATE).run();
  return { id, name: "Challenger Cars", slug: "challenger-cars" };
};

const handleCompanyList = async (env) => {
  const rows = await env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies ORDER BY active DESC, name`).all();
  return json({ companies: (rows.results || []).map(withLogoUrl) });
};

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

const handleCompanyCreate = async (request, env, ctx, session) => {
  const body = await bodyJson(request);
  const name = text(body?.name, 120);
  if (name.length < 2) return json({ error: "company_name_required" }, 400);
  const slug = slugify(body?.slug || name);
  if (!slug) return json({ error: "invalid_company_slug" }, 400);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO companies(id,name,slug,legal_name,phone,email,address,quotation_prefix,currency) VALUES(?,?,?,?,?,?,?,?,?)"
    ).bind(
      id, name, slug,
      text(body?.legal_name, 160) || name,
      text(body?.phone, 40),
      text(body?.email, 160),
      text(body?.address, 300),
      text(body?.quotation_prefix, 12) || "QA-",
      text(body?.currency, 3).toUpperCase() || "AED"
    ).run();
  } catch {
    return json({ error: "company_slug_already_exists" }, 409);
  }
  await env.DB.prepare("INSERT INTO templates(id,company_id,name,version,html,active) VALUES(?,?,?,1,?,1)")
    .bind(crypto.randomUUID(), id, "Default A4 quotation", DEFAULT_TEMPLATE).run();
  audit(env, ctx, session.name, "company.created", "company", id, { name, slug });
  const row = await env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(id).first();
  return json({ company: withLogoUrl(row) }, 201);
};

/** @type {[string, number][]} */
const COMPANY_TEXT_FIELDS = [
  ["name", 120], ["legal_name", 160], ["phone", 40], ["email", 160],
  ["address", 300], ["quotation_prefix", 12], ["currency", 3], ["font_name", 80],
];

const handleCompanyPatch = async (request, env, ctx, session, companyId) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const existing = await env.DB.prepare("SELECT id FROM companies WHERE id=?").bind(companyId).first();
  if (!existing) return json({ error: "company_not_found" }, 404);
  if (typeof body.name === "string" && body.name.trim().length < 2) return json({ error: "company_name_required" }, 400);
  const sets = [];
  const values = [];
  for (const [field, max] of COMPANY_TEXT_FIELDS) {
    if (typeof body[field] === "string") {
      const clean = body[field].trim().slice(0, max);
      sets.push(`${field}=?`);
      values.push(field === "currency" ? clean.toUpperCase() : clean);
    }
  }
  if (body.active === true || body.active === 1 || body.active === false || body.active === 0) {
    sets.push("active=?");
    values.push(body.active === true || body.active === 1 ? 1 : 0);
  }
  if (!sets.length) return json({ error: "no_fields_to_update" }, 400);
  await env.DB.prepare(`UPDATE companies SET ${sets.join(", ")}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(...values, companyId).run();
  audit(env, ctx, session.name, "company.updated", "company", companyId, { fields: sets.map((s) => s.replace("=?", "")) });
  const row = await env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(companyId).first();
  return json({ company: withLogoUrl(row) });
};

const handleCompanyDeactivate = async (env, ctx, session, companyId) => {
  const result = await env.DB.prepare("UPDATE companies SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(companyId).run();
  if (!result.meta || result.meta.changes === 0) return json({ error: "company_not_found" }, 404);
  audit(env, ctx, session.name, "company.deactivated", "company", companyId, {});
  return json({ deactivated: true });
};

/* ------------------------------ company logo ------------------------------ */

/**
 * Logo bytes live in R2 (binding ASSETS), never in D1: the row only keeps the key.
 * The signature check runs on the bytes themselves, so a mislabelled upload can
 * neither sneak a script through nor be served with a type the browser sniffs.
 */
const sniffLogoType = (bytes, declared) => {
  const match = LOGO_TYPES.find((type) => type.test(bytes));
  if (!match) return null;
  if (declared && declared !== match.mime) return null;
  return match;
};

const handleCompanyLogoGet = async (env, companyId) => {
  const row = await env.DB.prepare("SELECT logo_key FROM companies WHERE id=?").bind(companyId).first();
  if (!row || !row.logo_key) return json({ error: "logo_not_found" }, 404);
  if (!env.ASSETS) return json({ error: "storage_unavailable" }, 503);
  const object = await env.ASSETS.get(row.logo_key);
  if (!object) return json({ error: "logo_not_found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": (object.httpMetadata && object.httpMetadata.contentType) || "application/octet-stream",
      "cache-control": "private, max-age=0, must-revalidate",
      etag: `"${row.logo_key}"`,
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      /* a logo is artwork, never a document: no scripts, no framing, no navigation */
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
};

const handleCompanyLogoUpload = async (request, env, ctx, session, companyId) => {
  const row = await env.DB.prepare("SELECT id,logo_key FROM companies WHERE id=?").bind(companyId).first();
  if (!row) return json({ error: "company_not_found" }, 404);
  if (!env.ASSETS) return json({ error: "storage_unavailable" }, 503);
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return json({ error: "logo_file_required" }, 400);
  }
  if (file.size > MAX_LOGO_BYTES) return json({ error: "logo_too_large", max_bytes: MAX_LOGO_BYTES }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffLogoType(bytes, file.type || "");
  if (!type) return json({ error: "unsupported_image_type", accepted: LOGO_TYPES.map((t) => t.mime) }, 415);
  const key = `${LOGO_PREFIX}${companyId}-${randomToken(6)}.${type.ext}`;
  await env.ASSETS.put(key, bytes, {
    httpMetadata: { contentType: type.mime },
    customMetadata: { company_id: companyId },
  });
  await env.DB.prepare("UPDATE companies SET logo_key=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(key, companyId).run();
  if (row.logo_key && row.logo_key !== key) {
    /* the previous logo is unreachable now, so drop it instead of leaking buckets */
    try { await env.ASSETS.delete(row.logo_key); } catch { /* the new logo is already live */ }
  }
  audit(env, ctx, session.name, "company.logo_uploaded", "company", companyId, {
    type: type.mime, bytes: bytes.length, replaced: Boolean(row.logo_key),
  });
  /* Templates issued before the logo slot existed never ask for {{logo_url}}, so the
     operator is told instead of silently getting a sheet without the new mark. */
  const active = await env.DB.prepare(
    "SELECT html FROM templates WHERE company_id=? AND active=1 ORDER BY version DESC LIMIT 1"
  ).bind(companyId).first();
  const template_uses_logo = active ? /\{\{\s*logo_url\s*\}\}/.test(active.html) : false;
  const updated = await env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(companyId).first();
  return json({ company: withLogoUrl(updated), template_uses_logo }, 201);
};

const handleCompanyLogoDelete = async (env, ctx, session, companyId) => {
  const row = await env.DB.prepare("SELECT id,logo_key FROM companies WHERE id=?").bind(companyId).first();
  if (!row) return json({ error: "company_not_found" }, 404);
  if (!row.logo_key) {
    const current = await env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(companyId).first();
    return json({ removed: false, company: withLogoUrl(current) });
  }
  await env.DB.prepare("UPDATE companies SET logo_key=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(companyId).run();
  if (env.ASSETS) {
    try { await env.ASSETS.delete(row.logo_key); } catch { /* the row is already clear */ }
  }
  audit(env, ctx, session.name, "company.logo_removed", "company", companyId, {});
  const updated = await env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(companyId).first();
  return json({ removed: true, company: withLogoUrl(updated) });
};

/* ============================ templates ============================ */

const handleTemplateList = async (env, companyId) => {
  const rows = await env.DB.prepare(
    "SELECT id,name,version,active,created_at,length(html) AS bytes FROM templates WHERE company_id=? ORDER BY version DESC"
  ).bind(companyId).all();
  return json({ templates: rows.results || [] });
};

const handleTemplateGet = async (env, companyId, templateId) => {
  const row = await env.DB.prepare(
    "SELECT id,company_id,name,version,active,html,created_at FROM templates WHERE id=? AND company_id=?"
  ).bind(templateId, companyId).first();
  return row ? json({ template: row }) : json({ error: "template_not_found" }, 404);
};

const handleTemplateSave = async (request, env, ctx, session, companyId) => {
  const body = await bodyJson(request);
  const html = typeof body?.html === "string" ? body.html : "";
  if (!html.trim()) return json({ error: "template_html_required" }, 400);
  if (html.length > MAX_TEMPLATE_BYTES) return json({ error: "template_too_large" }, 413);
  const company = await env.DB.prepare("SELECT id FROM companies WHERE id=?").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  const versionRow = await env.DB.prepare("SELECT COALESCE(MAX(version),0)+1 AS next FROM templates WHERE company_id=?")
    .bind(companyId).first();
  const version = Number(versionRow?.next) || 1;
  const id = crypto.randomUUID();
  const name = text(body?.name, 100) || `Version ${version}`;
  const activate = body?.activate !== false;
  const statements = [];
  if (activate) statements.push(env.DB.prepare("UPDATE templates SET active=0 WHERE company_id=?").bind(companyId));
  statements.push(
    env.DB.prepare("INSERT INTO templates(id,company_id,name,version,html,active) VALUES(?,?,?,?,?,?)")
      .bind(id, companyId, name, version, html, activate ? 1 : 0)
  );
  await env.DB.batch(statements);
  audit(env, ctx, session.name, "template.saved", "template", id, { company_id: companyId, version, active: activate });
  return json({ template: { id, name, version, active: activate } }, 201);
};

const handleTemplateActivate = async (env, ctx, session, templateId) => {
  const row = await env.DB.prepare("SELECT id,company_id FROM templates WHERE id=?").bind(templateId).first();
  if (!row) return json({ error: "template_not_found" }, 404);
  await env.DB.batch([
    env.DB.prepare("UPDATE templates SET active=0 WHERE company_id=?").bind(row.company_id),
    env.DB.prepare("UPDATE templates SET active=1 WHERE id=?").bind(templateId),
  ]);
  audit(env, ctx, session.name, "template.activated", "template", templateId, { company_id: row.company_id });
  return json({ activated: templateId });
};

/** Sample vehicle used to proof a template before it goes live. */
const PREVIEW_SAMPLE = { model: "AUDI A8", year: "2012", chassis: "WAUZZZ4H0DN000001", cents: 24850000 };

const companyRow = async (env, companyId) =>
  env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(companyId).first();

/**
 * Renders a template through the same path as /print (snapshot fields + renderQuote),
 * so the settings preview cannot drift from the printed sheet. Uses sample data and the
 * next live number - nothing is written and no serial is burned.
 */
const renderTemplatePreview = async (env, company, html) => {
  const next = await peekNextNumber(env, company, todayIso());
  const row = {
    quote_number: next.quote_number,
    quote_date: todayIso(),
    model: PREVIEW_SAMPLE.model,
    year: PREVIEW_SAMPLE.year,
    chassis: PREVIEW_SAMPLE.chassis,
    amount_cents: PREVIEW_SAMPLE.cents,
    amount_words: amountWordsFromCents(PREVIEW_SAMPLE.cents),
    company_name: company.name,
    company_snapshot_json: JSON.stringify({
      name: company.name,
      legal_name: company.legal_name,
      address: company.address,
      phone: company.phone,
      email: company.email,
      currency: company.currency,
      letterhead_url: LETTERHEAD_URL,
      logo_url: logoUrlFor(company),
    }),
  };
  return {
    html: renderQuote(html || DEFAULT_TEMPLATE, buildPrintFields(row)),
    sample: { quote_number: next.quote_number, date: row.quote_date, amount_cents: row.amount_cents },
  };
};

/** Preview for HTML that is still in the editor (never persisted). */
const handleTemplatePreviewDraft = async (request, env, companyId) => {
  const body = await bodyJson(request);
  const html = typeof body?.html === "string" ? body.html : "";
  if (!html.trim()) return json({ error: "template_html_required" }, 400);
  if (html.length > MAX_TEMPLATE_BYTES) return json({ error: "template_too_large" }, 413);
  const company = await companyRow(env, companyId);
  if (!company) return json({ error: "company_not_found" }, 404);
  return json(await renderTemplatePreview(env, company, html));
};

/** Preview for a stored version. */
const handleTemplatePreviewVersion = async (env, companyId, templateId) => {
  const row = await env.DB.prepare("SELECT html FROM templates WHERE id=? AND company_id=?")
    .bind(templateId, companyId).first();
  if (!row) return json({ error: "template_not_found" }, 404);
  const company = await companyRow(env, companyId);
  if (!company) return json({ error: "company_not_found" }, 404);
  return json(await renderTemplatePreview(env, company, row.html));
};

/**
 * Deletes one stored version. The live version is protected; quotations keep their own
 * HTML snapshot, so records are detached (template_id -> NULL) instead of blocking.
 */
const handleTemplateDelete = async (env, ctx, session, companyId, templateId) => {
  const row = await env.DB.prepare("SELECT id,version,active FROM templates WHERE id=? AND company_id=?")
    .bind(templateId, companyId).first();
  if (!row) return json({ error: "template_not_found" }, 404);
  if (row.active) return json({ error: "template_is_active" }, 409);
  const inUse = await env.DB.prepare("SELECT COUNT(*) AS n FROM quotations WHERE template_id=?")
    .bind(templateId).first();
  const detached = Number(inUse?.n || 0);
  await env.DB.batch([
    env.DB.prepare("UPDATE quotations SET template_id=NULL WHERE template_id=?").bind(templateId),
    env.DB.prepare("DELETE FROM templates WHERE id=? AND company_id=?").bind(templateId, companyId),
  ]);
  audit(env, ctx, session.name, "template.deleted", "template", templateId, {
    company_id: companyId, version: row.version, detached_records: detached,
  });
  return json({ deleted: templateId, version: row.version, detached_records: detached });
};

/* =========================== quotations =========================== */

const decorate = (row) => ({
  ...row,
  amount: formatMoney(row.amount_cents),
  quote_date_text: formatDateDMY(row.quote_date),
});

const handleQuotationList = async (env, url) => {
  const companyId = url.searchParams.get("company_id");
  if (!companyId) return json({ error: "company_id_required" }, 400);
  const search = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const like = `%${search}%`;
  const rows = await env.DB.prepare(
    "SELECT id,quote_number,quote_date,model,year,chassis,amount_cents,amount_words,created_at FROM quotations " +
    "WHERE company_id=? AND deleted_at IS NULL " +
    "AND (quote_number LIKE ? OR model LIKE ? OR chassis LIKE ? OR year LIKE ?) " +
    "ORDER BY quote_date DESC, created_at DESC LIMIT ?"
  ).bind(companyId, like, like, like, like, limit).all();
  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM quotations WHERE company_id=? AND deleted_at IS NULL"
  ).bind(companyId).first();
  return json({ quotations: (rows.results || []).map(decorate), total: Number(total?.n || 0) });
};

/** Read-only numbering preview: never advances the sequence. */
const peekNextNumber = async (env, company, date) => {
  const period = date.slice(0, 4);
  const row = await env.DB.prepare("SELECT last_number FROM quote_sequences WHERE company_id=? AND period=?")
    .bind(company.id, period).first();
  const next = Number(row?.last_number || 0) + 1;
  const prefix = company.quotation_prefix || "QA-";
  return { period, next_serial: next, quote_number: `${prefix}${period}-${String(next).padStart(5, "0")}` };
};

const handleNextNumber = async (env, url) => {
  const companyId = url.searchParams.get("company_id");
  const date = url.searchParams.get("date") || todayIso();
  if (!companyId) return json({ error: "company_id_required" }, 400);
  if (!validIsoDate(date)) return json({ error: "invalid_quote_date" }, 400);
  const company = await env.DB.prepare("SELECT id,quotation_prefix FROM companies WHERE id=?").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  return json({ ...(await peekNextNumber(env, company, date)), date });
};

const allocateSerial = async (env, companyId, period) => {
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO quote_sequences(company_id,period,last_number) VALUES(?,?,1) " +
      "ON CONFLICT(company_id,period) DO UPDATE SET last_number=last_number+1"
    ).bind(companyId, period),
    env.DB.prepare("SELECT last_number FROM quote_sequences WHERE company_id=? AND period=?").bind(companyId, period),
  ]);
  return Number(results[1]?.results?.[0]?.last_number || 1);
};

const handleQuotationCreate = async (request, env, ctx, session) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const companyId = text(body.company_id, 48);
  if (!companyId) return json({ error: "company_id_required" }, 400);
  const model = text(body.model, 120);
  const year = text(body.year, 20);
  const chassis = text(body.chassis, 120);
  if (!model || !year || !chassis) return json({ error: "model_year_and_chassis_required" }, 400);
  const cents = parseAmountToCents(body.amount);
  if (cents === null) return json({ error: "invalid_amount" }, 400);
  const date = text(body.quote_date, 10) || todayIso();
  if (!validIsoDate(date)) return json({ error: "invalid_quote_date" }, 400);
  const company = await env.DB.prepare("SELECT * FROM companies WHERE id=? AND active=1").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  const period = date.slice(0, 4);
  const prefix = company.quotation_prefix || "QA-";
  let quoteNumber = text(body.quote_number, 60);
  if (!quoteNumber) {
    for (let attempt = 0; attempt < 8 && !quoteNumber; attempt++) {
      const serial = await allocateSerial(env, company.id, period);
      const candidate = `${prefix}${period}-${String(serial).padStart(5, "0")}`;
      const taken = await env.DB.prepare("SELECT 1 AS taken FROM quotations WHERE company_id=? AND quote_number=?")
        .bind(company.id, candidate).first();
      if (!taken) quoteNumber = candidate;
    }
    if (!quoteNumber) return json({ error: "numbering_exhausted" }, 409);
  }
  const template = await env.DB.prepare(
    "SELECT id,html FROM templates WHERE company_id=? AND active=1 ORDER BY version DESC LIMIT 1"
  ).bind(company.id).first();
  const amountWords = amountWordsFromCents(cents);
  const snapshot = {
    name: company.name, legal_name: company.legal_name, address: company.address,
    phone: company.phone, email: company.email, currency: company.currency,
    letterhead_url: company.letterhead_key ? `/api/companies/${company.id}/letterhead` : LETTERHEAD_URL,
    logo_url: logoUrlFor(company),
  };
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO quotations(id,company_id,template_id,quote_number,quote_date,model,year,chassis," +
      "amount_cents,amount_words,template_html_snapshot,company_snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, company.id, template?.id || null, quoteNumber, date, model, year, chassis, cents, amountWords,
      template?.html || DEFAULT_TEMPLATE, JSON.stringify(snapshot)).run();
  } catch {
    return json({ error: "quotation_number_already_exists" }, 409);
  }
  audit(env, ctx, session.name, "quotation.created", "quotation", id,
    { quote_number: quoteNumber, company_id: company.id, amount_cents: cents });
  return json({
    quotation: {
      id, company_id: company.id, quote_number: quoteNumber, quote_date: date,
      quote_date_text: formatDateDMY(date), model, year, chassis,
      amount_cents: cents, amount: formatMoney(cents), amount_words: amountWords,
      currency: company.currency || "AED",
    },
  }, 201);
};

const QUOTATION_COLUMNS =
  "id,company_id,template_id,quote_number,quote_date,model,year,chassis,amount_cents,amount_words,company_snapshot_json,created_at,updated_at";

const quotationById = (env, id) =>
  env.DB.prepare(`SELECT ${QUOTATION_COLUMNS} FROM quotations WHERE id=? AND deleted_at IS NULL`).bind(id).first();

const handleQuotationGet = async (env, id) => {
  const row = await quotationById(env, id);
  if (!row) return json({ error: "quotation_not_found" }, 404);
  const company = await env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(row.company_id).first();
  const snapshot = parseJson(row.company_snapshot_json);
  return json({
    quotation: {
      ...decorate(row),
      currency: snapshot.currency || company?.currency || "AED",
      company: company || null,
    },
  });
};

const handleQuotationPatch = async (request, env, ctx, session, id) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const row = await quotationById(env, id);
  if (!row) return json({ error: "quotation_not_found" }, 404);
  const sets = [];
  const values = [];
  if (typeof body.quote_date === "string") {
    if (!validIsoDate(body.quote_date)) return json({ error: "invalid_quote_date" }, 400);
    sets.push("quote_date=?");
    values.push(body.quote_date);
  }
  for (const field of ["model", "year", "chassis"]) {
    if (typeof body[field] === "string" && body[field].trim()) {
      sets.push(`${field}=?`);
      values.push(body[field].trim().slice(0, field === "year" ? 20 : 120));
    }
  }
  if (body.amount !== undefined) {
    const cents = parseAmountToCents(body.amount);
    if (cents === null) return json({ error: "invalid_amount" }, 400);
    sets.push("amount_cents=?", "amount_words=?");
    values.push(cents, amountWordsFromCents(cents));
  }
  if (typeof body.quote_number === "string") {
    const candidate = body.quote_number.trim().slice(0, 60);
    if (candidate && candidate !== row.quote_number) {
      sets.push("quote_number=?");
      values.push(candidate);
    }
  }
  if (!sets.length) return json({ error: "no_fields_to_update" }, 400);
  try {
    await env.DB.prepare(`UPDATE quotations SET ${sets.join(", ")}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(...values, id).run();
  } catch {
    return json({ error: "quotation_number_already_exists" }, 409);
  }
  audit(env, ctx, session.name, "quotation.updated", "quotation", id, { fields: sets.map((s) => s.replace("=?", "")) });
  return handleQuotationGet(env, id);
};

const handleQuotationCancel = async (env, ctx, session, id) => {
  const result = await env.DB.prepare(
    "UPDATE quotations SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL"
  ).bind(id).run();
  if (!result.meta || result.meta.changes === 0) return json({ error: "quotation_not_found" }, 404);
  audit(env, ctx, session.name, "quotation.cancelled", "quotation", id, {});
  return json({ cancelled: true });
};

/* ============================== print ============================== */

const buildPrintFields = (row) => {
  const snapshot = parseJson(row.company_snapshot_json);
  /* Branding follows the live company profile, exactly like the letterhead: a logo that
     is replaced or removed must never leave a broken image on a reprint. The snapshot
     value is only used where no company row is joined (template preview). */
  const logoUrl = row.company_logo_key === undefined
    ? snapshot.logo_url || ""
    : logoUrlFor({ id: row.company_id, logo_key: row.company_logo_key }) || "";
  return {
    quote_number: row.quote_number,
    quote_date: formatDateDMY(row.quote_date),
    model: row.model,
    year: row.year,
    chassis: row.chassis,
    currency: snapshot.currency || "AED",
    amount: formatMoney(row.amount_cents),
    amount_words: row.amount_words,
    company_name: snapshot.legal_name || snapshot.name || row.company_name || "",
    company_address: snapshot.address || "",
    company_phone: snapshot.phone || "",
    company_email: snapshot.email || "",
    letterhead_url: snapshot.letterhead_url || LETTERHEAD_URL,
    /* printed wherever the template asks for {{logo_url}} — header mark or watermark */
    logo_url: logoUrl || TRANSPARENT_PIXEL,
    /* lets a template keep its own artwork when no logo has been uploaded */
    logo_state: logoUrl ? "has-logo" : "no-logo",
  };
};

const handlePrint = async (env, url, id) => {
  const row = await env.DB.prepare(
    "SELECT q.*, c.name AS company_name, c.logo_key AS company_logo_key FROM quotations q JOIN companies c ON c.id=q.company_id " +
    "WHERE q.id=? AND q.deleted_at IS NULL"
  ).bind(id).first();
  if (!row) return json({ error: "quotation_not_found" }, 404);
  const autoprint = ["1", "true", "yes"].includes((url.searchParams.get("print") || "").toLowerCase());
  let html = renderQuote(row.template_html_snapshot || DEFAULT_TEMPLATE, buildPrintFields(row));
  if (autoprint) {
    const tag = `<script>${AUTOPRINT_SCRIPT}</script>`;
    html = html.includes("</body>") ? html.replace("</body>", tag + "</body>") : html + tag;
  }
  const scriptSrc = autoprint ? `'sha256-${await scriptHash()}'` : "'none'";
  const csp = [
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    "font-src 'self' data:",
    `script-src ${scriptSrc}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
    },
  });
};

/* ============================== export ============================== */

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

const handleCsvExport = async (env, url) => {
  const companyId = url.searchParams.get("company_id");
  if (!companyId) return json({ error: "company_id_required" }, 400);
  const company = await env.DB.prepare("SELECT name,currency FROM companies WHERE id=?").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  const rows = await env.DB.prepare(
    "SELECT quote_number,quote_date,model,year,chassis,amount_cents,amount_words,created_at " +
    "FROM quotations WHERE company_id=? AND deleted_at IS NULL ORDER BY quote_date DESC, created_at DESC"
  ).bind(companyId).all();
  const lines = ["quotation,date,model,year,chassis,amount,currency,amount_words,created"];
  for (const row of rows.results || []) {
    lines.push([
      row.quote_number, row.quote_date, row.model, row.year, row.chassis,
      (Number(row.amount_cents) / 100).toFixed(2), company.currency, row.amount_words, row.created_at,
    ].map(csvCell).join(","));
  }
  return new Response(lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="quotations-${todayIso()}.csv"`,
      "cache-control": "no-store",
    },
  });
};

/* ============================== router ============================== */

const KNOWN_RESOURCES = new Set(["companies", "templates", "quotations", "export", "auth"]);

const handleHealth = async (env) => {
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ ok: row?.ok === 1, service: "challenger-quotation-platform", version: "1.0.0" });
  } catch {
    return json({ ok: false, error: "database_unavailable" }, 503);
  }
};

async function route(request, env, ctx, url) {
  const method = request.method;
  const path = url.pathname;

  if (path === "/api/health" && method === "GET") return handleHealth(env);
  if (path === "/api/auth/status" && method === "GET") return authStatus(request, env);
  if (path === "/api/setup" && method === "POST") return handleSetup(request, env, ctx);
  if (path === "/api/auth/login" && method === "POST") return handleLogin(request, env);
  if (path === "/api/auth/logout" && method === "POST") return handleLogout(request);

  const [resource, id, action, child, tail] = path.slice("/api/".length).split("/").filter(Boolean);

  if (!KNOWN_RESOURCES.has(resource)) return json({ error: "not_found", path }, 404);

  /* A logo is public brand artwork. The print previews run in sandboxed iframes with an
     opaque origin, so a <img> request from them carries no SameSite cookie at all. */
  if (resource === "companies" && id && action === "logo" && !child && method === "GET") {
    return handleCompanyLogoGet(env, id);
  }

  const session = await currentSession(request, env);
  if (!session) return json({ error: "unauthorized" }, 401);

  if (path === "/api/auth/passcode" && method === "POST") return handleRotatePasscode(request, env, ctx, session);

  if (resource === "companies") {
    if (!id && method === "GET") return handleCompanyList(env);
    if (!id && method === "POST") return handleCompanyCreate(request, env, ctx, session);
    if (id && !action && method === "PATCH") return handleCompanyPatch(request, env, ctx, session, id);
    if (id && !action && method === "DELETE") return handleCompanyDeactivate(env, ctx, session, id);
    if (id && action === "logo" && !child) {
      if (method === "POST") return handleCompanyLogoUpload(request, env, ctx, session, id);
      if (method === "DELETE") return handleCompanyLogoDelete(env, ctx, session, id);
    }
    if (id && action === "templates" && !child) {
      if (method === "GET") return handleTemplateList(env, id);
      if (method === "POST") return handleTemplateSave(request, env, ctx, session, id);
    }
    if (id && action === "templates" && child === "preview" && !tail && method === "POST") {
      return handleTemplatePreviewDraft(request, env, id);
    }
    if (id && action === "templates" && child && !tail) {
      if (method === "GET") return handleTemplateGet(env, id, child);
      if (method === "DELETE") return handleTemplateDelete(env, ctx, session, id, child);
    }
    if (id && action === "templates" && child && tail === "preview" && method === "GET") {
      return handleTemplatePreviewVersion(env, id, child);
    }
  }

  if (resource === "templates" && id && action === "activate" && method === "POST") {
    return handleTemplateActivate(env, ctx, session, id);
  }

  if (resource === "quotations") {
    if (!id && method === "GET") return handleQuotationList(env, url);
    if (!id && method === "POST") return handleQuotationCreate(request, env, ctx, session);
    if (id === "next-number" && method === "GET") return handleNextNumber(env, url);
    if (id && !action && method === "GET") return handleQuotationGet(env, id);
    if (id && !action && method === "PATCH") return handleQuotationPatch(request, env, ctx, session, id);
    if (id && !action && method === "DELETE") return handleQuotationCancel(env, ctx, session, id);
    if (id && action === "print" && method === "GET") return handlePrint(env, url, id);
  }

  if (resource === "export" && id === "quotations.csv" && method === "GET") return handleCsvExport(env, url);

  return json({ error: "not_found", path }, 404);
}

export default {
  /**
   * @param {Request} request
   * @param {{DB:D1Database,ASSETS?:R2Bucket,SESSION_HOURS?:string}} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "GET, POST, PATCH, DELETE, OPTIONS" } });
    try {
      return await route(request, env, ctx, url);
    } catch (error) {
      if (error && error.status) return json({ error: error.code || "error", ...(error.details || {}) }, error.status);
      console.error(JSON.stringify({
        event: "request_failed",
        path: url.pathname,
        method: request.method,
        message: error?.message || String(error),
        stack: String(error?.stack || "").split("\n").slice(0, 4),
      }));
      return json({ error: "internal_error" }, 500);
    }
  },
};



