import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { PrismaClient } from '@prisma/client';

export class Query<T> {
  where?: T;
  sort?: 'asc' | 'desc';
  page?: number;
  offset?: number;
}

export class PrismaRepository extends PrismaClient {
  constructor(private readonly configService: ConfigService) {
    const dbConfig = configService.get<import('@config/env.config').Database>('DATABASE');
    const poolConfig = dbConfig.CONNECTION.POOL;
    
    // Build connection URL with pool parameters
    let connectionUri = dbConfig.CONNECTION.URI;
    
    // Add connection pool parameters to URL if not already present
    if (poolConfig) {
      const separator = connectionUri.includes('?') ? '&' : '?';
      const params: string[] = [];
      
      if (poolConfig.MAX_CONNECTIONS && !connectionUri.includes('connection_limit')) {
        params.push(`connection_limit=${poolConfig.MAX_CONNECTIONS}`);
      }
      if (poolConfig.CONNECTION_TIMEOUT && !connectionUri.includes('connect_timeout')) {
        params.push(`connect_timeout=${Math.floor(poolConfig.CONNECTION_TIMEOUT / 1000)}`);
      }
      if (poolConfig.MIN_CONNECTIONS && !connectionUri.includes('pool_timeout')) {
        // Prisma uses pool_timeout for connection pool management
        params.push('pool_timeout=20');
      }
      
      if (params.length > 0) {
        connectionUri = `${connectionUri}${separator}${params.join('&')}`;
      }
    }
    
    super({
      datasources: {
        db: {
          url: connectionUri,
        },
      },
      log: ['error', 'warn'],
    });
  }

  private readonly logger = new Logger('PrismaRepository');

  public async onModuleInit() {
    await this.$connect();
    const dbConfig = this.configService.get<import('@config/env.config').Database>('DATABASE');
    const poolConfig = dbConfig.CONNECTION.POOL;
    this.logger.info(
      `Repository:Prisma - ON (Pool: max=${poolConfig?.MAX_CONNECTIONS || 'default'}, timeout=${poolConfig?.CONNECTION_TIMEOUT || 'default'}ms)`,
    );
  }

  public async onModuleDestroy() {
    await this.$disconnect();
    this.logger.warn('Repository:Prisma - OFF');
  }
}
