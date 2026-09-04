/* eslint-disable node/no-process-env */
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import path from "node:path";
import { z } from "zod";

expand(config({
  path: path.resolve(
    process.cwd(),
    process.env.NODE_ENV === "test" ? ".env.test" : ".env",
  ),
}));

/**
 * Credentials that are only needed once the payment / email / media features
 * land. They're optional in dev and test so the API boots without them, but
 * required in production — enforced in the superRefine below.
 */
/**
 * Credentials production cannot run without.
 *
 * The platform-level `MPESA_CONSUMER_KEY` / `SECRET` / `SHORTCODE` / `PASSKEY`
 * are deliberately NOT here. They belong to the dormant STK-push client, and
 * under C2B every school transacts on its own paybill with its own credentials
 * (CLAUDE.md §5.8) — money never routes through our account. Requiring them
 * would make an operator invent values for a feature that is switched off, and
 * config nobody can explain is config nobody maintains.
 *
 * What production does need is the key those per-school credentials are
 * encrypted under, and the origin Safaricom posts confirmations back to.
 */
const PRODUCTION_REQUIRED = [
  "CREDENTIALS_ENCRYPTION_KEY",
  "MPESA_C2B_BASE_URL",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "IMAGEKIT_PUBLIC_KEY",
  "IMAGEKIT_PRIVATE_KEY",
  "IMAGEKIT_URL_ENDPOINT",
] as const;

