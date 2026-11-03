# AGENTS.md

The full NestJS reference (not a template; new services start from `nest-starter`): a `notes` HTTP API on PostgreSQL (Drizzle), Redis (cache and rate limit), pg-boss (the stats job) and RabbitMQ (the `notes.note.created.v1` event through outbox/inbox, consumed by `src/activity/`). The human-facing description is `README.md`.

## Commands

- `pnpm install`: dependencies (Node 26, pnpm 12; versions pinned exactly).
- `pnpm infra:up` / `pnpm infra:down` / `pnpm infra:reset`: Postgres 18, Redis 8, RabbitMQ 4 from `compose.yaml`.
- `pnpm env:local`: `.env` from `.env.example`; `pnpm db:migrate`: build and migrations; `pnpm dev`: build, `tsc --watch` and `node --watch`.
- `pnpm verify`: lint + typecheck + build + test. It must be green before you hand work over; report the command and its actual result.
- `pnpm test:unit` (no Docker), `pnpm test:int` (Testcontainers, needs Docker). Tests only through `vitest run`, never watch.
- `pnpm db:generate --name <what_it_changes>`: an SQL migration from `src/db/schema.ts`; read the generated SQL.
- `pnpm messaging:replay-dlq <queue> [--limit N]`: build, then move dead letters back to `<queue>` (`node dist/messaging/replay-dlq.js` in the image).
- `pnpm format`: Biome with fixes.

## Structure

