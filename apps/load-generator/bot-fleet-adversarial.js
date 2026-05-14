

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend, Gauge, Rate } from 'k6/metrics';

// ═══════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const SCENARIO = __ENV.SCENARIO || 'Smoke';
const REGIME = __ENV.REGIME || 'normal'; // calm | normal | stressed
const TEST_DURATION = __ENV.TEST_DURATION || '60s';
const THINK_TIME_MS = parseInt(__ENV.THINK_TIME_MS || '10');

// Custom metrics
const orderCounter = new Counter('orders_sent');
const fillCounter = new Counter('fills_received');
const orderLatency = new Trend('order_latency_ms');
const orderErrorRate = new Rate('order_errors');
const activeConnections = new Gauge('active_ws_connections');
const agentOrdersCounter = new Counter('agent_orders');
const toxicityGauge = new Gauge('market_toxicity');
const flashCrashCounter = new Counter('flash_crashes');

// ═══════════════════════════════════════════════════════════════════
// Agent Type Definitions & Strategies
// ═══════════════════════════════════════════════════════════════════

const AGENT_TYPES = {
  MARKET_MAKER: 'market_maker',
  MOMENTUM: 'momentum',
  MEAN_REVERSION: 'mean_reversion',
  NOISE_TRADER: 'noise_trader'
};

/**
 * Agent state for stateful strategies
 */
class AgentState {
  constructor(agentId, agentType) {
    this.agentId = agentId;
    this.agentType = agentType;
    this.lastFillPrices = [];    // Last 5 fill prices for momentum
    this.mmPositions = [];       // Market maker quote positions
    this.lastMidPrice = 1000;
    this.rollingAverage = 1000;
  }

  addFillPrice(price) {
    this.lastFillPrices.push(price);
    if (this.lastFillPrices.length > 5) this.lastFillPrices.shift();
    // Update rolling average
    if (this.lastFillPrices.length > 0) {
      this.rollingAverage = this.lastFillPrices.reduce((a, b) => a + b, 0) / this.lastFillPrices.length;
    }
  }

  getMomentum() {
    if (this.lastFillPrices.length < 2) return 0;
    const recent = this.lastFillPrices[this.lastFillPrices.length - 1];
    const previous = this.lastFillPrices[0];
    return recent - previous; // Cumulative move
  }
}

/**
 * Market Maker Strategy
 * Posts limit orders on both sides at configurable spread
 * Requotes on fill
 */
function marketMakerOrders(agentState, regime) {
  const orders = [];
  const spread = regime === 'calm' ? 1 : (regime === 'stressed' ? 3 : 2);
  
  const mid = 1000;
  const bidPrice = mid - spread;
  const askPrice = mid + spread;
  
  // Post both sides
  orders.push({
    side: 'BUY',
    type: 'LIMIT',
    price: bidPrice,
    quantity: 10 + Math.floor(Math.random() * 20),
    tif: 'GTC'
  });
  
  orders.push({
    side: 'SELL',
    type: 'LIMIT',
    price: askPrice,
    quantity: 10 + Math.floor(Math.random() * 20),
    tif: 'GTC'
  });
  
  return orders;
}

/**
 * Momentum Strategy
 * Watches last 5 fill prices. If up 3+ ticks, buys aggressively.
 * If down 3+ ticks, sells aggressively.
 */
function momentumOrders(agentState, regime) {
  const orders = [];
  const momentum = agentState.getMomentum();
  const threshold = regime === 'stressed' ? 2 : 3; // Lower threshold in stress
  
  if (momentum >= threshold) {
    // Buy signal - aggressive market order
    orders.push({
      side: 'BUY',
      type: 'MARKET',
      quantity: 50 + Math.floor(Math.random() * 50),
      tif: 'IOC'
    });
  } else if (momentum <= -threshold) {
    // Sell signal - aggressive market order
    orders.push({
      side: 'SELL',
      type: 'MARKET',
      quantity: 50 + Math.floor(Math.random() * 50),
      tif: 'IOC'
    });
  }
  
  return orders;
}

/**
 * Mean Reversion Strategy
 * Tracks rolling mid-price average. Bets on reversion when deviation > 5 ticks.
 */
