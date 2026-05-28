import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AwsSecretsService } from './aws-secrets.service';

@Module({
  imports: [TypeOrmModule],
  providers: [AwsSecretsService],
  exports: [AwsSecretsService],
})
export class DatabaseConfigModule {}

export const getDatabaseConfig =
  (awsSecretsService: AwsSecretsService) => async () => {
    const secretsName = process.env.AWS_SECRETS_NAME || 'prod/meru-core/rds';

    const dbSecrets = await awsSecretsService.getDatabaseSecrets(secretsName);

    return {
      type: 'postgres' as const,
      host: dbSecrets.host,
      port: dbSecrets.port,
      username: dbSecrets.username,
      password: dbSecrets.password,
      database: dbSecrets.database,
      ssl: dbSecrets.ssl,
      extra: {
        max: dbSecrets.maxConnections,
        connectionTimeoutMillis: dbSecrets.connectionTimeoutMillis,
        logging: process.env.NODE_ENV === 'development',
        ssl: dbSecrets.ssl
          ? {
              rejectUnauthorized: false,
            }
          : undefined,
      },
      synchronize: false,
      logging: process.env.NODE_ENV === 'development',
      entities: [],
    };
  };
