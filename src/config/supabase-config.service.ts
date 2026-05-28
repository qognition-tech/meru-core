import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseConfigService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseConfigService.name);
  private _client!: SupabaseClient;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const url = this.configService.get<string>('supabase.url');
    const serviceRoleKey = this.configService.get<string>('supabase.serviceRoleKey');

    if (!url || !serviceRoleKey) {
      this.logger.warn('Supabase URL or Service Role Key not configured. Supabase client will not be initialized.');
      return;
    }

    this._client = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      db: {
        schema: 'public',
      },
    });

    this.logger.log('Supabase client initialized successfully');
  }

  get client(): SupabaseClient {
    if (!this._client) {
      throw new Error('Supabase client not initialized. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
    }
    return this._client;
  }

  get adminClient(): SupabaseClient {
    return this.client;
  }

  async callRpc<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, params);
    if (error) {
      throw error;
    }
    return data as T;
  }

  async query(fn: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.callRpc(fn, params);
  }
}