function meanReversionOrders(agentState, regime) {
  const orders = [];
  const current = 1000;
  const average = agentState.rollingAverage;
  const deviation = Math.abs(current - average);
  const threshold = regime === 'calm' ? 4 : 5;
  
  if (deviation > threshold) {
    if (current > average) {
      // Price high, post limit buy (bet on reversion down)
      orders.push({
        side: 'BUY',
        type: 'LIMIT',
        price: current - 1,
        quantity: 30 + Math.floor(Math.random() * 20),
        tif: 'GTC'
      });
    } else {
      // Price low, post limit sell (bet on reversion up)
      orders.push({
        side: 'SELL',
        type: 'LIMIT',
        price: current + 1,
        quantity: 30 + Math.floor(Math.random() * 20),
        tif: 'GTC'
      });
    }
  }
  
  return orders;
}

/**
 * Noise Trader Strategy
 * Poisson process: random arrival of orders (LIMIT/MARKET/CANCEL)
 * Configurable lambda (orders per second)
 */
function noiseTraderOrders(agentState, regime) {
  const orders = [];
  const lambdas = {
    calm: 1.0,
    normal: 2.0,
    stressed: 4.0
  };
  
  const lambda = lambdas[regime] || 2.0;
  // Poisson: generate order arrival with probability lambda / 100
  if (Math.random() < lambda / 100) {
    const orderTypeRoll = Math.random();
    
    if (orderTypeRoll < 0.05) {
      // 5% CANCEL
      orders.push({
        action: 'CANCEL',
        orderId: 'order-' + Math.floor(Math.random() * 1000)
      });
    } else if (orderTypeRoll < 0.25) {
      // 20% MARKET
      orders.push({
        side: Math.random() < 0.5 ? 'BUY' : 'SELL',
        type: 'MARKET',
        quantity: 1 + Math.floor(Math.random() * 50),
        tif: 'FOK'
      });
    } else {
      // 75% LIMIT
      const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
      const basePrice = 1000;
      const priceOffsetRange = 5;
      const price = basePrice + (side === 'BUY' ? -1 : 1) * Math.floor(Math.random() * priceOffsetRange);
      
      orders.push({
        side,
        type: 'LIMIT',
        price,
        quantity: 1 + Math.floor(Math.random() * 100),
        tif: 'GTC'
      });
    }
  }
  
  return orders;
}

/**
 * Market Regime Configuration
 */
const REGIMES = {
  calm: {
    agentMix: {
      [AGENT_TYPES.MARKET_MAKER]: 0.5,
      [AGENT_TYPES.NOISE_TRADER]: 0.4,
      [AGENT_TYPES.MEAN_REVERSION]: 0.1,
      [AGENT_TYPES.MOMENTUM]: 0.0
    },
    VUsPerAgent: 2,
    thinkTimeMs: 20
  },
  normal: {
    agentMix: {
      [AGENT_TYPES.MARKET_MAKER]: 0.35,
      [AGENT_TYPES.MOMENTUM]: 0.2,
      [AGENT_TYPES.MEAN_REVERSION]: 0.2,
      [AGENT_TYPES.NOISE_TRADER]: 0.25
    },
    VUsPerAgent: 2,
    thinkTimeMs: 15
  },
  stressed: {
    agentMix: {
      [AGENT_TYPES.MOMENTUM]: 0.45,
      [AGENT_TYPES.NOISE_TRADER]: 0.35,
      [AGENT_TYPES.MEAN_REVERSION]: 0.1,
      [AGENT_TYPES.MARKET_MAKER]: 0.1
    },
    VUsPerAgent: 3,
    thinkTimeMs: 5,
    flashCrashEverySeconds: 15,
    flashCrashSize: 10
  }
};

/**
 * Generate orders based on agent type
 */
function generateOrdersByAgent(agentState, regime) {
  const strategy = {
    [AGENT_TYPES.MARKET_MAKER]: marketMakerOrders,
    [AGENT_TYPES.MOMENTUM]: momentumOrders,
    [AGENT_TYPES.MEAN_REVERSION]: meanReversionOrders,
    [AGENT_TYPES.NOISE_TRADER]: noiseTraderOrders
  }[agentState.agentType];
  
  return strategy ? strategy(agentState, regime) : [];
}

/**
 * Assign agent type based on regime mix
 */
function assignAgentType(vuIndex) {
  const regimeConfig = REGIMES[REGIME];
  const roll = Math.random();
  let cumulative = 0;
  
  for (const [agentType, weight] of Object.entries(regimeConfig.agentMix)) {
    cumulative += weight;
    if (roll < cumulative) return agentType;
  }
  
  return AGENT_TYPES.NOISE_TRADER;
}

