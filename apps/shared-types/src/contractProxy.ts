/**
 * Endpoint Contract Proxy Middleware
 * 
 * This proxy sits between the bot fleet and contestant services.
 * It enforces the endpoint contract by:
 * - Injecting send timestamps on all requests
 * - Validating response schemas
 * - Collecting latency metrics
 * - Detecting protocol violations
 */

import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import {
  PlaceOrderRequest,
  PlaceOrderResponse,
  CancelOrderResponse,
  OrderbookSnapshot,
  HealthResponse,
  WebSocketMessage
} from './contractSpec';

export interface LatencyMetric {
  orderId?: string;
  sendTimestampNs: number;
  receiveTimestampNs: number;
  latencyNs: number;
  status: string;
  endpoint: string;
}

export interface ContractViolation {
  endpoint: string;
  timestamp: number;
  issue: string;
  details: any;
}

/**
 * HTTP Client that enforces endpoint contract
 */
export class ContractEnforcingClient extends EventEmitter {
  private httpClient: AxiosInstance;
  private baseUrl: string;
  private metrics: LatencyMetric[] = [];
  private violations: ContractViolation[] = [];

  constructor(baseUrl: string, timeoutMs: number = 5000) {
    super();
    this.baseUrl = baseUrl;
    this.httpClient = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      validateStatus: () => true // Don't throw on any status code
    });
  }

  /**
   * Place order with timestamp injection and validation
   */
  async placeOrder(
    orderId: string,
    clientId: string,
    side: "BUY" | "SELL",
    type: "LIMIT" | "MARKET",
    price: number,
    quantity: number
  ): Promise<PlaceOrderResponse> {
    const sendTimestampNs = BigInt(Date.now()) * BigInt(1_000_000) + BigInt(process.hrtime.bigint() % BigInt(1_000_000));

    const payload: PlaceOrderRequest = {
      orderId,
      clientId,
      side,
      type,
      price,
      quantity,
      timestamp: Number(sendTimestampNs)
    };

    try {
      const response = await this.httpClient.post('/api/v1/orders', payload, {
        headers: {
          'X-Send-Timestamp': sendTimestampNs.toString(),
          'Content-Type': 'application/json'
        }
      });

      const receiveTimestampNs = BigInt(Date.now()) * BigInt(1_000_000);
      const latencyNs = Number(receiveTimestampNs - sendTimestampNs);

      const data = response.data as PlaceOrderResponse;

      // Validate response schema
      if (!data.orderId || !data.status || !data.timestamp) {
        this.recordViolation('/api/v1/orders', `Missing required fields: ${JSON.stringify(data)}`);
      }

      // Validate timestamp is present
      if (!Number.isFinite(data.timestamp)) {
        this.recordViolation('/api/v1/orders', `Invalid response timestamp: ${data.timestamp}`);
      }

      // Validate fills if present
      if (data.fills) {
        for (const fill of data.fills) {
          if (!fill.fillPrice || !Number.isFinite(fill.fillQuantity) || !fill.fillTimestamp) {
            this.recordViolation('/api/v1/orders', `Invalid fill: ${JSON.stringify(fill)}`);
          }
        }
      }

      this.recordMetric({
        orderId,
        sendTimestampNs: Number(sendTimestampNs),
        receiveTimestampNs: Number(receiveTimestampNs),
        latencyNs,
        status: data.status,
        endpoint: '/api/v1/orders'
      });

      return data;
    } catch (error: any) {
      this.recordViolation('/api/v1/orders', `Request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cancel order with timestamp validation
   */
  async cancelOrder(orderId: string, clientId: string): Promise<CancelOrderResponse> {
    const sendTimestampNs = BigInt(Date.now()) * BigInt(1_000_000);

    try {
      const response = await this.httpClient.delete(`/api/v1/orders/${orderId}`, {
        params: { clientId },
        headers: {
          'X-Send-Timestamp': sendTimestampNs.toString()
        }
      });

      const receiveTimestampNs = BigInt(Date.now()) * BigInt(1_000_000);
      const latencyNs = Number(receiveTimestampNs - sendTimestampNs);

      const data = response.data as CancelOrderResponse;

      // Validate response schema
      if (!data.orderId || !data.status || !data.timestamp) {
        this.recordViolation(`/api/v1/orders/${orderId}`, `Missing required fields`);
      }

      this.recordMetric({
        orderId,
        sendTimestampNs: Number(sendTimestampNs),
        receiveTimestampNs: Number(receiveTimestampNs),
        latencyNs,
        status: data.status,
        endpoint: '/api/v1/orders/{id}'
      });

      return data;
    } catch (error: any) {
      this.recordViolation(`/api/v1/orders/${orderId}`, `Cancel failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get orderbook snapshot with validation
   */
  async getOrderbook(levels: number = 10): Promise<OrderbookSnapshot> {
    const sendTimestampNs = BigInt(Date.now()) * BigInt(1_000_000);

    try {
      const response = await this.httpClient.get('/api/v1/orderbook', {
        params: { levels },
        headers: {
          'X-Send-Timestamp': sendTimestampNs.toString()
        }
      });

      const receiveTimestampNs = BigInt(Date.now()) * BigInt(1_000_000);
      const latencyNs = Number(receiveTimestampNs - sendTimestampNs);

      const data = response.data as OrderbookSnapshot;

      // Validate response schema
      if (!Number.isFinite(data.timestamp) || !Array.isArray(data.bids) || !Array.isArray(data.asks)) {
        this.recordViolation('/api/v1/orderbook', `Invalid orderbook schema`);
      }

      // Validate bid/ask ordering
      for (let i = 0; i < data.bids.length - 1; i++) {
        if (data.bids[i].price < data.bids[i + 1].price) {
          this.recordViolation('/api/v1/orderbook', `Bids not in descending order`);
        }
      }
      for (let i = 0; i < data.asks.length - 1; i++) {
        if (data.asks[i].price > data.asks[i + 1].price) {
          this.recordViolation('/api/v1/orderbook', `Asks not in ascending order`);
        }
      }

      this.recordMetric({
        sendTimestampNs: Number(sendTimestampNs),
        receiveTimestampNs: Number(receiveTimestampNs),
        latencyNs,
        status: 'SUCCESS',
        endpoint: '/api/v1/orderbook'
      });

      return data;
    } catch (error: any) {
      this.recordViolation('/api/v1/orderbook', `Request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Health check
   */
  async health(): Promise<HealthResponse> {
    try {
      const response = await this.httpClient.get('/health');
      const data = response.data as HealthResponse;

      if (!data.status) {
        this.recordViolation('/health', `Missing status field`);
      }

      return data;
    } catch (error: any) {
      this.recordViolation('/health', `Health check failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Record latency metric for later aggregation
   */
  private recordMetric(metric: LatencyMetric) {
    this.metrics.push(metric);
    this.emit('metric', metric);
  }

  /**
   * Record contract violation for audit
   */
  private recordViolation(endpoint: string, issue: string, details?: any) {
    const violation: ContractViolation = {
      endpoint,
      timestamp: Date.now(),
      issue,
      details
    };
    this.violations.push(violation);
    this.emit('violation', violation);
  }

  /**
   * Get aggregated latency statistics
   */
  getLatencyStats() {
    if (this.metrics.length === 0) {
      return null;
    }

    const latencies = this.metrics.map(m => m.latencyNs).sort((a, b) => a - b);
    const sum = latencies.reduce((a, b) => a + b, 0);

    return {
      count: latencies.length,
      minNs: latencies[0],
      maxNs: latencies[latencies.length - 1],
      avgNs: sum / latencies.length,
      p50Ns: latencies[Math.floor(latencies.length * 0.5)],
      p90Ns: latencies[Math.floor(latencies.length * 0.9)],
      p99Ns: latencies[Math.floor(latencies.length * 0.99)]
    };
  }

  /**
   * Get all recorded violations
   */
  getViolations(): ContractViolation[] {
    return this.violations;
  }

  /**
   * Clear metrics/violations
   */
  reset() {
    this.metrics = [];
    this.violations = [];
  }

  /**
   * Get all metrics
   */
  getMetrics(): LatencyMetric[] {
    return this.metrics;
  }
}

/**
 * WebSocket contract validator
 * Validates WebSocket messages match the contract
 */
export class WebSocketContractValidator extends EventEmitter {
  private violations: ContractViolation[] = [];

  validateMessage(message: WebSocketMessage): boolean {
    try {
      // Check message type
      if (!['FILL', 'ORDER_REJECTED', 'ORDERBOOK_DELTA'].includes(message.type)) {
        this.recordViolation('WS', `Unknown message type: ${(message as any).type}`);
        return false;
      }

      // Validate based on type
      switch (message.type) {
        case 'FILL':
          if (!message.fillId || !message.buyOrderId || !message.sellOrderId || !Number.isFinite(message.price) || !Number.isFinite(message.quantity) || !message.timestamp) {
            this.recordViolation('WS', `Invalid FILL message: missing required fields`);
            return false;
          }
          break;

        case 'ORDER_REJECTED':
          if (!message.orderId || !['INVALID_PRICE', 'INVALID_QTY', 'INSUFFICIENT_LIQUIDITY', 'SYSTEM_ERROR'].includes(message.reason) || !message.timestamp) {
            this.recordViolation('WS', `Invalid ORDER_REJECTED message`);
            return false;
          }
          break;

        case 'ORDERBOOK_DELTA':
          if (!Number.isFinite(message.timestamp)) {
            this.recordViolation('WS', `Invalid ORDERBOOK_DELTA timestamp`);
            return false;
          }
          break;
      }

      return true;
    } catch (error: any) {
      this.recordViolation('WS', `Validation error: ${error.message}`);
      return false;
    }
  }

  private recordViolation(endpoint: string, issue: string) {
    const violation: ContractViolation = {
      endpoint,
      timestamp: Date.now(),
      issue,
      details: null
    };
    this.violations.push(violation);
    this.emit('violation', violation);
  }

  getViolations(): ContractViolation[] {
    return this.violations;
  }

  reset() {
    this.violations = [];
  }
}
