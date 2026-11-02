import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import * as Sentry from "@sentry/node";
import apiRoutes from "./routes/index.js";
import { errorHandler } from "./middlewares/errorHandler.middleware.js";

const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Parse admin allowlist
const adminAllowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:3000", "http://localhost:3001"];

// 1. Open CORS for public embeddable widget & guest booking routes
app.use(
  "/api/v1/public",
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
  }),
);

// Strict CORS for Super Admin endpoints
app.use(
  "/api/v1/superadmin",
  cors({
    origin: (origin, callback) => {
      const allowed = [
        "http://localhost:3003",
        "https://ops.purebook.in",
        ...(process.env.SUPERADMIN_ALLOWED_ORIGINS
          ? process.env.SUPERADMIN_ALLOWED_ORIGINS.split(",").map((s) =>
              s.trim(),
            )
          : []),
      ];
      if (!origin || allowed.includes(origin)) return callback(null, true);
      return callback(new Error("CORS blocked for Super Admin gateway"));
    },
    credentials: true,
  }),
);

// 2. Strict CORS for hotelier administration endpoints
app.use(
  "/api/v1/admin",
  cors({
    origin: (origin, callback) => {
      if (!origin || adminAllowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  }),
);

// Raw body parser for HMAC verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get("/health", (req, res) => {
  res
    .status(200)
    .json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.use("/api/v1", apiRoutes);

// Modern Sentry v8+ Express error integration
if (process.env.SENTRY_DSN) {
  if (typeof Sentry.setupExpressErrorHandler === "function") {
    Sentry.setupExpressErrorHandler(app);
  }
}

// Application custom error handler
app.use(errorHandler);

export default app;
