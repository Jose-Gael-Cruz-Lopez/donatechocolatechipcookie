import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL as NodeURL } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import worker from "../src/worker.ts";
import type { Env } from "../src/worker.ts";

const origin = "https://community.example";
const password = "fixture-only-VQH3tSYZB6TszG9NqzF1z3nC9Gh2sfJt";
const email = "owner@example.com";
const ip = "192.0.2.21";
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const migrationsURL = new NodeURL("../migrations/", import.meta.url);
const migrations = readdirSync(migrationsURL)
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(new NodeURL(name, migrationsURL), "utf8"));

type AdminEnv = Env & {
  ADMIN_PASSWORD_HASH?: string;
  ADMIN_ORIGIN?: string;
  ADMIN_EMAIL?: string;
};
type Row = Record<string, string | number | null>;

function fixture(t: TestContext) {
  const sql = new DatabaseSync(":memory:");
  for (const migration of migrations) sql.exec(migration);
  t.after(() => sql.close());
  const queries: { sql: string; values: (string | number | null)[] }[] = [];
  const assets: string[] = [];
  const env: AdminEnv = {
    ADMIN_PASSWORD_HASH: sha256(password),
    ADMIN_ORIGIN: origin,
    ADMIN_EMAIL: email,
    DB: {
      prepare(query: string) {
        let values: (string | number | null)[] = [];
        return {
          bind(...bound: (string | number | null)[]) {
            values = bound;
            return this;
          },
          async run<T>() {
            queries.push({ sql: query, values });
            if (
              /\bLIKE\b/i.test(query) &&
              typeof values[0] === "string" &&
              Buffer.byteLength(values[0], "utf8") > 50
            )
              throw new Error("LIKE or GLOB pattern too complex");
            const rows = sql.prepare(query).all(...values);
            return { success: true, results: rows as T[] };
          },
        };
      },
    },
    ASSETS: {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        assets.push(path);
        // Workers Assets canonicalizes HTML URLs. Returning these redirects
        // catches a Worker that internally fetches an alias of the current URL.
        const canonical =
          path === "/admin/login.html"
            ? "/admin/login"
            : path === "/admin/index.html"
              ? "/admin/"
              : null;
        if (canonical)
          return Response.redirect(new URL(canonical, request.url).href, 308);
        return new Response(`asset:${path}`, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
  };
  function seed(
    values: Partial<
      Record<
        "name" | "email" | "school" | "grade" | "funFact" | "createdAt",
        string
      >
    > = {},
  ) {
    const next =
      Number(
        sql.prepare("SELECT COUNT(*) AS n FROM community_members").get()!.n,
      ) + 1;
    sql
      .prepare(
        "INSERT INTO community_members (name, email, school, grade, fun_fact, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        values.name ?? `Member ${next}`,
        values.email ?? `member${next}@example.com`,
        values.school ?? "Central School",
        values.grade ?? "11",
        values.funFact ?? "I collect unusual cookie cutters.",
        values.createdAt ??
          `2026-10-05T10:00:${String(next % 60).padStart(2, "0")}.000Z`,
      );
  }
  return { env, sql, queries, assets, seed };
}

function adminRequest(
  path: string,
  options: {
    method?: string;
    payload?: unknown;
    cookie?: string;
    csrf?: string;
    headers?: Record<string, string>;
    base?: string;
  } = {},
) {
  const method = options.method ?? "GET";
  const headers = new Headers({ "CF-Connecting-IP": ip, ...options.headers });
  if (options.payload !== undefined)
    headers.set("Content-Type", "application/json");
  if (method === "POST" && !headers.has("Origin"))
    headers.set("Origin", options.base ?? origin);
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
  return new Request(`${options.base ?? origin}${path}`, {
    method,
    headers,
    ...(options.payload !== undefined
      ? { body: JSON.stringify(options.payload) }
      : {}),
  });
}

function assertNoMemberQuery(queries: { sql: string }[]) {
  assert.ok(
    !queries.some((query) => /\bcommunity_members\b/i.test(query.sql)),
    "unauthenticated requests must not query member data",
  );
}

function assertPrivate(response: Response) {
  assert.match(response.headers.get("Cache-Control")!, /\bno-store\b/);
  assert.match(response.headers.get("Cache-Control")!, /\bprivate\b/);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
}

async function signIn(env: AdminEnv, headers: Record<string, string> = {}) {
  const response = await worker.fetch(
    adminRequest("/api/admin/login", {
      method: "POST",
      payload: { password },
      headers,
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const setCookie = response.headers.get("Set-Cookie")!;
  assert.ok(setCookie);
  const cookie = setCookie.split(";")[0];
  const token = cookie.slice(cookie.indexOf("=") + 1);
  const session = await worker.fetch(
    adminRequest("/api/admin/session", { cookie }),
    env,
  );
  assert.equal(session.status, 200);
  const body = (await session.json()) as {
    ok: boolean;
    email: string;
    csrfToken: string;
  };
  return {
    cookie,
    token,
    setCookie,
    csrf: body.csrfToken,
    response,
    session,
    body,
  };
}

function parseCSV(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const text = input.replace(/^\uFEFF/, "");
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && character === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (character === "\r" || character === "\n")) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  assert.equal(quoted, false, "CSV quoted fields must close");
  if (row.length || cell) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

test("admin APIs reject anonymous requests without querying or disclosing registrations", async (t) => {
  const { env, queries, seed } = fixture(t);
  seed({ name: "PRIVATE NAME", email: "private-member@example.com" });
  for (const path of [
    "/api/admin/session",
    "/api/admin/registrations",
    "/api/admin/export",
  ]) {
    const response = await worker.fetch(adminRequest(path), env);
    assert.equal(response.status, 401, path);
    assertPrivate(response);
    const text = await response.text();
    assert.ok(
      !text.includes("PRIVATE NAME") &&
        !text.includes("private-member@example.com"),
    );
  }
  assertNoMemberQuery(queries);
});

test("wrong passwords do not issue a session or query registrations", async (t) => {
  const { env, sql, queries } = fixture(t);
  const response = await worker.fetch(
    adminRequest("/api/admin/login", {
      method: "POST",
      payload: { password: "incorrect-password" },
    }),
    env,
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get()!.n,
    0,
  );
  assertPrivate(response);
  assertNoMemberQuery(queries);
  assert.ok(!JSON.stringify(queries).includes("incorrect-password"));
});

test("login rejects foreign, null, and absent Origin plus cross-site requests before database access", async (t) => {
  const { env, queries } = fixture(t);
  for (const value of [
    "https://evil.example",
    "https://community.example.evil.example",
    "http://community.example",
    "null",
    null,
  ]) {
    const request = adminRequest("/api/admin/login", {
      method: "POST",
      payload: { password },
    });
    if (value === null) request.headers.delete("Origin");
    else request.headers.set("Origin", value);
    assert.equal((await worker.fetch(request, env)).status, 403, String(value));
  }
  assert.equal(
    (
      await worker.fetch(
        adminRequest("/api/admin/login", {
          method: "POST",
          payload: { password },
          headers: { "Sec-Fetch-Site": "cross-site" },
        }),
        env,
      )
    ).status,
    403,
  );
  assert.equal(queries.length, 0);
});

test("admin login and read APIs are closed on noncanonical hosts", async (t) => {
  const { env, queries } = fixture(t);
  for (const base of [
    "https://www.community.example",
    "https://preview.workers.dev",
    "http://community.example",
    "https://community.example.evil.example",
  ]) {
    for (const path of [
      "/api/admin/login",
      "/api/admin/session",
      "/api/admin/registrations",
      "/api/admin/export",
    ]) {
      const response = await worker.fetch(
        adminRequest(path, {
          base,
          ...(path.endsWith("/login")
            ? { method: "POST", payload: { password } }
            : {}),
        }),
        env,
      );
      assert.equal(response.status, 403, `${base}${path}`);
      assert.equal(response.headers.get("Set-Cookie"), null);
    }
  }
  assert.equal(queries.length, 0);
});

test("missing or malformed authentication configuration fails closed", async (t) => {
  const { env, queries } = fixture(t);
  for (const config of [
    { ADMIN_PASSWORD_HASH: undefined },
    { ADMIN_PASSWORD_HASH: "" },
    { ADMIN_PASSWORD_HASH: "not-a-sha256-hash" },
    { ADMIN_EMAIL: undefined },
    { ADMIN_EMAIL: "" },
    { ADMIN_ORIGIN: undefined },
    { ADMIN_ORIGIN: "http://community.example" },
    { ADMIN_ORIGIN: "https://community.example/path" },
  ]) {
    const response = await worker.fetch(
      adminRequest("/api/admin/login", {
        method: "POST",
        payload: { password },
      }),
      { ...env, ...config },
    );
    assert.ok(
      response.status >= 400 && response.status < 600,
      JSON.stringify(config),
    );
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.ok(!(await response.text()).includes(password));
  }
  assert.equal(queries.length, 0);
});

test("successful login uses a random secure host cookie, stores only its hash, and exposes only the session's CSRF token", async (t) => {
  const { env, sql, queries } = fixture(t);
  const before = Math.floor(Date.now() / 1000);
  const signed = await signIn(env);
  assert.match(signed.cookie, /^__Host-cookie_admin=[a-f0-9]{64}$/);
  for (const flag of [
    /; Path=\//,
    /; HttpOnly(?:;|$)/,
    /; Secure(?:;|$)/,
    /; SameSite=Strict(?:;|$)/,
    /; Max-Age=28800(?:;|$)/,
  ])
    assert.match(signed.setCookie, flag);
  assert.doesNotMatch(signed.setCookie, /Domain=/i);
  const stored = sql.prepare("SELECT * FROM admin_sessions").get() as Row;
  assert.equal(stored.token_hash, sha256(signed.token));
  assert.notEqual(stored.token_hash, signed.token);
  assert.equal(stored.credential_version, sha256(env.ADMIN_PASSWORD_HASH!));
  assert.notEqual(stored.credential_version, env.ADMIN_PASSWORD_HASH);
  assert.equal(stored.email, email);
  assert.ok(Number(stored.created_at) >= before);
  assert.equal(Number(stored.expires_at) - Number(stored.created_at), 28800);
  assert.deepEqual(Object.keys(signed.body).sort(), [
    "csrfToken",
    "email",
    "ok",
  ]);
  assert.equal(signed.body.email, email);
  assert.match(signed.csrf, /^[a-f0-9]{64}$/);
  assert.equal(stored.csrf_token, signed.csrf);
  assert.notEqual(signed.csrf, signed.token);
  assert.ok(!JSON.stringify(queries).includes(signed.token));
  assert.ok(!JSON.stringify(queries).includes(password));
  assert.ok(!JSON.stringify(queries).includes(env.ADMIN_PASSWORD_HASH!));
  assertPrivate(signed.response);
  assertPrivate(signed.session);
  const second = await signIn(env);
  assert.notEqual(second.token, signed.token);
  assert.notEqual(second.csrf, signed.csrf);
});

test("missing, malformed, tampered, and expired cookies cannot read member data", async (t) => {
  const { env, sql, queries, seed } = fixture(t);
  seed();
  const signed = await signIn(env);
  queries.length = 0;
  const tampered = `${signed.token[0] === "a" ? "b" : "a"}${signed.token.slice(1)}`;
  for (const cookie of [
    undefined,
    "cookie_admin=" + signed.token,
    "__Host-cookie_admin=bad",
    "__Host-cookie_admin=" + "0".repeat(64),
    "__Host-cookie_admin=" + tampered,
  ]) {
    assert.equal(
      (
        await worker.fetch(
          adminRequest("/api/admin/registrations", { cookie }),
          env,
        )
      ).status,
      401,
    );
  }
  sql
    .prepare("UPDATE admin_sessions SET expires_at = ?")
    .run(Math.floor(Date.now() / 1000));
  assert.equal(
    (
      await worker.fetch(
        adminRequest("/api/admin/registrations", { cookie: signed.cookie }),
        env,
      )
    ).status,
    401,
  );
  assertNoMemberQuery(queries);
});

test("password or owner changes revoke old sessions without deleting their database row", async (t) => {
  const { env, sql, queries } = fixture(t);
  const signed = await signIn(env);
  queries.length = 0;
  for (const configuration of [
    { ADMIN_PASSWORD_HASH: sha256("replacement-secret") },
    { ADMIN_EMAIL: "replacement-owner@example.com" },
  ]) {
    assert.equal(
      (
        await worker.fetch(
          adminRequest("/api/admin/session", { cookie: signed.cookie }),
          { ...env, ...configuration },
        )
      ).status,
      401,
    );
  }
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get()!.n,
    1,
  );
  assertNoMemberQuery(queries);
});

test("logout requires same-origin POST and session-specific CSRF, then revokes the cookie server-side", async (t) => {
  const { env, sql } = fixture(t);
  const first = await signIn(env);
  const second = await signIn(env);
  const options = { method: "POST", cookie: first.cookie };
  for (const csrf of [undefined, "bad", "0".repeat(64), second.csrf]) {
    assert.equal(
      (
        await worker.fetch(
          adminRequest("/api/admin/logout", { ...options, csrf }),
          env,
        )
      ).status,
      403,
    );
  }
  const noOrigin = adminRequest("/api/admin/logout", {
    ...options,
    csrf: first.csrf,
  });
  noOrigin.headers.delete("Origin");
  assert.equal((await worker.fetch(noOrigin, env)).status, 403);
  assert.equal(
    (
      await worker.fetch(
        adminRequest("/api/admin/logout", {
          ...options,
          csrf: first.csrf,
          headers: { Origin: "https://evil.example" },
        }),
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await worker.fetch(
        adminRequest("/api/admin/logout", {
          cookie: first.cookie,
          csrf: first.csrf,
        }),
        env,
      )
    ).status,
    405,
  );
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get()!.n,
    2,
  );
  const response = await worker.fetch(
    adminRequest("/api/admin/logout", { ...options, csrf: first.csrf }),
    env,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Set-Cookie")!, /^__Host-cookie_admin=;/);
  assert.match(response.headers.get("Set-Cookie")!, /Max-Age=0/);
  assert.equal(
    (
      await worker.fetch(
        adminRequest("/api/admin/session", { cookie: first.cookie }),
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await worker.fetch(
        adminRequest("/api/admin/session", { cookie: second.cookie }),
        env,
      )
    ).status,
    200,
  );
});

test("login throttling permits eight attempts, is atomic, stores no raw IP, and ignores spoofed forwarding headers", async (t) => {
  const { env, sql, queries } = fixture(t);
  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      worker.fetch(
        adminRequest("/api/admin/login", {
          method: "POST",
          payload: { password: "wrong" },
        }),
        env,
      ),
    ),
  );
  assert.equal(
    responses.filter((response) => response.status === 401).length,
    8,
  );
  assert.equal(
    responses.filter((response) => response.status === 429).length,
    4,
  );
  const blocked = responses.find((response) => response.status === 429)!;
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  assert.ok(Number(blocked.headers.get("Retry-After")) <= 900);
  const bucket = sql.prepare("SELECT * FROM admin_login_attempts").get() as Row;
  assert.equal(bucket.attempts, 9);
  assert.match(String(bucket.bucket_hash), /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(queries).includes(ip));
  assert.equal(
    (
      await worker.fetch(
        adminRequest("/api/admin/login", {
          method: "POST",
          payload: { password },
          headers: { "X-Forwarded-For": "192.0.2.99" },
        }),
        env,
      )
    ).status,
    429,
  );
  await signIn(env, { "CF-Connecting-IP": "192.0.2.22" });
});

test("a new throttle window purges old buckets and permits another attempt", async (t) => {
  const { env, sql } = fixture(t);
  const beginning = 1_800_000_000_000;
  t.mock.method(Date, "now", () => beginning);
  await worker.fetch(
    adminRequest("/api/admin/login", {
      method: "POST",
      payload: { password: "wrong" },
    }),
    env,
  );
  sql.prepare("UPDATE admin_login_attempts SET attempts = 9").run();
  assert.equal(
    (
      await worker.fetch(
        adminRequest("/api/admin/login", {
          method: "POST",
          payload: { password },
        }),
        env,
      )
    ).status,
    429,
  );
  t.mock.method(Date, "now", () => beginning + 900_000);
  assert.equal(
    (
      await worker.fetch(
        adminRequest("/api/admin/login", {
          method: "POST",
          payload: { password: "wrong" },
        }),
        env,
      )
    ).status,
    401,
  );
  const rows = sql.prepare("SELECT * FROM admin_login_attempts").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 1);
});

test("login rejects malformed payloads, invalid UTF-8, non-JSON content, and oversized streamed bodies", async (t) => {
  const { env, sql } = fixture(t);
  let requestId = 0;
  for (const payload of [
    null,
    [],
    "password",
    {},
    { password: 3 },
    { password: "" },
    { password: "x".repeat(257) },
    { password, admin: true },
  ]) {
    const response = await worker.fetch(
      adminRequest("/api/admin/login", {
        method: "POST",
        payload,
        headers: { "CF-Connecting-IP": `192.0.2.${++requestId}` },
      }),
      env,
    );
    assert.equal(response.status, 400);
  }
  for (const body of ["{", new Uint8Array([0xff]), " ".repeat(2049)]) {
    const response = await worker.fetch(
      new Request(`${origin}/api/admin/login`, {
        method: "POST",
        body,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "CF-Connecting-IP": `192.0.2.${++requestId}`,
          "Content-Length": "1",
        },
      }),
      env,
    );
    assert.equal(response.status, 400);
  }
  const response = await worker.fetch(
    new Request(`${origin}/api/admin/login`, {
      method: "POST",
      body: JSON.stringify({ password }),
      headers: {
        Origin: origin,
        "Content-Type": "text/plain",
        "CF-Connecting-IP": "192.0.2.200",
      },
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get()!.n,
    0,
  );
});

test("admin HTML and script aliases cannot bypass authentication", async (t) => {
  const { env, queries, assets } = fixture(t);
  for (const path of [
    "/admin",
    "/admin/",
    "/admin/index.html",
    "/admin/admin.js",
  ]) {
    const response = await worker.fetch(adminRequest(path), env);
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get("Location"), "/admin/login");
    assertPrivate(response);
  }
  assert.equal(assets.length, 0);
  assertNoMemberQuery(queries);
  const loginPage = await worker.fetch(adminRequest("/admin/login"), env);
  assert.equal(loginPage.status, 200);
  assert.equal(await loginPage.text(), "asset:/admin/login");
  const signed = await signIn(env);
  const page = await worker.fetch(
    adminRequest("/admin/", { cookie: signed.cookie }),
    env,
  );
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "asset:/admin/");
  assertPrivate(page);
  const redirect = await worker.fetch(
    adminRequest("/admin/login", { cookie: signed.cookie }),
    env,
  );
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get("Location"), "/admin/");
});

test("HTML canonicalization reaches the login and dashboard without self-redirect loops", async (t) => {
  const { env, assets } = fixture(t);
  async function follow(path: string, cookie?: string) {
    const visited = new Set<string>();
    let url = new URL(path, origin);
    for (let redirects = 0; redirects <= 4; redirects++) {
      assert.ok(!visited.has(url.href), `redirect loop at ${url.pathname}`);
      visited.add(url.href);
      const response = await worker.fetch(
        adminRequest(url.pathname, { cookie }),
        env,
      );
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("Location");
      assert.ok(location, "redirects must have a destination");
      url = new URL(location, url);
      assert.equal(url.origin, origin);
    }
    assert.fail("admin navigation exceeded four redirects");
  }
  const login = await follow("/admin/");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Location"), null);
  assert.equal(await login.text(), "asset:/admin/login");
  const signed = await signIn(env);
  const dashboard = await follow("/admin", signed.cookie);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get("Location"), null);
  assert.equal(await dashboard.text(), "asset:/admin/");
  assert.deepEqual(assets, ["/admin/login", "/admin/"]);
});

