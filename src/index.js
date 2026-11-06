import DEFAULT_TEMPLATE from "../templates/default-quotation.html";
import DEFAULT_SALES_AGREEMENT from "../templates/default-sales-agreement.html";
import DEFAULT_PURCHASE_AGREEMENT from "../templates/default-purchase-agreement.html";
import { renderSharePage, renderShareMissing, SHARE_PRINT_SCRIPT } from "./share-page.js";
import { renderAgreementSharePage, renderAgreementShareMissing } from "./agreement-share.js";

/* --------------------------------------------------------------------------
   Challenger Quotation Platform - Cloudflare Worker
   - Auth: one shared passcode (settings table) + stateless HMAC session cookie
   - Data: D1 (companies, templates, quote_sequences, quotations, agreement_*,
     audit_events)
   - Print: hydrated HTML snapshot + A4 bilingual sheet, printed by the browser
   -------------------------------------------------------------------------- */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SESSION_COOKIE = "q_session";
const DEFAULT_SESSION_HOURS = 12;
const PBKDF2_ITERATIONS = 100000;
const MIN_PASSCODE_LENGTH = 6;
const MAX_PASSCODE_LENGTH = 200;
const MAX_TEMPLATE_BYTES = 200000;
/* The comment row on the A4 sheet is 12.5 mm tall, so the text is capped well below it. */
const MAX_QUOTATION_COMMENTS = 300;
const LETTERHEAD_URL = "/letterhead_background.png";
const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_PREFIX = "logos/";
/* A signed copy is a phone photo of a sheet: 4 MB covers a 12 Mpx JPEG at full quality. */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
/* A PDF straight from a scanning app carries the same page plus its text layer, so it
   comes through the same door with a bigger ceiling. */
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const SCAN_PREFIX = "scans/";
/* The WhatsApp hand-off default, stored in the settings table like the passcode row:
   "file" attaches the scan through the OS share sheet, "link" sends /s/<token>. */
const SHARE_MODE_KEY = "quotation_share_mode";
const SHARE_MODES = ["file", "link"];
const DEFAULT_SHARE_MODE = "file";
/* 24 random bytes -> 32 base64url characters: far too many to guess, short enough to paste. */
const SHARE_TOKEN_BYTES = 24;
const QUOTATION_STATUSES = ["issued", "completed"];
/* ---------------------------- vehicle agreements ---------------------------- */
/* One table, two kinds. The kind decides the number prefix, the default template
   and the wording, never the shape of the record. */
const AGREEMENT_KINDS = ["sale", "purchase"];
const AGREEMENT_KIND_LABELS = { sale: "Sale", purchase: "Purchase" };
/* SA-2026-00001 / PA-2026-00001: one counter per company, kind and year. */
const AGREEMENT_PREFIX = { sale: "SA-", purchase: "PA-" };
const AGREEMENT_STATUSES = ["issued", "completed"];
const DEFAULT_AGREEMENT_TEMPLATES = {
  sale: DEFAULT_SALES_AGREEMENT,
  purchase: DEFAULT_PURCHASE_AGREEMENT,
};
/* The free-text columns and their ceilings, in one place so create and patch agree. */
const AGREEMENT_TEXT_LIMITS = {
  vehicle_model: 120, vehicle_year: 20, vehicle_chassis: 120, vehicle_plate: 40,
  vehicle_color: 40, vehicle_odometer: 40, vehicle_registration_place: 80,
  seller_name: 120, seller_id_number: 60, seller_phone: 40, seller_address: 200,
  buyer_name: 120, buyer_id_number: 60, buyer_phone: 40, buyer_address: 200,
  intermediary_name: 120, intermediary_phone: 40, intermediary_commission: 120,
};
/* Required on every agreement; the rest may stay blank and simply print empty. */
const AGREEMENT_REQUIRED_TEXT = ["vehicle_model", "vehicle_year", "vehicle_chassis", "seller_name", "buyer_name"];
const MAX_AGREEMENT_NOTES = 600;
/* Signed pages live beside the quotation scans but under their own prefix, so a sweep
   of "scans/agreements/" can never touch a quotation scan. */
const AGREEMENT_SCAN_PREFIX = "scans/agreements/";
const TEMPLATE_KINDS = ["quotation", ...AGREEMENT_KINDS];

/** Human label for a sheet kind: "Quotation", "Sale agreement", "Purchase agreement". */
const templateKindLabel = (kind) =>
  kind === "quotation" ? "Quotation" : `${AGREEMENT_KIND_LABELS[kind] || "Vehicle"} agreement`;

/** The bundled sheet for a kind - what prints until the company publishes its own. */
const builtinSheet = (kind) =>
  kind === "quotation" ? DEFAULT_TEMPLATE : DEFAULT_AGREEMENT_TEMPLATES[kind] || DEFAULT_SALES_AGREEMENT;

/* A template may print {{logo_url}} even when the company has no logo. Pointing at a
   1x1 transparent GIF keeps the sheet clean instead of showing a broken-image icon. */
const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
/** Accepted image formats — the declared type must also match the file signature. */
const IMAGE_TYPES = [
  { mime: "image/png", ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/webp", ext: "webp",
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];
/** A signed page may also arrive as a PDF from a scanning app ("%PDF"). */
const PDF_TYPE = {
  mime: "application/pdf",
  ext: "pdf",
  test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
};
/** Everything the signed-copy slot accepts: the desk's own scans or an upload. */
const SCAN_TYPES = [...IMAGE_TYPES, PDF_TYPE];
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

/**
 * Validate the single-use Turnstile token on the server. A browser-side widget
 * alone is not a security boundary, so missing secrets, failed checks, unexpected
 * hostnames, and unexpected actions all fail closed.
 */
const verifyTurnstile = async (request, env, token, expectedAction) => {
  const secret = typeof env.TURNSTILE_SECRET === "string" ? env.TURNSTILE_SECRET.trim() : "";
  if (!secret || typeof token !== "string" || !token.trim()) return false;
  const form = new URLSearchParams({ secret, response: token });
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result?.success === true
      && result.hostname === "desk.luxoritpro.com"
      && result.action === expectedAction;
  } catch {
    return false;
  }
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

/** Read-only view of the retained activity history. Details stay structured for the UI. */
const handleAuditList = async (env, url) => {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 500);
  const offset = Math.min(Math.max(Math.floor(Number(url.searchParams.get("offset")) || 0), 0), 1000000);
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      "SELECT id,actor,action,entity,entity_id,details_json,created_at " +
      "FROM audit_events ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?"
    ).bind(limit, offset).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events").first(),
  ]);
  return json({
    events: (rows.results || []).map((row) => {
      const { details_json: detailsJson, ...rest } = row;
      return { ...rest, details: parseJson(detailsJson) };
    }),
    total: Number(count?.n || 0),
    limit,
    offset,
  });
};

let scriptHashCache = null;
const scriptHash = async () => {
  if (!scriptHashCache) scriptHashCache = b64url(await crypto.subtle.digest("SHA-256", enc.encode(AUTOPRINT_SCRIPT)));
  return scriptHashCache;
};

/* The customer page carries exactly one inline script (its Print button). Pinning it
   by hash keeps the page JavaScript-free apart from that one handler: no nonce state,
   nothing to leak, and a change to the script invalidates the policy loudly. */
let shareScriptHashCache = null;
const shareScriptHash = async () => {
  if (!shareScriptHashCache) {
    shareScriptHashCache = b64url(await crypto.subtle.digest("SHA-256", enc.encode(SHARE_PRINT_SCRIPT)));
  }
  return shareScriptHashCache;
};

const authStatus = async (request, env) => {
  const auth = await readAuth(env);
  const session = auth ? await currentSession(request, env) : null;
  return json({
    setup: !!auth,
    signed_in: !!session,
    name: session?.name || null,
    session_hours: sessionHours(env),
    turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
    /* the passcode is global (one settings row), so this timestamp is global too */
    passcode_updated_at: auth?.updated_at || null,
  });
};

const handleSetup = async (request, env, ctx) => {
  if (await readAuth(env)) return json({ error: "already_configured" }, 409);
  const body = await bodyJson(request);
  if (!(await verifyTurnstile(request, env, body?.turnstile_token, "business_desk_setup"))) {
    return json({ error: "security_check_failed" }, 403);
  }
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
  if (!(await verifyTurnstile(request, env, body?.turnstile_token, "business_desk_login"))) {
    return json({ error: "security_check_failed" }, 403);
  }
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

/* ============================== settings ============================== */

/**
 * The WhatsApp hand-off default. Stored as a plain settings row so it survives a
 * redeploy without a new binding, and read back with the session settings.
 */
const readShareMode = async (env) => {
  const value = await settingsRead(env, SHARE_MODE_KEY);
  return SHARE_MODES.includes(value) ? value : DEFAULT_SHARE_MODE;
};

const settingsPayload = async (env) => ({
  share_mode: await readShareMode(env),
  session_hours: sessionHours(env),
  /* the passcode is global (one settings row), so this timestamp is global too */
  passcode_updated_at: (await readAuth(env))?.updated_at || null,
});

const handleSettingsGet = async (env) => json({ settings: await settingsPayload(env) });

const handleSettingsPatch = async (request, env, ctx, session) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  if (body.share_mode === undefined) return json({ error: "no_fields_to_update" }, 400);
  if (!SHARE_MODES.includes(body.share_mode)) {
    return json({ error: "invalid_share_mode", accepted: SHARE_MODES }, 400);
  }
  await settingsWrite(env, SHARE_MODE_KEY, body.share_mode);
  audit(env, ctx, session.name, "settings.updated", "settings", SHARE_MODE_KEY, { share_mode: body.share_mode });
  return json({ settings: await settingsPayload(env) });
};

/* ============================ companies ============================ */

const COMPANY_COLUMNS =
  "id,name,slug,legal_name,legal_name_ar,phone,email,address,quotation_prefix,currency,logo_key,letterhead_key,font_name,active,created_at";

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
    "INSERT INTO companies(id,name,slug,legal_name,legal_name_ar,phone,email,address,quotation_prefix,currency) VALUES(?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    id, "Challenger Cars", "challenger-cars",
    "CHALLENGER USED CARS EXHB. LLC",
    "شالنجر للسيارات المستعملة ذ.م.م.",
    "", "", "", "QA-", "AED"
  ).run();
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
      "INSERT INTO companies(id,name,slug,legal_name,legal_name_ar,phone,email,address,quotation_prefix,currency) VALUES(?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      id, name, slug,
      text(body?.legal_name, 160) || name,
      text(body?.legal_name_ar, 160),
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
  ["name", 120], ["legal_name", 160], ["legal_name_ar", 160], ["phone", 40], ["email", 160],
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
  const row = await env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(companyId).first();
  audit(env, ctx, session.name, "company.updated", "company", companyId, {
    name: row?.name || "",
    fields: sets.map((s) => s.replace("=?", "")),
  });
  return json({ company: withLogoUrl(row) });
};

const handleCompanyDeactivate = async (env, ctx, session, companyId) => {
  const company = await env.DB.prepare("SELECT name FROM companies WHERE id=?").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  await env.DB.prepare("UPDATE companies SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(companyId).run();
  audit(env, ctx, session.name, "company.deactivated", "company", companyId, { name: company.name });
  return json({ deactivated: true });
};

/** Counts the records and R2 objects a permanent company deletion would remove. */
const handleCompanyDeleteSummary = async (env, companyId) => {
  const company = await env.DB.prepare(
    "SELECT id,name,slug,logo_key,letterhead_key,font_key FROM companies WHERE id=?"
  ).bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  const [quotes, templates, sequences, scans, agreements, agreementSequences, agreementScans] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM quotations WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM templates WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM quote_sequences WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM quotation_scans WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM agreements WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM agreement_sequences WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM agreement_scans WHERE company_id=?").bind(companyId).first(),
  ]);
  const companyAssets = [company.logo_key, company.letterhead_key, company.font_key].filter(Boolean);
  return json({
    company: { id: company.id, name: company.name, slug: company.slug },
    quotations: Number(quotes?.n || 0),
    agreements: Number(agreements?.n || 0),
    templates: Number(templates?.n || 0),
    numbering_sequences: Number(sequences?.n || 0) + Number(agreementSequences?.n || 0),
    signed_scans: Number(scans?.n || 0) + Number(agreementScans?.n || 0),
    company_files: new Set(companyAssets).size,
    audit_events: "retained",
  });
};

/**
 * Permanently removes one company and all company-owned records.
 * Audit events are deliberately retained, including the deletion event itself.
 */
