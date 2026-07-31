/**
 * Error tracking — the DriverOS half of the commercial-readiness review's
 * "no monitoring exists" finding. See apps/fleethq/src/instrument.ts and
 * apps/api/src/instrument.ts for the same pattern applied to the other two
 * apps. This one matters more than it might look: DriverOS is the app
 * running unattended in a vehicle cab — a crash nobody in an office ever
 * sees a screenshot of is exactly the failure mode error tracking exists for.
 */
import * as Sentry from '@sentry/react';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN || undefined,
  environment: import.meta.env.MODE,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
