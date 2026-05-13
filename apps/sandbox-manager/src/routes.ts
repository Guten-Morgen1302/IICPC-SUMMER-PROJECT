/**
 * Sandbox-manager Fastify route definitions.
 *
 * POST /deploy                — deploy a built image as an isolated container
 * POST /teardown              — stop and remove a container
 * POST /runs/process-next     — claim + launch next eligible BenchmarkRun
 * GET  /runs/:id              — fetch run status and runtime metadata
 * POST /runs/:id/stop         — stop and clean up sandbox
 * GET  /runs/:id/logs         — return structured lifecycle log
 * GET  /health                — liveness check
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '@benchmark/db';
import fs from 'fs';
import { processNextRun, stopRun } from './processor';
import { deployContainer, teardownContainer } from './dockerManager';
import { SandboxLogger } from './sandboxLogger';
import { runtimeLogPath } from './workspace';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ── Health ─────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    service: 'sandbox-manager',
    status: 'ok',
    timestamp: new Date().toISOString()
  }));

  // ── Deploy container from built image ──────────────────────────────────
  app.post<{ Body: { submissionId: string; imageName: string } }>(
    '/deploy',
    async (request, reply) => {
      const { submissionId, imageName } = request.body;

      if (!submissionId || !imageName) {
        return reply.status(400).send({
          error: 'submissionId and imageName are required'
        });
      }

      const logger = new SandboxLogger(submissionId);
      logger.info('deploy-api', 'Received deployment request', { submissionId, imageName });

      const result = await deployContainer(submissionId, imageName, logger);

      if (!result.success) {
        return reply.status(500).send({
          error: result.error,
          submissionId
        });
      }

      return reply.status(201).send({
        success: true,
        submissionId,
        containerId: result.containerId,
        internalUrl: result.internalUrl,
        deployedAt: new Date().toISOString()
      });
    }
  );

  // ── Teardown container ─────────────────────────────────────────────────
  app.post<{ Body: { submissionId: string } }>(
    '/teardown',
    async (request, reply) => {
      const { submissionId } = request.body;

      if (!submissionId) {
        return reply.status(400).send({
          error: 'submissionId is required'
        });
      }

      const logger = new SandboxLogger(submissionId);
      logger.info('teardown-api', 'Received teardown request', { submissionId });

      const result = await teardownContainer(submissionId, logger);

      if (!result.success) {
        return reply.status(500).send({
          error: result.error,
          submissionId
        });
      }

      return reply.status(200).send({
        success: true,
        submissionId,
        teardownAt: new Date().toISOString()
      });
    }
  );

  // ── Process next run ───────────────────────────────────────────────────
  app.post('/runs/process-next', async (_req, reply) => {
    const result = await processNextRun();

    if (!result.claimed) {
      return reply.status(200).send({ claimed: false, message: 'No eligible queued runs' });
    }

    return reply.status(200).send(result);
  });

  // ── Get run by ID ──────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const run = await prisma.benchmarkRun.findUnique({
      where: { id: req.params.id },
      include: {
        submission: { select: { id: true, status: true, userId: true } }
      }
    });

    if (!run) {
      return reply.status(404).send({ error: `BenchmarkRun ${req.params.id} not found` });
    }

    return reply.status(200).send(run);
  });

  // ── Stop run ───────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/runs/:id/stop', async (req, reply) => {
    const result = await stopRun(req.params.id);

    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }

    return reply.status(200).send({ stopped: true, benchmarkRunId: req.params.id });
  });

  // ── Get run logs ───────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/runs/:id/logs', async (req, reply) => {
    const run = await prisma.benchmarkRun.findUnique({ where: { id: req.params.id } });

    if (!run) {
      return reply.status(404).send({ error: `BenchmarkRun ${req.params.id} not found` });
    }

    const logFile = runtimeLogPath(req.params.id);
    if (!fs.existsSync(logFile)) {
      return reply.status(404).send({ error: 'Log file not yet available for this run' });
    }

    const entries = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    return reply.status(200).send({ benchmarkRunId: req.params.id, entries });
  });
}
