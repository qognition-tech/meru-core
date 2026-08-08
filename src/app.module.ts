import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { TenancyModule } from './core/tenancy/tenancy.module';
import { MailModule } from './core/mail/mail.module';
import { TenantAlsMiddleware } from './core/tenancy/tenant-als.middleware';
import { TenantBindingInterceptor } from './core/tenancy/tenant-binding.interceptor';
import { GlobalAuthGuard } from './core/auth/global-auth.guard';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { IamModule } from './iam/iam.module';
import { TenantModule } from './tenant/tenant.module';
import { CrmModule } from './crm/crm.module';
import { SearchModule } from './search/search.module';
import { AiModule } from './ai/ai.module';
import { OrchestrationModule } from './orchestration/orchestration.module';

import { DocumentsModule } from './documents/documents.module';
import { WorkflowModule } from './workflow/workflow.module';
import { FormsModule } from './forms/forms.module';
import { TasksModule } from './tasks/tasks.module';
import { BillingModule } from './billing/billing.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StorageModule } from './storage/storage.module';
import { QueueModule } from './queue/queue.module';
import { ElasticsearchModule } from './search/elasticsearch/elasticsearch.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';

import { ALL_ENTITIES } from './config/entities';

@Module({
  imports: [
    // 1. Configuration & Validation
    AppConfigModule,

    // 2. Event Emitter for @OnEvent decorators
    EventEmitterModule.forRoot(),

    // 3. Scheduler for @Cron/@Interval decorators
    ScheduleModule.forRoot(),

    // 4. Database Setup (Connecting all modules)
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      useFactory: (configService: ConfigService): any => {
        const isDevelopment = configService.get('NODE_ENV') === 'development';
        const isServerless = !!process.env.VERCEL;

        // Neon hands out a single connection string; prefer it when present and
        // fall back to the discrete vars for local/legacy setups.
        const databaseUrl = configService.get('database.url');
        const connection = databaseUrl
          ? { url: databaseUrl }
          : {
              host: configService.get('database.host'),
              port: configService.get('database.port'),
              username: configService.get('database.username'),
              password: configService.get('database.password'),
              database: configService.get('database.name'),
            };

        return {
          type: 'postgres' as const,
          ...connection,

          // CRITICAL: the shared catalogue in config/entities.ts — the same
          // list every per-vertical DataSource loads, so schemas cannot drift.
          entities: ALL_ENTITIES,

          // WARNING: synchronize: true is for DEVELOPMENT ONLY.
          // It automatically creates/updates tables. Disable for Production!
          synchronize: false, // Disabled for production - use migrations

          logging: isDevelopment,

          // Serverless gets ONE attempt. TypeORM funnels every DataSource
          // failure — including non-retryable ones like a bad entity
          // definition — through the same retry loop, logging each as
          // "Unable to connect to the database. Retrying (n)...". Ten attempts
          // at 3s spends 30s+ before the real error is ever thrown, which on a
          // 60s-maxDuration function means the platform kills the process
          // first: no stack, no log, just FUNCTION_INVOCATION_FAILED. That
          // masked a DataTypeNotSupportedError as a connection fault and cost
          // hours of downtime chasing TLS and env vars. Retrying also buys
          // nothing here — a cold start that cannot reach Postgres should fail
          // fast and let the next invocation try, not hold the caller open.
          retryAttempts: isServerless ? 1 : isDevelopment ? 3 : 10,
          retryDelay: 3000,
          ssl: { rejectUnauthorized: false },

          // Serverless: every lambda instance gets its own pool, so cap it at 1
          // connection. Without this each cold start opens pg's default pool of
          // 10 and exhausts Neon's connection limit under any real concurrency.
          extra: isServerless
            ? { max: 1, connectionTimeoutMillis: 10000 }
            : { max: 10 },
        };
      },
      inject: [ConfigService],
    }),

    IamModule,
    TenantModule,
    CrmModule,
    SearchModule,
    AiModule,
    OrchestrationModule,
    DocumentsModule,
    WorkflowModule,
    FormsModule,
    TasksModule,
    BillingModule,
    AnalyticsModule,
    AuditModule,
    NotificationsModule,
    StorageModule,
    QueueModule,
    ElasticsearchModule,
    IntegrationsModule,
    HealthModule,
    JobsModule,
    TenancyModule,
    MailModule,
  ],
  // AppController serves GET /api/v1/ (the root status route). It existed but
  // was never registered in any module, so the route 404'd and was missing from
  // the OpenAPI document despite carrying @ApiTags('app').
  controllers: [AppController],
  providers: [
    AppService,
    // Binds the authenticated tenant into the ALS context for every request.
    // Global (rather than per-controller) because a route that silently misses
    // this would run against an unbound connection — CLAUDE.md §6.4 admits no
    // opt-in surface for tenant isolation.
    { provide: APP_INTERCEPTOR, useClass: TenantBindingInterceptor },
    // Default-deny authentication: every route requires a JWT unless it
    // declares @Public(). Same rationale as the interceptor above — auth,
    // like tenancy, admits no opt-in surface.
    { provide: APP_GUARD, useClass: GlobalAuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must be the outermost middleware: it opens the AsyncLocalStorage context
    // that everything downstream — guards, interceptors, repositories — reads.
    consumer.apply(TenantAlsMiddleware).forRoutes('*');
  }
}
