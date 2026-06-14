import {
  Injectable,
  NestMiddleware,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import { VerticalType } from '../enums/vertical.enum';
import { UserPayload } from '../../common/types';

declare global {
  namespace Express {
    // Make Passport's `Express.User` resolve to our JWT payload shape so
    // `req.user` is consistently typed platform-wide (single source of truth).
    // Passport's own `Request.user?: User` then provides the property — we must
    // not redeclare `user` here or its type conflicts (TS2717).
    interface User extends UserPayload {}
    interface Request {
      meruTenant?: Tenant;
      tenantId?: string;
      tenantSlug?: string;
      vertical?: VerticalType;
      environment?: 'development' | 'staging' | 'production';
      host?: string;
    }
  }
}

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  // Domain mapping
  private readonly domainMapping: Record<
    string,
    { vertical: VerticalType; baseUrl: string }
  > = {
    'api.immistack.com': {
      vertical: VerticalType.IMMIGRATION,
      baseUrl: 'immistack.com',
    },
    'api.governancex.com': {
      vertical: VerticalType.GRC,
      baseUrl: 'governancex.com',
    },
    'api.meru.com': {
      vertical: VerticalType.IMMIGRATION, // Core platform
      baseUrl: 'meru.com',
    },
  };

  // Environment prefix mapping
  private readonly envPrefixes: Record<
    string,
    'development' | 'staging' | 'production'
  > = {
    'dev-api': 'development',
    'staging-api': 'staging',
    api: 'production',
  };

  constructor(
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
    private dataSource: DataSource,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    // Skip for public endpoints (health, signup, login, etc.)
    if (this.isPublicEndpoint(req.path)) {
      return next();
    }

    const host = req.headers.host?.split(':')[0]; // Remove port if present

    if (!host) {
      return next();
    }

    // Extract environment and domain
    const context = this.extractContext(host || '');

    if (!context) {
      // Unknown domain - let it through (will be handled by specific guards)
      return next();
    }

    try {
      // Set environment in request
      req.environment = context.environment;
      req.vertical = context.vertical;

      // Set RLS context in PostgreSQL for vertical isolation
      await this.setRLSContext(context.vertical, context.environment);

      // Log context for debugging (production: disable)
      if (process.env.NODE_ENV === 'development') {
        this.logger.debug(
          `Context set: ${context.environment} - ${context.vertical} (${host})`,
        );
      }

      next();
    } catch (error) {
      this.logger.error(`Error setting context: ${error.message}`);
      next(); // Continue without context
    }
  }

  private extractContext(host: string): {
    vertical: VerticalType;
    environment: 'development' | 'staging' | 'production';
    baseUrl: string;
  } | null {
    // Handle localhost with query parameters for testing
    // Example: localhost:3000?vertical=immigration&env=staging
    if (host.includes('localhost')) {
      const queryEnv = process.env.TEST_ENV || 'development';
      const queryVertical =
        process.env.TEST_VERTICAL || VerticalType.IMMIGRATION;

      if (Object.values(VerticalType).includes(queryVertical as any)) {
        return {
          vertical: queryVertical as VerticalType,
          environment: queryEnv as any,
          baseUrl: 'localhost',
        };
      }
      return null;
    }

    // Parse the host: env-prefix.vertical-domain.com
    // Examples:
    //   api.immistack.com → production, immigration
    //   staging-api.immistack.com → staging, immigration
    //   dev-api.immistack.com → development, immigration

    const parts = host.split('.');

    // Handle subdomain structure: [env-prefix, api, vertical-domain, com]
    if (parts.length >= 3) {
      const envPrefix = parts[0]; // api, staging-api, dev-api
      const apiPart = parts[1]; // api (must be present)
      const domain = parts.slice(1).join('.'); // api.immistack.com or api.governancex.com

      // Find matching domain
      const domainConfig = this.domainMapping[domain];

      if (domainConfig && apiPart === 'api') {
        const environment = this.envPrefixes[envPrefix];

        if (environment) {
          return {
            vertical: domainConfig.vertical,
            environment,
            baseUrl: domainConfig.baseUrl,
          };
        }
      }
    }

    // Handle api.meru.com (main platform)
    if (
      host === 'api.meru.com' ||
      host === 'staging-api.meru.com' ||
      host === 'dev-api.meru.com'
    ) {
      const parts = host.split('.');
      const envPrefix = parts[0];
      const environment = this.envPrefixes[envPrefix];

      return {
        vertical: VerticalType.IMMIGRATION, // Core platform
        environment: environment || 'production',
        baseUrl: 'meru.com',
      };
    }

    return null;
  }

  private async setRLSContext(
    vertical: VerticalType,
    environment: string,
  ): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      // Set PostgreSQL RLS context for vertical AND environment
      await queryRunner.query(`SELECT app.set_context($1, $2)`, [
        vertical,
        environment,
      ]);

      this.logger.debug(`RLS context set: ${vertical} (${environment})`);
    } catch (error) {
      this.logger.error(`Failed to set RLS context: ${error.message}`);
    } finally {
      await queryRunner.release();
    }
  }

  private isPublicEndpoint(path: string): boolean {
    const publicPaths = [
      '/health',
      '/api/v1/auth/login',
      '/api/v1/auth/register',
      '/api/v1/tenants/signup',
      '/api/v1/tenants/check-slug',
      '/api-docs',
      '/api',
      '/swagger',
      '/favicon.ico',
      '/static',
      '/public',
    ];

    return publicPaths.some((publicPath) => path.startsWith(publicPath));
  }
}
