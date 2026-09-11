import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { wrap } from '../middleware/http.js';
import { clearDemoData, getDemoDataStatus, loadDemoData } from '../services/demoData.js';

/** Admin > Master > Demo Data — Admin-only, same as every other master. */
export const demoDataRouter = Router();

demoDataRouter.get('/status', requireAuth, requireAdmin, wrap((_req, res) => {
  res.json(getDemoDataStatus());
}));

demoDataRouter.post('/load', requireAuth, requireAdmin, wrap((req, res) => {
  const result = loadDemoData({ user: req.user!.username, ip: req.clientIp ?? null });
  res.status(201).json(result);
}));

demoDataRouter.post('/clear', requireAuth, requireAdmin, wrap((req, res) => {
  const result = clearDemoData({ user: req.user!.username, ip: req.clientIp ?? null });
  res.json(result);
}));
