/**
 * SorobanPay Backend — Express application entry point.
 *
 * Registers routes, middleware, error handling, and starts the HTTP server.
 * Also bootstraps the IndexerService and WebhookWorker background tasks.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { createSubscriptionsRouter } from './routes/subscriptions';
import { createPaymentsRouter } from './routes/payments';
import { IndexerService } from './services/indexer';
import { WebhookWorker } from './workers/webhook';
import { closePool } from './db/pool';

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // OpenAPI docs
  const swaggerDocument = {
    openapi: '3.0.0',
    info: {
      title: 'SorobanPay Backend API',
      version: '1.0.0',
      description:
        'REST API for the SorobanPay recurring payments protocol. ' +
        'Provides subscription and payment history for merchants.',
    },
    servers: [{ url: '/' }],
    components: {
      schemas: {
        Subscription: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            subscriber: { type: 'string' },
            merchant: { type: 'string' },
            token: { type: 'string' },
            amount: { type: 'string' },
            interval_sec: { type: 'integer' },
            next_payment: { type: 'string', format: 'date-time' },
            status: {
              type: 'string',
              enum: ['active', 'overdue', 'expired', 'cancelled'],
            },
            overdue_since: { type: 'string', format: 'date-time', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        SubscriptionsResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/Subscription' },
            },
            pagination: { $ref: '#/components/schemas/PaginationMeta' },
          },
        },
        Payment: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            tx_hash: { type: 'string' },
            event_type: { type: 'string', enum: ['executed', 'failure', 'cancel'] },
            subscriber: { type: 'string' },
            merchant: { type: 'string' },
            amount: { type: 'string' },
            payment_nonce: { type: 'string', nullable: true },
            ledger_seq: { type: 'integer', nullable: true },
            occurred_at: { type: 'string', format: 'date-time' },
          },
        },
        PaymentsResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/Payment' },
            },
            pagination: { $ref: '#/components/schemas/PaginationMeta' },
          },
        },
        PaginationMeta: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
      },
    },
    paths: {
      '/subscriptions/{merchant}': {
        get: {
          summary: 'List subscriptions for a merchant',
          tags: ['Subscriptions'],
          parameters: [
            {
              in: 'path',
              name: 'merchant',
              required: true,
              schema: { type: 'string' },
              description: 'Merchant Stellar address',
            },
            {
              in: 'query',
              name: 'status',
              schema: {
                type: 'string',
                enum: ['active', 'overdue', 'expired', 'cancelled'],
              },
            },
            {
              in: 'query',
              name: 'page',
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              in: 'query',
              name: 'pageSize',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: {
            '200': {
              description: 'Paginated subscriptions',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SubscriptionsResponse' },
                },
              },
            },
            '400': { description: 'Invalid parameters' },
            '429': { description: 'Rate limit exceeded' },
          },
        },
      },
      '/payments/{merchant}': {
        get: {
          summary: 'List payment history for a merchant',
          tags: ['Payments'],
          parameters: [
            {
              in: 'path',
              name: 'merchant',
              required: true,
              schema: { type: 'string' },
            },
            {
              in: 'query',
              name: 'event_type',
              schema: {
                type: 'string',
                enum: ['executed', 'failure', 'cancel'],
              },
            },
            {
              in: 'query',
              name: 'subscriber',
              schema: { type: 'string' },
            },
            {
              in: 'query',
              name: 'from',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              in: 'query',
              name: 'to',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              in: 'query',
              name: 'page',
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              in: 'query',
              name: 'pageSize',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: {
            '200': {
              description: 'Payment history (JSON or CSV)',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PaymentsResponse' },
                },
                'text/csv': { schema: { type: 'string' } },
              },
            },
            '400': { description: 'Invalid parameters' },
          },
        },
      },
    },
  };

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  // Feature routes
  app.use('/', createSubscriptionsRouter());
  app.use('/', createPaymentsRouter());

  // Generic error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[App] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Bootstrap — only executed when this file is the entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const PORT = parseInt(process.env.PORT ?? '3001', 10);

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`[App] SorobanPay backend listening on port ${PORT}`);
  });

  const rpcUrl = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const contractId = process.env.CONTRACT_ID ?? '';
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS ?? '300000', 10);

  const indexer = new IndexerService({ rpcUrl, contractId, pollIntervalMs });
  const webhookWorker = new WebhookWorker();

  indexer.start();
  webhookWorker.start();

  const shutdown = async () => {
    console.log('[App] Shutting down...');
    indexer.stop();
    webhookWorker.stop();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
