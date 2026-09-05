# Nexus-Gate Architecture & Production Specification

Nexus-Gate is an event-driven reverse proxy, API gateway, and distributed telemetry engine engineered in TypeScript and Node.js. It coordinates high-throughput microservice routing, client-side traffic shaping, robust security verification, and real-time observability.

---

## 1. Rate Limiting & Traffic Regulation

Nexus-Gate enforces a distributed Token Bucket algorithm backed by Redis to regulate incoming client traffic across horizontal gateway instances.

- **Token Bucket Parameters:** Every registered API key or client IP is allocated an isolated bucket with a continuous refill rate of 100 tokens per minute and a burst capacity of 200 tokens.
- **Storage Strategy:** Token counts and timestamp states are tracked via atomic Redis keys utilizing TTL expiration to prevent memory leaks for dormant clients.
- **Throttling Behavior:** When an incoming client request exceeds available tokens, the gateway rejects the request with an HTTP 429 Too Many Requests status code.
- **Retry Semantics:** The response payload includes a `Retry-After` header indicating the exact number of seconds until sufficient tokens are replenished.
- **Burst Mitigation:** The token bucket bounds instantaneous request spikes to the burst capacity, protecting downstream microservices from request saturation.

---

## 2. Reverse Proxy & Upstream Routing Engine

The core forwarding engine is implemented using native Node.js HTTP streams and TCP connection pooling to minimize memory allocations and proxy latency.

- **Connection Management:** Reuses established TCP sockets using an active connection pool, avoiding three-way handshake overhead on high-frequency routes.
- **Streaming Support:** Supports end-to-end chunked HTTP streaming for large payloads, file uploads, and Server-Sent Events (SSE).
- **Timeout Configuration:** The reverse proxy enforces strict upstream request timeouts. If a backend replica fails to respond within the configured deadline, the proxy drops the socket and increments upstream failure counters.
- **Load Balancing:** Upstream routing uses a Least-Connections load balancing strategy with round-robin tie-breaking to distribute traffic evenly across replicas.
- **Target Configuration:** Upstream replica pools and routing tables are configured using the `UPSTREAM_TARGETS` environment variable.
- **Proactive Health Checks:** Background probes periodically test backend endpoints. Any replica failing two consecutive health checks is temporarily evicted from the routing table until recovery is confirmed.

---

## 3. Circuit Breaker Lifecycle & Fault Tolerance

To isolate failing downstream dependencies and prevent cascading outages, Nexus-Gate implements a finite 3-state Circuit Breaker pattern:

- **States:** The breaker transitions between CLOSED, OPEN, and HALF-OPEN.
  - **CLOSED:** Normal operating condition. Traffic routes transparently to upstream services.
  - **OPEN:** The breaker trips when downstream failure rates exceed 50% over a 10-second rolling window. All traffic to the target is blocked at the gateway, returning HTTP 502 Bad Gateway or 504 Gateway Timeout without consuming upstream sockets.
  - **HALF-OPEN:** After entering OPEN, a 30-second cooldown timeout elapses. The breaker switches to HALF-OPEN to test downstream recovery.
- **Canary Probing:** In the HALF-OPEN state, exactly 5 canary probe requests are permitted through to the backend service.
- **Recovery & Trip Rules:**
  - If all 5 canary probe requests succeed, the breaker transitions back to CLOSED and resets error metrics.
  - If any single canary request fails, the breaker immediately trips back to OPEN and restarts the 30-second cooldown timeout.

---

## 4. Authentication & Role-Based Access Control (RBAC)

Nexus-Gate secures sensitive endpoints through cryptographically signed JSON Web Tokens (JWT).

- **Token Extraction:** Incoming requests must provide the token in the `Authorization` header using the `Bearer <token>` scheme.
- **Cryptographic Signature:** Tokens are verified using HMAC-SHA256 (HS256) encryption validated against the shared `JWT_SECRET` signing key.
- **Required Claims:** Valid tokens must contain standard `sub` (subject identifier), `role` (user permissions), and `exp` (expiration timestamp) claims.
- **Token Expiration:** Requests containing expired JWT tokens are immediately rejected with an HTTP 401 Unauthorized response.
- **Privileged Access:** Access to sensitive administration, gateway metrics, and route configuration endpoints strictly requires the `admin` role claim. Requests lacking this role receive an HTTP 403 Forbidden status code.

---

## 5. Observability, Telemetry & Real-Time Dashboards

Nexus-Gate provides real-time distributed telemetry and Prometheus monitoring integration.

- **Prometheus Exporter:** System metrics are exposed on port 9090 at the `/metrics` endpoint.
- **Exported Metric Names:**
  - `http_requests_total`: Tracks aggregate request volume labeled by HTTP method, path, and response status code.
  - `gateway_circuit_breaker_state`: Gauge indicating the current state (0 = CLOSED, 1 = HALF-OPEN, 2 = OPEN) of each upstream circuit breaker.
  - `upstream_response_time_seconds`: Histogram and summary gauge measuring latency distributions for proxied upstream calls.
- **Live Control Plane Relays:** Operational dashboards receive real-time updates via WebSocket relays connected to Upstash Redis Pub/Sub channels broadcasting system throughput, circuit trips, and socket states.
