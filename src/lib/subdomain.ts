/**
 * Tenant routing is by subdomain: `stmarys.example.co.ke` is St Mary's.
 *
 * This is the first thing that runs on every tenant request, and the value it
 * produces decides which school's data the rest of the request may touch — so
 * it parses strictly and returns null rather than guessing.
 */

/**
 * Subdomains that can never be a school.
 *
 * `demo` is deliberately absent: CLAUDE.md §8 makes the demo a real tenant at
 * `demo.<domain>`, seeded through the actual API, precisely so it cannot drift
 * from the product. Reserving it here would break that.
 */
export const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "admin",
  "app",
  "static",
  "assets",
]);

/** A school subdomain: lowercase alphanumeric with internal hyphens. */
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The school subdomain in a Host header, or null if there isn't a usable one.
 *
 * Null covers every case the caller must treat identically — the apex domain,
 * an unknown domain, a reserved name, a nested subdomain, a malformed label —
 * because the response to all of them is the same 404. Distinguishing them in
 * the response would confirm which schools exist to anyone who asks.
 *
 * @param host the raw Host header, which may carry a port
 * @param rootDomain the domain schools are hosted under, e.g. `example.co.ke`
 */
export function subdomainFrom(
  host: string | undefined,
  rootDomain: string,
): string | null {
  if (!host)
    return null;

  // Strip the port. IPv6 literals arrive bracketed (`[::1]:9999`) and never
  // carry a subdomain, so they fall out as null below either way.
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, "");
  const root = rootDomain.trim().toLowerCase();

  if (!hostname || !root || !hostname.endsWith(`.${root}`))
    return null;

  const label = hostname.slice(0, -(root.length + 1));

  // A nested subdomain is not a tenant. Treating `evil.stmarys.example.co.ke`
  // as St Mary's would let anyone who can create a DNS record inherit a
  // school's cookies.
  if (label.includes("."))
    return null;

  if (!SUBDOMAIN_PATTERN.test(label) || RESERVED_SUBDOMAINS.has(label))
    return null;

  return label;
}