test("valid cookies do not authorize other hosts, foreign Origins, or cross-site fetches", async (t) => {
  const { env, queries } = fixture(t);
  const signed = await signIn(env);
  queries.length = 0;
  const variations: { base?: string; headers?: Record<string, string> }[] = [
    { base: "https://preview.workers.dev" },
    { base: "https://www.community.example" },
    { headers: { Origin: "https://evil.example" } },
    { headers: { "Sec-Fetch-Site": "cross-site" } },
  ];
  for (const options of variations) {
    for (const path of [
      "/api/admin/session",
      "/api/admin/registrations",
      "/api/admin/export",
    ]) {
      assert.equal(
        (
          await worker.fetch(
            adminRequest(path, { cookie: signed.cookie, ...options }),
            env,
          )
        ).status,
        403,
      );
    }
  }
  assert.equal(queries.length, 0);
});

test("read APIs reject state-changing methods without querying member data", async (t) => {
  const { env, queries } = fixture(t);
  const signed = await signIn(env);
  queries.length = 0;
  for (const path of [
    "/api/admin/session",
    "/api/admin/registrations",
    "/api/admin/export",
  ]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await worker.fetch(
        adminRequest(path, { method, cookie: signed.cookie }),
        env,
      );
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.get("Allow"), "GET, HEAD");
    }
  }
  assertNoMemberQuery(queries);
});

