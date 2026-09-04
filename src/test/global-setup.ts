/* eslint-disable node/no-process-env */
import { execSync } from "node:child_process";

/**
 * Runs once before the whole suite: brings the disposable test database
 * (:5433, tmpfs) up to the current migration head. drizzle-kit tracks what it
 * has applied, so this is idempotent across runs while the container lives.
 */
export default function setup() {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Test global-setup ran outside NODE_ENV=test");

  execSync("./node_modules/.bin/drizzle-kit migrate", {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  });
}
