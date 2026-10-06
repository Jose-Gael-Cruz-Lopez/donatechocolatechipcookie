import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL as NodeURL } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import worker from "../src/worker.ts";
import type { Env } from "../src/worker.ts";

const migration = readFileSync(
  new NodeURL("../migrations/0001_community.sql", import.meta.url),
  "utf8",
);
const origin = "https://community.example";
const valid = {
  name: "Alex Rivera",
  email: "alex@example.com",
  school: "Central High",
  grade: "11",
  funFact: "I bake with my grandmother.",
  website: "",
};

function fixture(t: TestContext) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(migration);
  t.after(() => sql.close());
  const queries: { sql: string; values: (string | number | null)[] }[] = [];
  const env: Env = {
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
            const rows = sql.prepare(query).all(...values);
            return { success: true, results: rows as T[] };
          },
        };
      },
    },
    ASSETS: {
      async fetch(request: Request) {
        return new Response(`asset:${new URL(request.url).pathname}`, {
          headers: { ETag: '"asset-v1"' },
        });
      },
    },
  };
  const members = () =>
    sql.prepare("SELECT * FROM community_members ORDER BY id").all();
  return { env, sql, queries, members };
}

function request(
  payload: unknown = valid,
  headers: Record<string, string> = {},
  path = "/api/join",
) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "CF-Connecting-IP": "192.0.2.1",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

function streamRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
) {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" };
  return new Request(`${origin}/api/join`, init);
}

test("a successful submission stores trimmed values and a normalized email", async (t) => {
  const { env, members } = fixture(t);
  const response = await worker.fetch(
    request({
      ...valid,
      name: "  Alex Rivera  ",
      email: "  ALEX@Example.COM ",
      school: " Central High ",
      grade: " 11 ",
      funFact: " I bake. ",
    }),
    env,
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    message: "Thanks — your details have been received.",
  });
  const [member] = members();
  assert.equal(member.name, "Alex Rivera");
  assert.equal(member.email, "alex@example.com");
  assert.equal(member.school, "Central High");
  assert.equal(member.grade, "11");
  assert.equal(member.fun_fact, "I bake.");
  assert.match(String(member.created_at), /^\d{4}-\d{2}-\d{2}T/);
});

test("a duplicate receives the same success without overwriting the original signup", async (t) => {
  const { env, members } = fixture(t);
  const first = await worker.fetch(request(), env);
  const duplicate = await worker.fetch(
    request({
      ...valid,
      name: "Changed Name",
      email: "ALEX@EXAMPLE.COM",
      funFact: "Changed fact",
    }),
    env,
  );
  assert.equal(duplicate.status, first.status);
  assert.deepEqual(await duplicate.json(), await first.json());
  assert.equal(members().length, 1);
  assert.equal(members()[0].name, valid.name);
  assert.equal(members()[0].fun_fact, valid.funFact);
});

test("concurrent duplicate submissions remain unique", async (t) => {
  const { env, members } = fixture(t);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => worker.fetch(request(), env)),
  );
  assert.ok(responses.every((response) => response.status === 201));
  assert.equal(members().length, 1);
});

test("all five fields are required strings, nonblank, and within their limits", async (t) => {
  const { env, members, queries } = fixture(t);
  for (const [field, limit] of Object.entries({
    name: 100,
    email: 254,
    school: 150,
    grade: 80,
    funFact: 500,
  })) {
    for (const value of [undefined, null, 11, "   ", "a".repeat(limit + 1)]) {
      const response = await worker.fetch(
        request({ ...valid, [field]: value }),
        env,
      );
      assert.equal(
        response.status,
        400,
        `${field}: ${String(value).slice(0, 20)}`,
      );
    }
  }
  assert.equal(members().length, 0);
  assert.equal(queries.length, 0);
});

test("valid field maxima and a 254-character email are accepted", async (t) => {
  const { env, members } = fixture(t);
  const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
  assert.equal(email.length, 254);
  const response = await worker.fetch(
    request({
      name: "a".repeat(100),
      email,
      school: "b".repeat(150),
      grade: "c".repeat(80),
      funFact: "d".repeat(500),
    }),
    env,
  );
  assert.equal(response.status, 201);
  assert.equal(members().length, 1);
});

