import Razorpay from 'razorpay';

export const masterRazorpay = new Razorpay({
  key_id: process.env.MASTER_RAZORPAY_KEY_ID || 'dummy_id',
  key_secret: process.env.MASTER_RAZORPAY_KEY_SECRET || 'dummy_secret',
});