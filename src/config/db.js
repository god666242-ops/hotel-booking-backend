// backend/src/config/db.js
import mongoose from 'mongoose';

export async function connectDB() {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`[Database] MongoDB Connected: ${conn.connection.host}`);

    // Ensure critical compound and unique indexes exist in production
    const models = [
      mongoose.model('Hotel'),
      mongoose.model('RoomType'),
      mongoose.model('DailyInventory'),
      mongoose.model('Booking'),
      mongoose.model('CommissionInvoice'),
      mongoose.model('User')
    ];

    for (const model of models) {
      await model.syncIndexes();
    }
    console.log('[Database] Schema indexes synchronized.');
  } catch (error) {
    console.error(`[Database Error] ${error.message}`);
    process.exit(1);
  }
}