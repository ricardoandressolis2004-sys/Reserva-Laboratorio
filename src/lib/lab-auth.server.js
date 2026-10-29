// Utilidades exclusivas del servidor: contraseñas, sesiones, IP y configuración.
import { getRequest } from "@tanstack/react-start/server";
import { todayInTz, windowOpen, addDays, parseDate, fmtDate, TOTAL_DAY_CAPACITY } from "@/lib/lab-constants";

const PBKDF2_ITERATIONS = 60000;
const SESSION_DAYS = 7;

const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function randomHex(size = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(size)));
}

async function derive(password, saltHex) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(bits);
}

export async function hashPassword(password) {
  const salt = randomHex(16);
  return `${salt}:${await derive(password, salt)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const candidate = await derive(password, salt);
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export async function sha256(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export function serviceRole(context) {
  return context.getBase44().asServiceRole;
}

export async function createToken(srp, { kind, role, userId, minutes }) {
  const token = randomHex(32);
  const expires = new Date(Date.now() + (minutes ? minutes * 60000 : SESSION_DAYS * 86400000)).toISOString();
  await srp.entities.SessionToken.create({
    token_hash: await sha256(token),
    kind,
    role,
    user_id: userId,
    expires_at: expires,
  });
  return token;
}

export async function readToken(srp, token, kind = "session") {
  if (!token || typeof token !== "string") return null;
  const hash = await sha256(token);
  const rows = await srp.entities.SessionToken.filter({ token_hash: hash, kind });
  const record = rows.find((row) => new Date(row.expires_at).getTime() > Date.now());
  return record ?? null;
}

export async function readSession(srp, token) {
  return readToken(srp, token, "session");
}

export async function loadStudent(srp, id) {
  return srp.entities.Student.get(id).catch(() => null);
}

export async function loadAdmin(srp, id) {
  return srp.entities.Admin.get(id).catch(() => null);
}

export function publicStudent(student) {
  if (!student) return null;
  return {
    id: student.id,
    matricula: student.matricula,
    first_name: student.first_name,
    last_name: student.last_name,
    email: student.email,
  };
}

export function publicAdmin(admin) {
  if (!admin) return null;
  return {
    id: admin.id,
    username: admin.username,
    first_name: admin.first_name,
    last_name: admin.last_name,
    email: admin.email,
  };
}

export async function getConfig(srp) {
  const rows = await srp.entities.AppConfig.list("-created_date", 5);
  if (rows.length) return rows[0];
  return srp.entities.AppConfig.create({
    allowed_ips: "10.4.26.250, 10.0.98.40",
    registration_enabled: false,
    teams_enabled: false,
    ip_restriction_enabled: true,
  });
}

export function allowedIpList(config) {
  return String(config?.allowed_ips || "")
    .split(/[,\s]+/)
    .map((ip) => ip.trim())
    .filter(Boolean);
}

export function ipRestrictionOn(config) {
  return config?.ip_restriction_enabled !== false;
}

export function requestIp() {
  let request;
  try {
    request = getRequest();
  } catch {
    return "";
  }
  if (!request) return "";
  const headers = request.headers;
  const direct = headers.get("cf-connecting-ip") || headers.get("x-real-ip");
  if (direct) return direct.trim();
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "";
}

export function normalizeIp(ip) {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export function registrationOpen(config) {
  const today = todayInTz();
  return windowOpen(config?.registration_enabled, config?.registration_start, config?.registration_end, today);
}

export function teamsWindowOpen(config) {
  const today = todayInTz();
  return windowOpen(config?.teams_enabled, config?.teams_start, config?.teams_end, today);
}

// Días en los que un estudiante puede apartar según las reglas:
// solo el día siguiente hábil y, si ese día ya se llenó por completo, el siguiente.
export function bookableDates(today, dayIsFull) {
  let cursor = addDays(today, 1);
  while ([0, 6].includes(new Date(parseDate(cursor)).getUTCDay())) cursor = addDays(cursor, 1);
  const dates = [cursor];
  if (dayIsFull(cursor)) {
    let next = addDays(cursor, 1);
    while ([0, 6].includes(new Date(parseDate(next)).getUTCDay())) next = addDays(next, 1);
    dates.push(next);
  }
  return dates;
}

export function isDayFull(count) {
  return count >= TOTAL_DAY_CAPACITY;
}

export function sanctionEndDate(reservationDate) {
  return addDays(reservationDate, 1);
}

export { fmtDate, parseDate };