- `src/main.ts`: entry point; `src/app.module.ts`: module wiring; `src/app.setup.ts`: HTTP setup (shared with the tests).
- `src/config/`: the Zod env schema (`env.ts`) and the `registerAs` groups (`config.ts`). Nothing else reads `process.env`.
- `src/common/`: infrastructure without business logic, ready to move into a package; the parts nest-starter has are identical there, so a change here is copied there too: `http` (errors, request id, cursors, validation), `database`, `redis`, `messaging` (RabbitMQ, outbox, inbox, event envelope), `jobs` (pg-boss), `health`, `metrics`, `logging`, `openapi`, `context` (AsyncLocalStorage).
- `src/db/`: Drizzle schema, types, `migrate.ts` (Argo CD Sync-hook Job before the Deployment: `node dist/db/migrate.js`).
- `src/messaging/replay-dlq.ts`: the DLQ replay command (`node dist/messaging/replay-dlq.js <queue> [--limit N]`).
- `src/notes/`: the example feature: schemas → repository → service → controller, its event (`notes.events.ts`) and its job (`note-stats.job.ts`).
- `src/activity/`: the example subscriber (stands in for another service): `ActivityConsumer` with the inbox, no HTTP.
- `drizzle/`: SQL migrations and `meta/` (generated, never edited by hand).
- `test/`: integration tests and the harness; unit tests sit next to the code (`*.test.ts`). Failure tests that stop and start a dependency start their own container (`test/containers.ts`).
- `Dockerfile`, `.github/workflows/ci.yml`: the image and CI follow the [service runtime contract](https://github.com/nick-lukashik/.github/blob/master/docs/service-contract.md) (kind **api**); see "Deploy" in `README.md`.

## Conventions

- Code style is Biome's (`biome.json`): 4 spaces, single quotes, no `;`, lines up to 120 characters, objects and arrays always expanded, operators at the start of a wrapped line, `type` over `interface`, `string[]`, kebab-case file names. Run `pnpm format` after edits.
- ESM: relative imports end in `.js`. Injectable classes are imported as values, not `import type` (DI reads `emitDecoratorMetadata`). Non-classes go through a `Symbol` token (`DB`, `PG_POOL`, `REDIS`, `PG_BOSS`).
- Controllers are thin: the schema on the parameter (`@Body({ schema })`, `@Query({ schema })`), a service call. SQL lives only in `*.repository.ts`.
- The contract is described by Zod schemas in `<feature>.schemas.ts` with `.meta({ id })`; OpenAPI (`/openapi.json`) is built from them. Responses through `@ApiOkResponse({ standardSchema })`, errors through `@ApiErrors(...)`.
- Errors: `throw new AppError(code, message, details?)` or `notFound("Note")`. Codes: `VALIDATION_FAILED` 400, `NOT_FOUND` 404, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429, `INTERNAL` 500, `UNAVAILABLE` 503 (Postgres over a time budget or down: `ErrorFilter` maps it by SQLSTATE), `TIMEOUT` 504 (the 10 s request budget). Only `ErrorFilter` builds the response body; stacks, SQL and internal messages never leave the service.
- Time budgets (service contract): request 10 s, SQL statement 5 s, lock 2 s, idle in transaction 10 s, pool wait 2 s, migration lock wait 1 s (retried), Redis command 500 ms, body 1 MiB. They are set once (`DATABASE_TIMEOUTS`, `REDIS_COMMAND_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `BODY_LIMIT`); work that needs more goes to a pg-boss job, not a longer budget. Every Redis command goes through `bounded(...)`.
- Degradation: readiness requires Postgres only. Register a readiness check with `health.register(name, check, { required })`; a degradable dependency (Redis, RabbitMQ) uses `required: false`, is reported as `degraded`, never blocks startup, and has a metric for its degraded state.
- Migrations: compatible with the code that is running (add → switch → remove, over separate releases), forward only, no long-locking DDL mixed into a feature migration, backfills as batched jobs ("Migrations" in `README.md`).
- A new environment variable: `src/config/env.ts` → a group in `src/config/config.ts` → `.env.example`. Secrets have no `.default()`.
- Events: `defineEvent` in `<feature>.events.ts`; write with `enqueueEvent(tx, ...)` in the same transaction, then `relay.kick()` after the commit. Consume with `defineQueue` + `rabbit.subscribe(...)` in `onApplicationBootstrap` + `processOnce(...)`. No direct `publish` from business code. Every publish (outbox, retry/DLQ move, replay) goes through `confirmedPublisher` (`mandatory` + confirm; a returned message is a failure); queue arguments come only from `queueDeclarations()` (quorum, at-least-once dead-lettering). See "Messaging guarantees" in `README.md`.
- Jobs: the queue is created in `onModuleInit` (`boss.createQueue`), the worker in `onApplicationBootstrap` (`boss.work`). From a transaction, send a job with `boss.send(..., { db: fromDrizzle(tx, sql) })` (`NoteStatsJob.request(tx)`).
- Which mechanism: a job for this service's own background work, an event for other services, a consumer with the inbox for their events. Do not publish an event to reach your own service, and do not chain event → job unless the handler has slow or external work ("Which mechanism" in `README.md`).
- Cache: `VersionedCache.remember(...)` with a Zod schema for the value; invalidate with `invalidate(namespace)`. Redis is not the source of truth.
- Logs: pino JSON, only `Logger` from `@nestjs/common`; the object first, a constant message. Secrets, tokens and personal data are never logged.
- Times in the API are ISO strings in UTC; ids are uuidv7 (`uuidv7()` in PostgreSQL 18, `randomUUIDv7()` in Node).
- Runtime: the app listens on `PORT` (local default 4000; the image and the cluster use 3000), metrics on `METRICS_PORT` (9464). The image runs as uid `10001` with a read-only root filesystem: write nothing outside `/tmp`.
- English everywhere: code, comments (short and rare) and docs.
- No secrets, real IPs or e-mail addresses in files (examples use `example.com`).

## Library rules

Short rules for each library, checked against the installed versions. Read the relevant file before changing code in that area.

- `.claude/rules/nestjs.md`: NestJS 12, @nestjs/config, terminus, throttler, swagger (NestJS llms.txt).
- `.claude/rules/zod.md`: Zod 4 (Zod llms.txt).
- `.claude/rules/drizzle.md`: Drizzle ORM 0.45 and drizzle-kit 0.31 (Drizzle llms.txt).
- `.claude/rules/redis.md`: Redis 8 and node-redis (the official Redis agent skills).
- `.claude/rules/rabbitmq.md`: RabbitMQ 4.4 and amqplib 2 (docs summary).
- `.claude/rules/pg-boss.md`: pg-boss 12 (docs summary).
- `.claude/rules/pino.md`: pino 10 and nestjs-pino 5 (docs summary).
- `.claude/rules/prometheus.md`: @prometheus-io/client (docs summary).
- `.claude/rules/vitest.md`: Vitest 5 (Vitest llms.txt and its guide for AI agents).
- `.claude/rules/testcontainers.md`: Testcontainers for Node 12 (docs summary).
- `.claude/rules/biome.md`: Biome 2 (docs summary).
