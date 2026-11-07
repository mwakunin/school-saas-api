import { describe, expect, it } from "vitest";

import { EnvSchema } from "./env";

/**
 * A production environment, its three connections as different roles.
 * Every required field is set, because the cross-field checks run only once
 * the fields themselves are valid: a partial one would pass them by never
 * running them.
 */
function production(app: string, auth: string) {
  return {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    DATABASE_URL: "postgresql://school:owner-secret@db.example.test/school",
    APP_DATABASE_URL: app,
    AUTH_DATABASE_URL: auth,
    REDIS_URL: "rediss://cache.example.test:6379",
    BETTER_AUTH_SECRET: "a-production-secret-that-is-long-enough-32",
    BETTER_AUTH_URL: "https://api.example.test",
  };
}

function issuesAt(input: Record<string, unknown>, key: string) {
  const result = EnvSchema.safeParse(input);
  return result.success ? [] : result.error.issues.filter(i => i.path[0] === key).map(i => i.message);
}

const DEFAULT = "Must not use the development default password from db/roles.sql in production";

describe("production database URLs", () => {
  it("refuse the default passwords db/roles.sql creates", () => {
    const input = production(
      "postgresql://school_app:school_app@db.example.test/school",
      "postgresql://school_auth:school_auth@db.example.test/school",
    );

    expect(issuesAt(input, "APP_DATABASE_URL")).toContain(DEFAULT);
    expect(issuesAt(input, "AUTH_DATABASE_URL")).toContain(DEFAULT);
  });

  it("accept passwords set out of band", () => {
    const input = production(
      "postgresql://school_app:from-secret-manager-1@db.example.test/school",
      "postgresql://school_auth:from-secret-manager-2@db.example.test/school",
    );

    expect(issuesAt(input, "APP_DATABASE_URL")).not.toContain(DEFAULT);
    expect(issuesAt(input, "AUTH_DATABASE_URL")).not.toContain(DEFAULT);
  });
});
