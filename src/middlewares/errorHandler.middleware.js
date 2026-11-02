import * as Sentry from "@sentry/node";

/**
 * Central error handler.
 * - Honors err.status / err.statusCode (body-parser 413, upload validation, etc.)
 * - Maps common Mongoose/Mongo errors to 4xx instead of a generic 500
 * - Dispatches 5xx unhandled exceptions to Sentry with enriched request context
 * - Never leaks internal messages or stacks for 5xx in production
 */
export function errorHandler(err, req, res, next) {
  console.error("[Unhandled Error]", err?.stack || err);

  if (res.headersSent) {
    return next(err);
  }

  let statusCode = Number(err?.status || err?.statusCode) || 0;
  let message = err?.message;

  if (err?.name === "ValidationError") {
    statusCode = 400;
    message = Object.values(err.errors || {})
      .map((e) => e.message)
      .join(" ") || "Validation failed.";
  } else if (err?.name === "CastError") {
    statusCode = 400;
    message = "Invalid identifier or value supplied.";
  } else if (err?.code === 11000) {
    statusCode = 409;
    message = "A record with these details already exists.";
  } else if (err?.name === "MulterError") {
    statusCode = 400;
  }

  if (!statusCode) {
    statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  }

  const isServerError = statusCode >= 500;
  const isProd = process.env.NODE_ENV === "production";

  // Report 5xx errors to Sentry with contextual metadata
  if (isServerError && process.env.SENTRY_DSN) {
    try {
      Sentry.withScope((scope) => {
        scope.setTag("path", req.originalUrl || req.url);
        scope.setTag("method", req.method);
        if (req.params?.hotelSlug) {
          scope.setTag("hotelSlug", req.params.hotelSlug);
        }
        if (req.user) {
          scope.setUser({
            id: req.user._id?.toString() || req.user.id,
            email: req.user.email,
            role: req.user.role,
          });
        }
        scope.setExtra("body", req.body ? { ...req.body, password: "[REDACTED]" } : undefined);
        scope.setExtra("query", req.query);
        Sentry.captureException(err);
      });
    } catch (sentryErr) {
      console.error("[Sentry Capture Failed]:", sentryErr);
    }
  }

  return res.status(statusCode).json({
    success: false,
    message:
      isServerError && isProd
        ? "Something went wrong. Please try again."
        : message || "Internal Server Error",
    ...(!isProd && isServerError && { stack: err?.stack }),
  });
}