test("registrations paginate in stable newest-first order, clamp excess pages, and report global statistics", async (t) => {
  const { env, seed } = fixture(t);
  const today = new Date().toISOString().slice(0, 10);
  for (let index = 0; index < 27; index++)
    seed({
      school: index < 25 ? " Central School " : "central SCHOOL",
      createdAt:
        index < 3 ? `${today}T00:00:00.000Z` : "2020-01-01T00:00:00.000Z",
    });
  seed({ school: "Other School", createdAt: "2020-01-01T00:00:00.000Z" });
  const signed = await signIn(env);
  const firstResponse = await worker.fetch(
    adminRequest("/api/admin/registrations", { cookie: signed.cookie }),
    env,
  );
  assert.equal(firstResponse.status, 200);
  assertPrivate(firstResponse);
  const first = (await firstResponse.json()) as any;
  assert.equal(first.page, 1);
  assert.equal(first.pageSize, 25);
  assert.equal(first.total, 28);
  assert.equal(first.totalPages, 2);
  assert.equal(first.registrations.length, 25);
  assert.deepEqual(
    first.registrations.map((row: Row) => row.id),
    Array.from({ length: 25 }, (_, index) => 28 - index),
  );
  assert.deepEqual(first.stats, { total: 28, today: 3, schools: 2 });
  const last = (await (
    await worker.fetch(
      adminRequest("/api/admin/registrations?page=999&pageSize=10", {
        cookie: signed.cookie,
      }),
      env,
    )
  ).json()) as any;
  assert.equal(last.page, 3);
  assert.equal(last.totalPages, 3);
  assert.deepEqual(
    last.registrations.map((row: Row) => row.id),
    [8, 7, 6, 5, 4, 3, 2, 1],
  );
  const search = (await (
    await worker.fetch(
      adminRequest("/api/admin/registrations?search=Other", {
        cookie: signed.cookie,
      }),
      env,
    )
  ).json()) as any;
  assert.equal(search.total, 1);
  assert.deepEqual(search.stats, first.stats);
});

