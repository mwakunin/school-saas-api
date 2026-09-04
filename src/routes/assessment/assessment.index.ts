import { createTenantRouter } from "@/lib/create-app";
import { withMembership, withTenant } from "@/middlewares/tenant";

import * as handlers from "./assessment.handlers";
import * as routes from "./assessment.routes";

const router = createTenantRouter();

router.use(withTenant);
router.use(withMembership);

router
  .openapi(routes.listAssessments, handlers.listAssessments)
  .openapi(routes.createAssessment, handlers.createAssessment)
  .openapi(routes.getAssessment, handlers.getAssessment)
  .openapi(routes.saveScores, handlers.saveScores)
  .openapi(routes.publishAssessment, handlers.publishAssessment)
  .openapi(routes.unpublishAssessment, handlers.unpublishAssessment)
  .openapi(routes.computeResults, handlers.computeResults)
  .openapi(routes.listTermResults, handlers.listTermResults)
  // Before /report-cards/{id}, so "finalise" is never parsed as an id.
  .openapi(routes.finaliseReportCard, handlers.finaliseReportCard)
  .openapi(routes.listReportCards, handlers.listReportCards)
  .openapi(routes.getReportCard, handlers.getReportCard)
  .openapi(routes.releaseReportCard, handlers.releaseReportCard);

export default router;
