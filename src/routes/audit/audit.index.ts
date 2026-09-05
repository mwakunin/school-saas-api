import { createTenantRouter } from "@/lib/create-app";
import { withMembership, withTenant } from "@/middlewares/tenant";

import * as handlers from "./audit.handlers";
import * as routes from "./audit.routes";

const router = createTenantRouter();

router.use(withTenant);
router.use(withMembership);

router.openapi(routes.listAudit, handlers.listAudit);

export default router;
