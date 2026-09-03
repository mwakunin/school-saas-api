import { createTenantRouter } from "@/lib/create-app";
import { withMembership, withTenant } from "@/middlewares/tenant";

import * as handlers from "./fees.handlers";
import * as routes from "./fees.routes";

const router = createTenantRouter();

router.use(withTenant);
router.use(withMembership);

router
  .openapi(routes.listStructures, handlers.listStructures)
  .openapi(routes.createStructure, handlers.createStructure)
  .openapi(routes.addItem, handlers.addItem)
  .openapi(routes.updateItem, handlers.updateItem)
  .openapi(routes.removeItem, handlers.removeItem)
  // Before /invoices/{id}, so "generate" is never parsed as an id.
  .openapi(routes.generate, handlers.generate)
  .openapi(routes.listInvoices, handlers.listInvoices)
  .openapi(routes.getInvoice, handlers.getInvoice)
  .openapi(routes.addLine, handlers.addLine)
  .openapi(routes.voidInvoice, handlers.voidInvoice)
  .openapi(routes.recordPayment, handlers.recordPayment)
  .openapi(routes.listPayments, handlers.listPayments)
  .openapi(routes.reversePayment, handlers.reversePayment)
  .openapi(routes.listBalances, handlers.listBalances);

export default router;