test("email syntax rejects malformed addresses and preserves plus tags", async (t) => {
  const { env, members } = fixture(t);
  for (const email of [
    "alex",
    "alex@",
    "@example.com",
    "alex@@example.com",
    "alex@example",
    "a..b@example.com",
    ".alex@example.com",
    "alex.@example.com",
    "alex@-example.com",
    "alex@example-.com",
    "alex@ex ample.com",
    "alex\n@example.com",
    `${"a".repeat(65)}@example.com`,
  ]) {
    assert.equal(
      (await worker.fetch(request({ ...valid, email }), env)).status,
      400,
      email,
    );
  }
  assert.equal(
    (
      await worker.fetch(
        request({ ...valid, email: "Alex+Cookie@Example.com" }),
        env,
      )
    ).status,
    201,
  );
  assert.equal(members()[0].email, "alex+cookie@example.com");
});

test("non-object payloads, unexpected fields, control characters, and honeypots are rejected", async (t) => {
  const { env, queries } = fixture(t);
  for (const payload of [
    null,
    [],
    "text",
    123,
    { ...valid, admin: true },
    { ...valid, website: "https://spam.example" },
    { ...valid, website: 1 },
    { ...valid, name: "Alex\nRivera" },
    { ...valid, funFact: "text\u0000hidden" },
  ]) {
    assert.equal((await worker.fetch(request(payload), env)).status, 400);
  }
  assert.equal(queries.length, 0);
});

test("unicode names and multiline fun facts survive prepared statements", async (t) => {
  const { env, members, queries } = fixture(t);
  const fact = "I bake.\n'); DROP TABLE community_members; --";
  assert.equal(
    (
      await worker.fetch(
        request({ ...valid, name: "Zoë O’Connor 李", funFact: fact }),
        env,
      )
    ).status,
    201,
  );
  assert.equal(members()[0].fun_fact, fact);
  assert.equal(members()[0].name, "Zoë O’Connor 李");
  const write = queries.find((entry) =>
    entry.sql.startsWith("INSERT INTO community_members"),
  )!;
  assert.ok(!write.sql.includes(fact));
  assert.ok(write.values.includes(fact));
});