const handleCompanyPermanentDelete = async (request, env, session, companyId) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const company = await env.DB.prepare(
    "SELECT id,name,slug,logo_key,letterhead_key,font_key FROM companies WHERE id=?"
  ).bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  if (text(body.confirm_name, 120) !== company.name) {
    return json({ error: "company_confirmation_required" }, 409);
  }

  const [quoteCount, templateCount, sequenceCount, scanRows, agreementCount, agreementSequenceCount, agreementScanRows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM quotations WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM templates WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM quote_sequences WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT r2_key FROM quotation_scans WHERE company_id=?").bind(companyId).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM agreements WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM agreement_sequences WHERE company_id=?").bind(companyId).first(),
    env.DB.prepare("SELECT r2_key FROM agreement_scans WHERE company_id=?").bind(companyId).all(),
  ]);
  const companyAssetKeys = [...new Set([
    company.logo_key, company.letterhead_key, company.font_key,
  ].filter(Boolean))];
  const scanAssetKeys = [...new Set([
    ...(scanRows.results || []).map((row) => row.r2_key),
    ...(agreementScanRows.results || []).map((row) => row.r2_key),
  ].filter(Boolean))];
  const assetKeys = [...new Set([...companyAssetKeys, ...scanAssetKeys])];
  if (assetKeys.length && !env.ASSETS) return json({ error: "storage_unavailable" }, 503);

  const quotationsDeleted = Number(quoteCount?.n || 0);
  const templatesDeleted = Number(templateCount?.n || 0);
  const sequencesDeleted = Number(sequenceCount?.n || 0) + Number(agreementSequenceCount?.n || 0);
  const agreementsDeleted = Number(agreementCount?.n || 0);
  const scansDeleted = (scanRows.results || []).length + (agreementScanRows.results || []).length;
  const auditId = crypto.randomUUID();
  const details = {
    name: company.name,
    slug: company.slug,
    quotations_deleted: quotationsDeleted,
    agreements_deleted: agreementsDeleted,
    templates_deleted: templatesDeleted,
    numbering_sequences_deleted: sequencesDeleted,
    signed_scans_deleted: scansDeleted,
    company_files_deleted: companyAssetKeys.length,
    audit_events_retained: true,
  };

  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO audit_events(id,actor,action,entity,entity_id,details_json) " +
      "SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM companies WHERE id=?)"
    ).bind(auditId, String(session.name || "shared"), "company.permanently_deleted", "company", companyId, JSON.stringify(details), companyId),
    env.DB.prepare(
      "DELETE FROM quotation_scans WHERE company_id=? " +
      "AND EXISTS (SELECT 1 FROM companies WHERE id=?)"
    ).bind(companyId, companyId),
    env.DB.prepare(
      "DELETE FROM agreement_scans WHERE company_id=? " +
      "AND EXISTS (SELECT 1 FROM companies WHERE id=?)"
    ).bind(companyId, companyId),
    env.DB.prepare(
      "DELETE FROM quotations WHERE company_id=? " +
      "AND EXISTS (SELECT 1 FROM companies WHERE id=?)"
    ).bind(companyId, companyId),
    env.DB.prepare(
      "DELETE FROM agreements WHERE company_id=? " +
      "AND EXISTS (SELECT 1 FROM companies WHERE id=?)"
    ).bind(companyId, companyId),
    env.DB.prepare(
      "DELETE FROM templates WHERE company_id=? " +
      "AND EXISTS (SELECT 1 FROM companies WHERE id=?)"
    ).bind(companyId, companyId),
    env.DB.prepare(
      "DELETE FROM quote_sequences WHERE company_id=? " +
      "AND EXISTS (SELECT 1 FROM companies WHERE id=?)"
    ).bind(companyId, companyId),
    env.DB.prepare(
      "DELETE FROM agreement_sequences WHERE company_id=? " +
      "AND EXISTS (SELECT 1 FROM companies WHERE id=?)"
    ).bind(companyId, companyId),
    env.DB.prepare("DELETE FROM companies WHERE id=?").bind(companyId),
  ]);
  if (!results[8]?.meta || results[8].meta.changes === 0) {
    return json({ error: "company_not_found" }, 404);
  }

  let assetCleanupFailed = 0;
  let failedAssetKeys = [];
  if (env.ASSETS && assetKeys.length) {
    const outcomes = await Promise.allSettled(assetKeys.map((key) => env.ASSETS.delete(key)));
    failedAssetKeys = outcomes.flatMap((outcome, index) =>
      outcome.status === "rejected" ? [assetKeys[index]] : []
    );
    assetCleanupFailed = failedAssetKeys.length;
    if (assetCleanupFailed) {
      try {
        await env.DB.prepare("UPDATE audit_events SET details_json=? WHERE id=?")
          .bind(JSON.stringify({
            ...details,
            asset_cleanup_failed: assetCleanupFailed,
            asset_cleanup_failed_keys: failedAssetKeys,
          }), auditId).run();
      } catch { /* the immediate API response still reports the failed cleanup */ }
    }
  }
  return json({
    deleted: true,
    company: { id: companyId, name: company.name },
    quotations_deleted: quotationsDeleted,
    agreements_deleted: agreementsDeleted,
    templates_deleted: templatesDeleted,
    numbering_sequences_deleted: sequencesDeleted,
    signed_scans_deleted: scansDeleted,
    asset_cleanup_failed: assetCleanupFailed,
    audit_events_retained: true,
  });
};

/* ------------------------------ company logo ------------------------------ */

/**
 * Logo and scan bytes live in R2 (binding ASSETS), never in D1: the row only keeps the key.
 * The signature check runs on the bytes themselves, so a mislabelled upload can
 * neither sneak a script through nor be served with a type the browser sniffs.
 */
const sniffImageType = (bytes, declared) => {
  const match = IMAGE_TYPES.find((type) => type.test(bytes));
  if (!match) return null;
  if (declared && declared !== match.mime) return null;
  return match;
};

/** The same check for the signed-copy slot, which also takes a PDF. */
const sniffScanType = (bytes, declared) => {
  const match = SCAN_TYPES.find((type) => type.test(bytes));
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
  const type = sniffImageType(bytes, file.type || "");
  if (!type) return json({ error: "unsupported_image_type", accepted: IMAGE_TYPES.map((t) => t.mime) }, 415);
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
    "SELECT html FROM templates WHERE company_id=? AND kind='quotation' AND active=1 ORDER BY version DESC LIMIT 1"
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

const templateKindOf = (value) => {
  const kind = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TEMPLATE_KINDS.includes(kind) ? kind : "quotation";
};

/* The settings studio lists one kind at a time: quotation, sale agreement or purchase
   agreement. Versions, live flags and numbering are per kind. */
const handleTemplateList = async (env, companyId, url) => {
  const kind = templateKindOf(url?.searchParams?.get("kind"));
  const rows = await env.DB.prepare(
    "SELECT id,name,kind,version,active,created_at,length(html) AS bytes FROM templates " +
    "WHERE company_id=? AND kind=? ORDER BY version DESC"
  ).bind(companyId, kind).all();
  return json({ kind, templates: rows.results ?? [] });
};

/**
 * The sheet that is bundled for a kind - what prints until the company publishes its
 * own. The studio loads it into the editor so an agreement sheet can be started from
 * the built-in page instead of a blank textarea.
 */
const handleTemplateDefault = async (env, companyId, url) => {
  const company = await env.DB.prepare("SELECT id FROM companies WHERE id=?").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  const kind = templateKindOf(url?.searchParams?.get("kind"));
  return json({ kind, html: builtinSheet(kind), label: templateKindLabel(kind) });
};

const handleTemplateGet = async (env, companyId, templateId) => {
  const row = await env.DB.prepare(
    "SELECT id,company_id,name,kind,version,active,html,created_at FROM templates WHERE id=? AND company_id=?"
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
  /* Versions count per kind: publishing a sale agreement never pushes the quotation
     template to v7, and each kind keeps its own live version. */
  const kind = templateKindOf(body?.kind);
  const versionRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(version),0)+1 AS next FROM templates WHERE company_id=? AND kind=?"
  ).bind(companyId, kind).first();
  const version = Number(versionRow?.next) || 1;
  const id = crypto.randomUUID();
  const name = text(body?.name, 100) || `Version ${version}`;
  const activate = body?.activate !== false;
  const statements = [];
  if (activate) statements.push(
    env.DB.prepare("UPDATE templates SET active=0 WHERE company_id=? AND kind=?").bind(companyId, kind)
  );
  statements.push(
    env.DB.prepare("INSERT INTO templates(id,company_id,name,kind,version,html,active) VALUES(?,?,?,?,?,?,?)")
      .bind(id, companyId, name, kind, version, html, activate ? 1 : 0)
  );
  await env.DB.batch(statements);
  audit(env, ctx, session.name, "template.saved", "template", id, { company_id: companyId, kind, version, active: activate });
  return json({ template: { id, name, kind, version, active: activate } }, 201);
};

const handleTemplateActivate = async (env, ctx, session, templateId) => {
  const row = await env.DB.prepare("SELECT id,company_id,kind FROM templates WHERE id=?").bind(templateId).first();
  if (!row) return json({ error: "template_not_found" }, 404);
  await env.DB.batch([
    env.DB.prepare("UPDATE templates SET active=0 WHERE company_id=? AND kind=?").bind(row.company_id, row.kind),
    env.DB.prepare("UPDATE templates SET active=1 WHERE id=?").bind(templateId),
  ]);
  audit(env, ctx, session.name, "template.activated", "template", templateId, { company_id: row.company_id, kind: row.kind });
  return json({ activated: templateId });
};

/** Sample vehicle used to proof a template before it goes live. */
const PREVIEW_SAMPLE = {
  model: "AUDI A8", year: "2012", chassis: "WAUZZZ4H0DN000001", cents: 24850000,
  comments: "One owner, full service history, 2 keys.",
};

const companyRow = async (env, companyId) =>
  env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(companyId).first();

/**
 * Renders a template through the same path as /print (snapshot fields + renderQuote),
 * so the settings preview cannot drift from the printed sheet. Uses sample data and the
 * next live number - nothing is written and no serial is burned.
 */
const renderTemplatePreview = async (env, company, html, kind = "quotation") =>
  kind === "quotation"
    ? renderQuotationTemplatePreview(env, company, html)
    : renderAgreementTemplatePreview(env, company, html, kind);

/** The company block a preview stamps on the sheet - the keys a create-time snapshot holds. */
const previewCompanySnapshot = (company) => JSON.stringify({
  name: company.name,
  legal_name: company.legal_name,
  legal_name_ar: company.legal_name_ar,
  address: company.address,
  phone: company.phone,
  email: company.email,
  currency: company.currency,
  letterhead_url: LETTERHEAD_URL,
  logo_url: logoUrlFor(company),
});

/** Sample parties used to proof an agreement sheet before it goes live. */
const PREVIEW_AGREEMENT = {
  plate: "A 48213", color: "Ibis white", odometer: "86,400 km", registration_place: "Dubai",
  seller_name: "Gulf Motors Trading LLC", seller_id_number: "1054721",
  seller_phone: "+971 50 123 4567", seller_address: "Al Quoz 1, Dubai",
  buyer_name: "Sunrise Trading LLC", buyer_id_number: "8842130",
  buyer_phone: "+971 55 765 4321", buyer_address: "Deira, Dubai",
  intermediary_name: "Challenger Motors LLC", intermediary_phone: "+971 4 000 1111",
  intermediary_commission: "AED 2,000 from the seller",
  full_cents: 18500000, paid_cents: 2500000,
  notes: "Sold as seen, two keys, service book included.",
};

const renderQuotationTemplatePreview = async (env, company, html) => {
  const next = await peekNextNumber(env, company, todayIso());
  const row = {
    quote_number: next.quote_number,
    quote_date: todayIso(),
    model: PREVIEW_SAMPLE.model,
    year: PREVIEW_SAMPLE.year,
    chassis: PREVIEW_SAMPLE.chassis,
    comments: PREVIEW_SAMPLE.comments,
    amount_cents: PREVIEW_SAMPLE.cents,
    amount_words: amountWordsFromCents(PREVIEW_SAMPLE.cents),
    company_name: company.name,
    company_snapshot_json: previewCompanySnapshot(company),
  };
  return {
    kind: "quotation",
    html: renderQuote(html || DEFAULT_TEMPLATE, buildPrintFields(row)),
    sample: { quote_number: next.quote_number, date: row.quote_date, amount_cents: row.amount_cents },
  };
};

/**
 * Agreement sheets print their own tokens (parties, plate, three money figures), so a
 * quotation sample would leave them blank. Same mapping as /print, sample parties, and
 * the kind's next number - still nothing written and no serial burned.
 */
