/**
 * Endpoint Contract Layer
 * 
 * Defines the public REST+WebSocket API that contestant services must implement.
 * This is the canonical specification for the benchmarking platform.
 * 
 * Every contestant's service must expose these endpoints on a well-known port (default: 8000)
 * and respond with the specified schemas.
 */

export const ENDPOINT_CONTRACT = {
  // HTTP REST Endpoints
  REST: {
    // Place a new order (Limit or Market)
    POST_ORDERS: {
      path: "/api/v1/orders",
      method: "POST",
      description: "Place a new limit or market order",
      requestBody: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "Unique order identifier (UUID or custom)" },
          clientId: { type: "string", description: "Client/contestant identifier" },
          side: { type: "string", enum: ["BUY", "SELL"], description: "Order side" },
          type: { type: "string", enum: ["LIMIT", "MARKET"], description: "Order type" },
          price: { type: "number", description: "Limit price (integer cents, e.g. 10050 = $100.50)" },
          quantity: { type: "number", description: "Order quantity" },
          timestamp: { type: "number", description: "Client-side timestamp (ns since epoch)" }
        },
        required: ["orderId", "clientId", "side", "type", "quantity", "timestamp"],
        additionalProperties: false
      },
      responseBody: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          status: { type: "string", enum: ["ACCEPTED", "REJECTED", "FILLED", "PARTIAL"], description: "Order status" },
          timestamp: { type: "number", description: "Server-side ack timestamp (ns since epoch)" },
          fills: {
            type: "array",
            items: {
              type: "object",
              properties: {
                fillId: { type: "string" },
                fillPrice: { type: "number" },
                fillQuantity: { type: "number" },
                fillTimestamp: { type: "number" },
                counterpartyOrderId: { type: "string" }
              },
              required: ["fillId", "fillPrice", "fillQuantity", "fillTimestamp"]
            },
            description: "Fills resulting from this order (may be empty for accepted orders)"
          },
          error: { type: "string", description: "Error message if status is REJECTED" }
        },
        required: ["orderId", "status", "timestamp"],
        additionalProperties: false
      },
      statusCodes: {
        "200": "Order accepted or filled",
        "400": "Bad request (invalid schema)",
        "503": "Service unavailable"
      }
    },

    // Cancel an existing order
    DELETE_ORDERS: {
      path: "/api/v1/orders/{orderId}",
      method: "DELETE",
      description: "Cancel an existing order",
      pathParameters: {
        orderId: { type: "string", description: "Order ID to cancel" }
      },
      queryParameters: {
        clientId: { type: "string", description: "Client identifier" }
      },
      responseBody: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          status: { type: "string", enum: ["CANCELLED", "NOT_FOUND", "ALREADY_FILLED"], description: "Cancel result" },
          timestamp: { type: "number", description: "Server ack timestamp (ns)" },
          cancelledQuantity: { type: "number", description: "Quantity successfully cancelled" }
        },
        required: ["orderId", "status", "timestamp"],
        additionalProperties: false
      },
      statusCodes: {
        "200": "Cancel accepted",
        "404": "Order not found",
        "503": "Service unavailable"
      }
    },

    // Get current orderbook snapshot
    GET_ORDERBOOK: {
      path: "/api/v1/orderbook",
      method: "GET",
      description: "Retrieve current limit order book (top N levels)",
      queryParameters: {
        levels: { type: "number", default: 10, description: "Depth of book (top N bid/ask levels)" }
      },
      responseBody: {
        type: "object",
        properties: {
          timestamp: { type: "number", description: "Snapshot timestamp (ns)" },
          bids: {
            type: "array",
            items: {
              type: "object",
              properties: {
                price: { type: "number" },
                quantity: { type: "number" },
                orderCount: { type: "number", description: "Number of orders at this price level" }
              },
              required: ["price", "quantity"]
            },
            description: "Bid levels (best to worst, highest price first)"
          },
          asks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                price: { type: "number" },
                quantity: { type: "number" },
                orderCount: { type: "number" }
              },
              required: ["price", "quantity"]
            },
            description: "Ask levels (best to worst, lowest price first)"
          },
          mid: { type: "number", description: "Mid price (if book is two-sided)" }
        },
        required: ["timestamp", "bids", "asks"],
        additionalProperties: false
      },
      statusCodes: {
        "200": "Book snapshot",
        "503": "Service unavailable"
      }
    },

    // Health check
    GET_HEALTH: {
      path: "/health",
      method: "GET",
      description: "Service health check (required for orchestration)",
      responseBody: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "degraded"] },
          timestamp: { type: "number" },
          uptime: { type: "number", description: "Uptime in milliseconds" }
        },
        required: ["status", "timestamp"],
        additionalProperties: false
      },
      statusCodes: {
        "200": "Service healthy",
        "503": "Service unhealthy"
      }
    }
  },

  // WebSocket Endpoints
  WEBSOCKET: {
    // Real-time fill stream
    WS_STREAM: {
      path: "/ws/stream",
      protocol: "WebSocket",
      description: "Real-time stream of fills and order book updates",
      messageTypes: {
        FILL: {
          type: "object",
          properties: {
            type: { type: "string", const: "FILL" },
            fillId: { type: "string" },
            buyOrderId: { type: "string" },
            sellOrderId: { type: "string" },
            price: { type: "number" },
            quantity: { type: "number" },
            timestamp: { type: "number", description: "Execution timestamp (ns)" },
            buyClientId: { type: "string" },
            sellClientId: { type: "string" }
          },
          required: ["type", "fillId", "buyOrderId", "sellOrderId", "price", "quantity", "timestamp"],
          description: "Trade execution notification"
        },
        ORDER_REJECTED: {
          type: "object",
          properties: {
            type: { type: "string", const: "ORDER_REJECTED" },
            orderId: { type: "string" },
            reason: { type: "string", enum: ["INVALID_PRICE", "INVALID_QTY", "INSUFFICIENT_LIQUIDITY", "SYSTEM_ERROR"] },
            timestamp: { type: "number" }
          },
          required: ["type", "orderId", "reason", "timestamp"],
          description: "Order rejection notification"
        },
        ORDERBOOK_DELTA: {
          type: "object",
          properties: {
            type: { type: "string", const: "ORDERBOOK_DELTA" },
            timestamp: { type: "number" },
            bids: {
              type: "array",
              items: { type: "object", properties: { price: { type: "number" }, quantity: { type: "number" } } }
            },
            asks: {
              type: "array",
              items: { type: "object", properties: { price: { type: "number" }, quantity: { type: "number" } } }
            },
            description: "Changed price levels only"
          },
          required: ["type", "timestamp"],
          description: "Order book differential update"
        }
      }
    }
  },

  // Global requirements
  REQUIREMENTS: {
    timing: {
      "Request Timestamp": "Injected by platform proxy into X-Send-Timestamp header (ns since epoch)",
      "Response Ack Timestamp": "Contestant service MUST include in response body (ns since epoch)",
      "WebSocket Timestamps": "All WebSocket messages MUST include ns-precision timestamps",
      "Clock Sync": "Contestant service should run NTP-synchronized; platform will account for skew"
    },
    reliability: {
      "Order Idempotency": "PlaceOrder(orderId=X) called twice should return same fills",
      "Fill Ordering": "Fills on WebSocket stream must be chronologically ordered by execution time",
      "Price-Time Priority": "Fills must respect FIFO within same price level",
      "Error Resilience": "Service must gracefully handle burst load without 5xx errors"
    },
    performance: {
      "P99 Latency Target": "< 100ms for order placement",
      "Throughput Target": "> 10K orders/sec",
      "WebSocket Connection Limit": "Support 1000+ concurrent connections",
      "Memory Limits": "< 512MB under normal load (enforced by platform)"
    }
  }
};

