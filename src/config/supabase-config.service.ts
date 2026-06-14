import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createClient,
  type PostgrestSingleResponse,
} from '@supabase/supabase-js';

@Injectable()
export class SupabaseConfigService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseConfigService.name);
  private _client!: ReturnType<typeof createClient>;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const url = this.configService.get<string>('supabase.url');
    const serviceRoleKey = this.configService.get<string>(
      'supabase.serviceRoleKey',
    );

    if (!url || !serviceRoleKey) {
      this.logger.warn(
        'Supabase URL or Service Role Key not configured. Supabase client will not be initialized.',
      );
      return;
    }

    this._client = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    this.logger.log('Supabase client initialized successfully');
  }

  get client(): ReturnType<typeof createClient> {
    if (!this._client) {
      throw new Error(
        'Supabase client not initialized. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.',
      );
    }
    return this._client;
  }

  get adminClient(): ReturnType<typeof createClient> {
    return this.client;
  }

  async callRpc<T = unknown>(
    fn: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const rpc = this.client.rpc.bind(this.client) as (
      fn: string,
      params?: Record<string, unknown>,
    ) => Promise<PostgrestSingleResponse<T>>;
    const { data, error } = await rpc(fn, params);
    if (error) {
      throw error;
    }
    return data;
  }

  async query(fn: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.callRpc(fn, params);
  }
}