const renderAgreementTemplatePreview = async (env, company, html, kind) => {
  const next = await peekNextAgreementNumber(env, company.id, kind, todayIso());
  const row = {
    kind,
    agreement_number: next.agreement_number,
    agreement_date: todayIso(),
    vehicle_model: PREVIEW_SAMPLE.model,
    vehicle_year: PREVIEW_SAMPLE.year,
    vehicle_chassis: PREVIEW_SAMPLE.chassis,
    vehicle_plate: PREVIEW_AGREEMENT.plate,
    vehicle_color: PREVIEW_AGREEMENT.color,
    vehicle_odometer: PREVIEW_AGREEMENT.odometer,
    vehicle_registration_place: PREVIEW_AGREEMENT.registration_place,
    seller_name: PREVIEW_AGREEMENT.seller_name,
    seller_id_number: PREVIEW_AGREEMENT.seller_id_number,
    seller_phone: PREVIEW_AGREEMENT.seller_phone,
    seller_address: PREVIEW_AGREEMENT.seller_address,
    buyer_name: PREVIEW_AGREEMENT.buyer_name,
    buyer_id_number: PREVIEW_AGREEMENT.buyer_id_number,
    buyer_phone: PREVIEW_AGREEMENT.buyer_phone,
    buyer_address: PREVIEW_AGREEMENT.buyer_address,
    intermediary_name: PREVIEW_AGREEMENT.intermediary_name,
    intermediary_phone: PREVIEW_AGREEMENT.intermediary_phone,
    intermediary_commission: PREVIEW_AGREEMENT.intermediary_commission,
    /* the same note the worksheet's sample vehicle carries, so notes_state can be proofed */
    notes: PREVIEW_AGREEMENT.notes,
    full_amount_cents: PREVIEW_AGREEMENT.full_cents,
    full_amount_words: amountWordsFromCents(PREVIEW_AGREEMENT.full_cents),
    paid_amount_cents: PREVIEW_AGREEMENT.paid_cents,
    paid_amount_words: amountWordsFromCents(PREVIEW_AGREEMENT.paid_cents),
    company_name: company.name,
    company_snapshot_json: previewCompanySnapshot(company),
  };
  return {
    kind,
    html: renderQuote(html || builtinSheet(kind), buildAgreementPrintFields(row)),
    sample: {
      agreement_number: next.agreement_number,
      kind,
      kind_label: templateKindLabel(kind),
      date: row.agreement_date,
      full_amount_cents: row.full_amount_cents,
      paid_amount_cents: row.paid_amount_cents,
    },
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
  /* the kind picks the sample record and the token set the draft is proofed against */
  return json(await renderTemplatePreview(env, company, html, templateKindOf(body?.kind)));
};

/** Preview for a stored version. */
const handleTemplatePreviewVersion = async (env, companyId, templateId) => {
  const row = await env.DB.prepare("SELECT html,kind FROM templates WHERE id=? AND company_id=?")
    .bind(templateId, companyId).first();
  if (!row) return json({ error: "template_not_found" }, 404);
  const company = await companyRow(env, companyId);
  if (!company) return json({ error: "company_not_found" }, 404);
  return json(await renderTemplatePreview(env, company, row.html, templateKindOf(row.kind)));
};

/**
 * Deletes one stored version. The live version is protected; quotations keep their own
 * HTML snapshot, so records are detached (template_id -> NULL) instead of blocking.
 */
const handleTemplateDelete = async (env, ctx, session, companyId, templateId) => {
  const row = await env.DB.prepare("SELECT id,version,active,kind FROM templates WHERE id=? AND company_id=?")
    .bind(templateId, companyId).first();
  if (!row) return json({ error: "template_not_found" }, 404);
  if (row.active) return json({ error: "template_is_active" }, 409);
  /* Records keep their own HTML snapshot, so deleting a version detaches them instead
     of blocking. Agreements are only detachable from agreement templates. */
  const inUse = row.kind === "quotation"
    ? await env.DB.prepare("SELECT COUNT(*) AS n FROM quotations WHERE template_id=?").bind(templateId).first()
    : await env.DB.prepare("SELECT COUNT(*) AS n FROM agreements WHERE template_id=?").bind(templateId).first();
  const detached = Number(inUse?.n || 0);
  const statements = [];
  if (row.kind === "quotation") {
    statements.push(env.DB.prepare("UPDATE quotations SET template_id=NULL WHERE template_id=?").bind(templateId));
  } else {
    statements.push(env.DB.prepare("UPDATE agreements SET template_id=NULL WHERE template_id=?").bind(templateId));
  }
  statements.push(env.DB.prepare("DELETE FROM templates WHERE id=? AND company_id=?").bind(templateId, companyId));
  await env.DB.batch(statements);
  audit(env, ctx, session.name, "template.deleted", "template", templateId, {
    company_id: companyId, kind: row.kind, version: row.version, detached_records: detached,
  });
  return json({ deleted: templateId, version: row.version, detached_records: detached });
};

/* =========================== quotations =========================== */

const decorate = (row) => ({
  ...row,
  amount: formatMoney(row.amount_cents),
  quote_date_text: formatDateDMY(row.quote_date),
});

/**
 * The comment row on the sheet is a single 12.5 mm line, so the note is stored as one line:
 * newlines and runs of spaces collapse instead of silently breaking the printed layout.
 */
const commentsField = (value) => text(value, MAX_QUOTATION_COMMENTS).replace(/\s+/g, " ").trim();

/**
 * The ledger lists by quotation number, newest first: the number is what people
 * quote on the phone and what the paper in their hand says, so a record issued
 * late (or back-dated) still lands where its serial says it belongs. `?sort=date`
 * keeps the old calendar order — and stays what the CSV export uses.
 */
const LEDGER_ORDER = {
  number: "q.quote_number DESC",
  date: "q.quote_date DESC, q.created_at DESC",
};

const handleQuotationList = async (env, url) => {
  const companyId = url.searchParams.get("company_id");
  if (!companyId) return json({ error: "company_id_required" }, 400);
  const search = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const sort = LEDGER_ORDER[url.searchParams.get("sort")] ? url.searchParams.get("sort") : "number";
  const view = ["active", "deleted"].includes(url.searchParams.get("view")) ? url.searchParams.get("view") : "active";
  const deletedClause = view === "deleted" ? "q.deleted_at IS NOT NULL" : "q.deleted_at IS NULL";

  const rows = await env.DB.prepare(
    "SELECT q.id,q.quote_number,q.quote_date,q.model,q.year,q.chassis,q.amount_cents,q.amount_words," +
    "q.status,q.completed_at,q.created_at,q.deleted_at,s.created_at AS scan_created_at FROM quotations q " +
    "LEFT JOIN quotation_scans s ON s.quotation_id=q.id " +
    `WHERE q.company_id=? AND ${deletedClause} ` +
    "AND (q.quote_number LIKE ? OR q.model LIKE ? OR q.chassis LIKE ? OR q.year LIKE ?) " +
    `ORDER BY ${LEDGER_ORDER[sort]} LIMIT ?`
  ).bind(companyId, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, limit).all();
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM quotations q WHERE q.company_id=? AND ${deletedClause}`
  ).bind(companyId).first();

  return json({
    quotations: (rows.results || []).map((row) => {
      const { scan_created_at: scannedAt, ...rest } = row;
      return {
        ...decorate(rest),
        status: rest.status === "completed" ? "completed" : "issued",
        completed_at: rest.completed_at || null,
        deleted_at: rest.deleted_at || null,
        signed: Boolean(scannedAt),
        has_scan: Boolean(scannedAt),
      };
    }),
    total: Number(total?.n || 0),
    sort,
    view,
  });
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
  const comments = commentsField(body.comments);
  if (!model || !year || !chassis) return json({ error: "model_year_and_chassis_required" }, 400);
  const cents = parseAmountToCents(body.amount);
  if (cents === null) return json({ error: "invalid_amount" }, 400);
  const date = text(body.quote_date, 10) || todayIso();
  if (!validIsoDate(date)) return json({ error: "invalid_quote_date" }, 400);
  const company = await env.DB.prepare("SELECT * FROM companies WHERE id=? AND active=1").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  const period = date.slice(0, 4);
  const prefix = company.quotation_prefix || "QA-";
  // New quotations always receive a server-allocated number. Never trust a
  // client-supplied quote_number, even if a caller bypasses the read-only UI.
  let quoteNumber = "";
  for (let attempt = 0; attempt < 8 && !quoteNumber; attempt++) {
    const serial = await allocateSerial(env, company.id, period);
    const candidate = `${prefix}${period}-${String(serial).padStart(5, "0")}`;
    const taken = await env.DB.prepare("SELECT 1 AS taken FROM quotations WHERE company_id=? AND quote_number=?")
      .bind(company.id, candidate).first();
    if (!taken) quoteNumber = candidate;
  }
  if (!quoteNumber) return json({ error: "numbering_exhausted" }, 409);
  const template = await env.DB.prepare(
    "SELECT id,html FROM templates WHERE company_id=? AND kind='quotation' AND active=1 ORDER BY version DESC LIMIT 1"
  ).bind(company.id).first();
  const amountWords = amountWordsFromCents(cents);
  const snapshot = {
    name: company.name, legal_name: company.legal_name, legal_name_ar: company.legal_name_ar,
    address: company.address,
    phone: company.phone, email: company.email, currency: company.currency,
    letterhead_url: company.letterhead_key ? `/api/companies/${company.id}/letterhead` : LETTERHEAD_URL,
    logo_url: logoUrlFor(company),
  };
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO quotations(id,company_id,template_id,quote_number,quote_date,model,year,chassis,comments," +
      "amount_cents,amount_words,template_html_snapshot,company_snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, company.id, template?.id || null, quoteNumber, date, model, year, chassis, comments, cents, amountWords,
      template?.html || DEFAULT_TEMPLATE, JSON.stringify(snapshot)).run();
  } catch {
    return json({ error: "quotation_number_already_exists" }, 409);
  }
  audit(env, ctx, session.name, "quotation.created", "quotation", id,
    { quote_number: quoteNumber, company_id: company.id, amount_cents: cents });
  return json({
    quotation: {
      id, company_id: company.id, quote_number: quoteNumber, quote_date: date,
      quote_date_text: formatDateDMY(date), model, year, chassis, comments,
      amount_cents: cents, amount: formatMoney(cents), amount_words: amountWords,
      currency: company.currency || "AED",
      status: "issued", completed_at: null, signed: false, has_scan: false, scan: null,
      share_path: null, share_token_created_at: null,
    },
  }, 201);
};

const QUOTATION_COLUMNS =
  "id,company_id,template_id,quote_number,quote_date,model,year,chassis,comments,amount_cents,amount_words," +
  "company_snapshot_json,status,completed_at,share_token,share_token_created_at,created_at,updated_at";

const quotationById = (env, id) =>
  env.DB.prepare(`SELECT ${QUOTATION_COLUMNS} FROM quotations WHERE id=? AND deleted_at IS NULL`).bind(id).first();

/**
 * The full record payload: decorated row + workflow block + live company.
 * The raw token never leaves the Worker — it travels as `share_path` only, so a
 * payload that lands in a screenshot still cannot hand out a link.
 */
const quotationPayload = async (env, id) => {
  const row = await quotationById(env, id);
  if (!row) return null;
  const [company, scan] = await Promise.all([
    env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(row.company_id).first(),
    scanRow(env, id),
  ]);
  const snapshot = parseJson(row.company_snapshot_json);
  const rest = { ...row };
  /* stripped, not renamed: the token is a credential, `share_path` is the pointer */
  delete rest.share_token;
  return {
    quotation: {
      ...decorate(rest),
      ...workflowPayload(row, scan),
      currency: snapshot.currency || company?.currency || "AED",
      company: company || null,
    },
  };
};

const handleQuotationGet = async (env, id) => {
  const payload = await quotationPayload(env, id);
  return payload ? json(payload) : json({ error: "quotation_not_found" }, 404);
};


const handleQuotationPatch = async (request, env, ctx, session, id) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const row = await quotationById(env, id);
  if (!row) return json({ error: "quotation_not_found" }, 404);
  /* completed means "filed": the numbers on the paper cannot drift from the record */
  if (row.status === "completed") return json({ error: "quotation_completed" }, 409);
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
  /* unlike the vehicle fields, the comment may be cleared: an empty string removes the row's text */
  if (typeof body.comments === "string") {
    sets.push("comments=?");
    values.push(commentsField(body.comments));
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
  const updated = await env.DB.prepare("SELECT quote_number FROM quotations WHERE id=?").bind(id).first();
  audit(env, ctx, session.name, "quotation.updated", "quotation", id, {
    quote_number: updated?.quote_number || row.quote_number,
    previous_quote_number: updated?.quote_number !== row.quote_number ? row.quote_number : undefined,
    company_id: row.company_id,
    fields: sets.map((s) => s.replace("=?", "")),
  });
  return handleQuotationGet(env, id);
};

const handleQuotationCancel = async (env, ctx, session, id) => {
  const row = await quotationById(env, id);
  if (!row) return json({ error: "quotation_not_found" }, 404);
  /* a completed record is filed paperwork: reopening it is the way to change it */
  if (row.status === "completed") return json({ error: "quotation_completed" }, 409);
  const result = await env.DB.prepare(
    "UPDATE quotations SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL"
  ).bind(id).run();
  if (!result.meta || result.meta.changes === 0) return json({ error: "quotation_not_found" }, 404);
  audit(env, ctx, session.name, "quotation.cancelled", "quotation", id, {
    quote_number: row.quote_number, company_id: row.company_id,
  });
  return json({ cancelled: true });
};

/** Restore a soft-deleted quotation to the active ledger. */
const handleQuotationRestore = async (env, ctx, session, id) => {
  const row = await env.DB.prepare(
    "SELECT id,company_id,quote_number,deleted_at FROM quotations WHERE id=?"
  ).bind(id).first();
  if (!row) return json({ error: "quotation_not_found" }, 404);
  if (!row.deleted_at) return json({ error: "quotation_not_deleted" }, 409);
  const result = await env.DB.prepare(
    "UPDATE quotations SET deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NOT NULL"
  ).bind(id).run();
  if (!result.meta || result.meta.changes === 0) return json({ error: "quotation_not_deleted" }, 409);
  audit(env, ctx, session.name, "quotation.restored", "quotation", id, {
    quote_number: row.quote_number, company_id: row.company_id,
  });
  return json({ restored: true, id, quote_number: row.quote_number });
};

/** Permanently delete only after a quotation has been soft-deleted. */
const handleQuotationPermanentDelete = async (request, env, session, id) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const row = await env.DB.prepare(
    "SELECT id,company_id,quote_number,deleted_at FROM quotations WHERE id=?"
  ).bind(id).first();
  if (!row) return json({ error: "quotation_not_found" }, 404);
  if (!row.deleted_at) return json({ error: "quotation_must_be_deleted_first" }, 409);
  if (text(body.confirm_number, 60) !== row.quote_number) {
    return json({ error: "quotation_confirmation_required" }, 409);
  }
  const scan = await env.DB.prepare("SELECT r2_key FROM quotation_scans WHERE quotation_id=?")
    .bind(id).first();
  if (scan?.r2_key && !env.ASSETS) return json({ error: "storage_unavailable" }, 503);

  const auditId = crypto.randomUUID();
  const details = {
    quote_number: row.quote_number,
    company_id: row.company_id,
    signed_scan_deleted: Boolean(scan?.r2_key),
    permanent: true,
  };
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO audit_events(id,actor,action,entity,entity_id,details_json) " +
      "SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM quotations WHERE id=? AND deleted_at IS NOT NULL)"
    ).bind(auditId, String(session.name || "shared"), "quotation.permanently_deleted", "quotation", id, JSON.stringify(details), id),
    env.DB.prepare(
      "DELETE FROM quotation_scans WHERE quotation_id=? " +
      "AND EXISTS (SELECT 1 FROM quotations WHERE id=? AND deleted_at IS NOT NULL)"
    ).bind(id, id),
    env.DB.prepare("DELETE FROM quotations WHERE id=? AND deleted_at IS NOT NULL").bind(id),
  ]);
  if (!results[2]?.meta || results[2].meta.changes === 0) {
    return json({ error: "quotation_must_be_deleted_first" }, 409);
  }

  let assetCleanupFailed = false;
  if (scan?.r2_key && env.ASSETS) {
    try {
      await env.ASSETS.delete(scan.r2_key);
    } catch {
      assetCleanupFailed = true;
      try {
        await env.DB.prepare("UPDATE audit_events SET details_json=? WHERE id=?")
          .bind(JSON.stringify({ ...details, asset_cleanup_failed: true, asset_cleanup_failed_key: scan.r2_key }), auditId).run();
      } catch { /* the immediate API response still reports the failed cleanup */ }
    }
  }
  return json({
    deleted: true,
    id,
    quote_number: row.quote_number,
    asset_cleanup_failed: assetCleanupFailed,
    audit_event_retained: true,
  });
};

/* --------------------------- signed copy (scan) --------------------------- */

/**
 * The signed sheet is one page per quotation: a re-scan replaces the stored copy,
 * the R2 key changes so caches (and the browser's own image cache) follow, and the
 * old object is deleted instead of being left unreachable in the bucket.
 */
const SCAN_COLUMNS = "quotation_id,company_id,r2_key,content_type,bytes,width,height,source,created_at";

const scanRow = (env, quotationId) =>
  env.DB.prepare(`SELECT ${SCAN_COLUMNS} FROM quotation_scans WHERE quotation_id=?`).bind(quotationId).first();

/** URL version tag: the random suffix already in the key, so it changes on every upload. */
const scanVersion = (scan) => encodeURIComponent(String(scan.r2_key || "").split("/").pop() || scan.created_at || "");

/** Public shape of a signed copy — URLs and measurements, never the R2 key. */
const scanPayload = (quotationId, scan) => {
  if (!scan) return null;
  const base = `/api/quotations/${encodeURIComponent(quotationId)}/scan`;
  const version = scanVersion(scan);
  return {
    url: `${base}?v=${version}`,
    download_url: `${base}?v=${version}&download=1`,
    content_type: scan.content_type,
    bytes: Number(scan.bytes) || 0,
    width: Number(scan.width) || 0,
    height: Number(scan.height) || 0,
    source: scan.source,
    created_at: scan.created_at,
  };
};

/** The workflow block every quotation payload carries. */
const workflowPayload = (row, scan) => ({
  status: row.status === "completed" ? "completed" : "issued",
  completed_at: row.completed_at || null,
  signed: Boolean(scan),
  has_scan: Boolean(scan),
  scan: scanPayload(row.id, scan),
  /* relative on purpose: the record page knows its own origin, and a pasted link
     must never inherit the hostname of some internal preview */
  share_path: row.share_token ? sharePath(row.share_token) : null,
  share_token_created_at: row.share_token_created_at || null,
});

/** Relative share path; the API additionally returns it absolute for copy-paste. */
const sharePath = (token) => `/s/${token}`;

const shareUrlFor = (request, token) => (token ? new URL(sharePath(token), request.url).toString() : null);
/* ------------------------------ scan routes ------------------------------ */

const handleQuotationScanGet = async (env, id, url) => {
  const row = await quotationById(env, id);
  if (!row) return json({ error: "quotation_not_found" }, 404);
  const scan = await scanRow(env, id);
  if (!scan) return json({ error: "scan_not_found" }, 404);
  if (!env.ASSETS) return json({ error: "storage_unavailable" }, 503);
  const object = await env.ASSETS.get(scan.r2_key);
  if (!object) return json({ error: "scan_not_found" }, 404);
  return imageResponse(object, scan, url, `${row.quote_number || "quotation"}-signed`);
};

/**
 * One response shape for every stored picture (desk route and public link), so a
 * scan is served with the same type, cache rules and sandboxing in both places.
 */
const imageResponse = (object, scan, url, baseName) => {
  const download = ["1", "true", "yes"].includes((url.searchParams.get("download") || "").toLowerCase());
  const kind = scan.content_type || "image/jpeg";
  const ext = kind === "image/png" ? "png" : kind === "image/webp" ? "webp" : kind === "application/pdf" ? "pdf" : "jpg";
  const name = `${String(baseName).replace(/[^A-Za-z0-9._-]+/g, "-")}.${ext}`;
  return new Response(object.body, {
    headers: {
      "content-type": kind,
      "cache-control": "private, max-age=31536000, immutable",
      etag: `"${scanVersion(scan)}"`,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
      "x-content-type-options": "nosniff",
      /* a scan is a picture of paperwork, never a document: no scripts, no framing.
         A PDF is left alone — the viewer decides how to render it, and a sandbox
         directive would be applied to the whole document. */
      ...(kind === "application/pdf" ? {} : { "content-security-policy": "default-src 'none'; sandbox" }),
    },
  });
};


/**
 * Stores the signed page: a corrected capture from the in-app scanner, a photo
 * uploaded from the gallery, or a PDF from a desktop scanner. The signature is
 * verified in every case, so a mislabelled upload can never be stored — or served —
 * under the wrong type.
 */
const handleQuotationScanUpload = async (request, env, ctx, session, id) => {
  const row = await quotationById(env, id);
  if (!row) return json({ error: "quotation_not_found" }, 404);
  if (!env.ASSETS) return json({ error: "storage_unavailable" }, 503);
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return json({ error: "scan_file_required" }, 400);
  }
  if (file.size > MAX_PDF_BYTES) return json({ error: "scan_too_large", max_bytes: MAX_PDF_BYTES }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffScanType(bytes, file.type || "");
  if (!type) return json({ error: "unsupported_scan_type", accepted: SCAN_TYPES.map((t) => t.mime) }, 415);
  /* the PDF ceiling is the outer limit; a picture still has to fit the smaller one */
  const ceiling = type.mime === PDF_TYPE.mime ? MAX_PDF_BYTES : MAX_SCAN_BYTES;
  if (bytes.length > ceiling) return json({ error: "scan_too_large", max_bytes: ceiling }, 413);

  const width = Math.min(Math.max(Number(form.get("width")) || 0, 0), 20000);
  const height = Math.min(Math.max(Number(form.get("height")) || 0, 0), 20000);
  const source = text(form.get("source"), 20) || "scan";
  const previous = await scanRow(env, id);
  const key = `${SCAN_PREFIX}${row.company_id}/${id}-${randomToken(6)}.${type.ext}`;

  await env.ASSETS.put(key, bytes, {
    httpMetadata: { contentType: type.mime },
    customMetadata: { quotation_id: id, company_id: row.company_id },
  });
  await env.DB.prepare(
    "INSERT INTO quotation_scans(quotation_id,company_id,r2_key,content_type,bytes,width,height,source) " +
    "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(quotation_id) DO UPDATE SET " +
    "company_id=excluded.company_id,r2_key=excluded.r2_key,content_type=excluded.content_type," +
    "bytes=excluded.bytes,width=excluded.width,height=excluded.height,source=excluded.source," +
    "created_at=CURRENT_TIMESTAMP"
  ).bind(id, row.company_id, key, type.mime, bytes.length, width, height, source).run();
  /* the token is minted with the first signed copy: a link to a quotation that has
     nothing to show is not worth sending, and rotating one stays an explicit act */
  if (!row.share_token) {
    await env.DB.prepare(
      "UPDATE quotations SET share_token=?, share_token_created_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(randomToken(SHARE_TOKEN_BYTES), id).run();
  }
  if (previous && previous.r2_key && previous.r2_key !== key) {
    try { await env.ASSETS.delete(previous.r2_key); } catch { /* the new copy is already live */ }
  }
  audit(env, ctx, session.name, "quotation.scan_uploaded", "quotation", id, {
    quote_number: row.quote_number,
    company_id: row.company_id,
    content_type: type.mime, bytes: bytes.length, replaced: Boolean(previous), source,
  });
  return json(await quotationPayload(env, id), previous ? 200 : 201);
};

const handleQuotationScanDelete = async (env, ctx, session, id) => {
  const row = await quotationById(env, id);
  if (!row) return json({ error: "quotation_not_found" }, 404);
  const scan = await scanRow(env, id);
  if (!scan) return json({ removed: false });
  await env.DB.prepare("DELETE FROM quotation_scans WHERE quotation_id=?").bind(id).run();
  if (env.ASSETS) {
    try { await env.ASSETS.delete(scan.r2_key); } catch { /* the row is already clear */ }
  }
  audit(env, ctx, session.name, "quotation.scan_removed", "quotation", id, {
    quote_number: row.quote_number, company_id: row.company_id,
  });
  return json({ removed: true });
};

/* ------------------------------ workflow ------------------------------ */

/** Open or close a record — closing it is what "the deal is done" means for the desk. */
const handleQuotationStatus = async (request, env, ctx, session, id) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  if (!QUOTATION_STATUSES.includes(body.status)) {
    return json({ error: "invalid_status", accepted: QUOTATION_STATUSES }, 400);
  }
  const row = await quotationById(env, id);
  if (!row) return json({ error: "quotation_not_found" }, 404);
  if (body.status === "completed") {
    /* a completed record claims the paperwork is filed, so there must be paperwork */
    const scan = await scanRow(env, id);
    if (!scan) return json({ error: "scan_required" }, 409);
  }
  await env.DB.prepare(
    "UPDATE quotations SET status=?, completed_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(body.status, body.status === "completed" ? new Date().toISOString() : null, id).run();
  audit(env, ctx, session.name,
    body.status === "completed" ? "quotation.completed" : "quotation.reopened", "quotation", id, {
      quote_number: row.quote_number, company_id: row.company_id, status: body.status,
    });
  return handleQuotationGet(env, id);
};

/** Mints (or rotates) the public link. Rotating invalidates every previously pasted URL. */
const handleShareLinkCreate = async (request, env, ctx, session, id) => {
  const row = await quotationById(env, id);
  if (!row) return json({ error: "quotation_not_found" }, 404);
  const token = randomToken(SHARE_TOKEN_BYTES);
  await env.DB.prepare(
    "UPDATE quotations SET share_token=?, share_token_created_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(token, id).run();
  audit(env, ctx, session.name,
    row.share_token ? "quotation.share_link_rotated" : "quotation.share_link_created", "quotation", id, {
      quote_number: row.quote_number, company_id: row.company_id,
    });
  return json({
    share_path: sharePath(token),
    share_url: shareUrlFor(request, token),
    share_token_created_at: new Date().toISOString(),
  }, row.share_token ? 200 : 201);
};

const handleShareLinkRevoke = async (env, ctx, session, id) => {
  const row = await quotationById(env, id);
  if (!row) return json({ error: "quotation_not_found" }, 404);
  await env.DB.prepare(
    "UPDATE quotations SET share_token=NULL, share_token_created_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(id).run();
  audit(env, ctx, session.name, "quotation.share_link_revoked", "quotation", id, {
    quote_number: row.quote_number, company_id: row.company_id,
  });
  return json({ share_path: null, share_url: null, share_token_created_at: null });
};


/* ========================= vehicle agreements ========================= */
/* Sale and purchase agreements share one table, one numbering scheme per kind and
   one set of handlers. Numbers come from the server (SA-/PA- + year + serial), the
   template and the company profile are snapshotted at issue time, and the signed
   copy follows the same "one page per record" rule as quotations. */

const agreementKindOf = (value) => {
  const kind = typeof value === "string" ? value.trim().toLowerCase() : "";
  return AGREEMENT_KINDS.includes(kind) ? kind : "";
};

/** Blank counts as zero: a deposit may legitimately be left out of a purchase. */
const amountOrZero = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  return parseAmountToCents(value);
};

const agreementNumberFor = (kind, period, serial) =>
  `${AGREEMENT_PREFIX[kind] || "AG-"}${period}-${String(serial).padStart(5, "0")}`;

/** Read-only numbering preview: never advances the counter. */
const peekNextAgreementNumber = async (env, companyId, kind, date) => {
  const period = String(date).slice(0, 4);
  const row = await env.DB.prepare(
    "SELECT last_number FROM agreement_sequences WHERE company_id=? AND kind=? AND period=?"
  ).bind(companyId, kind, period).first();
  const next = Number(row?.last_number || 0) + 1;
  return { period, next_serial: next, agreement_number: agreementNumberFor(kind, period, next) };
};

const allocateAgreementSerial = async (env, companyId, kind, period) => {
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO agreement_sequences(company_id,kind,period,last_number) VALUES(?,?,?,1) " +
      "ON CONFLICT(company_id,kind,period) DO UPDATE SET last_number=last_number+1"
    ).bind(companyId, kind, period),
    env.DB.prepare("SELECT last_number FROM agreement_sequences WHERE company_id=? AND kind=? AND period=?")
      .bind(companyId, kind, period),
  ]);
  return Number(results[1]?.results?.[0]?.last_number || 1);
};

const AGREEMENT_COLUMNS =
  "id,company_id,kind,template_id,agreement_number,agreement_date," +
  "vehicle_model,vehicle_year,vehicle_chassis,vehicle_plate,vehicle_color,vehicle_odometer," +
  "vehicle_registration_place,seller_name,seller_id_number,seller_phone,seller_address," +
  "buyer_name,buyer_id_number,buyer_phone,buyer_address," +
  "intermediary_name,intermediary_phone,intermediary_commission," +
  "full_amount_cents,paid_amount_cents,full_amount_words,paid_amount_words,currency,notes," +
  "company_snapshot_json,status,completed_at,share_token,share_token_created_at,created_at,updated_at";

/* One list drives the INSERT column order, the value order and the placeholder count,
   so the three can never drift apart. */
const AGREEMENT_FIELDS = [
  "id", "company_id", "kind", "template_id", "agreement_number", "agreement_date",
  "vehicle_model", "vehicle_year", "vehicle_chassis", "vehicle_plate", "vehicle_color",
  "vehicle_odometer", "vehicle_registration_place",
  "seller_name", "seller_id_number", "seller_phone", "seller_address",
  "buyer_name", "buyer_id_number", "buyer_phone", "buyer_address",
  "intermediary_name", "intermediary_phone", "intermediary_commission",
  "full_amount_cents", "paid_amount_cents", "full_amount_words", "paid_amount_words",
  "currency", "notes", "template_html_snapshot", "company_snapshot_json",
];

/** Money is formatted on the way out; the balance is derived, never stored. */
const decorateAgreement = (row) => {
  const full = Number(row.full_amount_cents || 0);
  const paid = Number(row.paid_amount_cents || 0);
  const balance = full - paid;
  return {
    ...row,
    kind_label: AGREEMENT_KIND_LABELS[row.kind] || "Agreement",
    agreement_date_text: formatDateDMY(row.agreement_date),
    full_amount: formatMoney(full),
    paid_amount: formatMoney(paid),
    balance: formatMoney(balance),
    balance_cents: balance,
  };
};

const agreementById = (env, id) =>
  env.DB.prepare(`SELECT ${AGREEMENT_COLUMNS} FROM agreements WHERE id=? AND deleted_at IS NULL`).bind(id).first();

const agreementScanRowFor = (env, agreementId) =>
  env.DB.prepare(
    "SELECT agreement_id,company_id,r2_key,content_type,bytes,width,height,source,created_at " +
    "FROM agreement_scans WHERE agreement_id=?"
  ).bind(agreementId).first();

/** Public shape of a signed copy — URLs and measurements, never the R2 key. */
const agreementScanPayload = (agreementId, scan) => {
  if (!scan) return null;
  const base = `/api/agreements/${encodeURIComponent(agreementId)}/scan`;
  const version = scanVersion(scan);
  return {
    url: `${base}?v=${version}`,
    download_url: `${base}?v=${version}&download=1`,
    content_type: scan.content_type,
    bytes: Number(scan.bytes) || 0,
    width: Number(scan.width) || 0,
    height: Number(scan.height) || 0,
    source: scan.source,
    created_at: scan.created_at,
  };
};

/** Agreements live under their own link namespace; /s/<token> stays quotation-only. */
const agreementSharePath = (token) => `/a/${token}`;

const agreementShareUrlFor = (request, token) =>
  (token ? new URL(agreementSharePath(token), request.url).toString() : null);

const agreementPayload = async (env, id) => {
  const row = await agreementById(env, id);
  if (!row) return null;
  const [company, scan] = await Promise.all([
    env.DB.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id=?`).bind(row.company_id).first(),
    agreementScanRowFor(env, id),
  ]);
  const snapshot = parseJson(row.company_snapshot_json);
  const rest = { ...row };
  /* stripped, not renamed: the token is a credential, `share_path` is the pointer */
  delete rest.share_token;
  return {
    agreement: {
      ...decorateAgreement(rest),
      status: row.status === "completed" ? "completed" : "issued",
      completed_at: row.completed_at || null,
      signed: Boolean(scan),
      has_scan: Boolean(scan),
      scan: agreementScanPayload(id, scan),
      share_path: row.share_token ? agreementSharePath(row.share_token) : null,
      share_token_created_at: row.share_token_created_at || null,
      currency: row.currency || snapshot.currency || company?.currency || "AED",
      company: company || null,
    },
  };
};

