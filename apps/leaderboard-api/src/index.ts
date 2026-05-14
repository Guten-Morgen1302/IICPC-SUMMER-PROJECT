import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '../../../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import Redis from 'ioredis';
import { prisma } from '@benchmark/db';
import { Worker } from 'bullmq';
import { QUEUES, LeaderboardJobPayload } from '@benchmark/shared-types';

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});
const redis = redisConnection;
const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: true });

fastify.get('/health', async () => ({ status: 'ok' }));

/**
 * GET /overview
 * Returns aggregate metrics for the dashboard.
 */
fastify.get('/overview', async () => {
  const [totalSubmissions, totalUsers, benchmarkedRuns, evaluatedRuns] = await Promise.all([
    prisma.submission.count(),
    prisma.user.count(),
    prisma.benchmarkRun.count(),
    prisma.benchmarkRun.count({ where: { status: 'EVALUATED' } })
  ]);

  const [topScore, rankedEntries] = await Promise.all([
    redis.zrevrange('leaderboard:overall', 0, 0, 'WITHSCORES'),
    redis.zcard('leaderboard:overall')
  ]);
  
  return {
    totalSubmissions,
    totalUsers,
    benchmarkedRuns,
    evaluatedRuns,
    topScore: topScore[1] ? parseFloat(topScore[1]) : 0,
    buildsSucceeded: await prisma.buildJob.count({ where: { status: 'SUCCESS' } }),
    buildsFailed: await prisma.buildJob.count({ where: { status: 'FAILED' } }),
    rankedEntries
  };
});

/**
 * GET /leaderboard/top
 * Returns the top-ranked submissions from Redis and joins with Postgres metadata.
 */
fastify.get('/leaderboard/top', async (request) => {
  const limit = parseInt((request.query as any).limit || '10', 10);
  
  // Get top N from Redis ZSET (descending order)
  const topData = await redis.zrevrange('leaderboard:overall', 0, limit - 1, 'WITHSCORES');
  
  const results = [];
  for (let i = 0; i < topData.length; i += 2) {
    const submissionId = topData[i];
    const score = parseFloat(topData[i + 1]);
    
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      include: { 
        user: true, 
        benchmarkRuns: { 
          where: { status: 'EVALUATED' }, 
          orderBy: { createdAt: 'desc' }, 
          take: 1 
        } 
      }
    });
    
    if (submission) {
      const latestRun = submission.benchmarkRuns[0];
      results.push({
        rank: (i / 2) + 1,
        submissionId,
        engineName: submission.originalFilename || 'Anonymous',
        developer: submission.user.email.split('@')[0],
        score,
        p99Ms: latestRun?.p99LatencyMs ?? 0,
        throughput: latestRun?.throughputRps ?? 0,
        lastEvaluated: latestRun?.evaluatedAt
      });
    }
  }
  
  return results;
});

/**
 * GET /runs/:runId/score
 * Returns the detailed score breakdown for a specific run.
 */
fastify.get<{ Params: { runId: string } }>('/runs/:runId/score', async (request, reply) => {
  const { runId } = request.params;
  
  const score = await prisma.score.findUnique({
    where: { benchmarkRunId: runId },
    include: { benchmarkRun: true }
  });
  
  if (!score) {
    return reply.status(404).send({ error: 'Score not found for this run' });
  }
  
  return {
    scoreValue: score.totalScore,
    metrics: {
      p95Ms: score.latency,
      p99Ms: score.benchmarkRun.p99LatencyMs,
      throughput: score.throughput,
      correctness: score.correctness
    },
    run: score.benchmarkRun
  };
});

// ═══════════════════════════════════════════════════════════════════
// BullMQ Worker: Process LEADERBOARD queue jobs
// ═══════════════════════════════════════════════════════════════════

const worker = new Worker<LeaderboardJobPayload>(
  QUEUES.LEADERBOARD,
  async (job: any) => {
    fastify.log.info({ jobId: job.id, benchmarkRunId: job.data.benchmarkRunId }, `Processing leaderboard update job`);
    try {
      // Query benchmark results for this run
      const benchmarkRun = await prisma.benchmarkRun.findUnique({
        where: { id: job.data.benchmarkRunId },
        include: { submission: true }
      });

      if (!benchmarkRun) {
        throw new Error(`BenchmarkRun ${job.data.benchmarkRunId} not found`);
      }

      const score = await prisma.score.findUnique({
        where: { benchmarkRunId: job.data.benchmarkRunId }
      });

      if (!score) {
        throw new Error(`Score for BenchmarkRun ${job.data.benchmarkRunId} not found`);
      }

      await redis.zadd('leaderboard:overall', score.totalScore, job.data.submissionId);
      await redis.zadd('leaderboard:latency', score.latency, job.data.submissionId);
      await redis.zadd('leaderboard:throughput', score.throughput, job.data.submissionId);

      await prisma.benchmarkRun.update({
        where: { id: job.data.benchmarkRunId },
        data: {
          status: 'EVALUATED',
          scoreValue: score.totalScore,
          rankingEligible: score.correctnessMultiplier > 0,
          evaluatedAt: new Date()
        }
      });

      await prisma.submission.update({
        where: { id: job.data.submissionId },
        data: { status: 'COMPLETED' }
      });

      return { status: 'UPDATED', score: score.totalScore };
    } catch (err) {
      fastify.log.error({ jobId: job.id, error: err }, 'Worker job handler error');
      throw err;
    }
  },
  { connection: redisConnection, concurrency: 1 }
);

worker.on('completed', (job: any) => {
  fastify.log.info({ jobId: job.id }, 'Leaderboard job completed successfully');
});

worker.on('failed', (job: any, err: any) => {
  fastify.log.error({ jobId: job?.id, error: err.message, stack: err.stack }, 'Leaderboard job failed');
});

worker.on('error', (err: any) => {
  fastify.log.error({ error: err.message, stack: err.stack }, 'Worker error');
});

worker.on('ready', () => {
  fastify.log.info({ queueName: QUEUES.LEADERBOARD }, 'Leaderboard worker ready');
});

worker.on('drained', () => {
  fastify.log.info('Leaderboard queue drained - all jobs processed');
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3008;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info('Leaderboard API listening');
    fastify.log.info({ queueName: QUEUES.LEADERBOARD }, 'Worker subscribed to queue');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
