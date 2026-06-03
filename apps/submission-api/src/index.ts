import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '../../../.env') });

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { prisma } from '@benchmark/db';
import Fastify from 'fastify';
import { storeSubmissionArtifact } from './storage';
import { Queue } from 'bullmq';
import { QUEUES, BuildJobPayload } from '@benchmark/shared-types';
import Redis from 'ioredis';
import { validateArchive } from './archive-validator';


// Helper to safely convert dates to ISO string
function toISOString(date: any): string | null {
  if (!date) return null;
  if (typeof date === 'string') return date;
  if (date instanceof Date) return date.toISOString();
  return null;
}

// Helper function to compute pipeline state from submission and runs
function computePipelineState(submission: any, benchmarkRuns: any[] = []) {
  try {
    const run = benchmarkRuns.length > 0 ? benchmarkRuns[0] : null;
    const buildStatus = submission.buildJobs?.[0]?.status;
    const runStatus = run?.status;

    const buildStepStatus =
      buildStatus === 'SUCCESS'
        ? 'DONE'
        : buildStatus === 'FAILED'
          ? 'FAILED'
          : buildStatus === 'IN_PROGRESS'
            ? 'IN_PROGRESS'
            : 'PENDING';

    const sandboxStepStatus =
      runStatus === 'FAILED'
        ? 'FAILED'
        : runStatus === 'READY' || runStatus === 'BENCHMARKING' || runStatus === 'EVALUATED' || runStatus === 'SUCCESS' || runStatus === 'STOPPED'
          ? 'DONE'
          : runStatus === 'IN_PROGRESS'
            ? 'IN_PROGRESS'
            : 'PENDING';

    const benchmarkStepStatus =
      runStatus === 'FAILED'
        ? 'FAILED'
        : runStatus === 'BENCHMARKING'
          ? 'IN_PROGRESS'
          : run?.benchmarkCompletedAt || runStatus === 'EVALUATED' || runStatus === 'SUCCESS' || runStatus === 'STOPPED'
            ? 'DONE'
            : 'PENDING';

    const submissionFailed = submission.status === 'FAILED' || runStatus === 'FAILED' || buildStatus === 'FAILED';
    const submissionCompleted = submission.status === 'COMPLETED' || runStatus === 'EVALUATED';
    
    const steps = [
      {
        name: 'SUBMISSION_RECEIVED',
        status: submission.status !== 'PENDING' ? 'DONE' : 'PENDING',
        message: 'Submission received',
        startedAt: toISOString(submission.createdAt),
        completedAt: toISOString(submission.createdAt),
        data: {}
      },
      {
        name: 'BUILDING_IMAGE',
        status: buildStepStatus,
        message: 'Building Docker image',
        startedAt: toISOString(submission.buildJobs?.[0]?.createdAt) || null,
        completedAt: toISOString(submission.buildJobs?.[0]?.completedAt) || null,
        data: { buildJobs: submission.buildJobs?.length || 0 }
      },
      {
        name: 'STARTING_SANDBOX',
        status: sandboxStepStatus,
        message: 'Starting sandbox container',
        startedAt: toISOString(run?.createdAt) || null,
        completedAt: null,
        data: { containerId: run?.containerId || null }
      },
      {
        name: 'RUNNING_BENCHMARK',
        status: benchmarkStepStatus,
        message: run?.benchmarkErrorMessage || 'Running benchmark load test',
        startedAt: toISOString(run?.createdAt) || null,
        completedAt: null,
        data: {}
      },
      {
        name: 'EVALUATING_CORRECTNESS',
        status: submissionCompleted ? 'DONE' : submissionFailed ? 'FAILED' : 'PENDING',
        message: 'Evaluating correctness',
        startedAt: null,
        completedAt: null,
        data: {}
      },
      {
        name: 'COMPUTING_SCORE',
        status: submissionCompleted ? 'DONE' : submissionFailed ? 'FAILED' : 'PENDING',
        message: 'Computing composite score',
        startedAt: null,
        completedAt: null,
        data: {}
      },
      {
        name: 'LEADERBOARD_UPDATED',
        status: submissionCompleted ? 'DONE' : submissionFailed ? 'FAILED' : 'PENDING',
        message: 'Leaderboard updated',
        startedAt: null,
        completedAt: null,
        data: {}
      },
      {
        name: 'COMPLETE',
        status: submissionCompleted ? 'DONE' : submissionFailed ? 'FAILED' : 'PENDING',
        message: submissionFailed ? 'Pipeline failed' : submissionCompleted ? 'Pipeline completed' : 'Waiting for completion',
        startedAt: null,
        completedAt: submissionCompleted || submissionFailed ? new Date().toISOString() : null,
        data: {}
      }
    ];

    const submissionStatus = submissionCompleted ? 'COMPLETED' : submissionFailed ? 'FAILED' : 'RUNNING';
    
    return {
      submissionId: submission.id,
      benchmarkRunId: run?.id || null,
      scenario: 'smoke',
      userEmail: submission.user?.email || submission.userEmail || 'unknown@cluster.io',
      status: submissionStatus,
      steps,
      createdAt: toISOString(submission.createdAt),
      explanation: null
    };
  } catch (err) {
    console.error('Error computing pipeline state:', err);
    throw err;
  }
}

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const buildQueue = new Queue<BuildJobPayload>(QUEUES.BUILD, { connection: redisConnection });

