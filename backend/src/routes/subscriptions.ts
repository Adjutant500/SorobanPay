/**
 * GET /subscriptions/:merchant
 *
 * Returns a paginated list of subscriptions associated with a merchant address.
 *
 * Issue: #1373
 *
 * Query parameters:
 *   status    — filter by subscription status: active | overdue | expired | cancelled
 *   page      — 1-based page number (default: 1)
 *   pageSize  — records per page, max 100 (default: 20)
 *
 * Response shape:
 *   {
 *     data: Subscription[],
 *     pagination: { page, pageSize, total, totalPages }
 *   }
 *
 * Rate limit: 100 requests per minute per IP (applied at router level).
 *
 * OpenAPI spec: see /docs endpoint served by the main app.
 */

import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import { getPool } from '../db/pool';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Subscription {
  id: number;
  subscriber: string;
  merchant: string;
  token: string;
  amount: string;
  interval_sec: number;
  next_payment: string;
  status: 'active' | 'overdue' | 'expired' | 'cancelled';
  overdue_since: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SubscriptionsResponse {
  data: Subscription[];
  pagination: PaginationMeta;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set(['active', 'overdue', 'expired', 'cancelled']);

function parsePositiveInt(value: unknown, fallback: number, max?: number): number {
  const n = parseInt(String(value), 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  if (max !== undefined && n > max) return max;
  return n;
}

// ---------------------------------------------------------------------------
// Route factory — accepts an optional pool for testing
// ---------------------------------------------------------------------------

export function createSubscriptionsRouter(pool?: Pool): Router {
  const router = Router();
  const db = pool ?? getPool();

  // Rate limit: 100 requests per minute per IP
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  /**
   * @openapi
   * /subscriptions/{merchant}:
   *   get:
   *     summary: List subscriptions for a merchant
   *     tags: [Subscriptions]
   *     parameters:
   *       - in: path
   *         name: merchant
   *         required: true
   *         schema:
   *           type: string
   *         description: Merchant Stellar address
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [active, overdue, expired, cancelled]
   *         description: Filter by subscription status
   *       - in: query
   *         name: page
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 1
   *       - in: query
   *         name: pageSize
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 20
   *     responses:
   *       200:
   *         description: Paginated list of subscriptions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SubscriptionsResponse'
   *       400:
   *         description: Invalid query parameters
   *       429:
   *         description: Rate limit exceeded
   *       500:
   *         description: Internal server error
   */
  router.get(
    '/subscriptions/:merchant',
    limiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { merchant } = req.params;
        const { status } = req.query;

        // Validate status filter
        if (status !== undefined && !VALID_STATUSES.has(String(status))) {
          res.status(400).json({
            error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(', ')}`,
          });
          return;
        }

        const page = parsePositiveInt(req.query.page, 1);
        const pageSize = parsePositiveInt(req.query.pageSize, 20, 100);
        const offset = (page - 1) * pageSize;

        // Build query dynamically based on optional status filter
        const conditions: string[] = ['merchant = $1'];
        const params: unknown[] = [merchant];
        let paramIdx = 2;

        if (status) {
          conditions.push(`status = $${paramIdx++}`);
          params.push(String(status));
        }

        const whereClause = conditions.join(' AND ');

        // Count total matching rows (for pagination metadata)
        const countResult = await db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM subscriptions WHERE ${whereClause}`,
          params,
        );
        const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

        // Fetch the requested page
        const dataResult = await db.query<Subscription>(
          `SELECT
             id, subscriber, merchant, token,
             amount::text AS amount,
             interval_sec,
             next_payment,
             status,
             overdue_since,
             created_at,
             updated_at
           FROM subscriptions
           WHERE ${whereClause}
           ORDER BY created_at DESC
           LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
          [...params, pageSize, offset],
        );

        const response: SubscriptionsResponse = {
          data: dataResult.rows,
          pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
          },
        };

        res.json(response);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
