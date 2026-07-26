import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  ApiResponse,
  MeruErrorCode,
  MeruError,
  ValidationErrorDetail,
} from '../../common/types';

/**
 * Global exception filter that enforces the Meru API Response Envelope.
 * All responses follow: { data: null, meta: { requestId, timestamp, version }, error: { code, message, details? } }
 *
 * Maps HTTP exceptions to Meru error codes per DESIGN_GUIDELINES.md:
 *   400 → MER-VAL-0001 (Validation)
 *   401 → MER-AUTH-0001 (Invalid Credentials) or MER-AUTH-0003 (Invalid Token)
 *   403 → MER-AUTH-0008 (Forbidden)
 *   404 → MER-RES-0001 (Not Found)
 *   409 → MER-RES-0002 (Already Exists)
 *   429 → MER-RATE-0001 (Rate Limit)
 *   5xx → MER-SRV-0001 (Internal Server)
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /** Maps HTTP status codes to Meru error codes */
  private mapStatusToErrorCode(
    status: number,
    exception: HttpException | null,
  ): MeruErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return MeruErrorCode.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        // Distinguish expired vs invalid based on exception message
        const msg = exception?.message?.toLowerCase() || '';
        return msg.includes('expired')
          ? MeruErrorCode.AUTH_TOKEN_EXPIRED
          : MeruErrorCode.AUTH_INVALID_CREDENTIALS;
      case HttpStatus.FORBIDDEN:
        return MeruErrorCode.AUTH_FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return MeruErrorCode.RESOURCE_NOT_FOUND;
      case HttpStatus.CONFLICT:
        return MeruErrorCode.RESOURCE_ALREADY_EXISTS;
      case HttpStatus.TOO_MANY_REQUESTS:
        return MeruErrorCode.RATE_LIMIT_EXCEEDED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return MeruErrorCode.SERVER_UNAVAILABLE;
      case HttpStatus.GATEWAY_TIMEOUT:
        return MeruErrorCode.SERVER_TIMEOUT;
      default:
        return status >= 500
          ? MeruErrorCode.SERVER_INTERNAL
          : MeruErrorCode.SERVER_INTERNAL;
    }
  }

  /** Extracts validation details from class-validator errors */
  private extractValidationDetails(
    exceptionResponse: any,
  ): ValidationErrorDetail[] | undefined {
    if (Array.isArray(exceptionResponse?.message)) {
      return exceptionResponse.message.map((msg: string) => {
        // Parse class-validator format: "field - constraint message"
        const match = msg.match(/^(\w+)\s*[-:]\s*(.+)$/);
        return {
          field: match?.[1] || 'unknown',
          message: match?.[2] || msg,
          code: 'VALIDATION',
        };
      });
    }
    return undefined;
  }

  /** Builds a MeruError from exception */
  private buildError(exception: unknown, status: number): MeruError {
    const httpException = exception instanceof HttpException ? exception : null;
    const code = this.mapStatusToErrorCode(status, httpException);

    let message = 'An unexpected error occurred';
    let details: ValidationErrorDetail[] | undefined;

    if (httpException) {
      const response = httpException.getResponse();
      if (typeof response === 'string') {
        message = response;
      } else if (typeof response === 'object' && response !== null) {
        message = (response as any).message || message;
        // Handle nested message arrays
        if (Array.isArray(message)) {
          message = message.join('; ');
        }
        details = this.extractValidationDetails(response);
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    return {
      code,
      message,
      ...(details && { details }),
      helpUrl: `https://docs.meru.dev/errors#${code.toLowerCase().replace(/-/g, '')}`,
    };
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const meruError = this.buildError(exception, status);
    const requestId = (request.headers['x-request-id'] as string) || randomUUID();

    // Structured Logging with Meru error code
    this.logger.error(
      `[${meruError.code}] ${request.method} ${request.url}`,
      JSON.stringify({
        requestId,
        status,
        errorCode: meruError.code,
        message: meruError.message,
        timestamp: new Date().toISOString(),
        path: request.url,
        method: request.method,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        ...(meruError.details && { details: meruError.details }),
      }),
    );

    const envelope: ApiResponse = {
      data: null,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
        version: 'v1',
      },
      error: meruError,
    };

    response.status(status).json(envelope);
  }
}
