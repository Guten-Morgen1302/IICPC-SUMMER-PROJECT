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

  // ── 2. Validate email ─────────────────────────────────────────────────
  if (!rawEmail || rawEmail.trim() === '') {
    return reply.status(400).send({ error: 'userEmail field is required' });
  }

  const email = normalizeEmail(rawEmail);

  if (!isValidEmail(email)) {
    return reply.status(400).send({ error: 'userEmail must be a valid email address' });
  }

  // ── 3. Validate file ──────────────────────────────────────────────────
  if (!fileStream || !originalFilename) {
    return reply.status(400).send({ error: 'A file upload is required' });
  }

  const buffered: Buffer = (fileStream as any)._buffered;
  if (!buffered || buffered.length === 0) {
    return reply.status(400).send({ error: 'Uploaded file is empty' });
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
  
  return run;
});

fastify.get('/orchestrator/pipelines', async () => {
  return Object.values(pipelines);
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