const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: true });
fastify.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB hard cap
    files: 1
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

// ── Routes ─────────────────────────────────────────────────────────────────

fastify.get('/health', async (_request, _reply) => {
  return {
    service: 'submission-api',
    status: 'ok',
    timestamp: new Date().toISOString()
  };
});

/**
 * POST /submit
 *
 * Accepts multipart/form-data with:
 * - userEmail (field) temporary identity token for hackathon phase
 * - file (file) the trading engine archive (.zip / .tar.gz)
 *
 * Flow:
 * 1. Parse + validate multipart upload
 * 2. Validate and normalize userEmail
 * 3. Persist artifact to storage abstraction
 * 4. Create / resolve User row
 * 5. Create Submission with artifact metadata
 * 6. Create linked BuildJob (QUEUED)
 * 7. Create linked BenchmarkRun (QUEUED)
 * 8. Return submissionId and job statuses
 *
 * NOTE(future): userEmail will be replaced by a real auth token in a later phase.
 */
const rateLimitMap = new Map<string, { count: number, resetAt: number }>();

fastify.post('/submit', async (request, reply) => {
  let rawEmail: string | undefined;
  let fileStream: ReturnType<typeof request.file> extends Promise<infer T> ? T : never;
  let originalFilename: string | undefined;
  let mimeType: string | undefined;

  // ── 1. Parse multipart ────────────────────────────────────────────────
  try {
    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'userEmail') {
        rawEmail = part.value as string;
      } else if (part.type === 'file') {
        originalFilename = part.filename;
        mimeType = part.mimetype;
        fileStream = part.file as any;

        // Guard: we need the email first; multipart field order matters.
        // Collect file into a temp buffer if email hasn't arrived yet —
        // but since the stream must be consumed here, we store it right away.
        // Validation of email happens after the loop.

        // We need submissionId before writing, so we defer file writing.
        // Drain and buffer the stream while we handle DB logic.
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        (part as any)._buffered = Buffer.concat(chunks);
        fileStream = part as any;
      }
    }
  } catch (err) {
    fastify.log.error(err, 'Failed to parse multipart body');
    return reply.status(400).send({ error: 'Invalid multipart request' });
  }

  // ── 2. Validate email & Rate Limit ─────────────────────────────────────────────────
  if (!rawEmail || rawEmail.trim() === '') {
    return reply.status(400).send({ error: 'userEmail field is required' });
  }

  const email = normalizeEmail(rawEmail);

  if (!isValidEmail(email)) {
    return reply.status(400).send({ error: 'userEmail must be a valid email address' });
  }

  const now = Date.now();
  let rateLimit = rateLimitMap.get(email);
  if (!rateLimit || now > rateLimit.resetAt) {
    rateLimit = { count: 0, resetAt: now + 5 * 60 * 1000 }; // 5 minutes window
  }
  rateLimit.count++;
  rateLimitMap.set(email, rateLimit);

  if (rateLimit.count > 3) {
    fastify.log.warn(`Rate limit exceeded for ${email}`);
    return reply.status(429).send({ error: 'Rate limit exceeded. Max 3 submissions per 5 minutes.' });
  }

  // ── 3. Validate file ──────────────────────────────────────────────────
  if (!fileStream || !originalFilename) {
    return reply.status(400).send({ error: 'A file upload is required' });
  }

  const buffered: Buffer = (fileStream as any)._buffered;
  if (!buffered || buffered.length === 0) {
    return reply.status(400).send({ error: 'Uploaded file is empty' });
  }

  // ── 3.1 Validate Archive Content ──────────────────────────────────────────
  const validation = validateArchive(buffered);
  if (!validation.isValid) {
    fastify.log.warn({ error: validation.error, filename: originalFilename }, 'Archive validation failed');
    return reply.status(400).send({ 
      error: `Archive validation failed: ${validation.error}` 
    });
  }

  // ── 4. Resolve User ───────────────────────────────────────────────────
  let user;
  try {
    user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        name: email.split('@')[0]
      }
    });
  } catch (err) {
    fastify.log.error(err, 'Failed to resolve user');
    return reply.status(500).send({ error: 'Failed to resolve user' });
  }

  // ── 5. Create Submission (no artifact fields yet) ─────────────────────
  let submission;
  try {
    submission = await prisma.submission.create({
      data: {
        userId: user.id,
        status: 'PENDING',
        buildJobs: { create: [{ status: 'QUEUED' }] },
        benchmarkRuns: { create: [{ status: 'QUEUED' }] }
      },
      include: { buildJobs: true, benchmarkRuns: true }
    });
  } catch (err) {
    fastify.log.error(err, 'Failed to create submission');
    return reply.status(500).send({ error: 'Failed to create submission' });
  }

  // ── 6. Persist artifact ───────────────────────────────────────────────
  // Done after submission creation so we have the submissionId for the path.
  let artifact;
  try {
    const { Readable } = await import('stream');
    const readable = Readable.from(buffered);
    artifact = await storeSubmissionArtifact(submission.id, originalFilename, readable);
  } catch (err) {
    // Roll back submission if storage fails
    await prisma.submission.delete({ where: { id: submission.id } }).catch(() => {});
    fastify.log.error(err, 'Failed to store artifact');
    return reply.status(500).send({ error: 'Failed to store uploaded file' });
  }

  // ── 7. Patch Submission with artifact metadata ─────────────────────────
  try {
    await prisma.submission.update({
      where: { id: submission.id },
      data: {
        originalFilename,
        storedFilename: artifact.storedFilename,
        storedPath: artifact.storedPath,
        mimeType: mimeType ?? null,
        sizeBytes: artifact.sizeBytes,
        uploadedAt: new Date()
      }
    });
  } catch (err) {
    fastify.log.error(err, 'Failed to update submission artifact metadata');
    // Non-fatal: submission record exists and file is saved; metadata patch can be retried.
  }

  // ── 8. Enqueue Build Job ──────────────────────────────────────────────
  try {
    if (artifact && artifact.storedPath) {
      const payload: BuildJobPayload = {
        submissionId: submission.id,
        buildJobId: submission.buildJobs[0].id,
        storedPath: artifact.storedPath,
      };
      await buildQueue.add('build-image', payload);
    }
  } catch (err) {
    fastify.log.error(err, 'Failed to enqueue build job');
  }

  // ── 9. Respond ────────────────────────────────────────────────────────
  return reply.status(201).send({
    submissionId: submission.id,
    userId: user.id,
    buildJob: {
      id: submission.buildJobs[0].id,
      status: submission.buildJobs[0].status
    },
    benchmarkRun: {
      id: submission.benchmarkRuns[0].id,
      status: submission.benchmarkRuns[0].status
    }
  });
});

