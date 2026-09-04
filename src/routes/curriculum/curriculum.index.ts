import { createTenantRouter } from "@/lib/create-app";
import { withMembership, withTenant } from "@/middlewares/tenant";

import * as handlers from "./curriculum.handlers";
import * as routes from "./curriculum.routes";

const router = createTenantRouter();

router.use(withTenant);
router.use(withMembership);

router
  // Before /learning-areas/{id}, so "seed" is never parsed as an id.
  .openapi(routes.seed, handlers.seed)
  .openapi(routes.listAreas, handlers.listAreas)
  .openapi(routes.createArea, handlers.createArea)
  .openapi(routes.getArea, handlers.getArea)
  .openapi(routes.updateArea, handlers.updateArea)
  .openapi(routes.removeArea, handlers.removeArea)
  .openapi(routes.addCompetency, handlers.addCompetency)
  .openapi(routes.removeCompetency, handlers.removeCompetency);

export default router;