test("literal search treats wildcard characters literally and keeps injection strings in bound parameters", async (t) => {
  const { env, queries, seed } = fixture(t);
  for (const school of [
    "100% Makers",
    "1000 Makers",
    "Code_Club",
    "CodeXClub",
    "Bang! School",
    "Bang School",
    "x' OR 1=1 --",
    "Other School",
  ])
    seed({ school });
  const signed = await signIn(env);
  for (const needle of ["%", "_", "!", "x' OR 1=1 --"]) {
    queries.length = 0;
    const response = await worker.fetch(
      adminRequest(
        `/api/admin/registrations?search=${encodeURIComponent(needle)}`,
        { cookie: signed.cookie },
      ),
      env,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.total, 1, needle);
    assert.ok(body.registrations[0].school.includes(needle));
    if (needle.includes("OR")) {
      assert.ok(!queries.some((query) => query.sql.includes(needle)));
      assert.ok(
        queries.some((query) =>
          query.values.some(
            (value) => typeof value === "string" && value.includes(needle),
          ),
        ),
      );
    }
  }
});

test("long and multibyte searches work within D1 limits for lists and CSV exports", async (t) => {
  const { env, seed } = fixture(t);
  const needles = [
    "Long query ".repeat(18).trim(),
    "é".repeat(30),
    "_".repeat(100),
  ];
  for (const funFact of needles) seed({ funFact });
  const signed = await signIn(env);
  for (const needle of needles) {
    const query = encodeURIComponent(needle);
    const response = await worker.fetch(
      adminRequest(`/api/admin/registrations?search=${query}`, {
        cookie: signed.cookie,
      }),
      env,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.total, 1);
    assert.equal(body.registrations[0].fun_fact, needle);
    const exported = await worker.fetch(
      adminRequest(`/api/admin/export?search=${query}`, {
        cookie: signed.cookie,
      }),
      env,
    );
    assert.equal(exported.status, 200);
    const csv = await exported.text();
    assert.ok(csv.includes(needle));
    assert.equal(csv.trim().split("\r\n").length, 2);
  }
});