test("present Origin must be exact same origin; cross-site fetches and null origins are denied", async (t) => {
  const { env, queries } = fixture(t);
  const variants: Record<string, string>[] = [
    { Origin: "https://evil.example" },
    { Origin: "null" },
    { Origin: "https://community.example.evil.com" },
    { Origin: "http://community.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of variants) {
    assert.equal(
      (await worker.fetch(request(valid, headers), env)).status,
      403,
    );
  }
  assert.equal(queries.length, 0);
});

test("clients without Origin can submit JSON; requests do not get CORS permission", async (t) => {
  const { env } = fixture(t);
  const submission = request();
  submission.headers.delete("Origin");
  const response = await worker.fetch(submission, env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("only POST with JSON is accepted and no public member endpoint exists", async (t) => {
  const { env, queries } = fixture(t);
  for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) {
    const response = await worker.fetch(
      new Request(`${origin}/api/join`, { method }),
      env,
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
  }
  for (const type of [
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
  ]) {
    assert.equal(
      (await worker.fetch(request(valid, { "Content-Type": type }), env))
        .status,
      415,
    );
  }
  for (const path of ["/api", "/api/members", "/api/signups", "/api/join/"]) {
    assert.equal(
      (await worker.fetch(new Request(`${origin}${path}`), env)).status,
      404,
    );
  }
  assert.equal(queries.length, 0);
});

test("malformed JSON and malformed UTF-8 fail before touching storage", async (t) => {
  const { env, queries } = fixture(t);
  const malformed = new Request(`${origin}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal((await worker.fetch(malformed, env)).status, 400);
  assert.equal(
    (await worker.fetch(streamRequest([new Uint8Array([0xff])]), env)).status,
    400,
  );
  assert.equal(queries.length, 0);
});

test("16 KiB is a byte limit enforced for streams even with missing or false Content-Length", async (t) => {
  const { env, queries } = fixture(t);
  const bytes = new TextEncoder().encode(" ".repeat(16 * 1024 + 1));
  const variants: Record<string, string>[] = [{}, { "Content-Length": "1" }];
  for (const headers of variants) {
    const response = await worker.fetch(
      streamRequest([bytes.slice(0, 8000), bytes.slice(8000)], headers),
      env,
    );
    assert.equal(response.status, 413);
  }
  const multibyte = new TextEncoder().encode(
    JSON.stringify({ ...valid, funFact: "🍪".repeat(5000) }),
  );
  assert.equal(
    (await worker.fetch(streamRequest([multibyte]), env)).status,
    413,
  );
  assert.equal(
    (await worker.fetch(request(valid, { "Content-Length": "16385" }), env))
      .status,
    413,
  );
  assert.equal(
    (await worker.fetch(request(valid, { "Content-Length": "invalid" }), env))
      .status,
    400,
  );
  assert.equal(queries.length, 0);
});

test("a valid exactly-16-KiB body is accepted", async (t) => {
  const { env } = fixture(t);
  const body = JSON.stringify(valid);
  const bytes = new TextEncoder().encode(
    body + " ".repeat(16384 - new TextEncoder().encode(body).length),
  );
  assert.equal((await worker.fetch(streamRequest([bytes]), env)).status, 201);
});

test("oversized streams are cancelled", async (t) => {
  const { env } = fixture(t);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16385));
    },
    cancel() {
      cancelled = true;
    },
  });
  const submission = new Request(`${origin}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.equal((await worker.fetch(submission, env)).status, 413);
  assert.equal(cancelled, true);
});

test("the per-IP limit is atomic, bounded, and stores no raw IP", async (t) => {
  const { env, sql, members, queries } = fixture(t);
  const responses = await Promise.all(
    Array.from({ length: 35 }, (_, i) =>
      worker.fetch(request({ ...valid, email: `member${i}@example.com` }), env),
    ),
  );
  assert.equal(
    responses.filter((response) => response.status === 201).length,
    30,
  );
  assert.equal(
    responses.filter((response) => response.status === 429).length,
    5,
  );
  assert.equal(members().length, 30);
  const blocked = responses.find((response) => response.status === 429)!;
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  assert.ok(Number(blocked.headers.get("Retry-After")) <= 600);
  const bucket = sql.prepare("SELECT * FROM join_rate_limits").get()!;
  assert.match(String(bucket.bucket_hash), /^[a-f0-9]{64}$/);
  assert.equal(bucket.attempts, 31);
  assert.ok(!JSON.stringify(queries).includes("192.0.2.1"));
  assert.equal(
    (
      await worker.fetch(
        request(
          { ...valid, email: "other@example.com" },
          { "CF-Connecting-IP": "192.0.2.2" },
        ),
        env,
      )
    ).status,
    201,
  );
});

test("expired buckets are purged and X-Forwarded-For cannot bypass the IP limit", async (t) => {
  const { env, sql } = fixture(t);
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  await worker.fetch(request(), env);
  sql.prepare("UPDATE join_rate_limits SET attempts = 30").run();
  assert.equal(
    (
      await worker.fetch(
        request(valid, { "X-Forwarded-For": "192.0.2.99" }),
        env,
      )
    ).status,
    429,
  );
  t.mock.method(Date, "now", () => 1_800_000_600_000);
  assert.equal((await worker.fetch(request(), env)).status, 201);
  const buckets = sql.prepare("SELECT * FROM join_rate_limits").all();
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].attempts, 1);
});

test("database errors return 503, never success or contact data", async (t) => {
  for (const mode of ["throw", "unsuccessful", "rate-limit-failure"]) {
    const { env, members } = fixture(t);
    const original = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (query) => {
      if (
        query.startsWith("INSERT INTO community_members") ||
        mode === "rate-limit-failure"
      ) {
        return {
          bind() {
            return this;
          },
          async run() {
            if (mode !== "unsuccessful")
              throw new Error(`Database failed: ${valid.email}`);
            return { success: false, results: [] };
          },
        };
      }
      return original(query);
    };
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 503, mode);
    assert.equal(response.headers.get("Retry-After"), "30");
    assert.ok(!(await response.text()).includes(valid.email));
    assert.equal(members().length, 0);
  }
});

test("API responses are JSON, uncached, and protected; static asset headers survive", async (t) => {
  const { env } = fixture(t);
  const response = await worker.fetch(request(), env);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Content-Type")!, /^application\/json/);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  const asset = await worker.fetch(new Request(`${origin}/styles.css`), env);
  assert.equal(await asset.text(), "asset:/styles.css");
  assert.equal(asset.headers.get("ETag"), '"asset-v1"');
  assert.match(
    asset.headers.get("Content-Security-Policy")!,
    /script-src 'self'/,
  );
});

test("the migration is repeatable and enforces email uniqueness in the database", (t) => {
  const { sql } = fixture(t);
  sql.exec(migration);
  const statement = sql.prepare(
    "INSERT INTO community_members (name, email, school, grade, fun_fact) VALUES (?, ?, ?, ?, ?)",
  );
  statement.run("Alex", "alex@example.com", "Central", "11", "Bakes");
  assert.throws(
    () => statement.run("Other", "ALEX@example.com", "Central", "11", "Bakes"),
    /UNIQUE constraint failed/,
  );
});
