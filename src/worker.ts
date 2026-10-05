type SQLValue = string | number | null;

interface DatabaseResult<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
}

interface Statement {
  bind(...values: SQLValue[]): Statement;
  run<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
}

export interface Env {
  DB: { prepare(sql: string): Statement };
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const BODY_LIMIT = 16 * 1024;
const RATE_WINDOW_SECONDS = 10 * 60;
const RATE_LIMIT = 30;
const FIELD_LIMITS = {
  name: 100,
  email: 254,
  school: 150,
  grade: 80,
  funFact: 500,
} as const;
type JoinFields = { -readonly [Key in keyof typeof FIELD_LIMITS]: string };

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const STATIC_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function json(
  status: number,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      ...extraHeaders,
    },
  });
}

function error(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json(status, { ok: false, error: message }, headers);
}

class BodyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJSON(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength))
      throw new BodyError(400, "Invalid request body.");
    if (Number(declaredLength) > BODY_LIMIT)
      throw new BodyError(413, "The form is too large.");
  }
  if (!request.body) throw new BodyError(400, "Please send a completed form.");

  // Enforce the byte limit while streaming; Content-Length is neither required nor trusted.
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw new BodyError(413, "The form is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (cause) {
    if (cause instanceof BodyError) throw cause;
    throw new BodyError(400, "Please send valid JSON.");
  } finally {
    reader.releaseLock();
  }
}

function isEmail(value: string): boolean {
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (
    !local ||
    local.length > 64 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
  )
    return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes(".."))
    return false;
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    ) &&
    /^[a-z]{2,63}$/i.test(labels.at(-1)!)
  );
}

function validate(payload: unknown): JoinFields | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const input = payload as Record<string, unknown>;
  const allowed = new Set([...Object.keys(FIELD_LIMITS), "website"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;
  if (
    input.website !== undefined &&
    (typeof input.website !== "string" || input.website.trim() !== "")
  )
    return null;

  const fields = {} as JoinFields;
  for (const key of Object.keys(FIELD_LIMITS) as (keyof JoinFields)[]) {
    if (typeof input[key] !== "string") return null;
    const value = input[key].trim();
    if (!value || value.length > FIELD_LIMITS[key]) return null;
    // Allow ordinary line breaks in the fun fact, but never control characters in contact fields.
    if (
      (key === "funFact"
        ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
        : /[\u0000-\u001f\u007f]/
      ).test(value)
    )
      return null;
    fields[key] = value;
  }
  fields.email = fields.email.toLowerCase();
  return isEmail(fields.email) ? fields : null;
}

async function takeRateLimitSlot(
  request: Request,
  env: Env,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / RATE_WINDOW_SECONDS);
  const expiresAt = (window + 1) * RATE_WINDOW_SECONDS;
  // Cloudflare sets this header. Do not trust client-controlled X-Forwarded-For.
  // Local requests without it share a bucket. Neither IPs nor contact fields are logged.
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${window}:${ip}`),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  const cleanup = await env.DB.prepare(
    "DELETE FROM join_rate_limits WHERE expires_at <= ?1",
  )
    .bind(now)
    .run();
  if (!cleanup.success) throw new Error("Database unavailable");
  // The atomic upsert also covers concurrent requests. Saturate the counter once blocked.
  const result = await env.DB.prepare(
    "INSERT INTO join_rate_limits (bucket_hash, attempts, expires_at) VALUES (?1, 1, ?2) " +
      "ON CONFLICT(bucket_hash) DO UPDATE SET attempts = MIN(attempts + 1, ?3) RETURNING attempts",
  )
    .bind(hash, expiresAt, RATE_LIMIT + 1)
    .run<{ attempts: number }>();
  const attempts = result.results?.[0]?.attempts;
  if (!result.success || typeof attempts !== "number")
    throw new Error("Database unavailable");
  return { allowed: attempts <= RATE_LIMIT, retryAfter: expiresAt - now };
}

async function join(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST")
    return error(405, "Use POST to submit the form.", { Allow: "POST" });
  const origin = request.headers.get("Origin");
  if (
    (origin !== null && origin !== new URL(request.url).origin) ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  ) {
    return error(403, "Please submit the form from this website.");
  }
  if (
    request.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  ) {
    return error(415, "Please send the form as JSON.");
  }

  let payload: unknown;
  try {
    payload = await readJSON(request);
  } catch (cause) {
    if (cause instanceof BodyError) return error(cause.status, cause.message);
    return error(400, "Invalid request body.");
  }
  const fields = validate(payload);
  if (!fields)
    return error(
      400,
      "Please check every field and enter a valid email address.",
    );

  try {
    const limit = await takeRateLimitSlot(request, env);
    if (!limit.allowed)
      return error(
        429,
        "Too many attempts. Please try again in a few minutes.",
        { "Retry-After": String(limit.retryAfter) },
      );
    const result = await env.DB.prepare(
      "INSERT INTO community_members (name, email, school, grade, fun_fact) VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(email) DO NOTHING",
    )
      .bind(
        fields.name,
        fields.email,
        fields.school,
        fields.grade,
        fields.funFact,
      )
      .run();
    if (!result.success) throw new Error("Database unavailable");
    // Return the same response for a new or existing email; never overwrite an existing signup.
    return json(201, {
      ok: true,
      message: "Thanks — your details have been received.",
    });
  } catch {
    // Do not expose SQL errors or log personal data. A failed write must never look successful.
    return error(
      503,
      "We could not save your form right now. Please try again shortly.",
      { "Retry-After": "30" },
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/join") return join(request, env);
    if (path === "/api" || path.startsWith("/api/"))
      return error(404, "Not found.");

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      headers.set(name, value);
    headers.set("Content-Security-Policy", STATIC_CSP);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
