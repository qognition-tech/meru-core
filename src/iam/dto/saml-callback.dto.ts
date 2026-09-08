import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body the IdP POSTs back after SAML authentication.
 *
 * The handler read `@Body('SAMLResponse')` with no DTO, so a request without
 * it passed `undefined` into the base64 decoder and crashed with
 * `The first argument must be of type string or an instance of Buffer…` — a
 * 500 on an unauthenticated, internet-facing endpoint, which is both a bad
 * error and free noise for anyone probing it.
 */
export class SamlCallbackDto {
  @ApiProperty({ description: 'Base64-encoded SAMLResponse from the IdP.' })
  @IsString()
  @MinLength(1)
  // SAML assertions are large but not unbounded; a cap keeps a hostile POST
  // from turning into an expensive parse.
  @MaxLength(1_000_000)
  SAMLResponse: string;

  @ApiPropertyOptional({ description: 'Opaque state echoed back by the IdP.' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  RelayState?: string;
}
