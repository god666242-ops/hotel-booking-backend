import express from 'express';
import publicRoutes from './public.routes.js';
import hotelierRoutes from './hotelier.routes.js';
import webhookRoutes from './webhook.routes.js';
import superadminRoutes from './superadmin.routes.js';

const router = express.Router();

router.use('/public', publicRoutes);
router.use('/admin', hotelierRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/superadmin', superadminRoutes);

export default router;