# nest-example

The full reference of a NestJS service on this platform: every capability, wired and tested together. PostgreSQL + Drizzle, Redis (cache, rate limit), RabbitMQ (transactional outbox → publish → idempotent inbox), pg-boss (jobs), Zod validation, OpenAPI, health, metrics, graceful shutdown, tests on Testcontainers, Dockerfile, CI.

It is not a template. A new service starts from [`nest-starter`](https://github.com/nick-lukashik/nest-starter) (HTTP, config, logs, health, metrics, Postgres) and copies from here only the capability it uses: Redis, RabbitMQ or pg-boss. The shared files under `src/common/` are the same in both, so a capability is a folder plus its wiring in `app.module.ts`. The steps are in "Add a capability" in the starter's README.

## Which mechanism

| Need                                                                    | Use                                                                    | Example here                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| Reliable background work inside this service (slow, retried, scheduled) | pg-boss job, sent in the transaction of the write                      | `notes.refresh-stats`: `NoteStatsJob`          |
| Tell other services what happened                                       | outbox + RabbitMQ: an event, written in the transaction of the write   | `notes.note.created.v1`: `NotesService.create` |
| React to another service's event with database work                     | a consumer with its own queue + inbox, effect in the inbox transaction | `ActivityConsumer` (`src/activity/`)           |
| React to an event with slow or external work (e-mail, HTTP)             | the consumer above sends a pg-boss job from its inbox transaction      | not shown: add it only when such work exists   |

A job is not an event: do not publish an event to reach your own service, and do not chain event → job when the handler can do the work in its transaction. Every extra hop is another queue, another retry policy and another place to look when something is stuck.

## What is inside

| Component                                           | Version         | Why this one                                                                                                                                                 |
| --------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js / pnpm                                      | 26.13 / 12.16   | `.node-version`, `packageManager`                                                                                                                            |
| NestJS (express)                                    | 12.3            | ESM; built-in `StandardSchemaValidationPipe` and `useSecurityHeaders()` (replaces helmet)                                                                    |
| TypeScript                                          | 7.0             | native `tsc` for build and typecheck; no Nest CLI, SWC only in tests                                                                                         |
| Zod                                                 | 4.6             | one schema for validation and OpenAPI; no class-validator or nestjs-zod                                                                                      |
| @nestjs/swagger                                     | 12.0.5          | understands Standard JSON Schema from Zod                                                                                                                    |
| Drizzle ORM / drizzle-kit                           | 0.45 / 0.31     | SQL migrations, typed queries; driver `pg` 8.23                                                                                                              |
| PostgreSQL                                          | 18.6            | `uuidv7()` built in                                                                                                                                          |
| `@redis/client` (node-redis)                        | 6.3             | the official Redis client; Redis recommends it over ioredis (maintenance only) for new projects                                                              |
| Redis                                               | 8.10            |                                                                                                                                                              |
| amqplib                                             | 2.2.0           | the client from the official RabbitMQ tutorials; since 1.1 it recovers the connection itself, no amqp-connection-manager. RabbitMQ has no official JS client |
| RabbitMQ                                            | 4.4             | quorum queues                                                                                                                                                |
| pg-boss                                             | 12.38           | jobs in the same database; the official `fromDrizzle` adapter sends a job inside a transaction                                                               |
| pino / nestjs-pino                                  | 10.4 / 5.3      | JSON logs with `requestId`                                                                                                                                   |
| @prometheus-io/client                               | 0.16            | prom-client, moved to the Prometheus organization                                                                                                            |
| @nestjs/terminus, @nestjs/throttler, @nestjs/config | 12.1, 6.7, 12.0 | official Nest modules                                                                                                                                        |
| Vitest / Testcontainers                             | 5.0 / 12.2      |                                                                                                                                                              |
| Biome                                               | 2.6             | linter and formatter                                                                                                                                         |

Versions are pinned exactly. @nestjs/swagger 12.1.0 and amqplib 2.2.1 were less than a day old, so pnpm's `minimumReleaseAge` threshold did not let them in; the previous releases are used.

[Renovate](https://docs.renovatebot.com/) (`renovate.json`, the same policy in every repo) opens update PRs on Monday early morning (`Asia/Tbilisi`): one PR for all non-major updates, one per major, weekly lockfile maintenance. It covers npm packages, `packageManager`, `.node-version`, the Dockerfile base image tag and the `compose.yaml` images. Releases younger than 3 days are skipped. It needs the Renovate GitHub app on the organization.

## Getting started

```sh
pnpm install
pnpm infra:up        # Postgres :5432, Redis :6379, RabbitMQ :5672 (UI :15672, app/app)
pnpm env:local       # .env from .env.example
pnpm db:migrate      # build + Drizzle migrations + pg-boss schema
pnpm dev             # http://localhost:4000, metrics http://localhost:9464/metrics
```

The rest:

```sh
pnpm verify          # lint + typecheck + build + test (Testcontainers need Docker)
pnpm test:unit       # no Docker
pnpm test:int        # Postgres, Redis, RabbitMQ in Testcontainers
pnpm start           # node dist/main.js after pnpm build
pnpm messaging:replay-dlq nest-example.activity --limit 10   # see "DLQ replay"
pnpm infra:down      # stop; pnpm infra:reset stops and deletes the data
```

Queue arguments are part of a queue's identity. A local RabbitMQ volume created before the at-least-once arguments (see "Messaging guarantees") makes the consumer fail with `PRECONDITION_FAILED` (reported in `/health/ready`, retried with backoff): run `pnpm infra:reset` once.

Manual check:

```sh
curl -s -X POST localhost:4000/api/v1/notes -H 'content-type: application/json' -d '{"title":"Hello","body":"World"}'
curl -s -i 'localhost:4000/api/v1/notes?limit=20' | grep -i x-cache   # MISS, then HIT
curl -s localhost:4000/api/v1/notes/stats                             # after ~1 s: {"total":1,"createdLastHour":1}
docker compose exec postgres psql -U app -c 'select type, summary from activity'   # the event's consumer
curl -s localhost:4000/health/ready
```

Swagger UI: `/docs` (except with `NODE_ENV=production`), document: `/openapi.json`.

## API

Prefix `/api`, version in the URI. The `x-request-id` header is accepted (if well-formed) or generated, and returned; `x-app-version` is `APP_VERSION`. CORS is off.

| Method and path                         | Response                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/notes?limit=20&cursor=…`   | `{ items: Note[], nextCursor: string \| null }`, newest first; cached in Redis, header `x-cache: HIT\|MISS` |
| `GET /api/v1/notes/:id`                 | `Note` or 404                                                                                               |
| `POST /api/v1/notes` `{ title, body }`  | 201 `Note`; 30 requests per minute per IP, then 429                                                         |
| `GET /api/v1/notes/stats`               | `{ total, createdLastHour }`, computed by the pg-boss job `notes.refresh-stats`                             |
| `GET /health/live`, `GET /health/ready` | ready: 503 only without Postgres; Redis and RabbitMQ are reported, `degraded` when down                     |
| `GET /openapi.json`, `GET /docs`        | OpenAPI from the Zod schemas                                                                                |

`Note = { id: uuidv7, title: 1–200, body: 0–5000, createdAt: ISO }`. Error: `{ code, message, details?: { path, message }[], requestId }` with `code` one of `VALIDATION_FAILED` (400), `NOT_FOUND` (404), `PAYLOAD_TOO_LARGE` (413, body over 1 MiB), `RATE_LIMITED` (429), `INTERNAL` (500), `UNAVAILABLE` (503: Postgres over a time budget or down, retry later), `TIMEOUT` (504: the request exceeded 10 s; a write may still have been applied).

## Where to find each example

| Topic                           | Files                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Config from env (Zod)           | `src/config/env.ts`, `src/config/config.ts`, `src/common/config/define-env.ts`                       |
| DB: schema, queries, migrations | `src/db/schema.ts`, `src/notes/notes.repository.ts`, `drizzle/`, `src/db/migrate.ts`                 |
| Validation and errors           | `src/notes/notes.schemas.ts`, `src/common/http/`                                                     |
| Redis cache                     | `src/common/redis/versioned-cache.ts`, `NotesService.list`                                           |
| Redis rate limit                | `src/common/redis/redis-throttler.storage.ts`, `@UseGuards(ThrottlerGuard)` in `notes.controller.ts` |
| Outbox → RabbitMQ               | `NotesService.create`, `src/common/messaging/outbox.ts`, `outbox-relay.ts`, `rabbitmq.ts`            |
| Inbox + consumer                | `src/common/messaging/inbox.ts`, `src/activity/activity.consumer.ts`                                 |
| pg-boss                         | `src/common/jobs/jobs.module.ts`, `src/notes/note-stats.job.ts`                                      |
| Logs, request id                | `src/common/logging/logger.module.ts`, `src/common/http/request-id.ts`                               |
| Health, metrics, OpenAPI        | `src/common/health/`, `src/common/metrics/`, `src/common/openapi/`                                   |
| Graceful shutdown               | `beforeApplicationShutdown` / `onApplicationShutdown` hooks in the `src/common/*` modules            |
| Time budgets, degradation       | `src/common/database/database.ts`, `src/common/http/request-timeout.ts`, `src/common/redis/`         |
| DLQ replay                      | `src/common/messaging/replay.ts`, `src/messaging/replay-dlq.ts`                                      |
| Tests                           | `src/**/*.test.ts` (unit), `test/*.int.test.ts`, `test/global-setup.ts`, `test/harness.ts`           |

`POST /notes` commits the note with two independent follow-ups; neither waits for the other:

- **Job** (this service's own work): the pg-boss job `notes.refresh-stats` is queued in the same transaction (`fromDrizzle(tx, sql)`), so a rolled-back note queues nothing. A worker recomputes `note_stats`; a schedule runs it once a minute too. It needs only Postgres: it keeps running while RabbitMQ is down.
- **Event** (for other services): an `outbox` row in the same transaction → `OutboxRelay` publishes `notes.note.created.v1` to the `notes.events` exchange (`mandatory`) and waits for the broker's confirm → queue `nest-example.activity` → `ActivityConsumer` writes `inbox` and the `activity` row in one transaction. Failed handling goes to `<queue>.retry.N`, then to `<queue>.dlq`. `src/activity/` stands in for another service: its own queue and table, only the event contract imported.

## Time budgets

A dependency that hangs fails the request fast instead of filling the pool (service contract, "Time budgets"):

| Budget                               | Value                      | Where                                                                                               | When exceeded                                                                                           |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Whole request                        | 10 s                       | `RequestTimeoutInterceptor` (`src/common/http/request-timeout.ts`)                                  | 504 `TIMEOUT`; `http_server_request_timeouts_total`                                                     |
| SQL statement                        | 5 s                        | `statement_timeout`, a startup parameter of every pool connection (`DATABASE_TIMEOUTS`)             | 503 `UNAVAILABLE`                                                                                       |
| Waiting for a lock                   | 2 s                        | `lock_timeout` (row and table locks, e.g. a migration's `ALTER TABLE`)                              | 503 `UNAVAILABLE`                                                                                       |
| Transaction idle without a statement | 10 s                       | `idle_in_transaction_session_timeout`: the server ends a leaked transaction                         | the connection is closed and replaced                                                                   |
| Waiting for a pool connection        | 2 s                        | `connectionTimeoutMillis`; the pool is bounded by `DATABASE_POOL_MAX` (10)                          | 503 `UNAVAILABLE` ("Database is busy")                                                                  |
| Redis command                        | 500 ms                     | `bounded()` in `src/common/redis/redis.client.ts`                                                   | cache bypassed / rate limiter open                                                                      |
| Request body                         | 1 MiB                      | the JSON and urlencoded body parsers (`BODY_LIMIT` in `src/app.setup.ts`), also chunked             | 413 `PAYLOAD_TOO_LARGE`                                                                                 |
| Migration waiting for a lock         | 1 s per run, up to 10 runs | `lock_timeout` of the migration connection (`MIGRATION_LOCKS` in `src/common/database/database.ts`) | the run is rolled back and repeated after 1–10 s; after about 1 min the Job fails and the rollout stops |

503s from Postgres are logged with the reason only (never the SQL) and counted in `http_server_database_failures_total{reason=lock_timeout|statement_timeout|pool_timeout|unavailable}`; `db_pool_connections{state=total|idle|waiting}` shows the pool. node-redis' own command `timeout` covers only the time before a command is written, so the wait for the reply is raced in `bounded()`; on timeout the connection is destroyed, all pending commands reject, and the client reconnects without replay. The queue is capped at 256 commands. A 5 s socket timeout also bounds a stalled reconnect handshake; idle connections are kept alive with a 2 s ping. Postgres also has a 6 s client reply deadline: the active connection is closed and removed from the pool if the server never replies (including inside transactions). Server-side SQL timeouts still fire first. A 504 stops waiting for the handler; the work it already started is ended by the budgets above, and a write that committed stays committed.

## Migrations

`node dist/db/migrate.js` runs in the migrate Job before the new pods, while the old pods keep serving. So:

- **Compatible with the running code.** The old version runs during the Job, during the rollout and after a rollback. Add first (a column, a table, an index), switch the code in the next release, remove the old in the release after that. Never rename or drop in the same release that stops using it.
- **Forward only.** There are no down migrations; a rollback in gitops brings back the old image, which works with the new schema because of the rule above.
- **Short locks.** A DDL statement waiting for a lock holds up every later query on that table. The migration connection waits at most 1 s, below the app's 2 s, so the app's queries get through; the run (one transaction for every pending migration) is then rolled back and repeated, up to 10 times (`MIGRATION_LOCKS`, each retry logged). Once a statement holds its lock, it holds it until the end: a rewrite of a big table or an index on it is planned on its own, not mixed into a feature migration.
- **Data in batches.** Backfilling existing rows is a job, in batches, not an `UPDATE` of the whole table in the migration.

## Degradation

Readiness (`/health/ready`) requires Postgres only. Redis and RabbitMQ are degradable: when one of them is down the body reports it as `degraded` (with the reason and, for RabbitMQ, every consumer) and the status stays 200, so the pods keep serving. Startup does not wait for them either (at most 3 s for Redis, 5 s for RabbitMQ); both reconnect forever in the background.

| Down       | Behavior                                                                                                                                                                               | Metric (alert)                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Postgres   | readiness 503; requests 503 `UNAVAILABLE` within the budgets above                                                                                                                     | readiness probe; `http_server_database_failures_total`                                 |
| Redis      | the list cache is bypassed (reads from Postgres, `x-cache: MISS`), the rate limiter fails open; one warning per 10 s. A failed invalidation is retried before that cache is used again | `redis_up == 0`, `cache_errors_total{operation}`, `rate_limit_fail_open_total`         |
| RabbitMQ   | writes succeed, events wait in the outbox and are published after the reconnect; consumers resubscribe when the broker is back                                                         | `messaging_broker_up == 0`, `outbox_pending_events`, `outbox_oldest_pending_seconds`   |
| a consumer | cancelled by the broker (queue deleted) or its channel closed: re-subscribed with backoff (0.5 s → 30 s), without waiting for a reconnect                                              | `messaging_consumer_up{queue} == 0`, `messaging_consumer_restarts_total{queue,reason}` |

Suggested alert expressions (the PrometheusRule belongs in gitops), each with `for: 5m`: `messaging_broker_up == 0`, `messaging_consumer_up == 0`, `outbox_oldest_pending_seconds > 300`, `redis_up == 0`, `increase(rate_limit_fail_open_total[10m]) > 0`, `increase(outbox_publish_failures_total{reason="unroutable"}[10m]) > 0`, `increase(http_server_database_failures_total[5m]) > 0`.

## Messaging guarantees

At-least-once from the outbox to the handler, with effects applied once through the inbox:

- **Publish**: `mandatory: true` on a confirm channel. RabbitMQ confirms an unroutable message too, but sends `basic.return` first; the relay treats a returned message (matched by a per-publish `x-publish-id` header), a nack, no confirm within 10 s or a lost connection as a failure: the outbox row stays `pending` with `last_error` and is retried with backoff (`outbox_publish_failures_total{reason=unroutable|unavailable|error}`). A deleted exchange closes the publisher channel; the next publish opens a new one and declares the exchanges again.
- **Queues**: quorum queues. The main queue and the retry queues use `x-dead-letter-strategy: at-least-once` with `x-overflow: reject-publish` (required by that strategy) and a dead-letter exchange: a message that expires in a retry queue, or exceeds the delivery limit (20) in the main queue, stays in its queue until the target queue confirmed it. Without these arguments RabbitMQ dead-letters at most once and drops the message when the target is missing.
- **Retry and DLQ moves**: the consumer copies a failed message to `<queue>.retry.N` or `<queue>.dlq` (mandatory, confirmed) before acking it. If the copy fails (target queue missing, nack), the original is not acked: the consumer's channel is closed (the message returns to its queue) and the consumer re-subscribes, declaring the retry queues and the DLQ again (`messaging_move_failures_total`).
- **Consumers**: each has its own channel and is supervised separately (see "Degradation"); `/health/ready` lists them under `rabbitmq.consumers`.
- **Duplicates** are normal (a crash between publish and mark, a redelivery after a restart, a replay): consumers deduplicate by `eventId` in the inbox.

### DLQ replay

After the cause is fixed, move dead letters back to their queue:

```sh
node dist/messaging/replay-dlq.js nest-example.activity --limit 100      # in the image, e.g. kubectl exec deploy/<svc> -- ...
pnpm messaging:replay-dlq nest-example.activity --limit 100              # locally (build + .env)
```

It reads only `RABBITMQ_URL`, checks that `<queue>.dlq` and `<queue>` exist (otherwise nothing is moved, exit code 1), then takes messages oldest first, at most `--limit` and at most the number present at the start (a message that fails again is not replayed twice in one run). Each one is published to `<queue>` with `mandatory` and a broker confirm before its DLQ copy is acked; on a failure it goes back to the DLQ and the command stops with exit code 1. The attempt counter restarts, so the full retry chain applies again. The result is a JSON line with `replayed` and `remaining`.

## New module

1. `src/<feature>/`: `<feature>.schemas.ts` (Zod, `.meta({ id })`), `<feature>.repository.ts`, `<feature>.service.ts`, `<feature>.controller.ts`, `<feature>.module.ts`. The model is `src/notes/`; a module without HTTP, only a consumer, is `src/activity/`.
2. Tables go to `src/db/schema.ts`, then `pnpm db:generate --name <change>`, read the SQL in `drizzle/`, `pnpm db:migrate`.
3. The module goes to `imports` in `src/app.module.ts`.
4. Environment variables: `src/config/env.ts`, a group in `src/config/config.ts`, a line in `.env.example`.
5. Pick the mechanism with "Which mechanism" above.
6. Events: `defineEvent` in `<feature>.events.ts`, `enqueueEvent(tx, …)` in the transaction and `relay.kick()` after it; a new producer goes to `exchanges` of `MessagingModule` in `app.module.ts`. Consumer: `defineQueue`, `rabbit.subscribe` in `onApplicationBootstrap`, `processOnce`.
7. Jobs: `boss.createQueue` in `onModuleInit`, `boss.work` in `onApplicationBootstrap`, a `request(tx)` method that sends with `fromDrizzle(tx, sql)`.
8. Tests: unit next to the code, integration in `test/` through `startApp()`.

Conventions for agents and people: `AGENTS.md`; library rules: `.claude/rules/`.

## Docker

```sh
docker build --build-arg APP_VERSION=$(git rev-parse HEAD) -t nest-example .
pnpm infra:up
# as in Kubernetes: read-only root filesystem, no capabilities, uid 10001
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --user 10001:10001 --network nest-example_default -p 4000:3000 -p 9464:9464 \
  -e DATABASE_URL=postgres://app:app@postgres:5432/app -e REDIS_URL=redis://redis:6379 \
  -e RABBITMQ_URL=amqp://app:app@rabbitmq:5672 nest-example
# migrations from the same image
docker run --rm --read-only --tmpfs /tmp --user 10001:10001 --network nest-example_default \
  -e DATABASE_URL=postgres://app:app@postgres:5432/app nest-example node dist/db/migrate.js
```

- Base `node:26.13.0-trixie-slim`. Stages: `deps` (pnpm from `packageManager`) → `build` (`dist/`) and `prod-deps` (`node_modules` without dev dependencies) → `runtime`.
- `APP_VERSION` is the only build arg: nothing environment-specific is baked in, so one image runs on stage and prod.
- App files are owned by root, the app runs as uid `10001` and writes nothing: a read-only root filesystem works, only `/tmp` is writable.
- `PORT` is 3000 in the image (the local default without it is 4000), metrics on `METRICS_PORT` 9464. `HEALTHCHECK` polls `/health/ready` for `docker run`; Kubernetes ignores it and uses its probes.
- `node dist/main.js` is PID 1. On `SIGTERM`: readiness answers 503 for `SHUTDOWN_DELAY_MS` (0 by default; the pod's `preStop` sleep drains the load balancer), consumers stop and drain (at most 10 s; an unfinished message is redelivered), pg-boss stops (at most 10 s for running jobs), then HTTP, pools and connections close. `SHUTDOWN_DELAY_MS` is capped at 10 s. A hard deadline in `main.ts` exits with an error after 25 s, before Kubernetes kills the pod at 30 s. With idle jobs shutdown takes well under a second.
- Behind an ingress set `TRUST_PROXY_HOPS=1`, or the rate limit counts the proxy's IP.

## CI

`.github/workflows/ci.yml` calls `build.yml@v1` of `nick-lukashik/.github` with `kind: api`, `services: postgres,redis,rabbitmq` and `publish: false`. It starts those service containers, exports them as `TEST_DATABASE_URL`, `TEST_REDIS_URL` and `TEST_RABBITMQ_URL`, runs `pnpm verify` and builds the image. Nothing is pushed and nothing is deployed: this repo proves that every capability works together. The required check is `ci / verify`.

The integration tests (`test/global-setup.ts`) use ready services instead of Testcontainers when all three `TEST_*_URL` are set. Plain `DATABASE_URL` and the like are never used, because the tests truncate tables. The failure tests that stop and start a dependency (`test/broker-outage.int.test.ts`, `test/redis-degradation.int.test.ts`) always start their own RabbitMQ or Redis container, so they need Docker in CI too.

Failure tests: broker restart and at-least-once dead-lettering (`broker-outage`, which also checks that the pg-boss job keeps running without the broker), lost subscription, channel error, unroutable publish, missing retry queue and DLQ replay (`messaging`), SQL lock, pool exhaustion and statement timeout (`time-budgets`), Redis hung and stopped (`redis-degradation`), large body (`body-limit`).

## Deploy

This repo is never deployed. A service built from `nest-starter` with these capabilities is, and follows the [service runtime contract](https://github.com/nick-lukashik/.github/blob/master/docs/service-contract.md) (kind **api**); the points below are what the capabilities add to it.

- Image: `ghcr.io/nick-lukashik/<repo-name>`, tags `sha-<7 chars>` and the full SHA, deployed by digest only. The same image goes to stage and then to prod.
- gitops: `apps/<svc>/prod/kustomization.yaml` includes `components/service` and `components/api`, sets the host, and has one `images:` entry `ghcr.io/nick-lukashik/<svc>` with a `digest` (no `newName`). The deploy PR changes only that digest.
- Config through `envFrom`: non-secret values (`LOG_LEVEL`, `TRUST_PROXY_HOPS`, `DATABASE_POOL_MAX`, `RATE_LIMIT_PER_MINUTE`, …) in the ConfigMap `<svc>-config`; `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL` in the SealedSecret `<svc>-secrets`. `PORT=3000` comes from gitops; `APP_VERSION` from the image. A bad or missing value stops the process at start.
- Migrations: `components/api` runs `node dist/db/migrate.js` as an Argo CD `Sync`-hook Job in wave 0 with the same image, config and secrets: after `<svc>-secrets` (wave -1), before the Deployment (wave 1), so a failed migration stops the rollout. See "Migrations" for the rules a migration follows. It applies pending migrations and, with jobs, the pg-boss schema; it is idempotent and exits 0.
- Probes on the `http` port: `/health/live` (the process answers, no dependency checks) and `/health/ready` (503 only without Postgres; Redis and RabbitMQ are reported in the body and in metrics, see "Degradation"). Both return `x-app-version`, which the post-deploy smoke check waits for.
- Metrics: Prometheus text on port `9464` (`METRICS_PORT`), path `/metrics`, container port `metrics`, scraped through the ServiceMonitor from `components/api`. Never on the public `http` port.
- Callers: only Traefik and pods labelled `nick-lukashik.com/api-client: "true"` (NetworkPolicy from `components/api`).