test("invalid page/search settings do not reach member queries and empty datasets remain usable", async (t) => {
  const { env, queries } = fixture(t);
  const signed = await signIn(env);
  queries.length = 0;
  for (const query of [
    "page=0",
    "page=-1",
    "page=1.5",
    "page=1e2",
    "page=100000000",
    "pageSize=0",
    "pageSize=20",
    "pageSize=1000",
    `search=${"a".repeat(201)}`,
  ]) {
    assert.equal(
      (
        await worker.fetch(
          adminRequest(`/api/admin/registrations?${query}`, {
            cookie: signed.cookie,
          }),
          env,
        )
      ).status,
      400,
      query,
    );
  }
  assertNoMemberQuery(queries);
  const body = (await (
    await worker.fetch(
      adminRequest("/api/admin/registrations", { cookie: signed.cookie }),
      env,
    )
  ).json()) as any;
  assert.deepEqual(body.registrations, []);
  assert.equal(body.total, 0);
  assert.equal(body.totalPages, 1);
  assert.equal(body.page, 1);
  assert.deepEqual(body.stats, { total: 0, today: 0, schools: 0 });
});

test("untrusted registration content is returned as JSON data and CSV formulas are neutralized", async (t) => {
  const { env, seed } = fixture(t);
  const attack = '<img src=x onerror="alert(1)">';
  seed({ name: attack, funFact: 'A comma, a "quote",\nand another line.' });
  const dangerous = [
    '=HYPERLINK("https://evil.example")',
    "+SUM(1,2)",
    "-1+2",
    "@SUM(A1)",
    " \t=1+1",
    "\r\n+1+1",
  ];
  for (const name of dangerous) seed({ name });
  const signed = await signIn(env);
  const response = await worker.fetch(
    adminRequest("/api/admin/registrations", { cookie: signed.cookie }),
    env,
  );
  assert.match(response.headers.get("Content-Type")!, /^application\/json/);
  const body = (await response.json()) as any;
  assert.ok(body.registrations.some((row: Row) => row.name === attack));
  const exported = await worker.fetch(
    adminRequest("/api/admin/export", { cookie: signed.cookie }),
    env,
  );
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("Content-Type")!, /^text\/csv/);
  assert.match(
    exported.headers.get("Content-Disposition")!,
    /^attachment; filename="cookie-registrations-\d{4}-\d{2}-\d{2}\.csv"$/,
  );
  assertPrivate(exported);
  const csv = parseCSV(await exported.text());
  assert.equal(csv.length, 8);
  assert.ok(csv.every((row) => row.length === 7));
  assert.equal(csv[1][1], attack);
  assert.equal(csv[1][5], 'A comma, a "quote",\nand another line.');
  for (const [index, raw] of dangerous.entries())
    assert.equal(csv[index + 2][1], `'${raw}`);
});

