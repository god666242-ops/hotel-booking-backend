import "dotenv/config";
// Initialize Sentry before importing HTTP, Express, Mongoose, or background workers
// to ensure auto-instrumentation hooks attach to all network and database drivers.
import { initSentry } from "./src/config/sentry.js";
initSentry();

import http from "http";
import dns from "dns";
import mongoose from "mongoose";
import app from "./src/app.js";
import { connectDB } from "./src/config/db.js";
import { validateEnv } from "./src/config/env.js";
import { getRedisClient } from "./src/config/redis.js";
import { startHoldCleanupScheduler } from "./src/jobs/cleanupExpiredHolds.js";
import { startPaymentReconciliationScheduler } from "./src/jobs/reconcilePayments.js";
import { startGuestLifecycleScheduler } from "./src/jobs/processGuestLifecycleEmails.js";
import { startIcalSyncScheduler } from "./src/services/ical.service.js";
import { startCommissionScheduler } from "./src/jobs/processWeeklyCommission.js";

// Hardcoded DNS fix: Only set in local development if specifically requested
if (
  process.env.NODE_ENV !== "production" &&
  process.env.DEV_FORCE_CUSTOM_DNS === "true"
) {
  dns.setServers(["8.8.8.8", "8.8.4.4"]);
}

const PORT = process.env.PORT || 5000;

async function startServer() {
  // 0. Refuse to boot with a broken or unsafe configuration
  validateEnv();

  // 1. Connect to MongoDB
  await connectDB();

  // 2. Initialize Redis Client
  getRedisClient();

  // 3. Create HTTP Server
  const server = http.createServer(app);

  server.listen(PORT, () => {
    console.log(
      `[Server] Running in ${process.env.NODE_ENV || "development"} mode on port ${PORT}`,
    );
  });

  // Start background schedulers
  const timers = [
    startHoldCleanupScheduler(),
    startCommissionScheduler(),
    startPaymentReconciliationScheduler(),
    startGuestLifecycleScheduler(),
    startIcalSyncScheduler(),
  ].filter(Boolean);

  // Graceful shutdown: stop jobs, drain HTTP, close the DB, then exit
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Server] ${signal} received. Gracefully shutting down...`);

    timers.forEach((t) => clearInterval(t));

    // Force-exit if connections refuse to drain
    const forceExit = setTimeout(() => {
      console.error("[Server] Forced shutdown after timeout.");
      process.exit(1);
    }, 15000);
    forceExit.unref();

    server.close(async () => {
      try {
        await mongoose.connection.close();
      } catch (err) {
        console.error(
          "[Server] Error closing MongoDB connection:",
          err.message,
        );
      }
      console.log("[Server] Closed remaining connections.");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled Rejection]", reason);
});

startServer().catch((err) => {
  console.error("[Startup Failed]", err.message);
  process.exit(1);
});
