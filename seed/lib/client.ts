import { eq } from "drizzle-orm";

import app from "@/app";
import db from "@/db";
import { user } from "@/db/schema";
import env from "@/env";

/**
 * The seed talks to the API, not to the tables.
 *
 * CLAUDE.md §8: seeded "through the actual API. Never a special code path — it
 * will drift and embarrass you mid-presentation." A seed that inserts rows
 * directly can produce a school that the API itself would have refused to
 * create: an invoice whose lines do not sum to its total, a child enrolled in
 * two classes at once, a mark above the paper's total. Everything here goes
 * through the same validation, the same tenant middleware and the same
 * business rules a real request does, so if the demo builds, the product
 * works.
 *
 * In-process rather than over HTTP. `app.request` is the same Hono app with
 * the same middleware chain — nothing is stubbed — and it means the seed needs
 * no running server, which is what lets CI run it as an integration test.
 */

export interface Session {
  id: string;
  email: string;
  cookie: string;
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie)
    throw new Error("Expected a session cookie and got none");

  // Only the name=value pairs; a request Cookie header carries no attributes.
  return setCookie
    .split(/,(?=\s*[^;=\s]+=)/)
    .map(c => c.split(";")[0].trim())
    .join("; ");
}

export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} -> ${status}\n${body}`);
    this.name = "ApiError";
  }
}

/**
 * A caller addressing one school, optionally as one person.
 *
 * The Host header is how the tenant is chosen, so this exists mostly to make
 * forgetting it impossible — a seed step that addressed the wrong host would
 * quietly build its school somewhere else.
 */
export class Api {
  constructor(
    private readonly host: string,
    private readonly cookie?: string,
  ) {}

  /** The same caller, acting as someone. */
  as(session: Session): Api {
    return new Api(this.host, session.cookie);
  }

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await app.request(path, {
      method,
      headers: {
        host: this.host,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    /*
     * Loud on failure, always.
     *
     * A seed that shrugged off a 422 would leave a school missing whichever
     * piece failed — no fee structure for Grade 7, say — and the gap would
     * surface as a confusing empty screen during a presentation rather than as
     * an error anyone could act on. The response body is included because
     * "422" alone never says which field.
     */
    if (!response.ok) {
      throw new ApiError(method, path, response.status, await response.text());
    }

    if (response.status === 204)
      return undefined as T;

    return response.json() as Promise<T>;
  }

  get<T = any>(path: string) {
    return this.request<T>("GET", path);
  }

  post<T = any>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body ?? {});
  }

  put<T = any>(path: string, body: unknown) {
    return this.request<T>("PUT", path, body);
  }

  patch<T = any>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }
}

/** A caller addressing the platform rather than any school. */
export function platformApi(cookie?: string): Api {
  return new Api(env.ROOT_DOMAIN, cookie);
}

/** A caller addressing one school by subdomain. */
export function schoolApi(subdomain: string, cookie?: string): Api {
  return new Api(`${subdomain}.${env.ROOT_DOMAIN}`, cookie);
}

/**
 * Creates an account through the real sign-up endpoint.
 *
 * Email and password rather than phone OTP: these are staff at a desk, and the
 * OTP path would need the code intercepted, which is a test affordance rather
 * than something a demo should depend on.
 */
export async function signUp(
  email: string,
  name: string,
  password = "demo-password-2026",
): Promise<Session> {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", "host": env.ROOT_DOMAIN },
    body: JSON.stringify({ email, password, name }),
  });

  if (!response.ok) {
    throw new ApiError(
      "POST",
      "/api/auth/sign-up/email",
      response.status,
      await response.text(),
    );
  }

  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));

  if (!row)
    throw new Error(`No user row after signing up ${email}`);

  return { id: row.id, email, cookie: cookieFrom(response) };
}

/**
 * Makes an account a platform superadmin.
 *
 * The one write in this seed that does not go through the API, and it cannot:
 * `user.role` is deliberately not client-settable, and no endpoint grants it —
 * correctly, since an endpoint that promoted its own caller to superadmin
 * would be the whole isolation model undone. Granting the operator account is
 * an out-of-band act by definition.
 *
 * Everything downstream of this — the school, its staff, its children, their
 * marks and their fees — goes through the API.
 */
export async function makeSuperadmin(session: Session): Promise<void> {
  await db.update(user).set({ role: "superadmin" }).where(eq(user.id, session.id));
}
