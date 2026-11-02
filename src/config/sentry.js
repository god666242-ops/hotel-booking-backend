import * as Sentry from "@sentry/node";

let isInitialized = false;

export function initSentry() {
  if (isInitialized) return;
  
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[Sentry] SENTRY_DSN not provided. System alerts disabled.");
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    // Tracing is automatic in modern @sentry/node
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
  });

  isInitialized = true;
  console.log("[Sentry] Initialized error monitoring and alerting.");
}

export { Sentry };