const handleAgreementGet = async (env, id) => {
  const payload = await agreementPayload(env, id);
  return payload ? json(payload) : json({ error: "agreement_not_found" }, 404);
};

/* ------------------------------ ledger ------------------------------ */

const AGREEMENT_LEDGER_ORDER = {
  number: "a.agreement_number DESC",
  date: "a.agreement_date DESC, a.created_at DESC",
};

/**
 * The desk keeps one ledger per kind, so `kind` is required in practice; `all` exists
 * for reporting and for the CSV export, where both books belong in one sheet.
 */
const handleAgreementList = async (env, url) => {
  const companyId = url.searchParams.get("company_id");
  if (!companyId) return json({ error: "company_id_required" }, 400);
  const rawKind = (url.searchParams.get("kind") || "").trim().toLowerCase();
  const kind = rawKind === "all" ? "" : (agreementKindOf(rawKind) || "sale");
  const search = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const sort = AGREEMENT_LEDGER_ORDER[url.searchParams.get("sort")] ? url.searchParams.get("sort") : "number";
  const view = ["active", "deleted"].includes(url.searchParams.get("view")) ? url.searchParams.get("view") : "active";
  const deletedClause = view === "deleted" ? "a.deleted_at IS NOT NULL" : "a.deleted_at IS NULL";
  const kindClause = kind ? "AND a.kind=? " : "";

  const rows = await env.DB.prepare(
    "SELECT a.id,a.kind,a.agreement_number,a.agreement_date,a.vehicle_model,a.vehicle_year," +
    "a.vehicle_chassis,a.vehicle_plate,a.seller_name,a.buyer_name,a.full_amount_cents," +
    "a.paid_amount_cents,a.currency,a.status,a.completed_at,a.created_at,a.deleted_at," +
    "s.created_at AS scan_created_at FROM agreements a " +
    "LEFT JOIN agreement_scans s ON s.agreement_id=a.id " +
    `WHERE a.company_id=? ${kindClause}AND ${deletedClause} ` +
    "AND (a.agreement_number LIKE ? OR a.vehicle_model LIKE ? OR a.vehicle_chassis LIKE ? " +
    "OR a.vehicle_plate LIKE ? OR a.seller_name LIKE ? OR a.buyer_name LIKE ?) " +
    `ORDER BY ${AGREEMENT_LEDGER_ORDER[sort]} LIMIT ?`
  ).bind(companyId, ...(kind ? [kind] : []), ...Array(6).fill(`%${search}%`), limit).all();

  /* the tab badges: counts per kind for the same company and view, search excluded */
  const countRows = await env.DB.prepare(
    `SELECT a.kind, COUNT(*) AS n FROM agreements a WHERE a.company_id=? AND ${deletedClause} GROUP BY a.kind`
  ).bind(companyId).all();
  const counts = { sale: 0, purchase: 0 };
  for (const row of countRows.results || []) {
    if (row.kind in counts) counts[row.kind] = Number(row.n) || 0;
  }
  const total = kind ? counts[kind] : counts.sale + counts.purchase;

  return json({
    agreements: (rows.results || []).map((row) => {
      const { scan_created_at: scannedAt, ...rest } = row;
      return {
        ...decorateAgreement(rest),
        deleted_at: rest.deleted_at || null,
        signed: Boolean(scannedAt),
        has_scan: Boolean(scannedAt),
      };
    }),
    counts,
    total,
    kind: kind || "all",
    sort,
    view,
  });
};

