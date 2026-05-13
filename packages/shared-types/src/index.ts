import { z } from 'zod';

export const OrderSideSchema = z.enum(['BUY', 'SELL']);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum(['LIMIT', 'MARKET']);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const OrderRequestSchema = z.object({
  orderId: z.string(),
  userId: z.string(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  price: z.number(),
  quantity: z.number(),
  timestamp: z.number(), // Unix timestamp in nanoseconds
});

export type OrderRequest = z.infer<typeof OrderRequestSchema>;

export const ExecutionStatusSchema = z.enum([
  'ACK',
  'PARTIAL_FILL',
  'FILL',
  'REJECTED',
  'CANCELLED',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const ExecutionReportSchema = z.object({
  orderId: z.string(),
  status: ExecutionStatusSchema,
  filledQuantity: z.number(),
  remainingQuantity: z.number(),
  price: z.number(),
  timestamp: z.number(),
  reason: z.string().optional(),
});

export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;

export const PipelineStatusSchema = z.enum([
  'PENDING',
  'BUILDING',
  'SUCCESS',
  'FAILED',
  'RUNNING',
  'COMPLETED'
]);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

// Queue Names
export const QUEUES = {
  BUILD: 'build-queue',
  SANDBOX: 'sandbox-queue',
  BENCHMARK: 'benchmark-queue',
  CORRECTNESS: 'correctness-queue',
};

// Job Payloads
export const BuildJobPayloadSchema = z.object({
  submissionId: z.string(),
  buildJobId: z.string(),
  storedPath: z.string(),
});
export type BuildJobPayload = z.infer<typeof BuildJobPayloadSchema>;

export const SandboxJobPayloadSchema = z.object({
  submissionId: z.string(),
  benchmarkRunId: z.string(),
  imageId: z.string(),
});
export type SandboxJobPayload = z.infer<typeof SandboxJobPayloadSchema>;

export const BenchmarkJobPayloadSchema = z.object({
  submissionId: z.string(),
  benchmarkRunId: z.string(),
  sandboxUrl: z.string(),
});
export type BenchmarkJobPayload = z.infer<typeof BenchmarkJobPayloadSchema>;
