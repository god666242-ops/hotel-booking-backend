import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Hotel from '../models/Hotel.js';
import RoomType from '../models/RoomType.js';
import { releaseRoomInventory, removeRedisHoldLock } from '../services/inventory.service.js';
import { recoverStuckCancellation } from '../services/bookingCancellation.service.js';
import { sendAbandonedHoldRecoveryEmail } from '../services/notification.service.js';
import { sendSystemAlert } from '../utils/systemAlerts.js';

const HOLD_EXPIRATION_MINUTES = 10;
const STUCK_REHOLD_MINUTES = 5;
const STUCK_CANCELLATION_MINUTES = 10;

export async function cleanupExpiredHolds() {
  try {
    const expirationThreshold = new Date(Date.now() - HOLD_EXPIRATION_MINUTES * 60 * 1000);

    const staleHolds = await Booking.find({
      status: 'HELD',
      createdAt: { $lt: expirationThreshold },
    }).select('_id').lean();

    for (const hold of staleHolds) {
      const session = await mongoose.startSession();
      let expired = null;

      try {
        await session.withTransaction(async () => {
          expired = null;

          const updated = await Booking.findOneAndUpdate(
            { _id: hold._id, status: 'HELD' },
            { $set: { status: 'EXPIRED', 'payment.status': 'EXPIRED' } },
            { session, new: true }
          );
          if (!updated) return;

          if (updated.promotions?.promoCode) {
            await Hotel.updateOne(
              { _id: updated.hotelId, 'promoCodes.code': updated.promotions.promoCode },
              { $inc: { 'promoCodes.$.usedCount': -1 } },
              { session }
            );
          }

          await releaseRoomInventory({
            hotelId: updated.hotelId,
            roomTypeId: updated.roomTypeId,
            checkInDate: updated.dates.checkIn,
            checkOutDate: updated.dates.checkOut,
            roomCount: updated.roomCount,
            session,
          });

          expired = updated;
        });

        if (expired) {
          await removeRedisHoldLock(expired._id.toString()).catch(() => {});

          if (expired.guest?.email && expired.source === 'ONLINE') {
            try {
              const [hotel, roomType] = await Promise.all([
                Hotel.findById(expired.hotelId).lean(),
                RoomType.findById(expired.roomTypeId).lean(),
              ]);

              if (hotel) {
                await sendAbandonedHoldRecoveryEmail({
                  booking: expired,
                  hotel,
                  roomType,
                });
              }
            } catch (notifyErr) {
              console.error(`[Recovery Job Error] Failed to send recovery email:`, notifyErr.message);
            }
          }
        }
      } catch (error) {
        console.error(`[Cleanup Job] Failed processing booking ${hold._id}:`, error.message);
      } finally {
        await session.endSession();
      }
    }
  } catch (error) {
    console.error('[Cleanup Job Error]:', error.message);
  }
}

export async function recoverStuckBookings() {
  try {
    const rehold = await Booking.updateMany(
      {
        status: 'REHOLD_IN_PROGRESS',
        updatedAt: { $lt: new Date(Date.now() - STUCK_REHOLD_MINUTES * 60 * 1000) },
      },
      { $set: { status: 'EXPIRED' } }
    );
    if (rehold.modifiedCount > 0) {
      await sendSystemAlert({
        type: 'STUCK_BOOKING',
        title: 'Bookings Stuck in REHOLD_IN_PROGRESS',
        message: `Found ${rehold.modifiedCount} booking(s) stuck in REHOLD_IN_PROGRESS. Unlocked back to EXPIRED for webhook retry.`,
        severity: 'warning',
      });
    }

    const stuckCancellations = await Booking.find({
      status: 'CANCELLATION_IN_PROGRESS',
      updatedAt: { $lt: new Date(Date.now() - STUCK_CANCELLATION_MINUTES * 60 * 1000) },
    }).select('_id bookingCode hotelId').lean();

    for (const stuck of stuckCancellations) {
      try {
        const outcome = await recoverStuckCancellation(stuck._id);
        if (outcome !== 'finalized' && outcome !== 'reverted') {
          await sendSystemAlert({
            type: 'STUCK_BOOKING',
            title: 'Stuck Cancellation Unresolved',
            message: `Booking ${stuck.bookingCode} stuck in CANCELLATION_IN_PROGRESS could not be resolved automatically (${outcome}).`,
            metadata: { bookingId: stuck._id, bookingCode: stuck.bookingCode, hotelId: stuck.hotelId },
            severity: 'error',
          });
        }
      } catch (error) {
        await sendSystemAlert({
          type: 'STUCK_BOOKING',
          title: 'Error Recovering Stuck Cancellation',
          message: `Crash attempting to recover stuck booking ${stuck.bookingCode}: ${error.message}`,
          metadata: { bookingCode: stuck.bookingCode, error: error.message },
          severity: 'error',
        });
      }
    }
  } catch (error) {
    console.error('[Recovery Job Error]:', error.message);
  }
}

let isRunning = false;

async function runMaintenance() {
  if (isRunning) return;
  isRunning = true;
  try {
    await cleanupExpiredHolds();
    await recoverStuckBookings();
  } finally {
    isRunning = false;
  }
}

export function startHoldCleanupScheduler(intervalMs = 120000) {
  console.log('[Scheduler] Expired hold cleanup + stuck booking recovery worker active.');
  const timer = setInterval(runMaintenance, intervalMs);
  timer.unref?.();
  return timer;
}