test("CSV export streams more than 500 records without gaps or duplicates and respects a fixed snapshot", async (t) => {
  const { env, sql, queries, seed } = fixture(t);
  for (let index = 0; index < 1003; index++)
    seed({ school: index % 2 ? "Odd School" : "Even School" });
  sql.exec("DELETE FROM community_members WHERE id IN (2, 501)");
  const expectedIds = sql
    .prepare("SELECT id FROM community_members ORDER BY id")
    .all()
    .map((row) => String(row.id));
  const signed = await signIn(env);
  const response = await worker.fetch(
    adminRequest("/api/admin/export", { cookie: signed.cookie }),
    env,
  );
  sql
    .prepare(
      "INSERT INTO community_members (name,email,school,grade,fun_fact) VALUES (?,?,?,?,?)",
    )
    .run(
      "Late member",
      "late@example.com",
      "Later",
      "11",
      "Arrived after the snapshot",
    );
  const csv = parseCSV(await response.text());
  assert.deepEqual(
    csv.slice(1).map((row) => row[0]),
    expectedIds,
  );
  assert.equal(
    new Set(csv.slice(1).map((row) => row[0])).size,
    expectedIds.length,
  );
  assert.ok(queries.filter((query) => /LIMIT 500/.test(query.sql)).length >= 3);
  const filtered = await worker.fetch(
    adminRequest("/api/admin/export?search=Odd%20School", {
      cookie: signed.cookie,
    }),
    env,
  );
  const filteredRows = parseCSV(await filtered.text()).slice(1);
  assert.ok(filteredRows.length > 0);
  assert.ok(filteredRows.every((row) => row[3] === "Odd School"));
});

