import { createTenantRouter } from "@/lib/create-app";
import { withMembership, withTenant } from "@/middlewares/tenant";

import * as handlers from "./messaging.handlers";
import * as routes from "./messaging.routes";

const router = createTenantRouter();

router.use(withTenant);
router.use(withMembership);

router
  .openapi(routes.resultsNotice, handlers.resultsNotice)
  .openapi(routes.feeReminders, handlers.feeReminders)
  .openapi(routes.listSms, handlers.listSms);

export default router;
