import { createTenantRouter } from "@/lib/create-app";
import { withMembership, withTenant } from "@/middlewares/tenant";

import * as handlers from "./students.handlers";
import * as routes from "./students.routes";

const router = createTenantRouter();

router.use(withTenant);
router.use(withMembership);

router
  .openapi(routes.list, handlers.list)
  .openapi(routes.create, handlers.create)
  // Before /students/{id}, so `guardians` is never parsed as an id.
  .openapi(routes.listGuardians, handlers.listGuardians)
  .openapi(routes.createGuardian, handlers.createGuardian)
  .openapi(routes.getGuardian, handlers.getGuardian)
  .openapi(routes.getOne, handlers.getOne)
  .openapi(routes.update, handlers.update)
  .openapi(routes.exitStudent, handlers.exitStudent)
  .openapi(routes.readmit, handlers.readmit)
  .openapi(routes.enroll, handlers.enroll)
  .openapi(routes.linkGuardian, handlers.linkGuardian)
  .openapi(routes.updateGuardianLink, handlers.updateGuardianLink)
  .openapi(routes.unlinkGuardian, handlers.unlinkGuardian);

export default router;
