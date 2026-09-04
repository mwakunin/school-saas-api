import { createRouter } from "@/lib/create-app";

import * as handlers from "./webhooks.handlers";
import * as routes from "./webhooks.routes";

/**
 * Not a tenant router, and not rate limited.
 *
 * The tenant comes from the callback token in the path rather than a subdomain
 * or a session, so `withTenant` has nothing to work from. And Safaricom
 * retries anything it does not see acknowledged, so a throttled confirmation
 * becomes a payment the school never learns about.
 */
const router = createRouter()
  .openapi(routes.c2bConfirmation, handlers.c2bConfirmation)
  .openapi(routes.c2bValidation, handlers.c2bValidation);

export default router;
