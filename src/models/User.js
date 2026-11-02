import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const UserSchema = new mongoose.Schema(
  {
    hotelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hotel',
      default: null, // null for super-admins
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6,
      select: false, // Omit password hash by default in queries
    },
    role: {
      type: String,
      enum: ['HOTELIER', 'STAFF', 'SUPER_ADMIN'],
      default: 'HOTELIER',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Bumped on password change / reset / "sign out everywhere" / deactivation.
    // Every JWT carries the value it was issued with; a mismatch means it was revoked.
    tokenVersion: { type: Number, default: 0 },
    passwordChangedAt: { type: Date, default: null },
    // Set for staff invited by a manager; cleared when the invite is accepted.
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    invitePending: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password method
UserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model('User', UserSchema);