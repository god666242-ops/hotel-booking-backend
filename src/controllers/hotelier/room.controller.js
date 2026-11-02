import RoomType from '../../models/RoomType.js';

export async function getRooms(req, res, next) {
  try {
    const rooms = await RoomType.find({ hotelId: req.user.hotelId }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: rooms });
  } catch (error) {
    next(error);
  }
}

export async function createRoom(req, res, next) {
  try {
    const room = await RoomType.create({
      ...req.body,
      hotelId: req.user.hotelId,
    });
    return res.status(201).json({ success: true, data: room });
  } catch (error) {
    next(error);
  }
}

export async function updateRoom(req, res, next) {
  try {
    const { id } = req.params;
    const allowedUpdates = [
      'name', 'description', 'baseOccupancy', 'maxOccupancy',
      'extraAdultRate', 'extraChildRate', 'basePrice',
      'totalUnits', 'taxPercent', 'photos', 'amenities', 'addOns', 'isActive'
    ];

    const sanitized = {};
    for (const key of allowedUpdates) {
      if (req.body[key] !== undefined) sanitized[key] = req.body[key];
    }

    const room = await RoomType.findOneAndUpdate(
      { _id: id, hotelId: req.user.hotelId },
      { $set: sanitized },
      { new: true, runValidators: true }
    );

    if (!room) return res.status(404).json({ success: false, message: 'Room not found.' });
    return res.status(200).json({ success: true, data: room });
  } catch (error) {
    next(error);
  }
}

export async function deleteRoom(req, res, next) {
  try {
    const { id } = req.params;
    const room = await RoomType.findOneAndUpdate(
      { _id: id, hotelId: req.user.hotelId },
      { isActive: false },
      { new: true }
    );
    if (!room) return res.status(404).json({ success: false, message: 'Room type not found.' });

    return res.status(200).json({ success: true, message: 'Room type deactivated successfully.' });
  } catch (error) {
    next(error);
  }
}