/** Read-only numbering preview for the wizard's first step. */
const handleAgreementNextNumber = async (env, url) => {
  const companyId = url.searchParams.get("company_id");
  const date = url.searchParams.get("date") || todayIso();
  const kind = agreementKindOf(url.searchParams.get("kind") || "sale");
  if (!companyId) return json({ error: "company_id_required" }, 400);
  if (!validIsoDate(date)) return json({ error: "invalid_agreement_date" }, 400);
  if (!kind) return json({ error: "invalid_agreement_kind", accepted: AGREEMENT_KINDS }, 400);
  const company = await env.DB.prepare("SELECT id FROM companies WHERE id=?").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  return json({ ...(await peekNextAgreementNumber(env, company.id, kind, date)), date, kind });
};

/* ------------------------------ create ------------------------------ */

const agreementTextFields = (body) => {
  const fields = {};
  for (const [field, max] of Object.entries(AGREEMENT_TEXT_LIMITS)) fields[field] = text(body?.[field], max);
  return fields;
};

const agreementNotes = (value) => text(value, MAX_AGREEMENT_NOTES).replace(/\s+/g, " ").trim();

const handleAgreementCreate = async (request, env, ctx, session) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const companyId = text(body.company_id, 48);
  if (!companyId) return json({ error: "company_id_required" }, 400);
  const kind = agreementKindOf(body.kind);
  if (!kind) return json({ error: "invalid_agreement_kind", accepted: AGREEMENT_KINDS }, 400);
  const fields = agreementTextFields(body);
  const missing = AGREEMENT_REQUIRED_TEXT.filter((field) => !fields[field]);
  if (missing.length) return json({ error: "agreement_fields_required", fields: missing }, 400);
  const date = text(body.agreement_date, 10) || todayIso();
  if (!validIsoDate(date)) return json({ error: "invalid_agreement_date" }, 400);
  const fullCents = amountOrZero(body.full_amount);
  if (fullCents === null) return json({ error: "invalid_full_amount" }, 400);
  const paidCents = amountOrZero(body.paid_amount);
  if (paidCents === null) return json({ error: "invalid_paid_amount" }, 400);
  /* a deposit larger than the price would print a negative balance */
  if (paidCents > fullCents) return json({ error: "paid_amount_exceeds_full" }, 400);
  const company = await env.DB.prepare("SELECT * FROM companies WHERE id=? AND active=1").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);

  const period = date.slice(0, 4);
  /* numbers are always server-allocated, one counter per company, kind and year */
  let agreementNumber = "";
  for (let attempt = 0; attempt < 8 && !agreementNumber; attempt++) {
    const serial = await allocateAgreementSerial(env, company.id, kind, period);
    const candidate = agreementNumberFor(kind, period, serial);
    const taken = await env.DB.prepare("SELECT 1 AS taken FROM agreements WHERE company_id=? AND agreement_number=?")
      .bind(company.id, candidate).first();
    if (!taken) agreementNumber = candidate;
  }
  if (!agreementNumber) return json({ error: "numbering_exhausted" }, 409);

  const template = await env.DB.prepare(
    "SELECT id,html FROM templates WHERE company_id=? AND kind=? AND active=1 ORDER BY version DESC LIMIT 1"
  ).bind(company.id, kind).first();
  const snapshot = {
    name: company.name, legal_name: company.legal_name, legal_name_ar: company.legal_name_ar,
    address: company.address,
    phone: company.phone, email: company.email, currency: company.currency,
    letterhead_url: company.letterhead_key ? `/api/companies/${company.id}/letterhead` : LETTERHEAD_URL,
    logo_url: logoUrlFor(company),
  };
  const id = crypto.randomUUID();
  const values = {
    id,
    company_id: company.id,
    kind,
    template_id: template?.id || null,
    agreement_number: agreementNumber,
    agreement_date: date,
    ...fields,
    full_amount_cents: fullCents,
    paid_amount_cents: paidCents,
    full_amount_words: amountWordsFromCents(fullCents),
    paid_amount_words: paidCents ? amountWordsFromCents(paidCents) : "",
    currency: text(body.currency, 8) || company.currency || "AED",
    notes: agreementNotes(body.notes),
    template_html_snapshot: template?.html || DEFAULT_AGREEMENT_TEMPLATES[kind],
    company_snapshot_json: JSON.stringify(snapshot),
  };
  await env.DB.prepare(
    `INSERT INTO agreements(${AGREEMENT_FIELDS.join(",")}) VALUES(${AGREEMENT_FIELDS.map(() => "?").join(",")})`
  ).bind(...AGREEMENT_FIELDS.map((field) => values[field] ?? null)).run();
  audit(env, ctx, session.name, "agreement.created", "agreement", id, {
    agreement_number: agreementNumber, kind, company_id: company.id, full_amount_cents: fullCents,
  });
  return json(await agreementPayload(env, id), 201);
};

