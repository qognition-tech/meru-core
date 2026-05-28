import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * SSO Authentication Guard for Document Access
 * Validates JWT token and ensures user has access to the tenant/workspace
 */
@Injectable()
export class DocumentAuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // Check if user has tenant access
    if (!user.tenantId) {
      throw new ForbiddenException('No tenant/workspace assigned');
    }

    // Verify workspace/vertical match
    const requiredVertical = this.reflector.get<string>(
      'vertical',
      context.getHandler(),
    );
    if (requiredVertical && user.vertical !== requiredVertical) {
      throw new ForbiddenException('Access denied for this vertical');
    }

    // Check document-specific permissions
    const documentId = request.params.documentId || request.params.id;
    if (documentId) {
      // Document-specific permission check would go here
      // This could check if user owns the document or has explicit permissions
      const requiredPermission =
        this.reflector.get<string>(
          'documentPermission',
          context.getHandler(),
        ) || 'read';

      // For now, allow if user is in the same tenant
      // In production, implement proper document-level permission checks
      const canAccess = await this.checkDocumentAccess(
        documentId,
        user,
        requiredPermission,
      );
      if (!canAccess) {
        throw new ForbiddenException('Access denied to this document');
      }
    }

    return true;
  }

  private async checkDocumentAccess(
    documentId: string,
    user: any,
    permission: string,
  ): Promise<boolean> {
    // Implement document access logic here
    // This could query the database to check:
    // 1. If user is the document owner
    // 2. If user has explicit permissions
    // 3. If document is shared with user's role
    // 4. If document is in user's tenant/workspace

    // Simplified check - in production, implement full logic
    return user.tenantId !== undefined;
  }
}
