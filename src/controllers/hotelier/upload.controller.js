import multer from 'multer';
import { uploadImageFile, getActiveProvider } from '../../services/storage.service.js';

// Multer memory storage (keeps file in RAM buffer for direct cloud piping)
const storage = multer.memoryStorage();
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per image
  fileFilter: (req, file, cb) => {
    // Explicitly reject SVGs which can embed executable JavaScript
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error('Only safe raster images (JPG, PNG, WEBP, AVIF) are permitted.');
      err.status = 400;
      cb(err, false);
    }
  },
});

/**
 * The multipart Content-Type is chosen by the client, so also check the file's
 * real magic bytes. Stops an SVG/HTML payload being uploaded as "image/png".
 */
export function looksLikeAllowedImage(buffer) {
  if (!buffer || buffer.length < 12) return false;

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isWebp =
    buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  const isAvif =
    buffer.toString('ascii', 4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(buffer.toString('ascii', 8, 12));

  return isJpeg || isPng || isWebp || isAvif;
}

/**
 * POST /api/v1/admin/upload/images
 * Uploads up to 8 images at once and returns their secure public URLs
 */
export async function handleImageUpload(req, res, next) {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: 'No image files provided.' });
    }

    if (!files.every((file) => looksLikeAllowedImage(file.buffer))) {
      return res.status(400).json({
        success: false,
        message: 'One or more files are not valid JPG, PNG, WEBP or AVIF images.',
      });
    }

    const provider = getActiveProvider();
    if (!provider) {
      return res.status(500).json({
        success: false,
        message: 'Storage configuration missing. Please provide Cloudinary or AWS S3 credentials in backend .env',
      });
    }

    // Upload files in parallel
    const folder = `hotels/${req.user.hotelId || 'common'}/rooms`;
    const uploadPromises = files.map((file) =>
      uploadImageFile(
        {
          buffer: file.buffer,
          originalname: file.originalname,
          mimetype: file.mimetype,
        },
        folder
      )
    );

    const urls = await Promise.all(uploadPromises);

    return res.status(200).json({
      success: true,
      provider,
      urls,
      message: `Successfully uploaded ${urls.length} image(s) via ${provider}.`,
    });
  } catch (error) {
    next(error);
  }
}