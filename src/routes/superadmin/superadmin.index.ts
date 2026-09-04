import { createRouter } from "@/lib/create-app";

import * as handlers from "./superadmin.handlers";
import * as routes from "./superadmin.routes";

const router = createRouter()
  .openapi(routes.list, handlers.list)
  .openapi(routes.create, handlers.create)
  .openapi(routes.setStatus, handlers.setStatus)
  .openapi(routes.grantMembership, handlers.grantMembership);

export default router;
