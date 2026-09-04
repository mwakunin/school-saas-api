import { createTenantRouter } from "@/lib/create-app";
import { withMembership, withTenant } from "@/middlewares/tenant";

import * as handlers from "./reconciliation.handlers";
import * as routes from "./reconciliation.routes";

const router = createTenantRouter();

router.use(withTenant);
router.use(withMembership);

router
  // Before /mpesa/transactions/{id}, so "match" is never parsed as an id.
  .openapi(routes.runMatcher, handlers.runMatcher)
  .openapi(routes.listTransactions, handlers.listTransactions)
  .openapi(routes.getTransaction, handlers.getTransaction)
  .openapi(routes.allocate, handlers.allocate)
  .openapi(routes.reject, handlers.reject)
  .openapi(routes.requeue, handlers.requeue)
  .openapi(routes.getMpesaSettings, handlers.getMpesaSettings)
  .openapi(routes.configureMpesa, handlers.configureMpesa);

export default router;
