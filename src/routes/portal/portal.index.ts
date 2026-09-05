import { createTenantRouter } from "@/lib/create-app";
import { withTenant } from "@/middlewares/tenant";

import * as handlers from "./portal.handlers";
import * as routes from "./portal.routes";

const router = createTenantRouter();

/*
 * `withMembership` is applied PER ROUTE here, not to the router.
 *
 * It answers 404 for anyone without a membership at this school — which is
 * right for every other tenant route and fatal for this one. A parent signing
 * up has no membership; claiming is how they get one; and claiming behind
 * `withMembership` means they could never reach it. The portal was
 * unreachable for anybody an admin had not already granted the role to by
 * hand, which is every real parent.
 */
router.use(withTenant);

router
  .openapi(routes.claim, handlers.claim)
  .openapi(routes.myChildren, handlers.myChildren)
  .openapi(routes.childResults, handlers.childResults)
  .openapi(routes.childReportCards, handlers.childReportCards)
  .openapi(routes.childFees, handlers.childFees);

export default router;
