import { Scalar } from "@scalar/hono-api-reference";

import type { AppOpenAPI } from "./types";

import packageJSON from "../../package.json" with { type: "json" };

export default function configureOpenAPI(app: AppOpenAPI) {
  app.doc("/doc", {
    openapi: "3.0.0",
    info: {
      version: packageJSON.version,
      title: "School API",
      description:
        "Multi-tenant school management for Kenyan primary and junior schools "
        + "(Grade 1-9, CBE curriculum). Student records, CBE assessment, fees, "
        + "and M-Pesa reconciliation. Each school is a tenant, resolved by "
        + "subdomain.",
    },
  });

  app.get(
    "/reference",
    Scalar({
      url: "/doc",
      theme: "kepler",
      layout: "classic",
      defaultHttpClient: {
        targetKey: "js",
        clientKey: "fetch",
      },
    }),
  );
}
