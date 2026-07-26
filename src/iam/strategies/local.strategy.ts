import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { IamService } from '../iam.service';
import { UserPayload } from '../../common/types';

/**
 * Passport "local" strategy used by `POST /auth/login`.
 *
 * Reads `email` + `password` from the request body (instead of the default
 * `username` field), delegates credential checking to IamService.validateUser,
 * and attaches the resulting UserPayload to `req.user` for the controller.
 */
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private iamService: IamService) {
    super({ usernameField: 'email', passwordField: 'password' });
  }

  async validate(email: string, password: string): Promise<UserPayload> {
    const user = await this.iamService.validateUser(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return user;
  }
}
