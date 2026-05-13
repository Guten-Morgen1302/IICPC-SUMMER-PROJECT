import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '../../../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerRoutes } from './routes';
import { Worker, Queue } from 'bullmq';
import { QUEUES, SandboxJobPayload, BenchmarkJobPayload } from '@benchmark/shared-types';
import Redis from 'ioredis';
import { processRun } from './processor';

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});
const benchmarkQueue = new Queue<BenchmarkJobPayload>(QUEUES.BENCHMARK, { connection: redisConnection });

const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: true });

registerRoutes(fastify);

const worker = new Worker<SandboxJobPayload>(
  QUEUES.SANDBOX,
  async (job) => {
    fastify.log.info({ jobId: job.id, submissionId: job.data.submissionId }, `Processing sandbox job`);
    try {
      const result = await processRun(job.data);
      
      if (result.status === 'READY') {
        fastify.log.info({ jobId: job.id }, `Sandbox ready, enqueueing to benchmark queue`);
        
        const payload: BenchmarkJobPayload = {
          submissionId: job.data.submissionId,
          benchmarkRunId: job.data.benchmarkRunId,
          sandboxUrl: `http://${result.runtimeHost}:${result.runtimePort}`,
        };
        
        await benchmarkQueue.add('run-benchmark', payload);
      } else {
        throw new Error(`Sandbox failed: ${result.error}`);
      }
    } catch (err) {
      fastify.log.error({ jobId: job.id, error: err }, 'Worker job handler error');
      throw err;
    }
  },
  { connection: redisConnection, concurrency: 5 }
);

worker.on('completed', (job) => {
  fastify.log.info({ jobId: job.id }, 'Sandbox job completed successfully');
});

worker.on('failed', (job, err) => {
  fastify.log.error({ jobId: job?.id, error: err.message, stack: err.stack }, 'Sandbox job failed');
});

worker.on('error', (err) => {
  fastify.log.error({ error: err.message, stack: err.stack }, 'Worker error');
});

worker.on('ready', () => {
  fastify.log.info({ queueName: QUEUES.SANDBOX }, 'Sandbox worker ready');
});

worker.on('drained', () => {
  fastify.log.info('Sandbox queue drained - all jobs processed');
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info('Sandbox manager worker listening for jobs');
    fastify.log.info({ queueName: QUEUES.SANDBOX }, 'Worker subscribed to queue');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
