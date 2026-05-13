import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '../../../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerRoutes } from './routes';
import { Worker, Queue } from 'bullmq';
import { QUEUES, BuildJobPayload, SandboxJobPayload } from '@benchmark/shared-types';
import Redis from 'ioredis';
import { processJob } from './processor';

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const sandboxQueue = new Queue<SandboxJobPayload>(QUEUES.SANDBOX, { connection: redisConnection });

const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: true });

registerRoutes(fastify);

const worker = new Worker<BuildJobPayload>(
  QUEUES.BUILD,
  async (job) => {
    fastify.log.info(`Processing build job ${job.id}`);
    const result = await processJob(job.data);
    
    if (result.status === 'SUCCESS') {
      fastify.log.info(`Build job ${job.id} successful, enqueueing to sandbox queue`);
      
      const { prisma } = await import('@benchmark/db');
      const submission = await prisma.submission.findUnique({
        where: { id: job.data.submissionId },
        include: { benchmarkRuns: true }
      });
      
      const runId = submission?.benchmarkRuns[0]?.id;
      if (!runId) {
        throw new Error(`No benchmark run found for submission ${job.data.submissionId}`);
      }

      const payload: SandboxJobPayload = {
        submissionId: job.data.submissionId,
        benchmarkRunId: runId,
        imageId: `engine-${job.data.submissionId.toLowerCase()}`,
      };
      
      await sandboxQueue.add('start-sandbox', payload);
    } else {
      throw new Error(`Build failed: ${result.error}`);
    }
  },
  { connection: redisConnection, concurrency: 1 }
);

worker.on('failed', (job, err) => {
  fastify.log.error(`Job ${job?.id} failed: ${err.message}`);
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3002;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info('Build runner worker listening for jobs');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
