import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from "dns";

// Load backend environment variables
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import User from '../models/User.js';

if (
  process.env.NODE_ENV !== "production" &&
  process.env.DEV_FORCE_CUSTOM_DNS === "true"
) {
  dns.setServers(["8.8.8.8", "8.8.4.4"]);
}

const createSuperAdmin = async () => {
  const email = 'superadmin@purebook.in';
  const password = 'Kpking@900';
  const name = 'PurBook SuperAdmin';

  if (!process.env.MONGODB_URI) {
    console.error('Error: MONGODB_URI is not defined in your environment.');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB database.');

    const existingUser = await User.findOne({ email: email.toLowerCase() });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    if (existingUser) {
      existingUser.role = 'SUPER_ADMIN';
      existingUser.password = passwordHash;
      existingUser.name = name;
      existingUser.isActive = true;
      await existingUser.save();
      console.log(`Updated existing user [${email}] to role 'superadmin'.`);
    } else {
      await User.create({
        name,
        email: email.toLowerCase(),
        password,
        role: 'SUPER_ADMIN',
        isActive: true,
      });
      console.log(`Created new superadmin account: ${email}`);
    }

    console.log('Superadmin credentials set successfully:');
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${password}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Failed to create superadmin:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  }
};

createSuperAdmin();