// ═══════════════════════════════════════════════════════════════════
// Main Load Generation
// ═══════════════════════════════════════════════════════════════════

export default function () {
  const vuId = `vu-${__VU}`;
  const agentType = assignAgentType(__VU);
  const agentState = new AgentState(`agent-${__VU}`, agentType);
  
  const regimeConfig = REGIMES[REGIME];
  let flashCrashTimer = 0;
  
  // Main loop for this VU lifetime
  for (let iteration = 0; iteration < 100; iteration++) {
    // Flash crash trigger (stressed regime only)
    if (REGIME === 'stressed' && regimeConfig.flashCrashEverySeconds) {
      if (flashCrashTimer++ % Math.round(regimeConfig.flashCrashEverySeconds * 10) === 0) {
        // Send 10 large aggressive SELL orders within ~100ms
        for (let i = 0; i < 10; i++) {
          const sendTs = Date.now();
          const response = http.post(
            `${BASE_URL}/api/v1/orders`,
            JSON.stringify({
              orderId: `flash-crash-${__VU}-${iteration}-${i}`,
              side: 'SELL',
              type: 'MARKET',
              quantity: 100,
              timestamp: sendTs * 1_000_000,
              tif: 'IOC'
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                'X-Send-Timestamp': (sendTs * 1_000_000).toString()
              },
              timeout: '2s'
            }
          );
          
          if (response.status === 200) {
            flashCrashCounter.add(1);
          }
        }
      }
    }
    
    // Generate orders based on agent strategy
    const orders = generateOrdersByAgent(agentState, REGIME);
    
    for (const order of orders) {
      const sendTimestamp = Date.now();
      
      // Construct payload
      const payload = {
        orderId: `${vuId}-${agentType}-${iteration}-${Date.now()}`,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        timestamp: sendTimestamp * 1_000_000,
        tif: order.tif || 'GTC'
      };
      
      if (order.price !== undefined) {
        payload.price = order.price;
      }
      
      const response = http.post(
        `${BASE_URL}/api/v1/orders`,
        JSON.stringify(payload),
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Send-Timestamp': (sendTimestamp * 1_000_000).toString(),
            'X-Agent-Type': agentType,
            'X-Regime': REGIME
          },
          timeout: '5s'
        }
      );
      
      const receiveTimestamp = Date.now();
      const latency = receiveTimestamp - sendTimestamp;
      
      check(response, {
        'order status 200': (r) => r.status === 200,
        'has response body': (r) => r.body.length > 0
      });
      
      orderLatency.add(latency);
      orderCounter.add(1);
      agentOrdersCounter.add(1);
      
      if (response.status !== 200) {
        orderErrorRate.add(1);
      }
      
      // Track fills for agent state updates
      try {
        const data = JSON.parse(response.body);
        if (data.fills && data.fills.length > 0) {
          fillCounter.add(data.fills.length);
          for (const fill of data.fills) {
            agentState.addFillPrice(fill.fillPrice);
          }
        }
      } catch (e) {
        // Non-JSON response
      }
    }
    
    // Think time between iterations
    sleep(regimeConfig.thinkTimeMs / 1000);
  }
}

/**
 * Setup: Configure WebSocket connections for fill stream
 */
export function setup() {
  const regimeConfig = REGIMES[REGIME];
  const numConnections = Math.min(10, __ENV.VUSER || 5);
  
  for (let i = 0; i < numConnections; i++) {
    ws.connect(
      `${BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://')}/ws/stream`,
      {},
      (socket) => {
        activeConnections.add(1);
        
        socket.on('open', () => {
          console.log(`WebSocket ${i} connected for regime ${REGIME}`);
        });
        
        socket.on('message', (message) => {
          try {
            const data = JSON.parse(message);
            if (data.type === 'FILL') {
              fillCounter.add(1);
            }
          } catch (e) {
            // Non-JSON
          }
        });
        
        socket.on('close', () => {
          activeConnections.add(-1);
        });
      }
    );
  }
}

export const options = {
  scenarios: {
    [SCENARIO]: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '10s', target: 10 },
        { duration: TEST_DURATION, target: 20 },
        { duration: '10s', target: 0 }
      ],
      gracefulRampDown: '5s'
    }
  },
  thresholds: {
    order_latency_ms: ['p(95) < 100', 'p(99) < 200'],
    order_errors: ['rate < 0.05']
  }
};
