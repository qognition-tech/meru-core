import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../../common/types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret') || 'default-secret',
    });
  }

  validate(payload: JwtPayload) {
    // Payload is attached to request.user
    return {
      id: payload.sub,
      email: payload.email,
      tenantId: payload.tenantId,
      roles: payload.roles,
      // The session this token was issued against. Lets `GET /auth/sessions`
      // mark which row is the caller's current device, and is why the session
      // is created before the token is signed. Absent on tokens issued before
      // that change — treated as "unknown", never as a match.
      sessionId: payload.sid,
    };
  }
}
