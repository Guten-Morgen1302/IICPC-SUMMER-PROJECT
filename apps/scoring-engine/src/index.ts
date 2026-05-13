import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '../../../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import axios from 'axios';
import Redis from 'ioredis';
import { prisma } from '@benchmark/db';
import { Worker, Queue } from 'bullmq';
import { QUEUES, ScoringJobPayload } from '@benchmark/shared-types';

const QUESTDB_URL = process.env.QUESTDB_URL || 'http://localhost:9003';
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});
const leaderboardQueue = new Queue<any>(QUEUES.LEADERBOARD, { connection: redisConnection });

const fastify = Fastify({ logger: true });
fastify.register(cors, { origin: true });

fastify.get('/health', async () => ({ status: 'ok' }));

/**
 * Scoring Weights (configurable via environment)
 */
const WEIGHTS = {
  latency: parseFloat(process.env.WEIGHT_LATENCY || '0.30'),
  throughput: parseFloat(process.env.WEIGHT_THROUGHPUT || '0.40'),
  correctness: parseFloat(process.env.WEIGHT_CORRECTNESS || '0.30')
};

/**
 * Scoring Targets and Thresholds
 */
const THRESHOLDS = {
  latencyFloor: parseInt(process.env.LATENCY_FLOOR_MS || '10'),     // Min latency (ms)
  latencyCeiling: parseInt(process.env.LATENCY_CEILING_MS || '100'), // Max latency (ms)
  throughputTarget: parseInt(process.env.THROUGHPUT_TARGET || '10000'), // Target TPS
  correctnessGate: parseFloat(process.env.CORRECTNESS_GATE || '0.5') // Gating threshold
};

/**
 * Normalize latency score (lower is better)
 * Score = max(0, 1 - (latency - floor) / (ceiling - floor))
 */
function normalizeLatencyScore(latencyMs: number): number {
  if (latencyMs <= THRESHOLDS.latencyFloor) return 1.0;
  if (latencyMs >= THRESHOLDS.latencyCeiling) return 0.0;
  
  const normalized = 1.0 - (latencyMs - THRESHOLDS.latencyFloor) / 
                     (THRESHOLDS.latencyCeiling - THRESHOLDS.latencyFloor);
  return Math.max(0, Math.min(1, normalized));
}

/**
 * Normalize throughput score (higher is better)
 * Score = min(1, throughput / target)
 */
function normalizeThroughputScore(tps: number): number {
  const normalized = tps / THRESHOLDS.throughputTarget;
  return Math.min(1.0, normalized);
}

/**
 * Compute composite score
 * If correctness < gate, score = 0 (gating rule)
 * Otherwise: score = w_l * l_score + w_t * t_score + w_c * c_score
 */
function computeCompositeScore(
  latencyScore: number,
  throughputScore: number,
  correctnessScore: number
): number {
  // Gating rule: if correctness below threshold, return 0
  if (correctnessScore < THRESHOLDS.correctnessGate) {
    return 0;
  }

  // Weighted combination
  const composite =
    (WEIGHTS.latency * latencyScore) +
    (WEIGHTS.throughput * throughputScore) +
    (WEIGHTS.correctness * correctnessScore);

  return Math.round(composite * 1000) / 1000; // Round to 3 decimals
}

/**
 * Main scoring endpoint
 */
fastify.post<{
  Body: {
    runId: string;
    submissionId: string;
    durationSeconds: number;
    correctnessRatio?: number;
  };
}>(
  '/score-run',
  async (request, reply) => {
    const { runId, submissionId, durationSeconds, correctnessRatio = 1.0 } = request.body;

    try {
      // 1. Query telemetry from QuestDB
      const query = `
        SELECT 
          count() as total_orders,
          count() FILTER (WHERE status = 'FILL') as filled_orders,
          percentile(latency_ns, 0.95) as p95_ns,
          percentile(latency_ns, 0.99) as p99_ns,
          max(latency_ns) as max_ns
        FROM trades
        WHERE run_id = '${runId}'
      `;

      const questRes = await axios.get(
        `${QUESTDB_URL}/exec?query=${encodeURIComponent(query)}`
      );

      if (!questRes.data.dataset || questRes.data.dataset.length === 0) {
        return reply.status(404).send({ error: 'No telemetry found for runId' });
      }

      const row = questRes.data.dataset[0];
      const totalOrders = Number(row[0]) || 0;
      const filledOrders = Number(row[1]) || 0;
      const p95Ns = Number(row[2]) || 0;
      const p99Ns = Number(row[3]) || 0;

      // Convert nanoseconds to milliseconds
      const p95Ms = p95Ns / 1_000_000;
      const p99Ms = p99Ns / 1_000_000;
      const throughput = totalOrders / Math.max(1, durationSeconds);

      // 2. Normalize scores
      const latencyScore = normalizeLatencyScore(p99Ms);
      const throughputScore = normalizeThroughputScore(throughput);
      const correctionScore = correctnessRatio; // Already normalized 0-1

      // 3. Compute composite score
      const totalScore = computeCompositeScore(latencyScore, throughputScore, correctionScore);

      // 4. Store in PostgreSQL and Redis
      const score = await prisma.score.upsert({
        where: { benchmarkRunId: runId },
        update: {
          totalScore,
          latencyScore,
          throughputScore,
          correctnessMultiplier: correctionScore,
          latency: p99Ms,
          throughput: Math.round(throughput),
          correctness: correctionScore,
          rawScore: totalScore
        },
        create: {
          benchmarkRunId: runId,
          totalScore,
          rawScore: totalScore,
          latencyScore,
          throughputScore,
          errorRateScore: 1.0 - (1 - filledOrders / Math.max(1, totalOrders)),
          correctnessMultiplier: correctionScore,
          latency: p99Ms,
          throughput: Math.round(throughput),
          correctness: correctionScore
        }
      });

      // 5. Add to Redis leaderboard (sorted set)
      await redis.zadd('leaderboard:overall', totalScore, `${submissionId}`);
      await redis.zadd('leaderboard:latency', p99Ms, `${submissionId}`);
      await redis.zadd('leaderboard:throughput', throughput, `${submissionId}`);

      // 6. Publish score update event
      await redis.publish('score-updates', JSON.stringify({
        submissionId,
        runId,
        totalScore,
        latencyScore,
        throughputScore,
        correctnessScore: correctionScore,
        timestamp: Date.now()
      }));

      return reply.send({
        runId,
        submissionId,
        totalScore,
        breakdown: {
          latency: {
            value: p99Ms,
            normalized: latencyScore
          },
          throughput: {
            value: throughput,
            normalized: throughputScore
          },
          correctness: {
            value: correctionScore,
            normalized: correctionScore
          }
        },
        weights: WEIGHTS,
        telemetry: {
          totalOrders,
          filledOrders,
          p95Ms,
          p99Ms
        }
      });
    } catch (error: any) {
      fastify.log.error(`Scoring error: ${error.message}`);
      return reply.status(500).send({ error: error.message });
    }
  }
);

