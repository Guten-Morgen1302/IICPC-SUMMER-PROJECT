/**
 * k6 Load Testing Script for Trading Engine Benchmarking
 * 
 * This script runs as a distributed bot fleet across multiple k6 workers.
 * Each bot simulates a trader sending orders to the contestant's service.
 * 
 * Usage: k6 run -e BASE_URL=http://contestant:8000 -e NUM_TRADERS=100 bot-fleet.js
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend, Gauge, Rate } from 'k6/metrics';

// Environment configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const NUM_TRADERS = parseInt(__ENV.NUM_TRADERS || '10');
const TEST_DURATION = __ENV.TEST_DURATION || '60s';
const RPS_TARGET = parseInt(__ENV.RPS_TARGET || '1000'); // Orders per second
const THINK_TIME_MS = parseInt(__ENV.THINK_TIME_MS || '10'); // Time between orders per trader

// Custom metrics
const orderCounter = new Counter('orders_sent');
const fillCounter = new Counter('fills_received');
const orderLatency = new Trend('order_latency_ms');
const orderErrorRate = new Rate('order_errors');
const activeConnections = new Gauge('active_ws_connections');
const orderQueue = new Gauge('pending_orders');

// Price generator - tight range around 1000 to force matches
function generatePrice() {
  return 990 + Math.floor(Math.random() * 20); // 990-1009
}

// Order side - alternate for better matching
function generateSide(orderId) {
  return orderId % 2 === 0 ? 'BUY' : 'SELL';
}

// Order type - 80% limit, 20% market
function generateOrderType() {
  return Math.random() < 0.8 ? 'LIMIT' : 'MARKET';
}

// Quantity generation - small quantities to allow partial fills
function generateQuantity() {
  return 1 + Math.floor(Math.random() * 100); // 1-100 shares
}

/**
 * Main trading bot function
 * Each "trader" sends orders at a controlled rate
 */
export default function () {
  // Distribute traders across VUs (virtual users)
  const traderId = `trader-${__VU}-${__ITER}`;
  const baseClientId = `${__ENV.SCENARIO_ID || 'test'}-${__VU}`;
  
  for (let i = 0; i < NUM_TRADERS; i++) {
    const clientId = `${baseClientId}-${i}`;
    
    // Place order
    const orderId = `${clientId}-${Date.now()}-${i}`;
    const side = generateSide(i);
    const price = generatePrice();
    const quantity = generateQuantity();
    const orderType = generateOrderType();
    
    // Measure order placement latency
    const sendTimestamp = Date.now();
    const response = http.post(
      `${BASE_URL}/api/v1/orders`,
      JSON.stringify({
        orderId,
        clientId,
        side,
        type: orderType,
        price,
        quantity,
        timestamp: sendTimestamp * 1_000_000 // Convert to nanoseconds
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Send-Timestamp': (sendTimestamp * 1_000_000).toString()
        },
        timeout: '5s'
      }
    );
    
    const receiveTimestamp = Date.now();
    const latency = receiveTimestamp - sendTimestamp;
    
    // Record metrics
    check(response, {
      'order placement status 200': (r) => r.status === 200,
      'order has response': (r) => r.body.length > 0
    });
    
    orderLatency.add(latency);
    orderCounter.add(1);
    
    if (response.status !== 200) {
      orderErrorRate.add(1);
    }
    
    // Parse response to track fills
    try {
      const data = JSON.parse(response.body);
      if (data.fills && data.fills.length > 0) {
        fillCounter.add(data.fills.length);
      }
    } catch (e) {
      // Response body might not be valid JSON
    }
    
    // Think time between orders - distribute across traders
    sleep(THINK_TIME_MS / 1000 / NUM_TRADERS);
  }
}

/**
 * Setup phase - establish WebSocket connections for fill stream
 */
export function setup() {
  const wsConnections = [];
  
  // Establish WebSocket connections in a pool
  const numConnections = Math.min(10, Math.ceil(NUM_TRADERS / 10));
  
  for (let i = 0; i < numConnections; i++) {
    const res = ws.connect(
      `${BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://')}/ws/stream`,
      {},
      (socket) => {
        activeConnections.add(1);
        
        socket.on('open', () => {
          console.log(`WebSocket ${i} connected`);
        });
        
        socket.on('message', (message) => {
          // Parse incoming message (FILL, ORDER_REJECTED, ORDERBOOK_DELTA)
          try {
            const data = JSON.parse(message);
            if (data.type === 'FILL') {
              fillCounter.add(1);
            }
          } catch (e) {
            // Non-JSON message
          }
        });
        
        socket.on('close', () => {
          activeConnections.add(-1);
          console.log(`WebSocket ${i} closed`);
        });
        
        socket.on('error', (e) => {
          console.log(`WebSocket error on connection ${i}: ${e}`);
        });
      }
    );
    
    wsConnections.push(res);
  }
  
  return { wsConnections };
}

/**
 * Teardown phase - close WebSocket connections
 */
export function teardown(data) {
  if (data && data.wsConnections) {
    for (const connection of data.wsConnections) {
      try {
        connection.close();
      } catch (e) {
        // Connection already closed
      }
    }
  }
}

/**
 * Handle summary - log final metrics
 */
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(data)
  };
}

// Lightweight text summary
function textSummary(data, options) {
  const lines = [
    '=== Load Test Summary ===',
    `Orders Sent: ${data.metrics.orders_sent?.value || 0}`,
    `Fills Received: ${data.metrics.fills_received?.value || 0}`,
    `Avg Latency: ${(data.metrics.order_latency_ms?.value || 0).toFixed(2)}ms`,
    `Error Rate: ${((data.metrics.order_errors?.value || 0) * 100).toFixed(2)}%`
  ];
  return lines.join('\n');
}

/**
 * Options configuration for k6
 */
export const options = {
  vus: parseInt(__ENV.VUS || '10'),
  duration: TEST_DURATION,
  
  // Thresholds for pass/fail criteria
  thresholds: {
    'order_latency_ms': ['p(95) < 100', 'p(99) < 200'],
    'order_errors': ['rate < 0.05'], // Less than 5% error rate
    'orders_sent': ['count > 0']
  },
  
  // Stages for ramping up load
  stages: [
    { duration: '10s', target: parseInt(__ENV.VUS || '10') },      // Warm up
    { duration: '40s', target: parseInt(__ENV.VUS || '10') * 2 },  // Ramp up
    { duration: '10s', target: parseInt(__ENV.VUS || '10') }       // Cool down
  ]
};
