import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import * as AWS from 'aws-sdk';
import { setTimeout } from 'timers/promises';

interface RdsSecrets {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  ssl: boolean;
  maxConnections: number;
  connectionTimeoutMillis: number;
}

@Injectable()
export class AwsSecretsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AwsSecretsService.name);
  private readonly secretsManager: AWS.SecretsManager;
  private cachedSecrets: RdsSecrets | null = null;
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL = 300000; // 5 minutes
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000; // 1 second
  private connectionHealthCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    const region = process.env.AWS_REGION || 'us-east-1';

    AWS.config.update({
      region,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      maxRetries: 3,
      httpOptions: {
        timeout: 5000,
        connectTimeout: 5000,
      },
    });

    this.secretsManager = new AWS.SecretsManager({
      region,
      maxRetries: 3,
    });

    this.logger.log(`AWS Secrets Manager initialized in region: ${region}`);
  }

  async onModuleInit() {
    this.logger.log('Initializing AWS Secrets Service');
    await this.verifyAwsCredentials();
    this.startHealthCheck();
  }

  async onModuleDestroy() {
    this.logger.log('Cleaning up AWS Secrets Service');
    if (this.connectionHealthCheckInterval) {
      clearInterval(this.connectionHealthCheckInterval);
    }
  }

  private async verifyAwsCredentials(): Promise<void> {
    try {
      this.logger.log('Verifying AWS credentials...');
      const sts = new AWS.STS();
      await sts.getCallerIdentity().promise();
      this.logger.log('AWS credentials verified successfully');
    } catch (error: any) {
      this.logger.error(
        `AWS credentials verification failed: ${error.message}`,
      );
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Invalid AWS credentials. Application cannot start.');
      }
      this.logger.warn(
        'Running in development mode with potentially invalid credentials',
      );
    }
  }

  async getDatabaseSecrets(secretName: string): Promise<RdsSecrets> {
    if (this.cachedSecrets && Date.now() < this.cacheExpiry) {
      this.logger.debug('Returning cached database secrets');
      return this.cachedSecrets;
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          this.logger.warn(
            `Retry attempt ${attempt}/${this.MAX_RETRIES} for secret: ${secretName}`,
          );
        }

        this.logger.log(
          `Fetching secrets from AWS Secrets Manager: ${secretName}`,
        );
        const data = await this.secretsManager
          .getSecretValue({ SecretId: secretName })
          .promise();

        const secretString = data.SecretString;
        if (!secretString) {
          throw new Error('Secret string is empty from AWS Secrets Manager');
        }

        this.logger.debug(`Secret data retrieved, parsing JSON...`);
        const secrets = JSON.parse(secretString);

        this.cachedSecrets = {
          host: secrets.host || process.env.DATABASE_HOST,
          port: parseInt(
            secrets.port || process.env.DATABASE_PORT || '5432',
            10,
          ),
          username: secrets.username || process.env.DATABASE_USERNAME,
          password: secrets.password || process.env.DATABASE_PASSWORD,
          database:
            secrets.database || process.env.DATABASE_NAME || 'meru_core',
          ssl: secrets.ssl === undefined ? true : secrets.ssl,
          maxConnections: parseInt(secrets.maxConnections || '20', 10),
          connectionTimeoutMillis: parseInt(
            secrets.connectionTimeoutMillis || '30000',
            10,
          ),
        };

        this.cacheExpiry = Date.now() + this.CACHE_TTL;

        this.logger.log('Successfully fetched and cached database secrets');
        this.logSecretsInfo(this.cachedSecrets);

        return this.cachedSecrets;
      } catch (error: any) {
        lastError = error;
        this.logger.error(
          `Attempt ${attempt} failed: ${error.message}`,
          error.stack,
        );

        if (attempt < this.MAX_RETRIES) {
          this.logger.log(`Waiting ${this.RETRY_DELAY}ms before retry...`);
          await setTimeout(this.RETRY_DELAY);
        }
      }
    }

    if (process.env.NODE_ENV === 'production') {
      this.logger.error(
        `Failed to fetch secrets after ${this.MAX_RETRIES} attempts. Last error: ${lastError?.message}`,
      );
      throw new Error(
        `Failed to fetch database secrets from AWS: ${lastError?.message}`,
      );
    } else {
      this.logger.warn(
        'All AWS retry attempts failed, falling back to environment variables',
      );
      return this.getFallbackSecrets();
    }
  }

  async rotateSecret(
    secretName: string,
    newSecretValue: Record<string, any>,
  ): Promise<void> {
    try {
      this.logger.log(`Initiating secret rotation: ${secretName}`);

      const secretString = JSON.stringify(newSecretValue);

      await this.secretsManager
        .putSecretValue({
          SecretId: secretName,
          SecretString: secretString,
        })
        .promise();

      this.cachedSecrets = null;
      this.cacheExpiry = 0;

      this.logger.log('Secret rotated successfully, cache cleared');

      this.emitSecretRotationEvent(secretName, 'success');
    } catch (error: any) {
      this.logger.error(`Failed to rotate secret: ${secretName}`, error.stack);

      if (process.env.NODE_ENV === 'production') {
        throw error;
      }

      this.emitSecretRotationEvent(secretName, 'failed');
    }
  }

  async invalidateCache(): Promise<void> {
    this.logger.log('Invalidating secrets cache');
    this.cachedSecrets = null;
    this.cacheExpiry = 0;
  }

  async healthCheck(): Promise<{
    status: string;
    cached: boolean;
    awsAccessible: boolean;
  }> {
    try {
      const sts = new AWS.STS();
      await sts.getCallerIdentity().promise();

      return {
        status: 'healthy',
        cached: !!this.cachedSecrets && Date.now() < this.cacheExpiry,
        awsAccessible: true,
      };
    } catch (error: any) {
      return {
        status: 'unhealthy',
        cached: false,
        awsAccessible: false,
      };
    }
  }

  private getFallbackSecrets(): RdsSecrets {
    this.logger.warn('Using fallback environment variables');

    return {
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432', 10),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'meru_core',
      ssl: false,
      maxConnections: 20,
      connectionTimeoutMillis: 30000,
    };
  }

  private logSecretsInfo(secrets: RdsSecrets): void {
    this.logger.log({
      host: secrets.host,
      port: secrets.port,
      username: secrets.username,
      database: secrets.database,
      ssl: secrets.ssl,
      maxConnections: secrets.maxConnections,
      connectionTimeout: secrets.connectionTimeoutMillis / 1000,
    });
  }

  private startHealthCheck(): void {
    this.connectionHealthCheckInterval = setInterval(() => {
      this.healthCheck()
        .then((result) => {
          if (result.status !== 'healthy') {
            this.logger.error('AWS Secrets health check failed', result);
          }
        })
        .catch((error) => {
          this.logger.error('Health check error', error);
        });
    }, 60000); // Check every minute
  }

  private emitSecretRotationEvent(
    secretName: string,
    status: 'success' | 'failed',
  ): void {
    this.logger.log(`Secret rotation event: ${secretName} - ${status}`);

    if (process.env.ENABLE_EVENT_EMITTER === 'true') {
      this.logger.log(`Event emission enabled: secrets-rotation:${status}`);
    }
  }
}
