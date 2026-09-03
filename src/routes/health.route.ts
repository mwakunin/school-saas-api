import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";

import db from "@/db";
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
        "Verifies the process is up AND that it can reach the database. Use "
        + "this for load-balancer / container readiness probes, not `GET /`.",
      responses: {
        [HttpStatusCodes.OK]: jsonContent(HealthSchema, "Everything is reachable"),
        [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
          HealthSchema,
          "The database is unreachable",
        ),
      },
    }),
    async (c) => {
      let database: "up" | "down" = "up";

      try {
        await db.execute(sql`select 1`);
      }
      catch (err) {
        database = "down";
        c.var.logger.error({ err }, "health check: database unreachable");
      }

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