/**
 * GET /submissions
 * Returns a list of all submissions.
 */
fastify.get('/submissions', async () => {
  const subs = await prisma.submission.findMany({
    include: {
      user: true,
      buildJobs: true,
      benchmarkRuns: {
        where: { status: 'EVALUATED' },
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    },
    orderBy: { createdAt: 'desc' }
  });
  
  return subs.map(s => ({
    id: s.id,
    userId: s.userId,
    userEmail: s.user?.email || 'unknown@cluster.io',
    userName: s.user?.name || null,
    status: s.status,
    pipelineStatus: s.status,
    originalFilename: s.originalFilename,
    createdAt: s.createdAt.toISOString(),
    latestScore: s.benchmarkRuns[0]?.scoreValue || null,
    buildCount: s.buildJobs.length,
    runCount: s.benchmarkRuns.length,
    sizeBytes: s.sizeBytes?.toString()
  }));
});

/**
 * GET /submissions/:id
 */
fastify.get<{ Params: { id: string } }>('/submissions/:id', async (request, reply) => {
  const { id } = request.params;
  const submission = await prisma.submission.findUnique({
    where: { id },
    include: {
      user: true,
      buildJobs: true,
      benchmarkRuns: true
    }
  });

  if (!submission) return reply.status(404).send({ error: 'Submission not found' });
  
  return {
    ...submission,
    userEmail: submission.user?.email || 'unknown@cluster.io',
    userName: submission.user?.name || null,
    pipelineStatus: submission.status,
    sizeBytes: submission.sizeBytes?.toString()
  };
});

/**
 * GET /runs
 */
fastify.get('/runs', async (request) => {
  const status = (request.query as any).status;
  const runs = await prisma.benchmarkRun.findMany({
    where: status ? { status } : {},
    include: { submission: { include: { user: true } } },
    orderBy: { createdAt: 'desc' }
  });
  
  return runs.map(r => ({
    ...r,
    submission: {
      ...r.submission,
      sizeBytes: r.submission.sizeBytes?.toString()
    }
  }));
});

/**
 * GET /runs/:id
 */
fastify.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
  const { id } = request.params;
  const run = await prisma.benchmarkRun.findUnique({
    where: { id },
    include: { 
      submission: { include: { user: true } },
      score: true
    }
  });

  if (!run) return reply.status(404).send({ error: 'Run not found' });
  
  return {
    ...run,
    submission: {
      ...run.submission,
      sizeBytes: run.submission.sizeBytes?.toString()
    }
  };
});

