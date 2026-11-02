import { v2 as cloudinary } from 'cloudinary';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import path from 'path';

// 1. Cloudinary initialization
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

// 2. AWS S3 initialization
let s3Client = null;
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET_NAME) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Determine the active storage provider based on environment variables
 */
export function getActiveProvider() {
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    return 'CLOUDINARY';
  }
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET_NAME) {
    return 'S3';
  }
  return null;
}

/**
 * Upload to Cloudinary using a buffer stream
 */
function uploadToCloudinary(buffer, folder = 'hotel_rooms') {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    uploadStream.end(buffer);
  });
}

/**
 * Upload to AWS S3 using PutObjectCommand
 */
async function uploadToS3(buffer, originalname, mimetype, folder = 'hotel_rooms') {
  const fileExt = path.extname(originalname);
  const randomHex = crypto.randomBytes(8).toString('hex');
  const key = `${folder}/${Date.now()}-${randomHex}${fileExt}`;

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimetype,
  });

  await s3Client.send(command);

  const region = process.env.AWS_REGION || 'ap-south-1';
  return `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Main export: Upload file to whichever cloud provider is configured
 */
export async function uploadImageFile({ buffer, originalname, mimetype }, folder = 'hotel_rooms') {
  const provider = getActiveProvider();

  if (provider === 'CLOUDINARY') {
    return await uploadToCloudinary(buffer, folder);
  }

  if (provider === 'S3') {
    return await uploadToS3(buffer, originalname, mimetype, folder);
  }

  throw new Error('No cloud storage credentials found. Please set Cloudinary or AWS S3 variables in .env');
}