import { Hono } from "hono";
import postgres from "postgres";
import Redis from "ioredis";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";

const sql = postgres({
  host: Deno.env.get("POSTGRES_HOST"),
  port: parseInt(Deno.env.get("POSTGRES_PORT") || "5432"),
  database: Deno.env.get("POSTGRES_DB"),
  username: Deno.env.get("POSTGRES_USER"),
  password: Deno.env.get("POSTGRES_PASSWORD"),
});

let redis;
if (Deno.env.get("REDIS_HOST")) {
  redis = new Redis(
    Number.parseInt(Deno.env.get("REDIS_PORT")),
    Deno.env.get("REDIS_HOST"),
  );
} else {
  redis = new Redis(6379, "redis");
}

// Initialize Drizzle ORM
const db = drizzle(sql);

// Initialize Better Auth
const auth = betterAuth({
  database: drizzleAdapter(db),
  secret: Deno.env.get("BETTER_AUTH_SECRET") || "your-secret-key-change-in-production",
  trustedOrigins: ["http://localhost:3000"],
});

// Simple in-memory cache
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  return entry.value;
}

function setCache(key, value) {
  cache.set(key, { value });
}

// Middleware to check authentication
async function requireAuth(c, next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", session.user);
  c.set("session", session.session);
  await next();
}

const app = new Hono();

// Better Auth routes
app.all("/api/auth/*", auth.handler);

app.get("/api/languages", async (c) => {
  const cacheKey = "languages";
  const cached = getCached(cacheKey);
  if (cached) {
    return c.json(cached);
  }

  const languages = await sql`SELECT id, name FROM languages ORDER BY id`;
  setCache(cacheKey, languages);
  return c.json(languages);
});

app.get("/api/languages/:id/exercises", async (c) => {
  const id = c.req.param("id");
  const cacheKey = `exercises_${id}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return c.json(cached);
  }

  const exercises = await sql`
    SELECT id, title, description
    FROM exercises
    WHERE language_id = ${id}
    ORDER BY id
  `;
  setCache(cacheKey, exercises);
  return c.json(exercises);
});

app.get("/api/exercises/:id", async (c) => {
  const id = c.req.param("id");
  const cacheKey = `exercise_${id}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return c.json(cached);
  }

  const result = await sql`
    SELECT id, title, description
    FROM exercises
    WHERE id = ${id}
  `;
  if (result.length === 0) {
    return c.json({ error: "Not found" }, 404);
  }
  setCache(cacheKey, result[0]);
  return c.json(result[0]);
});

app.get("/api/submissions/:id/status", requireAuth, async (c) => {
  const id = c.req.param("id");
  const result = await sql`
    SELECT grading_status, grade
    FROM exercise_submissions
    WHERE id = ${id}
  `;
  if (result.length === 0) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(result[0]);
});

app.post("/api/exercises/:id/submissions", requireAuth, async (c) => {
  const exerciseId = c.req.param("id");
  const body = await c.req.json();
  const sourceCode = body.source_code;

  const result = await sql`
    INSERT INTO exercise_submissions (exercise_id, source_code)
    VALUES (${exerciseId}, ${sourceCode})
    RETURNING id
  `;

  const submissionId = result[0].id;

  await redis.lpush("submissions", submissionId);

  return c.json({ id: submissionId });
});

export default app;
