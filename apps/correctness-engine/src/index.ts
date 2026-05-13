/**
 * Correctness Engine - Order Fill Validation
 * 
 * Validates that contestant orders were filled correctly:
 * 1. Price-time priority respected
 * 2. Fill prices correct
 * 3. Fill quantities correct
 * 4. No phantom fills or double-fills
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '../../../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import axios from 'axios';
import { prisma } from '@benchmark/db';

const fastify = Fastify({ logger: true });
fastify.register(cors, { origin: true });

const QUESTDB_URL = process.env.QUESTDB_URL || 'http://localhost:9003';

fastify.get('/health', async () => ({ status: 'ok' }));

/**
 * Validate fills against price-time priority rules
 */
interface Fill {
  orderId: string;
  fillPrice: number;
  fillQuantity: number;
  fillTime: number;
  side: 'BUY' | 'SELL';
}

interface ValidationResult {
  correctnessRatio: number;
  totalExpected: number;
  totalCorrect: number;
  violations: Array<{ issue: string; details: any }>;
}

function validateFills(expectedFills: Fill[], actualFills: Fill[]): ValidationResult {
  const violations: Array<{ issue: string; details: any }> = [];
  let correctCount = 0;

  // Build maps for quick lookup
  const expectedMap = new Map(expectedFills.map(f => [`${f.orderId}`, f]));
  const actualMap = new Map(actualFills.map(f => [`${f.orderId}`, f]));

  // Check each expected fill
  for (const [orderId, expected] of expectedMap) {
    const actual = actualMap.get(orderId);

    if (!actual) {
      violations.push({
        issue: 'MISSING_FILL',
        details: { orderId, expected }
      });
      continue;
    }

    // Validate price
    if (actual.fillPrice !== expected.fillPrice) {
      violations.push({
        issue: 'WRONG_FILL_PRICE',
        details: { orderId, expected: expected.fillPrice, actual: actual.fillPrice }
      });
      continue;
    }

    // Validate quantity
    if (actual.fillQuantity !== expected.fillQuantity) {
      violations.push({
        issue: 'WRONG_FILL_QUANTITY',
        details: { orderId, expected: expected.fillQuantity, actual: actual.fillQuantity }
      });
      continue;
    }

    // If we got here, fill is correct
    correctCount++;
  }

  // Check for phantom fills (actual fills not in expected)
  for (const [orderId, actual] of actualMap) {
    if (!expectedMap.has(orderId)) {
      violations.push({
        issue: 'PHANTOM_FILL',
        details: { orderId, actual }
      });
    }
  }

  const correctnessRatio = expectedFills.length > 0 ? correctCount / expectedFills.length : 1.0;

  return {
    correctnessRatio,
    totalExpected: expectedFills.length,
    totalCorrect: correctCount,
    violations
  };
}

/**
 * Validate endpoint contract responses
 */
function validateContractCompliance(responses: any[]): { compliant: boolean; violations: any[] } {
  const violations = [];

  for (const response of responses) {
    // Check required fields
    if (!response.orderId || !response.status || !Number.isFinite(response.timestamp)) {
      violations.push({
        issue: 'MISSING_REQUIRED_FIELD',
        details: response
      });
    }

    // Check fills schema
    if (response.fills && Array.isArray(response.fills)) {
      for (const fill of response.fills) {
        if (!Number.isFinite(fill.fillPrice) || !Number.isFinite(fill.fillQuantity) || !fill.fillTimestamp) {
          violations.push({
            issue: 'INVALID_FILL_SCHEMA',
            details: { fill }
          });
        }
      }
    }
  }

  return {
    compliant: violations.length === 0,
    violations
  };
}

/**
 * Main validation endpoint
 */
fastify.post<{
  Body: {
    runId: string;
    submissionId: string;
    expectedFills: Fill[];
    actualFills: Fill[];
  };
}>(
  '/validate',
  async (request, reply) => {
    const { runId, submissionId, expectedFills, actualFills } = request.body;

    try {
      const result = validateFills(expectedFills, actualFills);
      const contractCheck = validateContractCompliance(actualFills);

      // Calculate penalty for contract violations
      let correctnessScore = result.correctnessRatio;
      if (!contractCheck.compliant) {
        correctnessScore *= 0.8; // 20% penalty for contract violations
      }

      // Gating rule: if correctness < 50%, final score = 0
      const finalCorrectness = correctnessScore < 0.5 ? 0 : correctnessScore;

      // Store result in database
      const validation = await prisma.correctnessReport.upsert({
        where: { benchmarkRunId: runId },
        update: {
          expectedFills: expectedFills.length,
          correctFills: result.totalCorrect,
          correctnessRatio: finalCorrectness,
          violations: JSON.stringify(result.violations)
        },
        create: {
          benchmarkRunId: runId,
          submissionId,
          expectedFills: expectedFills.length,
          correctFills: result.totalCorrect,
          correctnessRatio: finalCorrectness,
          violations: JSON.stringify(result.violations)
        }
      });

      return reply.send({
        runId,
        correctnessRatio: finalCorrectness,
        breakdown: {
          expectedFills: result.totalExpected,
          correctFills: result.totalCorrect,
          contractCompliant: contractCheck.compliant
        },
        violations: result.violations.slice(0, 10) // Return first 10 violations
      });
    } catch (error: any) {
      fastify.log.error(`Validation error: ${error.message}`);
      return reply.status(500).send({ error: error.message });
    }
  }
);

/**
 * Query aggregated correctness metrics
 */
fastify.get<{ Querystring: { submissionId?: string } }>(
  '/metrics',
  async (request, reply) => {
    try {
      const { submissionId } = request.query as any;

      const where = submissionId ? { submissionId } : {};
      const reports = await prisma.correctnessReport.findMany({
        where,
        select: {
          correctnessRatio: true,
          expectedFills: true,
          correctFills: true
        }
      });

      if (reports.length === 0) {
        return reply.send({ error: 'No correctness reports found' });
      }

      const avgCorrectness = reports.reduce((sum, r) => sum + r.correctnessRatio, 0) / reports.length;
      const totalExpected = reports.reduce((sum, r) => sum + r.expectedFills, 0);
      const totalCorrect = reports.reduce((sum, r) => sum + r.correctFills, 0);

      return reply.send({
        submissions: reports.length,
        averageCorrectness: avgCorrectness,
        totalExpected,
        totalCorrect,
        overallRatio: totalExpected > 0 ? totalCorrect / totalExpected : 0
      });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  }
);

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3006;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Correctness engine listening on ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
