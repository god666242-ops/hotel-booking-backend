// backend/scripts/migrateHotelPaymentModes.js
// One-off migration for the new payment model.
//   node --env-file=.env scripts/migrateHotelPaymentModes.js --dry   (preview)
//   node --env-file=.env scripts/migrateHotelPaymentModes.js         (apply)
import mongoose from "mongoose";
import dns from "dns";

const DRY = process.argv.includes("--dry");

if (
  process.env.NODE_ENV !== "production" &&
  process.env.DEV_FORCE_CUSTOM_DNS === "true"
) {
  dns.setServers(["8.8.8.8", "8.8.4.4"]);
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set.");
  await mongoose.connect(process.env.MONGODB_URI);

  const db = mongoose.connection.db;
  const hotels = db.collection("hotels");
  const ledgers = db.collection("payoutledgers");

  // 1. Unsettled payouts you still owe hotels. Settle these by hand BEFORE
  //    deleting the payout code, because nothing will pay them afterwards.
  const unsettled = await ledgers
    .aggregate([
      {
        $match: {
          payoutStatus: {
            $in: ["PENDING", "READY_FOR_SETTLEMENT", "PROCESSING", "FAILED", "ON_HOLD"],
          },
        },
      },
      {
        $group: {
          _id: "$payoutStatus",
          count: { $sum: 1 },
          amount: { $sum: "$netPayableToHotel" },
        },
      },
    ])
    .toArray();
  console.log("Unsettled payout ledgers:", unsettled.length ? unsettled : "none");

  // 2. Hotels on the old PLATFORM_MANAGED mode become PAY_AT_HOTEL.
  const toMove = await hotels.countDocuments({ "paymentConfig.mode": "PLATFORM_MANAGED" });
  console.log(`Hotels to move PLATFORM_MANAGED -> PAY_AT_HOTEL: ${toMove}`);

  // 3. Hotels missing the new commission settings.
  const missingDefaults = await hotels.countDocuments({
    $or: [
      { "paymentConfig.gatewayCommissionPercent": { $exists: false } },
      { "paymentConfig.payAtHotelCommissionPercent": { $exists: false } },
    ],
  });
  console.log(`Hotels missing commission settings: ${missingDefaults}`);

  // 4. Own-gateway hotels with no webhook secret saved (they cannot confirm payments).
  const noWebhook = await hotels
    .find(
      {
        "paymentConfig.mode": "HOTEL_GATEWAY",
        $or: [
          { "paymentConfig.hotelRazorpay.webhookSecretEncrypted": null },
          { "paymentConfig.hotelRazorpay.webhookSecretEncrypted": { $exists: false } },
        ],
      },
      { projection: { name: 1, slug: 1 } },
    )
    .toArray();
  console.log(
    "Own-gateway hotels without a webhook secret:",
    noWebhook.length ? noWebhook.map((h) => h.slug || h.name) : "none",
  );

  if (DRY) {
    console.log("\nDry run: nothing was changed.");
    return;
  }

  const moved = await hotels.updateMany(
    { "paymentConfig.mode": "PLATFORM_MANAGED" },
    { $set: { "paymentConfig.mode": "PAY_AT_HOTEL" } },
  );
  const g = await hotels.updateMany(
    { "paymentConfig.gatewayCommissionPercent": { $exists: false } },
    { $set: { "paymentConfig.gatewayCommissionPercent": 5 } },
  );
  const p = await hotels.updateMany(
    { "paymentConfig.payAtHotelCommissionPercent": { $exists: false } },
    { $set: { "paymentConfig.payAtHotelCommissionPercent": 8 } },
  );

  console.log(
    `\nApplied. Modes moved: ${moved.modifiedCount}, gateway % set: ${g.modifiedCount}, pay-at-hotel % set: ${p.modifiedCount}`,
  );
}

main()
  .catch((err) => {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());