/* ------------------------------ edit ------------------------------ */

const handleAgreementPatch = async (request, env, ctx, session, id) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const row = await agreementById(env, id);
  if (!row) return json({ error: "agreement_not_found" }, 404);
  /* completed means "filed": the terms on the signed paper cannot drift from the record */
  if (row.status === "completed") return json({ error: "agreement_completed" }, 409);
  const sets = [];
  const values = [];
  if (typeof body.agreement_date === "string") {
    if (!validIsoDate(body.agreement_date)) return json({ error: "invalid_agreement_date" }, 400);
    sets.push("agreement_date=?");
    values.push(body.agreement_date);
  }
  for (const [field, max] of Object.entries(AGREEMENT_TEXT_LIMITS)) {
    if (typeof body[field] !== "string") continue;
    const value = text(body[field], max);
    /* required fields may be corrected but never cleared; the rest may go blank */
    if (!value && AGREEMENT_REQUIRED_TEXT.includes(field)) {
      return json({ error: "agreement_fields_required", fields: [field] }, 400);
    }
    sets.push(`${field}=?`);
    values.push(value);
  }
  if (typeof body.currency === "string" && text(body.currency, 8)) {
    sets.push("currency=?");
    values.push(text(body.currency, 8));
  }
  if (typeof body.notes === "string") {
    sets.push("notes=?");
    values.push(agreementNotes(body.notes));
  }
  /* the two amounts are validated together, so a patch that only raises the deposit still
     sees the stored price */
  const fullGiven = body.full_amount !== undefined;
  const paidGiven = body.paid_amount !== undefined;
  const fullCents = fullGiven ? amountOrZero(body.full_amount) : Number(row.full_amount_cents || 0);
  if (fullCents === null) return json({ error: "invalid_full_amount" }, 400);
  const paidCents = paidGiven ? amountOrZero(body.paid_amount) : Number(row.paid_amount_cents || 0);
  if (paidCents === null) return json({ error: "invalid_paid_amount" }, 400);
  if (paidCents > fullCents) return json({ error: "paid_amount_exceeds_full" }, 400);
  if (fullGiven) {
    sets.push("full_amount_cents=?", "full_amount_words=?");
    values.push(fullCents, amountWordsFromCents(fullCents));
  }
  if (paidGiven) {
    sets.push("paid_amount_cents=?", "paid_amount_words=?");
    values.push(paidCents, paidCents ? amountWordsFromCents(paidCents) : "");
  }
  if (!sets.length) return json({ error: "no_fields_to_update" }, 400);
  await env.DB.prepare(`UPDATE agreements SET ${sets.join(", ")}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(...values, id).run();
  audit(env, ctx, session.name, "agreement.updated", "agreement", id, {
    agreement_number: row.agreement_number,
    kind: row.kind,
    company_id: row.company_id,
    fields: sets.map((entry) => entry.replace("=?", "")),
  });
  return handleAgreementGet(env, id);
};

/* ---------------------------- cancel / restore ---------------------------- */

const handleAgreementCancel = async (env, ctx, session, id) => {
  const row = await agreementById(env, id);
  if (!row) return json({ error: "agreement_not_found" }, 404);
  /* a completed record is filed paperwork: reopening it is the way to change it */
  if (row.status === "completed") return json({ error: "agreement_completed" }, 409);
  const result = await env.DB.prepare(
    "UPDATE agreements SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL"
  ).bind(id).run();
  if (!result.meta || result.meta.changes === 0) return json({ error: "agreement_not_found" }, 404);
  audit(env, ctx, session.name, "agreement.cancelled", "agreement", id, {
    agreement_number: row.agreement_number, kind: row.kind, company_id: row.company_id,
  });
  return json({ cancelled: true });
};

const handleAgreementRestore = async (env, ctx, session, id) => {
  const row = await env.DB.prepare(
    "SELECT id,company_id,kind,agreement_number,deleted_at FROM agreements WHERE id=?"
  ).bind(id).first();
  if (!row) return json({ error: "agreement_not_found" }, 404);
  if (!row.deleted_at) return json({ error: "agreement_not_deleted" }, 409);
  const result = await env.DB.prepare(
    "UPDATE agreements SET deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NOT NULL"
  ).bind(id).run();
  if (!result.meta || result.meta.changes === 0) return json({ error: "agreement_not_deleted" }, 409);
  audit(env, ctx, session.name, "agreement.restored", "agreement", id, {
    agreement_number: row.agreement_number, kind: row.kind, company_id: row.company_id,
  });
  return json({ restored: true, id, agreement_number: row.agreement_number });
};

/** Permanent delete only after a soft delete, and only with the number typed back. */
const handleAgreementPermanentDelete = async (request, env, ctx, session, id) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const row = await env.DB.prepare(
    "SELECT id,company_id,kind,agreement_number,deleted_at FROM agreements WHERE id=?"
  ).bind(id).first();
  if (!row) return json({ error: "agreement_not_found" }, 404);
  if (!row.deleted_at) return json({ error: "agreement_must_be_deleted_first" }, 409);
  if (text(body.confirm_number, 60) !== row.agreement_number) {
    return json({ error: "agreement_confirmation_required" }, 409);
  }
  const scan = await env.DB.prepare("SELECT r2_key FROM agreement_scans WHERE agreement_id=?").bind(id).first();
  if (scan?.r2_key && !env.ASSETS) return json({ error: "storage_unavailable" }, 503);

  const details = {
    agreement_number: row.agreement_number,
    kind: row.kind,
    company_id: row.company_id,
    signed_scan_deleted: Boolean(scan?.r2_key),
    permanent: true,
  };
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO audit_events(id,actor,action,entity,entity_id,details_json) " +
      "SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM agreements WHERE id=? AND deleted_at IS NOT NULL)"
    ).bind(crypto.randomUUID(), String(session.name || "shared"), "agreement.permanently_deleted",
      "agreement", id, JSON.stringify(details), id),
    env.DB.prepare(
      "DELETE FROM agreement_scans WHERE agreement_id=? " +
      "AND EXISTS (SELECT 1 FROM agreements WHERE id=? AND deleted_at IS NOT NULL)"
    ).bind(id, id),
    env.DB.prepare("DELETE FROM agreements WHERE id=? AND deleted_at IS NOT NULL").bind(id),
  ]);
  if (!results[2]?.meta || results[2].meta.changes === 0) {
    return json({ error: "agreement_must_be_deleted_first" }, 409);
  }
  let assetCleanupFailed = false;
  if (scan?.r2_key && env.ASSETS) {
    try {
      await env.ASSETS.delete(scan.r2_key);
    } catch {
      /* the row is gone either way; the object is reported so an operator can sweep it */
      assetCleanupFailed = true;
    }
  }
  return json({ deleted: true, id, asset_cleanup_failed: assetCleanupFailed });
};


const COMPANY_JOIN_COLUMNS =
  "c.name AS company_name, c.legal_name AS company_legal_name, " +
  "c.legal_name_ar AS company_legal_name_ar, c.logo_key AS company_logo_key";

const agreementKindLabel = (kind) => AGREEMENT_KIND_LABELS[kind] || "Agreement";

/**
 * The agreement sheet's own tokens, on top of the shared company block. Percentages
 * and dates are pre-formatted: a template must never do arithmetic or date maths.
 */
const buildAgreementPrintFields = (row) => {
  const full = Number(row.full_amount_cents || 0);
  const paid = Number(row.paid_amount_cents || 0);
  const balance = full - paid;
  const intermediaryName = row.intermediary_name || "";
  const intermediaryPhone = row.intermediary_phone || "";
  return {
    agreement_number: row.agreement_number,
    agreement_date: formatDateDMY(row.agreement_date),
    agreement_kind: row.kind,
    agreement_kind_label: agreementKindLabel(row.kind),
    vehicle_model: row.vehicle_model || "",
    vehicle_year: row.vehicle_year || "",
    vehicle_chassis: row.vehicle_chassis || "",
    vehicle_plate: row.vehicle_plate || "",
    vehicle_color: row.vehicle_color || "",
    vehicle_odometer: row.vehicle_odometer || "",
    vehicle_registration_place: row.vehicle_registration_place || "",
    seller_name: row.seller_name || "",
    seller_id_number: row.seller_id_number || "",
    seller_phone: row.seller_phone || "",
    seller_address: row.seller_address || "",
    buyer_name: row.buyer_name || "",
    buyer_id_number: row.buyer_id_number || "",
    buyer_phone: row.buyer_phone || "",
    buyer_address: row.buyer_address || "",
    /* present-but-empty: the template decides whether an empty row still prints */
    intermediary_name: intermediaryName,
    intermediary_phone: intermediaryPhone,
    intermediary_commission: row.intermediary_commission || "",
    intermediary_state: intermediaryName || intermediaryPhone ? "has-intermediary" : "no-intermediary",
    full_amount: formatMoney(full),
    full_amount_words: row.full_amount_words || "",
    paid_amount: formatMoney(paid),
    paid_amount_words: row.paid_amount_words || "",
    balance: formatMoney(balance),
    balance_words: amountWordsFromCents(balance),
    notes: row.notes || "",
    notes_state: row.notes ? "has-notes" : "no-notes",
    ...companyPrintFields(row),
  };
};

const agreementSheetRow = (env, id) =>
  env.DB.prepare(
    `SELECT a.*, ${COMPANY_JOIN_COLUMNS} FROM agreements a JOIN companies c ON c.id=a.company_id ` +
    "WHERE a.id=? AND a.deleted_at IS NULL"
  ).bind(id).first();

/** The agreement print sheet: the version snapshotted at issue time, autoprinted on request. */
const handleAgreementPrint = async (env, url, id) => {
  const row = await agreementSheetRow(env, id);
  if (!row) return json({ error: "agreement_not_found" }, 404);
  const autoprint = ["1", "true", "yes"].includes((url.searchParams.get("print") || "").toLowerCase());
  const template = row.template_html_snapshot || DEFAULT_AGREEMENT_TEMPLATES[row.kind] || DEFAULT_SALES_AGREEMENT;
  return sheetResponse(renderQuote(template, buildAgreementPrintFields(row)), autoprint);
};

/* ---------------------------- signed copy ---------------------------- */

const handleAgreementScanGet = async (env, id, url) => {
  const row = await agreementById(env, id);
  if (!row) return json({ error: "agreement_not_found" }, 404);
  const scan = await agreementScanRowFor(env, id);
  if (!scan) return json({ error: "scan_not_found" }, 404);
  if (!env.ASSETS) return json({ error: "storage_unavailable" }, 503);
  const object = await env.ASSETS.get(scan.r2_key);
  if (!object) return json({ error: "scan_not_found" }, 404);
  return imageResponse(object, scan, url, `${row.agreement_number || "agreement"}-signed`);
};

/**
 * Stores the signed page. The signature is verified exactly like a quotation scan, so a
 * file renamed to ".pdf" can never be stored — or served — under the wrong type.
 */
const handleAgreementScanUpload = async (request, env, ctx, session, id) => {
  const row = await agreementById(env, id);
  if (!row) return json({ error: "agreement_not_found" }, 404);
  if (!env.ASSETS) return json({ error: "storage_unavailable" }, 503);
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return json({ error: "scan_file_required" }, 400);
  }
  if (file.size > MAX_PDF_BYTES) return json({ error: "scan_too_large", max_bytes: MAX_PDF_BYTES }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffScanType(bytes, file.type || "");
  if (!type) return json({ error: "unsupported_scan_type", accepted: SCAN_TYPES.map((t) => t.mime) }, 415);
  /* the PDF ceiling is the outer limit; a picture still has to fit the smaller one */
  const ceiling = type.mime === PDF_TYPE.mime ? MAX_PDF_BYTES : MAX_SCAN_BYTES;
  if (bytes.length > ceiling) return json({ error: "scan_too_large", max_bytes: ceiling }, 413);

  const width = Math.min(Math.max(Number(form.get("width")) || 0, 0), 20000);
  const height = Math.min(Math.max(Number(form.get("height")) || 0, 0), 20000);
  const source = text(form.get("source"), 20) || "scan";
  const previous = await agreementScanRowFor(env, id);
  const key = `${AGREEMENT_SCAN_PREFIX}${row.company_id}/${id}-${randomToken(6)}.${type.ext}`;

  await env.ASSETS.put(key, bytes, {
    httpMetadata: { contentType: type.mime },
    customMetadata: { agreement_id: id, company_id: row.company_id },
  });
  await env.DB.prepare(
    "INSERT INTO agreement_scans(agreement_id,company_id,r2_key,content_type,bytes,width,height,source) " +
    "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agreement_id) DO UPDATE SET " +
    "company_id=excluded.company_id,r2_key=excluded.r2_key,content_type=excluded.content_type," +
    "bytes=excluded.bytes,width=excluded.width,height=excluded.height,source=excluded.source," +
    "created_at=CURRENT_TIMESTAMP"
  ).bind(id, row.company_id, key, type.mime, bytes.length, width, height, source).run();
  /* the token is minted with the first signed copy: a link to a record that has nothing
     to show is not worth sending, and rotating one stays an explicit act */
  if (!row.share_token) {
    await env.DB.prepare(
      "UPDATE agreements SET share_token=?, share_token_created_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(randomToken(SHARE_TOKEN_BYTES), id).run();
  }
  if (previous?.r2_key && previous.r2_key !== key) {
    try { await env.ASSETS.delete(previous.r2_key); } catch { /* the new copy is already live */ }
  }
  audit(env, ctx, session.name, "agreement.scan_uploaded", "agreement", id, {
    agreement_number: row.agreement_number,
    kind: row.kind,
    company_id: row.company_id,
    content_type: type.mime, bytes: bytes.length, replaced: Boolean(previous), source,
  });
  return json(await agreementPayload(env, id), previous ? 200 : 201);
};

const handleAgreementScanDelete = async (env, ctx, session, id) => {
  const row = await agreementById(env, id);
  if (!row) return json({ error: "agreement_not_found" }, 404);
  const scan = await agreementScanRowFor(env, id);
  if (!scan) return json({ removed: false });
  await env.DB.prepare("DELETE FROM agreement_scans WHERE agreement_id=?").bind(id).run();
  if (env.ASSETS) {
    try { await env.ASSETS.delete(scan.r2_key); } catch { /* the row is already clear */ }
  }
  audit(env, ctx, session.name, "agreement.scan_removed", "agreement", id, {
    agreement_number: row.agreement_number, kind: row.kind, company_id: row.company_id,
  });
  return json({ removed: true });
};

/* ---------------------------- workflow ---------------------------- */

/** Open or close an agreement — closing it is what "the deal is done" means for the desk. */
const handleAgreementStatus = async (request, env, ctx, session, id) => {
  const body = await bodyJson(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  if (!AGREEMENT_STATUSES.includes(body.status)) {
    return json({ error: "invalid_status", accepted: AGREEMENT_STATUSES }, 400);
  }
  const row = await agreementById(env, id);
  if (!row) return json({ error: "agreement_not_found" }, 404);
  if (body.status === "completed") {
    /* completed claims the paperwork is filed, so there must be paperwork */
    const scan = await agreementScanRowFor(env, id);
    if (!scan) return json({ error: "scan_required" }, 409);
  }
  await env.DB.prepare(
    "UPDATE agreements SET status=?, completed_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(body.status, body.status === "completed" ? new Date().toISOString() : null, id).run();
  audit(env, ctx, session.name,
    body.status === "completed" ? "agreement.completed" : "agreement.reopened", "agreement", id, {
      agreement_number: row.agreement_number, kind: row.kind,
      company_id: row.company_id, status: body.status,
    });
  return handleAgreementGet(env, id);
};

/** Mints (or rotates) the public link. Rotating invalidates every previously pasted URL. */
const handleAgreementShareLinkCreate = async (request, env, ctx, session, id) => {
  const row = await agreementById(env, id);
  if (!row) return json({ error: "agreement_not_found" }, 404);
  const token = randomToken(SHARE_TOKEN_BYTES);
  await env.DB.prepare(
    "UPDATE agreements SET share_token=?, share_token_created_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(token, id).run();
  audit(env, ctx, session.name,
    row.share_token ? "agreement.share_link_rotated" : "agreement.share_link_created", "agreement", id, {
      agreement_number: row.agreement_number, kind: row.kind, company_id: row.company_id,
    });
  return json({
    share_path: agreementSharePath(token),
    share_url: agreementShareUrlFor(request, token),
    share_token_created_at: new Date().toISOString(),
  }, row.share_token ? 200 : 201);
};

const handleAgreementShareLinkRevoke = async (env, ctx, session, id) => {
  const row = await agreementById(env, id);
  if (!row) return json({ error: "agreement_not_found" }, 404);
  await env.DB.prepare(
    "UPDATE agreements SET share_token=NULL, share_token_created_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(id).run();
  audit(env, ctx, session.name, "agreement.share_link_revoked", "agreement", id, {
    agreement_number: row.agreement_number, kind: row.kind, company_id: row.company_id,
  });
  return json({ share_path: null, share_url: null, share_token_created_at: null });
};


/**
 * The agreement ledger as a spreadsheet: one row per record, both amounts and the
 * derived balance, so finance never has to recompute the arithmetic.
 */
const handleAgreementCsvExport = async (env, url) => {
  const companyId = url.searchParams.get("company_id");
  if (!companyId) return json({ error: "company_id_required" }, 400);
  const rawKind = (url.searchParams.get("kind") || "").trim().toLowerCase();
  const kind = rawKind === "all" ? "" : agreementKindOf(rawKind);
  const company = await env.DB.prepare("SELECT name,currency FROM companies WHERE id=?").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  const rows = await env.DB.prepare(
    "SELECT kind,agreement_number,agreement_date,vehicle_model,vehicle_year,vehicle_chassis," +
    "vehicle_plate,vehicle_color,seller_name,seller_id_number,seller_phone,buyer_name,buyer_id_number," +
    "buyer_phone,intermediary_name,intermediary_commission,full_amount_cents,paid_amount_cents," +
    "currency,status,notes,created_at FROM agreements WHERE company_id=? " +
    `${kind ? "AND kind=? " : ""}AND deleted_at IS NULL ORDER BY agreement_number DESC`
  ).bind(companyId, ...(kind ? [kind] : [])).all();

  const lines = [
    "kind,agreement,date,model,year,chassis,plate,color,seller,seller_id,seller_phone," +
    "buyer,buyer_id,buyer_phone,intermediary,commission,full_amount,paid_amount,balance," +
    "currency,status,notes,created",
  ];
  for (const row of rows.results || []) {
    const full = Number(row.full_amount_cents || 0);
    const paid = Number(row.paid_amount_cents || 0);
    lines.push([
      row.kind, row.agreement_number, row.agreement_date, row.vehicle_model, row.vehicle_year,
      row.vehicle_chassis, row.vehicle_plate, row.vehicle_color, row.seller_name, row.seller_id_number,
      row.seller_phone, row.buyer_name, row.buyer_id_number, row.buyer_phone, row.intermediary_name,
      row.intermediary_commission, (full / 100).toFixed(2), (paid / 100).toFixed(2),
      ((full - paid) / 100).toFixed(2), row.currency || company.currency, row.status, row.notes,
      row.created_at,
    ].map(csvCell).join(","));
  }
  const name = kind ? `${kind}-agreements` : "agreements";
  return new Response(lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}-${todayIso()}.csv"`,
      "cache-control": "no-store",
    },
  });
};


