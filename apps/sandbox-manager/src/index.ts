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

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const benchmarkQueue = new Queue<BenchmarkJobPayload>(QUEUES.BENCHMARK, { connection: redisConnection });

const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: true });

registerRoutes(fastify);

const worker = new Worker<SandboxJobPayload>(
  QUEUES.SANDBOX,
  async (job) => {
    fastify.log.info(`Processing sandbox job ${job.id} for submission ${job.data.submissionId}`);
    const result = await processRun(job.data);
    
    if (result.status === 'READY') {
      fastify.log.info(`Sandbox ${job.id} ready, enqueueing to benchmark queue`);
      
      const payload: BenchmarkJobPayload = {
        submissionId: job.data.submissionId,
        benchmarkRunId: job.data.benchmarkRunId,
        sandboxUrl: `http://${result.runtimeHost}:${result.runtimePort}`,
      };
      
      await benchmarkQueue.add('run-benchmark', payload);
    } else {
      throw new Error(`Sandbox failed: ${result.error}`);
    }
  },
  { connection: redisConnection, concurrency: 5 }
);

worker.on('failed', (job, err) => {
  fastify.log.error(`Job ${job?.id} failed: ${err.message}`);
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info('Sandbox manager worker listening for jobs');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
