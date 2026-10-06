import type { Env } from "./worker.ts";

const COOKIE = "__Host-cookie_admin";
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_LIMIT = 8;
const PAGE_SIZES = new Set([10, 25, 50, 100]);
const HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
};

type Session = {
  token_hash: string;
  csrf_token: string;
  email: string;
  expires_at: number;
};
type Registration = {
  id: number;
  name: string;
  email: string;
  school: string;
  grade: string;
  fun_fact: string;
  created_at: string;
};
const COLUMNS = "id, name, email, school, grade, fun_fact, created_at";
const SEARCH =
  "(name LIKE ?1 ESCAPE '!' OR email LIKE ?1 ESCAPE '!' OR school LIKE ?1 ESCAPE '!' OR grade LIKE ?1 ESCAPE '!' OR fun_fact LIKE ?1 ESCAPE '!')";

function json(status: number, body: Record<string, unknown>, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    },
  });
}
function error(status: number, message: string, extra = {}) {
  return json(status, { ok: false, error: message }, extra);
}
function redirect(location: string) {
  return new Response(null, {
    status: 303,
    headers: { ...HEADERS, Location: location },
  });
}
async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function equalHashes(left: string, right: string) {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
function cookie(value: string, maxAge = SESSION_SECONDS) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function sessionToken(request: Request) {
  const value = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function configured(env: Env) {
  if (
    !env.ADMIN_PASSWORD_HASH ||
    !/^[a-f0-9]{64}$/.test(env.ADMIN_PASSWORD_HASH) ||
    !env.ADMIN_EMAIL
  )
    return false;
  try {
    const url = new URL(env.ADMIN_ORIGIN!);
    return (
      url.origin === env.ADMIN_ORIGIN &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
async function query<T>(
  env: Env,
  sql: string,
  ...values: (string | number | null)[]
): Promise<T[]> {
  const result = await env.DB.prepare(sql)
    .bind(...values)
    .run<T>();
  if (!result.success) throw new Error("Database unavailable");
  return result.results;
}
async function getSession(request: Request, env: Env): Promise<Session | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const sessions = await query<Session>(
    env,
    "SELECT token_hash, csrf_token, email, expires_at FROM admin_sessions WHERE token_hash = ?1 AND expires_at > ?2 AND credential_version = ?3 AND email = ?4",
    await digest(token),
    Math.floor(Date.now() / 1000),
    await digest(env.ADMIN_PASSWORD_HASH!),
    env.ADMIN_EMAIL!,
  );
  return sessions[0] ?? null;
}

// Limit bytes even when Content-Length is missing. Never log request bodies.
async function loginBody(
  request: Request,
): Promise<{ password: string } | null> {
  if (
    request.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json" ||
    !request.body
  )
    return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2048) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    if (
      !body ||
      Array.isArray(body) ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      typeof body.password !== "string" ||
      body.password.length < 1 ||
      body.password.length > 256
    )
      return null;
    return body;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
async function login(request: Request, env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / LOGIN_WINDOW_SECONDS);
  const expiresAt = (window + 1) * LOGIN_WINDOW_SECONDS;
  const bucket = await digest(
    `admin:${window}:${request.headers.get("CF-Connecting-IP") || "local"}`,
  );
  await query(
    env,
    "DELETE FROM admin_login_attempts WHERE expires_at <= ?1",
    now,
  );
  const [limit] = await query<{ attempts: number }>(
    env,
    "INSERT INTO admin_login_attempts (bucket_hash, attempts, expires_at) VALUES (?1, 1, ?2) ON CONFLICT(bucket_hash) DO UPDATE SET attempts = MIN(attempts + 1, 9) RETURNING attempts",
    bucket,
    expiresAt,
  );
  if (!limit || limit.attempts > LOGIN_LIMIT)
    return error(
      429,
      "Too many sign-in attempts. Please try again in a few minutes.",
      { "Retry-After": String(expiresAt - now) },
    );
  const body = await loginBody(request);
  if (!body) return error(400, "Enter your admin password.");
  if (!equalHashes(await digest(body.password), env.ADMIN_PASSWORD_HASH!))
    return error(401, "That password isn’t correct.");
  const token = randomToken();
  const csrf = randomToken();
  await query(env, "DELETE FROM admin_sessions WHERE expires_at <= ?1", now);
  await query(
    env,
    "INSERT INTO admin_sessions (token_hash, csrf_token, credential_version, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    await digest(token),
    csrf,
    await digest(env.ADMIN_PASSWORD_HASH!),
    env.ADMIN_EMAIL!,
    now,
    now + SESSION_SECONDS,
  );
  await query(
    env,
    "DELETE FROM admin_login_attempts WHERE bucket_hash = ?1",
    bucket,
  );
  return json(200, { ok: true }, { "Set-Cookie": cookie(token) });
}

function searchPattern(url: URL) {
  const search = (url.searchParams.get("search") || "").trim();
  if (search.length > 200) return null;
  return `%${search.replace(/[!%_]/g, (character) => `!${character}`)}%`;
}
function pageNumber(value: string | null, fallback: number) {
  return value === null
    ? fallback
    : /^[1-9]\d{0,7}$/.test(value)
      ? Number(value)
      : null;
}
async function registrations(url: URL, env: Env) {
  const pattern = searchPattern(url);
  const requestedPage = pageNumber(url.searchParams.get("page"), 1);
  const pageSize = pageNumber(url.searchParams.get("pageSize"), 25);
  if (
    pattern === null ||
    requestedPage === null ||
    pageSize === null ||
    !PAGE_SIZES.has(pageSize)
  )
    return error(400, "Check the search or page settings.");
  const [count] = await query<{ total: number }>(
    env,
    `SELECT COUNT(*) AS total FROM community_members WHERE ${SEARCH}`,
    pattern,
  );
  const total = count.total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const rows = await query<Registration>(
    env,
    `SELECT ${COLUMNS} FROM community_members WHERE ${SEARCH} ORDER BY id DESC LIMIT ?2 OFFSET ?3`,
    pattern,
    pageSize,
    (page - 1) * pageSize,
  );
  const [stats] = await query<{
    total: number;
    today: number;
    schools: number;
  }>(
    env,
    "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END), 0) AS today, COUNT(DISTINCT lower(trim(school))) AS schools FROM community_members",
    `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
  );
  return json(200, {
    ok: true,
    registrations: rows,
    total,
    page,
    pageSize,
    totalPages,
    stats,
  });
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  // Quoting alone does not stop spreadsheet formulas. Prefix dangerous cells.
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
function csvRows(rows: Registration[]) {
  return rows
    .map(
      (row) =>
        [
          row.id,
          row.name,
          row.email,
          row.school,
          row.grade,
          row.fun_fact,
          row.created_at,
        ]
          .map(csvCell)
          .join(",") + "\r\n",
    )
    .join("");
}
async function exportRegistrations(url: URL, env: Env) {
  const pattern = searchPattern(url);
  if (pattern === null)
    return error(400, "Keep the search under 200 characters.");
  const [snapshot] = await query<{ lastId: number }>(
    env,
    "SELECT COALESCE(MAX(id), 0) AS lastId FROM community_members",
  );
  const select = `SELECT ${COLUMNS} FROM community_members WHERE ${SEARCH} AND id > ?2 AND id <= ?3 ORDER BY id ASC LIMIT 500`;
  let batch = await query<Registration>(
    env,
    select,
    pattern,
    0,
    snapshot.lastId,
  );
  let cursor = 0;
  let first = true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!first)
          batch = await query<Registration>(
            env,
            select,
            pattern!,
            cursor,
            snapshot.lastId,
          );
        const header = first
          ? "\uFEFFID,Name,Email,School,Grade / year,Fun fact,Joined at (UTC)\r\n"
          : "";
        first = false;
        controller.enqueue(encoder.encode(header + csvRows(batch)));
        if (batch.length < 500 || batch[batch.length - 1].id >= snapshot.lastId)
          controller.close();
        else cursor = batch[batch.length - 1].id;
      } catch {
        controller.error(
          new Error("The export could not finish. Please retry."),
        );
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cookie-registrations-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
async function asset(request: Request, env: Env, path: string) {
  const response = await env.ASSETS.fetch(
    new Request(new URL(path, request.url), {
      method: request.method,
      headers: request.headers,
    }),
  );
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

export async function handleAdmin(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const api = url.pathname.startsWith("/api/");
  if (!configured(env))
    return error(503, "Admin sign-in is not configured yet.");
  if (url.origin !== env.ADMIN_ORIGIN) {
    return !api && ["GET", "HEAD"].includes(request.method)
      ? redirect(new URL(url.pathname + url.search, env.ADMIN_ORIGIN).href)
      : error(403, "Please use the admin portal on the main website.");
  }
  const origin = request.headers.get("Origin");
  if (
    (origin !== null && origin !== env.ADMIN_ORIGIN) ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    return error(403, "Please use the admin portal on this website.");
  try {
    if (url.pathname === "/api/admin/login") {
      if (request.method !== "POST")
        return error(405, "Use POST to sign in.", { Allow: "POST" });
      if (origin !== env.ADMIN_ORIGIN)
        return error(403, "Please sign in from this website.");
      return await login(request, env);
    }
    if (!api && ["GET", "HEAD"].includes(request.method)) {
      if (["/admin/admin.css", "/admin/login.js"].includes(url.pathname))
        return await asset(request, env, url.pathname);
      if (
        ["/admin/login", "/admin/login/", "/admin/login.html"].includes(
          url.pathname,
        )
      ) {
        if (await getSession(request, env)) return redirect("/admin/");
        return await asset(request, env, "/admin/login");
      }
    }
    const session = await getSession(request, env);
    if (!session)
      return api
        ? error(401, "Please sign in to view registrations.")
        : redirect("/admin/login");
    if (url.pathname === "/api/admin/logout") {
      if (request.method !== "POST")
        return error(405, "Use POST to sign out.", { Allow: "POST" });
      if (
        origin !== env.ADMIN_ORIGIN ||
        !equalHashes(
          request.headers.get("X-CSRF-Token") || "",
          session.csrf_token,
        )
      )
        return error(403, "Please sign out from this page.");
      await query(
        env,
        "DELETE FROM admin_sessions WHERE token_hash = ?1",
        session.token_hash,
      );
      return json(200, { ok: true }, { "Set-Cookie": cookie("", 0) });
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return error(405, "Use GET to view registrations.", {
        Allow: "GET, HEAD",
      });
    if (url.pathname === "/api/admin/session")
      return json(200, {
        ok: true,
        email: session.email,
        csrfToken: session.csrf_token,
      });
    if (url.pathname === "/api/admin/registrations")
      return await registrations(url, env);
    if (url.pathname === "/api/admin/export")
      return await exportRegistrations(url, env);
    if (["/admin", "/admin/", "/admin/index.html"].includes(url.pathname))
      return url.pathname === "/admin"
        ? redirect("/admin/")
        : await asset(request, env, "/admin/");
    if (url.pathname === "/admin/admin.js")
      return await asset(request, env, url.pathname);
    return error(404, "Not found.");
  } catch {
    // Fail closed, without returning database errors, submitted data, or credentials.
    return error(
      503,
      "The admin portal is temporarily unavailable. Please try again.",
    );
  }
}
