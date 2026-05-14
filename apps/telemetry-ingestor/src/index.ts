/**
 * Telemetry Ingestor - Redpanda Consumer → QuestDB Writer
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '../../../.env') });

import { Kafka } from 'kafkajs';
import axios from 'axios';
import cors from '@fastify/cors';
import Fastify from 'fastify';

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const QUESTDB_URL = process.env.QUESTDB_URL || 'http://localhost:9003';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000');
const BATCH_TIMEOUT_MS = parseInt(process.env.BATCH_TIMEOUT_MS || '5000');

const fastify = Fastify({ logger: true });
fastify.register(cors, { origin: true });

const kafka = new Kafka({
  clientId: 'telemetry-ingestor',
  brokers: KAFKA_BROKERS,
  connectionTimeout: 10000,
  requestTimeout: 30000
});

const consumer = kafka.consumer({ groupId: 'telemetry-ingestor-group' });

let eventsProcessed = 0;
let currentBatch: string[] = [];
let lastFlushTime = Date.now();

fastify.get('/health', async () => ({
  status: 'ok',
  eventsProcessed,
  batchSize: currentBatch.length
}));

function eventToILP(event: any): string | null {
  try {
    const { orderId, clientId, runId, submissionId, sendTimestampNs, ackTimestampNs, status } = event;

    if (!runId || !submissionId || !sendTimestampNs || !ackTimestampNs) {
      return null;
    }

    const latencyNs = ackTimestampNs - sendTimestampNs;
    const tags = [
      `run_id=${runId}`,
      `submission_id=${submissionId}`,
      `status=${status || 'UNKNOWN'}`
    ].join(',');

    const fields = [
      `latency_ns=${latencyNs}i`,
      `send_ts=${sendTimestampNs}i`,
      `ack_ts=${ackTimestampNs}i`
    ].join(',');

    return `trades,${tags} ${fields} ${ackTimestampNs}`;
  } catch (error) {
    return null;
  }
}

async function flushBatch(): Promise<void> {
  if (currentBatch.length === 0) return;

  try {
    const ilpData = currentBatch.join('\n');
    await axios.post(`${QUESTDB_URL}/write?fmt=ilp`, ilpData, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 10000
    });
    fastify.log.info(`Flushed ${currentBatch.length} events to QuestDB`);
    currentBatch = [];
    lastFlushTime = Date.now();
  } catch (error: any) {
    fastify.log.error(`Flush failed: ${error.message}`);
  }
}

fastify.post('/query', async (request: any) => {
  const { runId, metric } = request.body;
  try {
    const query = metric === 'latency_percentiles'
      ? `SELECT percentile(latency_ns, 0.95) as p95_ns FROM trades WHERE run_id = '${runId}'`
      : `SELECT count() FROM trades WHERE run_id = '${runId}'`;

    const response = await axios.get(`${QUESTDB_URL}/exec?query=${encodeURIComponent(query)}`);
    return { runId, metric, data: response.data.dataset || [] };
  } catch (error: any) {
    return { error: error.message };
  }
});

async function startConsumer() {
  try {
    await consumer.connect();
    await consumer.subscribe({ topic: 'telemetry.raw', fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        try {
          const event = JSON.parse(message.value.toString());
          const ilpLine = eventToILP(event);
          if (ilpLine) {
            currentBatch.push(ilpLine);
            eventsProcessed++;
            if (currentBatch.length >= BATCH_SIZE) {
              await flushBatch();
            }
          }
        } catch (err) {
          fastify.log.warn('Error processing message');
        }
      }
    });
  } catch (error: any) {
    fastify.log.error(`Consumer error: ${error.message}`);
    setTimeout(startConsumer, 5000);
  }
}

setInterval(async () => {
  if (currentBatch.length > 0 && Date.now() - lastFlushTime >= BATCH_TIMEOUT_MS) {
    await flushBatch();
  }
}, 1000);

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Telemetry ingestor listening on ${port}`);
    await startConsumer();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
