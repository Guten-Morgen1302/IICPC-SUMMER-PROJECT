import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '../../../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerRoutes } from './routes';
import { Worker, Queue } from 'bullmq';
import { QUEUES, BenchmarkJobPayload, CorrectnessJobPayload } from '@benchmark/shared-types';
import Redis from 'ioredis';
import { processNextBenchmark } from './processor';

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});
const correctnessQueue = new Queue<CorrectnessJobPayload>(QUEUES.CORRECTNESS, { connection: redisConnection });

const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: true });

registerRoutes(fastify);

// ═══════════════════════════════════════════════════════════════════
// BullMQ Worker: Process BENCHMARK queue jobs
// ═══════════════════════════════════════════════════════════════════

const worker = new Worker<BenchmarkJobPayload>(
  QUEUES.BENCHMARK,
  async (job) => {
    fastify.log.info({ jobId: job.id, submissionId: job.data.submissionId }, `Processing benchmark job`);
    try {
      const result = await processNextBenchmark(undefined);
      
      if (result.claimed && result.status === 'SUCCESS') {
        fastify.log.info({ jobId: job.id }, `Benchmark complete, enqueueing to correctness queue`);
        
        const payload: CorrectnessJobPayload = {
          submissionId: job.data.submissionId,
          benchmarkRunId: job.data.benchmarkRunId,
        };
        
        await correctnessQueue.add('evaluate-correctness', payload);
      } else {
        throw new Error(`Benchmark processing failed: ${result.error || 'unknown error'}`);
      }
    } catch (err) {
      fastify.log.error({ jobId: job.id, error: err }, 'Worker job handler error');
      throw err;
    }
  },
  { connection: redisConnection, concurrency: 1 }
);

worker.on('completed', (job: any) => {
  fastify.log.info({ jobId: job.id }, 'Benchmark job completed successfully');
});

worker.on('failed', (job: any, err: any) => {
  fastify.log.error({ jobId: job?.id, error: err.message, stack: err.stack }, 'Benchmark job failed');
});

worker.on('error', (err: any) => {
  fastify.log.error({ error: err.message, stack: err.stack }, 'Worker error');
});

worker.on('ready', () => {
  fastify.log.info({ queueName: QUEUES.BENCHMARK }, 'Benchmark worker ready');
});

worker.on('drained', () => {
  fastify.log.info('Benchmark queue drained - all jobs processed');
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3004;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info('Load generator controller server listening for jobs');
    fastify.log.info({ queueName: QUEUES.BENCHMARK }, 'Worker subscribed to queue');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