// Type-safe TypeScript interfaces
export interface PlaceOrderRequest {
  orderId: string;
  clientId: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  price: number; // integer cents
  quantity: number;
  timestamp: number; // ns
}

export interface OrderFill {
  fillId: string;
  fillPrice: number;
  fillQuantity: number;
  fillTimestamp: number;
  counterpartyOrderId?: string;
}

export interface PlaceOrderResponse {
  orderId: string;
  status: "ACCEPTED" | "REJECTED" | "FILLED" | "PARTIAL";
  timestamp: number;
  fills?: OrderFill[];
  error?: string;
}

export interface CancelOrderResponse {
  orderId: string;
  status: "CANCELLED" | "NOT_FOUND" | "ALREADY_FILLED";
  timestamp: number;
  cancelledQuantity?: number;
}

export interface OrderbookLevel {
  price: number;
  quantity: number;
  orderCount?: number;
}

export interface OrderbookSnapshot {
  timestamp: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  mid?: number;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: number;
  uptime?: number;
}

// WebSocket message types
export interface FillMessage {
  type: "FILL";
  fillId: string;
  buyOrderId: string;
  sellOrderId: string;
  price: number;
  quantity: number;
  timestamp: number;
  buyClientId?: string;
  sellClientId?: string;
}

export interface OrderRejectedMessage {
  type: "ORDER_REJECTED";
  orderId: string;
  reason: "INVALID_PRICE" | "INVALID_QTY" | "INSUFFICIENT_LIQUIDITY" | "SYSTEM_ERROR";
  timestamp: number;
}

export interface OrderbookDeltaMessage {
  type: "ORDERBOOK_DELTA";
  timestamp: number;
  bids?: OrderbookLevel[];
  asks?: OrderbookLevel[];
}

export type WebSocketMessage = FillMessage | OrderRejectedMessage | OrderbookDeltaMessage;
