import { createTenantRouter } from "@/lib/create-app";
import { withMembership, withTenant } from "@/middlewares/tenant";

import * as handlers from "./staff.handlers";
import * as routes from "./staff.routes";

const router = createTenantRouter();

router.use(withTenant);
router.use(withMembership);

router
  .openapi(routes.listStaff, handlers.listStaff)
  .openapi(routes.grantStaff, handlers.grantStaff)
  .openapi(routes.updateStaff, handlers.updateStaff);

export default router;