test("database failures in login, session validation, member queries, and initial export fail closed without leaking details", async (t) => {
  for (const stage of ["login", "session", "registrations", "export"]) {
    for (const mode of ["throw", "unsuccessful"]) {
      const { env } = fixture(t);
      const signed = stage === "login" ? null : await signIn(env);
      const original = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (query) => {
        const fail =
          stage === "login" || stage === "session"
            ? true
            : /\bcommunity_members\b/.test(query);
        if (!fail) return original(query);
        return {
          bind() {
            return this;
          },
          async run() {
            if (mode === "throw")
              throw new Error(
                `PRIVATE DATABASE DETAIL ${password} private@example.com`,
              );
            return { success: false, results: [] };
          },
        };
      };
      const path =
        stage === "login" ? "/api/admin/login" : `/api/admin/${stage}`;
      const response = await worker.fetch(
        adminRequest(
          path,
          stage === "login"
            ? { method: "POST", payload: { password } }
            : { cookie: signed!.cookie },
        ),
        env,
      );
      assert.equal(response.status, 503, `${stage} ${mode}`);
      assert.equal(response.headers.get("Set-Cookie"), null);
      assertPrivate(response);
      const text = await response.text();
      assert.ok(
        !text.includes(password) &&
          !text.includes("PRIVATE DATABASE DETAIL") &&
          !text.includes("private@example.com"),
      );
    }
  }
});

