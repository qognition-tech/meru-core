import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    // Throw rather than `return false`. A guard returning false produces
    // **403 Forbidden**, which tells the client "you are authenticated but not
    // allowed" — so a caller with no token at all was told to stop trying
    // instead of to log in. Every route behind this guard (queue, storage,
    // elasticsearch) answered 403 to anonymous callers.
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        // Same key the JwtModule and JwtStrategy sign/verify with. Reading the
        // raw `JWT_SECRET` env var here worked only because the nested config
        // happens to map to it; if that mapping ever changed, this guard would
        // silently reject every valid token.
        secret: this.configService.get<string>('jwt.secret'),
      });

      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
