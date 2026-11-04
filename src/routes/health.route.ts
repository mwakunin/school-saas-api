import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";

import { checkConnections } from "@/db";
import { createRouter } from "@/lib/create-app";

const HealthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  database: z.enum(["up", "down"]),
  uptime: z.number().describe("Process uptime in seconds"),
});

const router = createRouter()
  .openapi(
    createRoute({
      tags: ["Health"],
      method: "get",
      path: "/health",
      summary: "Readiness check",
      description:
        "Verifies the process is up AND that each of its three database "
        + "connections can run a query. Use this for load-balancer / container "
        + "readiness probes, not `GET /`.",
      responses: {
        [HttpStatusCodes.OK]: jsonContent(HealthSchema, "Everything is reachable"),
        [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
          HealthSchema,
          "The database is unreachable",
        ),
      },
    }),
    async (c) => {
      /*
       * Every connection, not just the owner: each signs in as its own role,
       * and the owner can be up while `school_app` (every school's requests)
       * or `school_auth` (every sign-in) is not.
       *
       * Bounded on both halves, and bounded by Postgres rather than by a
       * timer here: waiting for a connection is capped by the pool's
       * `connectionTimeoutMillis`, and running the query by a
       * transaction-local `statement_timeout` (db/index.ts). A readiness
       * probe that can hang is worse than one that fails: the load balancer
       * learns nothing either way, but a hung probe also holds a connection.
       */
      const connections = await checkConnections();
      const database: "up" | "down" = connections.owner && connections.app && connections.auth ? "up" : "down";

      if (database === "down")
        c.var.logger.error({ connections }, "health check: a database connection is down");

      const body = {
        status: database === "up" ? "ok" as const : "degraded" as const,
        database,
        uptime: Math.round(process.uptime()),
      };

      return c.json(
        body,
        database === "up"
          ? HttpStatusCodes.OK
          : HttpStatusCodes.SERVICE_UNAVAILABLE,
      );
    },
  );

export default router;