test("a mid-export database failure errors the stream instead of silently returning a complete-looking CSV", async (t) => {
  const { env, seed } = fixture(t);
  for (let index = 0; index < 501; index++) seed();
  const signed = await signIn(env);
  const original = env.DB.prepare.bind(env.DB);
  let batches = 0;
  env.DB.prepare = (query) => {
    if (/LIMIT 500/.test(query) && ++batches > 1)
      return {
        bind() {
          return this;
        },
        async run() {
          throw new Error("SECRET SQL ERROR");
        },
      };
    return original(query);
  };
  const response = await worker.fetch(
    adminRequest("/api/admin/export", { cookie: signed.cookie }),
    env,
  );
  assert.equal(response.status, 200);
  await assert.rejects(response.text(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /export could not finish/i);
    assert.ok(!error.message.includes("SECRET SQL ERROR"));
    return true;
  });
});

test("failed server-side revocation never reports successful logout or clears the browser cookie", async (t) => {
  const { env, sql } = fixture(t);
  const signed = await signIn(env);
  const original = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (query) => {
    if (/DELETE FROM admin_sessions WHERE token_hash/.test(query))
      return {
        bind() {
          return this;
        },
        async run() {
          return { success: false, results: [] };
        },
      };
    return original(query);
  };
  const response = await worker.fetch(
    adminRequest("/api/admin/logout", {
      method: "POST",
      cookie: signed.cookie,
      csrf: signed.csrf,
    }),
    env,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(((await response.json()) as { ok: boolean }).ok, false);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get()!.n,
    1,
  );
});

test("public signup continues to work with admin configured or absent and never issues an admin cookie", async (t) => {
  const { env, sql } = fixture(t);
  for (const [index, configuration] of [
    env,
    {
      ...env,
      ADMIN_PASSWORD_HASH: undefined,
      ADMIN_ORIGIN: undefined,
      ADMIN_EMAIL: undefined,
    },
  ].entries()) {
    const response = await worker.fetch(
      adminRequest("/api/join", {
        method: "POST",
        payload: {
          name: "Public member",
          email: `public${index}@example.com`,
          school: "Central",
          grade: "11",
          funFact: "Bakes bread",
          website: "",
        },
      }),
      configuration,
    );
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM community_members").get()!.n,
    2,
  );
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get()!.n,
    0,
  );
});