/* ============================== print ============================== */

/**
 * One sheet response for every HTML document the Worker renders (quotation and
 * agreement prints), so the autoprint hash and the CSP can never drift apart.
 */
const sheetResponse = async (html, autoprint) => {
  let body = html;
  if (autoprint) {
    const tag = `<script>${AUTOPRINT_SCRIPT}</script>`;
    body = html.includes("</body>") ? html.replace("</body>", tag + "</body>") : html + tag;
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
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
    },
  });
};

/**
 * Splits a legal name into its brand word and the remainder, so a template can keep the first
 * word in the sheet's accent colour without letting markup into the value (values stay escaped):
 * "CHALLENGER USED CARS EXHB. LLC" -> { head: "CHALLENGER", tail: "USED CARS EXHB. LLC" }.
 */
const splitBrandWord = (value) => {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  const head = parts.shift() || "";
  return { head, tail: parts.join(" ") };
};

/**
 * Company-derived print fields. Quotation sheets and agreement sheets both print the
 * same lockup, logo rules and letterhead, so the mapping lives in one place.
 */
const companyPrintFields = (row) => {
  const snapshot = parseJson(row.company_snapshot_json);
  /* Branding follows the live company profile, exactly like the letterhead: a logo that
     is replaced or removed must never leave a broken image on a reprint. The snapshot
     value is only used where no company row is joined (template preview). */
  const logoUrl = row.company_logo_key === undefined
    ? snapshot.logo_url || ""
    : logoUrlFor({ id: row.company_id, logo_key: row.company_logo_key }) || "";
  /* Both legal names print in the header lockup. Wording comes from the snapshot; the live
     column only fills the gaps, which is how quotations issued before the Arabic name existed
     still print it after the profile is completed. */
  const legalEn = snapshot.legal_name || snapshot.name || row.company_legal_name || row.company_name || "";
  const legalAr = snapshot.legal_name_ar || row.company_legal_name_ar || "";
  const brandEn = splitBrandWord(legalEn);
  const brandAr = splitBrandWord(legalAr);
  return {
    currency: snapshot.currency || "AED",
    company_name: snapshot.legal_name || snapshot.name || row.company_name || "",
    /* the two legal names, English then Arabic, plus their accent-ready halves */
    company_legal_name_en: legalEn,
    company_legal_name_en_head: brandEn.head,
    company_legal_name_en_tail: brandEn.tail,
    company_legal_name_ar: legalAr,
    company_legal_name_ar_head: brandAr.head,
    company_legal_name_ar_tail: brandAr.tail,
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

const buildPrintFields = (row) => ({
  quote_number: row.quote_number,
  quote_date: formatDateDMY(row.quote_date),
  model: row.model,
  year: row.year,
  chassis: row.chassis,
  /* the free-form note from the quotation itself; the Challenger sheet prints it in its fourth row */
  comments: commentsField(row.comments || ""),
  amount: formatMoney(row.amount_cents),
  amount_words: row.amount_words,
  ...companyPrintFields(row),
});

const handlePrint = async (env, url, id) => {
  const row = await env.DB.prepare(
    "SELECT q.*, c.name AS company_name, c.legal_name AS company_legal_name, " +
    "c.legal_name_ar AS company_legal_name_ar, c.logo_key AS company_logo_key " +
    "FROM quotations q JOIN companies c ON c.id=q.company_id " +
    "WHERE q.id=? AND q.deleted_at IS NULL"
  ).bind(id).first();
  if (!row) return json({ error: "quotation_not_found" }, 404);
  const autoprint = ["1", "true", "yes"].includes((url.searchParams.get("print") || "").toLowerCase());
  return sheetResponse(renderQuote(row.template_html_snapshot || DEFAULT_TEMPLATE, buildPrintFields(row)), autoprint);
};

/* ============================ public share ============================ */

/**
 * A share token is a bearer credential in a URL, so it is matched exactly and only
 * ever resolves a live quotation: revoking the token, cancelling the record or
 * rotating the link all make the same 404 page appear.
 */
const shareRowFor = (env, token) =>
  env.DB.prepare(
    "SELECT q.*, c.name AS company_name, c.legal_name AS company_legal_name, " +
    "c.legal_name_ar AS company_legal_name_ar, c.phone AS company_phone, c.email AS company_email, " +
    "c.logo_key AS company_logo_key FROM quotations q JOIN companies c ON c.id=q.company_id " +
    "WHERE q.share_token=? AND q.deleted_at IS NULL"
  ).bind(token).first();

const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const htmlResponse = async (body, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      /* inline styles for the document itself, plus the one hashed script behind the
         Print button — nothing is loaded from anywhere else */
      "content-security-policy": [
        "default-src 'none'",
        "img-src 'self' data:",
        "style-src 'unsafe-inline'",
        `script-src 'sha256-${await shareScriptHash()}'`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      /* a customer link is nobody's search result, and it never leaks its referrer */
      "x-robots-tag": "noindex, nofollow, noarchive",
      "referrer-policy": "no-referrer",
    },
  });

const handleSharePage = async (request, env, token) => {
  const row = SHARE_TOKEN_PATTERN.test(token) ? await shareRowFor(env, token) : null;
  if (!row) return htmlResponse(renderShareMissing(), 404);
  const scan = await scanRow(env, row.id);
  const snapshot = parseJson(row.company_snapshot_json);
  const origin = new URL(request.url).origin;
  const base = origin + sharePath(token);
  return htmlResponse(renderSharePage({
    quotation: {
      quote_number: row.quote_number,
      quote_date_text: formatDateDMY(row.quote_date),
      model: row.model,
      year: row.year,
      chassis: row.chassis,
      amount: formatMoney(row.amount_cents),
      currency: snapshot.currency || "AED",
      amount_words: row.amount_words,
      comments: commentsField(row.comments || ""),
      status: row.status === "completed" ? "completed" : "issued",
    },
    company: {
      name: row.company_name || "",
      legal_name: snapshot.legal_name || row.company_legal_name || row.company_name || "",
      legal_name_ar: snapshot.legal_name_ar || row.company_legal_name_ar || "",
      phone: snapshot.phone || row.company_phone || "",
      email: snapshot.email || row.company_email || "",
    },
    scan: scan
      ? {
        bytes: Number(scan.bytes) || 0,
        width: Number(scan.width) || 0,
        height: Number(scan.height) || 0,
        content_type: scan.content_type || "image/jpeg",
      }
      : null,
    links: { image: `${base}/scan`, download: `${base}/scan?download=1` },
  }));
};

/** The signed picture behind a token. Public by design; unguessable by construction. */
const handleShareScan = async (env, url, token) => {
  const row = SHARE_TOKEN_PATTERN.test(token) ? await shareRowFor(env, token) : null;
  if (!row) return json({ error: "not_found" }, 404);
  const scan = await scanRow(env, row.id);
  if (!scan) return json({ error: "scan_not_found" }, 404);
  if (!env.ASSETS) return json({ error: "storage_unavailable" }, 503);
  const object = await env.ASSETS.get(scan.r2_key);
  if (!object) return json({ error: "scan_not_found" }, 404);
  return imageResponse(object, scan, url, `${row.quote_number}-signed`);
};

/* ---------------------- public agreement share ---------------------- */

/**
 * The same rule as a quotation link: the token is matched exactly and only ever
 * resolves a live agreement, so revoking it, cancelling the record or mistyping it
 * all end on the same 404 page. Agreements keep their own namespace (/a/<token>) so
 * a token can never be replayed against the quotation route.
 */
const agreementShareRowFor = (env, token) =>
  env.DB.prepare(
    `SELECT a.*, ${COMPANY_JOIN_COLUMNS} FROM agreements a JOIN companies c ON c.id=a.company_id ` +
    "WHERE a.share_token=? AND a.deleted_at IS NULL"
  ).bind(token).first();

const handleAgreementSharePage = async (request, env, token) => {
  const row = SHARE_TOKEN_PATTERN.test(token) ? await agreementShareRowFor(env, token) : null;
  if (!row) return htmlResponse(renderAgreementShareMissing(), 404);
  const scan = await agreementScanRowFor(env, row.id);
  const snapshot = parseJson(row.company_snapshot_json);
  const origin = new URL(request.url).origin;
  const base = origin + agreementSharePath(token);
  const full = Number(row.full_amount_cents || 0);
  const paid = Number(row.paid_amount_cents || 0);
  return htmlResponse(renderAgreementSharePage({
    agreement: {
      agreement_number: row.agreement_number,
      kind_label: agreementKindLabel(row.kind),
      agreement_date_text: formatDateDMY(row.agreement_date),
      status: row.status === "completed" ? "completed" : "issued",
      vehicle_model: row.vehicle_model || "",
      vehicle_year: row.vehicle_year || "",
      vehicle_chassis: row.vehicle_chassis || "",
      vehicle_plate: row.vehicle_plate || "",
      vehicle_color: row.vehicle_color || "",
      seller_name: row.seller_name || "",
      buyer_name: row.buyer_name || "",
      full_amount: formatMoney(full),
      paid_amount: formatMoney(paid),
      balance: formatMoney(full - paid),
      currency: row.currency || snapshot.currency || "AED",
      full_amount_words: row.full_amount_words || amountWordsFromCents(full),
      balance_words: amountWordsFromCents(full - paid),
      notes: row.notes || "",
    },
    company: {
      name: row.company_name || "",
      legal_name: snapshot.legal_name || row.company_legal_name || row.company_name || "",
      legal_name_ar: snapshot.legal_name_ar || row.company_legal_name_ar || "",
      phone: snapshot.phone || "",
      email: snapshot.email || "",
    },
    scan: scan
      ? {
        bytes: Number(scan.bytes) || 0,
        width: Number(scan.width) || 0,
        height: Number(scan.height) || 0,
        content_type: scan.content_type || "image/jpeg",
      }
      : null,
    links: { image: `${base}/scan`, download: `${base}/scan?download=1` },
  }));
};

/** The signed agreement behind a token. Public by design; unguessable by construction. */
const handleAgreementShareScan = async (env, url, token) => {
  const row = SHARE_TOKEN_PATTERN.test(token) ? await agreementShareRowFor(env, token) : null;
  if (!row) return json({ error: "not_found" }, 404);
  const scan = await agreementScanRowFor(env, row.id);
  if (!scan) return json({ error: "scan_not_found" }, 404);
  if (!env.ASSETS) return json({ error: "storage_unavailable" }, 503);
  const object = await env.ASSETS.get(scan.r2_key);
  if (!object) return json({ error: "scan_not_found" }, 404);
  return imageResponse(object, scan, url, `${row.agreement_number}-signed`);
};


/* ============================== export ============================== */

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

const handleCsvExport = async (env, url) => {
  const companyId = url.searchParams.get("company_id");
  if (!companyId) return json({ error: "company_id_required" }, 400);
  const company = await env.DB.prepare("SELECT name,currency FROM companies WHERE id=?").bind(companyId).first();
  if (!company) return json({ error: "company_not_found" }, 404);
  const rows = await env.DB.prepare(
    "SELECT quote_number,quote_date,model,year,chassis,comments,amount_cents,amount_words,created_at " +
    "FROM quotations WHERE company_id=? AND deleted_at IS NULL ORDER BY quote_number DESC"
  ).bind(companyId).all();
  const lines = ["quotation,date,model,year,chassis,comments,amount,currency,amount_words,created"];
  for (const row of rows.results || []) {
    lines.push([
      row.quote_number, row.quote_date, row.model, row.year, row.chassis, row.comments,
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

const KNOWN_RESOURCES = new Set([
  "companies", "templates", "quotations", "agreements", "export", "auth", "settings", "audit",
]);


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

  if (resource === "audit" && !id && method === "GET") return handleAuditList(env, url);

  if (resource === "companies") {
    if (!id && method === "GET") return handleCompanyList(env);
    if (!id && method === "POST") return handleCompanyCreate(request, env, ctx, session);
    if (id && !action && method === "PATCH") return handleCompanyPatch(request, env, ctx, session, id);
    if (id && !action && method === "DELETE") return handleCompanyDeactivate(env, ctx, session, id);
    if (id && action === "delete-summary" && !child && method === "GET") return handleCompanyDeleteSummary(env, id);
    if (id && action === "permanent" && !child && method === "DELETE") {
      return handleCompanyPermanentDelete(request, env, session, id);
    }
    if (id && action === "logo" && !child) {
      if (method === "POST") return handleCompanyLogoUpload(request, env, ctx, session, id);
      if (method === "DELETE") return handleCompanyLogoDelete(env, ctx, session, id);
    }
    if (id && action === "templates" && !child) {
      if (method === "GET") return handleTemplateList(env, id, url);
      if (method === "POST") return handleTemplateSave(request, env, ctx, session, id);
    }
    if (id && action === "templates" && child === "default" && !tail && method === "GET") {
      return handleTemplateDefault(env, id, url);
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
    if (id && action === "restore" && !child && method === "POST") {
      return handleQuotationRestore(env, ctx, session, id);
    }
    if (id && action === "permanent" && !child && method === "DELETE") {
      return handleQuotationPermanentDelete(request, env, session, id);
    }
    if (id && !action && method === "GET") return handleQuotationGet(env, id);
    if (id && !action && method === "PATCH") return handleQuotationPatch(request, env, ctx, session, id);
    if (id && !action && method === "DELETE") return handleQuotationCancel(env, ctx, session, id);
    if (id && action === "print" && method === "GET") return handlePrint(env, url, id);
    if (id && action === "scan" && !child) {
      if (method === "GET") return handleQuotationScanGet(env, id, url);
      if (method === "POST") return handleQuotationScanUpload(request, env, ctx, session, id);
      if (method === "DELETE") return handleQuotationScanDelete(env, ctx, session, id);
    }
    if (id && action === "status" && !child && method === "PATCH") {
      return handleQuotationStatus(request, env, ctx, session, id);
    }
    if (id && action === "share-link" && !child) {
      if (method === "POST") return handleShareLinkCreate(request, env, ctx, session, id);
      if (method === "DELETE") return handleShareLinkRevoke(env, ctx, session, id);
    }
  }

  if (resource === "agreements") {
    if (!id && method === "GET") return handleAgreementList(env, url);
    if (!id && method === "POST") return handleAgreementCreate(request, env, ctx, session);
    if (id === "next-number" && !action && method === "GET") return handleAgreementNextNumber(env, url);
    if (id && action === "restore" && !child && method === "POST") {
      return handleAgreementRestore(env, ctx, session, id);
    }
    if (id && action === "permanent" && !child && method === "DELETE") {
      return handleAgreementPermanentDelete(request, env, ctx, session, id);
    }
    if (id && !action && method === "GET") return handleAgreementGet(env, id);
    if (id && !action && method === "PATCH") return handleAgreementPatch(request, env, ctx, session, id);
    if (id && !action && method === "DELETE") return handleAgreementCancel(env, ctx, session, id);
    if (id && action === "print" && !child && method === "GET") return handleAgreementPrint(env, url, id);
    if (id && action === "scan" && !child) {
      if (method === "GET") return handleAgreementScanGet(env, id, url);
      if (method === "POST") return handleAgreementScanUpload(request, env, ctx, session, id);
      if (method === "DELETE") return handleAgreementScanDelete(env, ctx, session, id);
    }
    if (id && action === "status" && !child && method === "PATCH") {
      return handleAgreementStatus(request, env, ctx, session, id);
    }
    if (id && action === "share-link" && !child) {
      if (method === "POST") return handleAgreementShareLinkCreate(request, env, ctx, session, id);
      if (method === "DELETE") return handleAgreementShareLinkRevoke(env, ctx, session, id);
    }
  }

  if (resource === "settings" && !id) {
    if (method === "GET") return handleSettingsGet(env);
    if (method === "PATCH") return handleSettingsPatch(request, env, ctx, session);
  }


  if (resource === "export" && id === "quotations.csv" && method === "GET") return handleCsvExport(env, url);
  if (resource === "export" && id === "agreements.csv" && method === "GET") return handleAgreementCsvExport(env, url);

  return json({ error: "not_found", path }, 404);
}

export default {
  /**
   * @param {Request} request
   * @param {{DB:D1Database,ASSETS?:R2Bucket,STATIC?:Fetcher,SESSION_HOURS?:string}} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* Customer links live outside /api/ on purpose: no cookie, no JSON, one document. */
    if (url.pathname === "/s" || url.pathname.startsWith("/s/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method_not_allowed" }, 405);
      }
      const [token, action, ...rest] = url.pathname.slice("/s/".length).split("/").filter(Boolean);
      if (rest.length) return json({ error: "not_found" }, 404);
      try {
        if (action === "scan") return await handleShareScan(env, url, token || "");
        if (action) return json({ error: "not_found" }, 404);
        return await handleSharePage(request, env, token || "");
      } catch (error) {
        console.error(JSON.stringify({
          event: "share_page_failed",
          token_length: String(token || "").length,
          message: error?.message || String(error),
        }));
        return htmlResponse(renderShareMissing(), 500);
      }
    }

    /* Agreement links are their own namespace: /a/<token> and /a/<token>/scan. */
    if (url.pathname === "/a" || url.pathname.startsWith("/a/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method_not_allowed" }, 405);
      }
      const [token, action, ...rest] = url.pathname.slice("/a/".length).split("/").filter(Boolean);
      if (rest.length) return json({ error: "not_found" }, 404);
      try {
        if (action === "scan") return await handleAgreementShareScan(env, url, token || "");
        if (action) return json({ error: "not_found" }, 404);
        return await handleAgreementSharePage(request, env, token || "");
      } catch (error) {
        console.error(JSON.stringify({
          event: "agreement_share_page_failed",
          token_length: String(token || "").length,
          message: error?.message || String(error),
        }));
        return htmlResponse(renderAgreementShareMissing(), 500);
      }
    }


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

