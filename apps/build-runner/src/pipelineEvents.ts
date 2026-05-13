/**
 * Pipeline event publisher for Redpanda.
 *
 * Emits structured events to the 'pipeline-events' topic so the UI
 * and other services can track submission progress: QUEUED → BUILDING → DEPLOYING → etc.
 */
import { Kafka } from 'kafkajs';
import { BuildLogger } from './buildLogger';

// Redpanda connection settings (same Kafka API)
const REDPANDA_BROKERS = (process.env.REDPANDA_BROKERS || 'redpanda:29092').split(',');
const PIPELINE_EVENTS_TOPIC = 'pipeline-events';

export interface PipelineEvent {
  submissionId: string;
  status: 'QUEUED' | 'BUILDING' | 'DEPLOYING' | 'BENCHMARKING' | 'SCORING' | 'COMPLETE' | 'DEPLOYED' | 'FAILED';
  timestamp: string;
  message?: string;
}

/** Get or create Redpanda producer instance */
let kafkaInstance: Kafka | null = null;

function getKafkaClient(): Kafka {
  if (!kafkaInstance) {
    kafkaInstance = new Kafka({
      clientId: 'build-runner',
      brokers: REDPANDA_BROKERS,
      connectionTimeout: 10_000,
      requestTimeout: 30_000
    });
  }
  return kafkaInstance;
}

/**
 * Emit a pipeline event to Redpanda.
 * Non-blocking: logs errors but does not throw.
 */
export async function emitPipelineEvent(
  event: PipelineEvent,
  logger: BuildLogger
): Promise<void> {
  try {
    const kafka = getKafkaClient();
    const producer = kafka.producer();

    await producer.connect();

    await producer.send({
      topic: PIPELINE_EVENTS_TOPIC,
      messages: [
        {
          key: event.submissionId,
          value: JSON.stringify({
            ...event,
            timestamp: event.timestamp || new Date().toISOString()
          })
        }
      ]
    });

    logger.info('redpanda', 'Emitted pipeline event', {
      submissionId: event.submissionId,
      status: event.status
    });

    await producer.disconnect();
  } catch (err) {
    // Non-fatal: log but don't throw
    logger.warn('redpanda', `Failed to emit pipeline event: ${String(err)}`);
  }
}

/**
 * Emit build logs to the build-logs topic for real-time streaming.
 * (Optional: defer this to later if time is limited)
 */
export async function emitBuildLogEvent(
  submissionId: string,
  log: string,
  logger: BuildLogger
): Promise<void> {
  try {
    const kafka = getKafkaClient();
    const producer = kafka.producer();

    await producer.connect();

    await producer.send({
      topic: 'build-logs',
      messages: [
        {
          key: submissionId,
          value: JSON.stringify({
            submissionId,
            log,
            timestamp: new Date().toISOString()
          })
        }
      ]
    });

    await producer.disconnect();
  } catch (err) {
    // Non-fatal
    logger.warn('redpanda', `Failed to emit build log: ${String(err)}`);
  }
}
