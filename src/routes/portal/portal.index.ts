import { createTenantRouter } from "@/lib/create-app";
import { withMembership, withTenant } from "@/middlewares/tenant";

import * as handlers from "./portal.handlers";
import * as routes from "./portal.routes";

const router = createTenantRouter();

router.use(withTenant);
router.use(withMembership);

router
  .openapi(routes.claim, handlers.claim)
  .openapi(routes.myChildren, handlers.myChildren)
  .openapi(routes.childResults, handlers.childResults)
  .openapi(routes.childReportCards, handlers.childReportCards)
  .openapi(routes.childFees, handlers.childFees);

export default router;
