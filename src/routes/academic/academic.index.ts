import { createTenantRouter } from "@/lib/create-app";
import { withMembership, withTenant } from "@/middlewares/tenant";

import * as handlers from "./academic.handlers";
import * as routes from "./academic.routes";

/**
 * Mounted behind the tenant chain, which must run in this order: `withTenant`
 * opens the transaction that carries `app.school_id`, then `withMembership`
 * reads this user's roles through it. Reversing them would query memberships
 * with no tenant set and find nothing.
 */
const router = createTenantRouter();

router.use(withTenant);
router.use(withMembership);

router
  .openapi(routes.getSchool, handlers.getSchool)
  .openapi(routes.listAcademicYears, handlers.listAcademicYears)
  .openapi(routes.createAcademicYear, handlers.createAcademicYear)
  .openapi(routes.listTerms, handlers.listTerms)
  .openapi(routes.updateTerm, handlers.updateTerm)
  .openapi(routes.listGradeLevels, handlers.listGradeLevels)
  .openapi(routes.listStreams, handlers.listStreams)
  .openapi(routes.createStream, handlers.createStream);

export default router;