/**
 * Get leaderboard rankings
 */
fastify.get<{ Querystring: { limit?: string; type?: string } }>(
  '/leaderboard',
  async (request, reply) => {
    try {
      const limit = parseInt((request.query as any).limit || '100', 10);
      const type = ((request.query as any).type || 'overall') as string;

      const rankings = await redis.zrevrange(
        `leaderboard:${type}`,
        0,
        limit - 1,
        'WITHSCORES'
      );

      const results = [];
      for (let i = 0; i < rankings.length; i += 2) {
        results.push({
          rank: results.length + 1,
          submissionId: rankings[i],
          score: parseFloat(rankings[i + 1])
        });
      }

      return reply.send({
        type,
        rankings: results,
        generatedAt: new Date().toISOString()
      });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  }
);

/**
 * Get detailed score breakdown
 */
fastify.get<{ Params: { submissionId: string } }>(
  '/details/:submissionId',
  async (request, reply) => {
    try {
      const { submissionId } = request.params as any;

      const score = await prisma.score.findFirst({
        where: {
          benchmarkRun: {
            submission: {
              id: submissionId
            }
          }
        }
      });

      if (!score) {
        return reply.status(404).send({ error: 'Score not found' });
      }

      return reply.send({
        submissionId,
        score: {
          total: score.totalScore,
          latency: score.latencyScore,
          throughput: score.throughputScore,
          correctness: score.correctnessMultiplier
        },
        metrics: {
          p99Latency: score.latency,
          throughput: score.throughput,
          correctness: score.correctness
        }
      });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// BullMQ Worker: Process SCORING queue jobs
// ═══════════════════════════════════════════════════════════════════

const worker = new Worker<ScoringJobPayload>(
  QUEUES.SCORING,
  async (job: any) => {
    fastify.log.info({ jobId: job.id, benchmarkRunId: job.data.benchmarkRunId }, `Processing scoring job`);
    try {
      // Query benchmark results for this run
      const benchmarkRun = await prisma.benchmarkRun.findUnique({
        where: { id: job.data.benchmarkRunId },
        include: { submission: true }
      });

      if (!benchmarkRun) {
        throw new Error(`BenchmarkRun ${job.data.benchmarkRunId} not found`);
      }

      // TODO: Implement scoring logic here
      // For now, mark as scored and enqueue to leaderboard
      
      await prisma.benchmarkRun.update({
        where: { id: job.data.benchmarkRunId },
        data: { status: 'SCORED' }
      });

      // Enqueue to leaderboard queue
      await leaderboardQueue.add('update-leaderboard', {
        submissionId: job.data.submissionId,
        benchmarkRunId: job.data.benchmarkRunId,
      });

      return { status: 'SCORED' };
    } catch (err) {
      fastify.log.error({ jobId: job.id, error: err }, 'Worker job handler error');
      throw err;
    }
  },
  { connection: redisConnection, concurrency: 1 }
);

worker.on('completed', (job: any) => {
  fastify.log.info({ jobId: job.id }, 'Scoring job completed successfully');
});

worker.on('failed', (job: any, err: any) => {
  fastify.log.error({ jobId: job?.id, error: err.message, stack: err.stack }, 'Scoring job failed');
});

worker.on('error', (err: any) => {
  fastify.log.error({ error: err.message, stack: err.stack }, 'Worker error');
});

worker.on('ready', () => {
  fastify.log.info({ queueName: QUEUES.SCORING }, 'Scoring worker ready');
});

worker.on('drained', () => {
  fastify.log.info('Scoring queue drained - all jobs processed');
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3007;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Scoring engine listening on ${port}`);
    fastify.log.info({ queueName: QUEUES.SCORING }, 'Worker subscribed to queue');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