/**
 * POST /orchestrator/run
 * Trigger the pipeline for a submission (pipeline orchestration is already triggered via BullMQ in /submit)
 */
fastify.post<{ Body: { submissionId: string; benchmarkRunId?: string; buildJobId?: string; userEmail?: string; scenario?: string } }>(
  '/orchestrator/run',
  async (request, reply) => {
    const { submissionId } = request.body;

    try {
      const submission = await prisma.submission.findUnique({
        where: { id: submissionId },
        include: { 
          buildJobs: { orderBy: { createdAt: 'desc' } },
          benchmarkRuns: { orderBy: { createdAt: 'desc' } },
          user: { select: { email: true } }
        }
      });

      if (!submission) {
        return reply.status(404).send({ error: 'Submission not found' });
      }

      // Return pipeline state
      return reply.status(200).send(computePipelineState(submission, submission.benchmarkRuns));
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: String(err) });
    }
  }
);

/**
 * GET /orchestrator/status/:submissionId
 * Get current pipeline status for a submission
 */
fastify.get<{ Params: { submissionId: string } }>(
  '/orchestrator/status/:submissionId',
  async (request, reply) => {
    const { submissionId } = request.params;

    try {
      const submission = await prisma.submission.findUnique({
        where: { id: submissionId },
        include: { 
          buildJobs: { orderBy: { createdAt: 'desc' } },
          benchmarkRuns: { orderBy: { createdAt: 'desc' } },
          user: { select: { email: true } }
        }
      });

      if (!submission) {
        return reply.status(404).send({ error: 'Submission not found' });
      }

      return reply.status(200).send(computePipelineState(submission, submission.benchmarkRuns));
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: String(err) });
    }
  }
);

/**
 * GET /orchestrator/pipelines
 * Get all pipeline statuses
 */
fastify.get('/orchestrator/pipelines', async (request, reply) => {
  try {
    const submissions = await prisma.submission.findMany({
      include: { 
        buildJobs: { orderBy: { createdAt: 'desc' } },
        benchmarkRuns: { orderBy: { createdAt: 'desc' } },
        user: { select: { email: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    return reply.status(200).send(
      submissions.map(s => computePipelineState(s, s.benchmarkRuns))
    );
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ error: String(err) });
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
    await fastify.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