/** The username from a DSN, or undefined if it isn't parseable. */
function parseRole(dsn: string | undefined): string | undefined {
  if (!dsn)
    return undefined;
  try {
    return decodeURIComponent(new URL(dsn).username) || undefined;
  }
  catch {
    return undefined;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(9999),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),

  // --- Data stores ---
  /**
   * The OWNER connection: migrations, the test harness, the superadmin plane.
   * Exempt from row-level security, so nothing that serves a tenant request
   * may use it.
   */
  DATABASE_URL: z.url(),
  /**
   * The unprivileged runtime connection (`school_app`, see db/roles.sql).
   * Subject to RLS, which is what makes the policies load-bearing rather than
   * decorative.
   *
   * Required, and required to be *different* from DATABASE_URL — the whole
   * guarantee collapses if they are the same role, and a deployment that
   * quietly pointed both at the owner would look completely healthy.
   */
  APP_DATABASE_URL: z.url(),
  TEST_DATABASE_URL: z.url().optional(),
  TEST_APP_DATABASE_URL: z.url().optional(),
  REDIS_URL: z.url(),

  // --- Auth (Better Auth) ---
  BETTER_AUTH_SECRET: z.string().min(32, "Must be at least 32 characters"),
  BETTER_AUTH_URL: z.url(),

  /**
   * The domain schools are hosted under: `stmarys.example.co.ke` resolves the
   * `stmarys` tenant when this is `example.co.ke`. Requires wildcard DNS and a
   * wildcard TLS certificate (CLAUDE.md §2).
   *
   * Locally this is `localhost`, which browsers resolve for any subdomain
   * without hosts-file edits, so `stmarys.localhost:9999` just works.
   */
  ROOT_DOMAIN: z.string().min(1).default("localhost"),

  // --- M-Pesa ---
  // Picks the Daraja host: sandbox.safaricom.co.ke vs api.safaricom.co.ke.
  MPESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_CONSUMER_KEY: z.string().optional(),
  MPESA_CONSUMER_SECRET: z.string().optional(),
  MPESA_SHORTCODE: z.string().optional(),
  MPESA_PASSKEY: z.string().optional(),
  MPESA_CALLBACK_URL: z.url().optional(),
  /**
   * Comma-separated Safaricom source IPs permitted to POST the callback.
   * Safaricom does not sign callbacks, so this is one of the few things that
   * distinguishes a real one. Optional because the published list changes;
   * when empty the endpoint relies on its other checks instead.
   */
  MPESA_CALLBACK_ALLOWED_IPS: z.string().optional(),

  /**
   * Base64 of 32 random bytes, encrypting each school's Daraja credentials.
   *
   * A leak of `schools.mpesa_credentials` is a leak of every tenant's ability
   * to transact on their own paybill, so it is encrypted at rest rather than
   * merely access-controlled — a backup or a replica must not be enough.
   *
   * Generate with:
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   *
   * Required in production. Optional in dev and test so the API boots without
   * it; anything that actually touches a credential fails with an explanation
   * at that point instead.
   */
  CREDENTIALS_ENCRYPTION_KEY: z.string().optional(),

  /**
   * The public base URL Safaricom posts C2B confirmations to.
   *
   * Each school gets its own unguessable path underneath it, so this is the
   * origin only — `https://api.example.co.ke`. Must be HTTPS and reachable
   * from the internet; use a tunnel in development.
   */
  MPESA_C2B_BASE_URL: z.url().optional(),

  /**
   * How many of your own proxies sit in front of the app.
   *
   * 0 (default) means it is exposed directly, so X-Forwarded-For is ignored
   * entirely — trusting it would let anyone reset their own rate limit by
   * rotating the header. Set to the real number of hops when deployed behind
   * a load balancer; setting it too high reintroduces the bypass.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  /**
   * Comma-separated addresses allowed to have written X-Forwarded-For.
   *
   * TRUST_PROXY_HOPS on its own assumes every request came through your proxy.
   * If the app is also reachable directly, an attacker connects to it and
   * supplies their own chain. Either make direct access impossible at the
   * network layer, or list the proxy addresses here.
   */
  TRUSTED_PROXY_IPS: z.string().optional(),

  // --- Google sign-in (optional; enabled only when both are present) ---
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // --- Email (Resend) ---
  RESEND_API_KEY: z.string().optional(),
  /** From-address for verification mail. Required alongside RESEND_API_KEY. */
  RESEND_FROM_EMAIL: z.string().optional(),

  // --- Image CDN (ImageKit) ---
  IMAGEKIT_PUBLIC_KEY: z.string().optional(),
  IMAGEKIT_PRIVATE_KEY: z.string().optional(),
  IMAGEKIT_URL_ENDPOINT: z.url().optional(),
})
  .superRefine((input, ctx) => {
    if (input.NODE_ENV === "production") {
      for (const key of PRODUCTION_REQUIRED) {
        if (!input[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "Must be set when NODE_ENV is 'production'",
          });
        }
      }

      if (input.MPESA_CALLBACK_URL && !input.MPESA_CALLBACK_URL.startsWith("https://")) {
        ctx.addIssue({
          code: "custom",
          path: ["MPESA_CALLBACK_URL"],
          message: "Must be a publicly reachable HTTPS URL",
        });
      }
    }

    // Paired credentials are checked in every environment, not just
    // production. Half a pair silently disables the feature — Google simply
    // isn't offered, email verification quietly isn't required — which is
    // precisely the failure you'd waste time debugging locally.
    if (Boolean(input.RESEND_API_KEY) !== Boolean(input.RESEND_FROM_EMAIL)) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_FROM_EMAIL"],
        message: "Set both RESEND_API_KEY and RESEND_FROM_EMAIL, or neither",
      });
    }

    if (Boolean(input.GOOGLE_CLIENT_ID) !== Boolean(input.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_CLIENT_SECRET"],
        message: "Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither",
      });
    }

    // Guard against a stray `pnpm test` running against — and truncating —
    // the development database.
    if (input.NODE_ENV === "test" && !input.TEST_DATABASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["TEST_DATABASE_URL"],
        message: "Must be set when NODE_ENV is 'test'",
      });
    }

    if (input.NODE_ENV === "test" && !input.TEST_APP_DATABASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["TEST_APP_DATABASE_URL"],
        message: "Must be set when NODE_ENV is 'test'",
      });
    }

    /*
     * The two connections must be different roles.
     *
     * If APP_DATABASE_URL points at the owner, every RLS policy silently stops
     * applying and one school can read another's children's records — with no
     * error, no failing test that doesn't check for this specifically, and a
     * `pg_policies` listing that still looks correct. It is the single
     * highest-consequence misconfiguration in the system, so it fails at boot
     * rather than at the first cross-tenant read.
     */
    const owner = parseRole(input.DATABASE_URL);
    const app = parseRole(input.APP_DATABASE_URL);

    /*
     * A missing username is rejected, not skipped.
     *
     * Both DSNs omitting the role is the case that used to slip through: the
     * comparison below had nothing to compare, so it passed — while libpq
     * quietly fell back to PGUSER or the OS user for both, making them the
     * same role and disabling isolation. The check has to be able to see what
     * it is checking.
     */
    for (const [key, role] of [
      ["DATABASE_URL", owner],
      ["APP_DATABASE_URL", app],
    ] as const) {
      if (!role) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            "Must name its role explicitly (postgresql://ROLE:password@host/db). "
            + "Without it the connecting role comes from the environment, and "
            + "the two connections cannot be shown to differ.",
        });
      }
    }

    if (owner && app && owner === app) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_DATABASE_URL"],
        message:
          `Must connect as a different role from DATABASE_URL (both are `
          + `'${owner}'). The owner role bypasses row-level security, so `
          + `sharing it disables tenant isolation entirely — see db/roles.sql.`,
      });
    }
  })
  .transform(input => ({
    ...input,
    // Everything downstream reads DATABASE_URL / APP_DATABASE_URL; in test they
    // resolve to the disposable test database so no caller has to remember the
    // distinction.
    DATABASE_URL: input.NODE_ENV === "test" && input.TEST_DATABASE_URL
      ? input.TEST_DATABASE_URL
      : input.DATABASE_URL,
    APP_DATABASE_URL: input.NODE_ENV === "test" && input.TEST_APP_DATABASE_URL
      ? input.TEST_APP_DATABASE_URL
      : input.APP_DATABASE_URL,
  }));

export type env = z.infer<typeof EnvSchema>;

// eslint-disable-next-line ts/no-redeclare
const { data: env, error } = EnvSchema.safeParse(process.env);

if (error) {
  console.error("❌ Invalid env:");
  console.error(JSON.stringify(z.flattenError(error).fieldErrors, null, 2));
  process.exit(1);
}

export default env!;
