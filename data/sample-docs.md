# Nexus Infrastructure & Gateway Architecture

## Overview

Nexus-Gate is an event-driven reverse proxy and API Gateway engineered for microservice environments. It handles dynamic request routing, token-bucket rate limiting, circuit breaking, and telemetry streaming.

## Rate Limiting Architecture

Nexus-Gate implements a distributed Token Bucket algorithm backed by Redis. Each client IP or API token receives a refill rate of 100 tokens per minute with a burst capacity of 200 tokens. When the token count reaches zero, the gateway immediately returns HTTP 429 Too Many Requests with a `Retry-After` header.

## Circuit Breaker Pattern

To prevent cascading failures across downstream services, Nexus-Gate implements a 3-state Circuit Breaker:

- **CLOSED**: Requests flow normally to downstream microservices. Error rates are tracked over a 10-second rolling window.
- **OPEN**: If downstream error rates exceed 50%, the circuit trips to OPEN. All subsequent requests fail fast immediately with HTTP 503 Service Unavailable without hitting the downstream server.
- **HALF-OPEN**: After a 30-second cooldown timeout, the circuit enters HALF-OPEN state, allowing a canary probe of 5 requests through. If all 5 succeed, the circuit resets to CLOSED; otherwise, it trips back to OPEN.

## Authentication & Authorization

Requests pass through a JWT validation middleware before routing. The gateway verifies HMAC-SHA256 signatures, validates token expiration timestamps, and extracts role claims (`admin`, `developer`, `readonly`) to enforce endpoint-level Role-Based Access Control (RBAC).

## Health Check and Metrics

Prometheus metrics are exposed on port 9090 at `/metrics`. Key exported metrics include `http_requests_total`, `gateway_circuit_breaker_state`, and `upstream_response_time_seconds`.
