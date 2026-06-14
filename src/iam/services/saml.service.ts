import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { Tenant } from '../entities/tenant.entity';
import { User, UserStatus, AuthProvider } from '../entities/user.entity';
import { v4 as uuidv4 } from 'uuid';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SamlAuthnRequestResult {
  redirectUrl: string;
  requestId: string;
  relayState: string;
}

export interface SamlUserAttributes {
  nameId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  groups?: string[];
}

export interface SamlLoginResult {
  access_token: string;
  refresh_token?: string;
  user: Partial<User>;
  tenant: Partial<Tenant>;
}

// In-memory SAML request store (production: use Redis with TTL)
// requestId → { tenantId, nonce, issuedAt }
const pendingRequests = new Map<
  string,
  { tenantId: string; issuedAt: Date }
>();

// ── SamlService ────────────────────────────────────────────────────────────

@Injectable()
export class SamlService {
  private readonly logger = new Logger(SamlService.name);
  private readonly spIssuer: string;
  private readonly callbackUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {
    this.spIssuer =
      configService.get<string>('SAML_SP_ISSUER') ?? 'https://api.meru.com';
    this.callbackUrl =
      configService.get<string>('SAML_CALLBACK_URL') ??
      'https://api.meru.com/api/v1/auth/saml/callback';
  }

  // ── SP-initiated SSO: generate AuthnRequest redirect URL ─────────────────

  async initiateLogin(tenantSlug: string): Promise<SamlAuthnRequestResult> {
    const tenant = await this.tenantRepo.findOne({ where: { slug: tenantSlug } });
    if (!tenant) throw new BadRequestException(`Tenant not found: ${tenantSlug}`);

    const cfg = tenant.ssoConfig;
    if (cfg?.provider !== 'saml' || !cfg.entryPoint) {
      throw new BadRequestException(
        `Tenant ${tenantSlug} does not have SAML SSO configured`,
      );
    }

    const requestId = `_${uuidv4().replace(/-/g, '')}`;
    const relayState = uuidv4();
    const issueInstant = new Date().toISOString();

    pendingRequests.set(requestId, { tenantId: tenant.id, issuedAt: new Date() });

    // Clean up requests older than 10 minutes
    this.purgeStalePendingRequests();

    const authnRequestXml = this.buildAuthnRequestXml(
      requestId,
      issueInstant,
      cfg.entryPoint,
    );

    const encoded = this.deflateAndBase64(authnRequestXml);
    const params = new URLSearchParams({
      SAMLRequest: encoded,
      RelayState: relayState,
    });

    const redirectUrl = `${cfg.entryPoint}?${params.toString()}`;

    this.logger.log(
      `SAML AuthnRequest generated for tenant ${tenantSlug} (requestId=${requestId})`,
    );

    return { redirectUrl, requestId, relayState };
  }

  // ── IdP callback: validate SAMLResponse and issue JWT ────────────────────

  async handleCallback(
    samlResponseB64: string,
    relayState: string,
  ): Promise<SamlLoginResult> {
    const xml = Buffer.from(samlResponseB64, 'base64').toString('utf8');

    const inResponseTo = this.extractXmlValue(xml, 'InResponseTo') ?? '';
    const pending = pendingRequests.get(inResponseTo);

    if (!pending) {
      throw new UnauthorizedException(
        'SAML response does not match a pending request or has expired',
      );
    }

    pendingRequests.delete(inResponseTo);

    const tenant = await this.tenantRepo.findOne({
      where: { id: pending.tenantId },
    });
    if (!tenant) throw new UnauthorizedException('Tenant not found');

    // Verify status code
    const statusCode =
      this.extractXmlValue(xml, 'StatusCode') ?? '';
    if (!statusCode.includes('Success')) {
      const statusMessage =
        this.extractXmlValue(xml, 'StatusMessage') ?? 'Authentication failed';
      throw new UnauthorizedException(`SAML authentication failed: ${statusMessage}`);
    }

    // Verify signature if tenant has a certificate configured
    if (tenant.ssoConfig?.cert) {
      this.verifySignature(xml, tenant.ssoConfig.cert);
    } else {
      this.logger.warn(
        `SAML signature not verified for tenant ${tenant.id} — no cert configured`,
      );
    }

    // Verify audience / issuer
    const audience = this.extractXmlValue(xml, 'Audience');
    if (audience && audience !== this.spIssuer && audience !== this.callbackUrl) {
      throw new UnauthorizedException(
        `SAML audience mismatch: expected ${this.spIssuer}, got ${audience}`,
      );
    }

    // Check assertion validity window
    const notBefore = this.extractXmlAttribute(xml, 'NotBefore');
    const notOnOrAfter = this.extractXmlAttribute(xml, 'NotOnOrAfter');
    const now = new Date();

    if (notBefore && new Date(notBefore) > now) {
      throw new UnauthorizedException('SAML assertion not yet valid (NotBefore)');
    }
    if (notOnOrAfter && new Date(notOnOrAfter) <= now) {
      throw new UnauthorizedException('SAML assertion has expired (NotOnOrAfter)');
    }

    // Extract user attributes
    const attributes = this.extractUserAttributes(xml);
    if (!attributes.email) {
      throw new UnauthorizedException(
        'SAML response missing email attribute — cannot identify user',
      );
    }

    // Find or provision user
    const user = await this.findOrProvisionSamlUser(attributes, tenant);

    const jwtPayload = {
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: [],
    };

    const accessToken = this.jwtService.sign(jwtPayload);

    this.logger.log(
      `SAML login successful: ${user.email} (tenant=${tenant.slug})`,
    );

    return {
      access_token: accessToken,
      user: { id: user.id, email: user.email, tenantId: user.tenantId },
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    };
  }

  // ── User provisioning ─────────────────────────────────────────────────────

  private async findOrProvisionSamlUser(
    attributes: SamlUserAttributes,
    tenant: Tenant,
  ): Promise<User> {
    const existing = await this.userRepo.findOne({
      where: { email: attributes.email, tenantId: tenant.id },
    });

    if (existing) {
      if (existing.provider !== AuthProvider.SAML) {
        throw new UnauthorizedException(
          `User ${attributes.email} exists with a different auth provider`,
        );
      }
      return existing;
    }

    // Just-in-time provisioning
    const newUser = this.userRepo.create({
      id: uuidv4(),
      email: attributes.email,
      tenantId: tenant.id,
      provider: AuthProvider.SAML,
      status: UserStatus.ACTIVE,
      firstName: attributes.firstName ?? '',
      lastName: attributes.lastName ?? '',
      attributes: { displayName: attributes.displayName ?? attributes.email },
      password: crypto.randomBytes(32).toString('hex'), // unusable random password
    });

    const saved = await this.userRepo.save(newUser);
    this.logger.log(`JIT-provisioned SAML user: ${saved.email}`);
    return saved;
  }

  // ── XML helpers ────────────────────────────────────────────────────────────

  private buildAuthnRequestXml(
    requestId: string,
    issueInstant: string,
    destination: string,
  ): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<samlp:AuthnRequest ` +
      `xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
      `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="${requestId}" ` +
      `Version="2.0" ` +
      `IssueInstant="${issueInstant}" ` +
      `Destination="${this.escapeXml(destination)}" ` +
      `AssertionConsumerServiceURL="${this.escapeXml(this.callbackUrl)}" ` +
      `ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">` +
      `<saml:Issuer>${this.escapeXml(this.spIssuer)}</saml:Issuer>` +
      `<samlp:NameIDPolicy ` +
      `Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" ` +
      `AllowCreate="true"/>` +
      `</samlp:AuthnRequest>`
    );
  }

  private extractUserAttributes(xml: string): SamlUserAttributes {
    const nameId =
      this.extractXmlValue(xml, 'saml:NameID') ??
      this.extractXmlValue(xml, 'NameID') ??
      '';

    const email =
      this.extractAttributeValue(xml, 'email') ??
      this.extractAttributeValue(xml, 'mail') ??
      this.extractAttributeValue(xml, 'emailAddress') ??
      (nameId.includes('@') ? nameId : '');

    const firstName =
      this.extractAttributeValue(xml, 'firstName') ??
      this.extractAttributeValue(xml, 'givenName') ??
      this.extractAttributeValue(xml, 'given_name');

    const lastName =
      this.extractAttributeValue(xml, 'lastName') ??
      this.extractAttributeValue(xml, 'sn') ??
      this.extractAttributeValue(xml, 'surname') ??
      this.extractAttributeValue(xml, 'family_name');

    const displayName =
      this.extractAttributeValue(xml, 'displayName') ??
      this.extractAttributeValue(xml, 'cn');

    return { nameId, email, firstName, lastName, displayName };
  }

  private extractXmlValue(xml: string, tag: string): string | undefined {
    const patterns = [
      new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i'),
      new RegExp(`<[^:]+:${tag}[^>]*>([^<]*)<\/[^:]+:${tag}>`, 'i'),
    ];
    for (const re of patterns) {
      const m = xml.match(re);
      if (m?.[1]) return m[1].trim();
    }
    return undefined;
  }

  private extractXmlAttribute(xml: string, attr: string): string | undefined {
    const re = new RegExp(`${attr}="([^"]+)"`, 'i');
    return xml.match(re)?.[1];
  }

  private extractAttributeValue(xml: string, name: string): string | undefined {
    // Matches: <saml:Attribute Name="email"><saml:AttributeValue>val</saml:AttributeValue>
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `Name="${escapedName}"[^>]*>[\\s\\S]*?<[^:>]+:?AttributeValue[^>]*>([^<]+)<`,
      'i',
    );
    return xml.match(re)?.[1]?.trim();
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Crypto helpers ────────────────────────────────────────────────────────

  private deflateAndBase64(xml: string): string {
    const deflated = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));
    return deflated.toString('base64');
  }

  private verifySignature(xml: string, certPem: string): void {
    // Extract the SignatureValue from the XML
    const sigValueMatch = xml.match(
      /<(?:[^:]+:)?SignatureValue[^>]*>([\s\S]+?)<\/(?:[^:]+:)?SignatureValue>/i,
    );
    if (!sigValueMatch) {
      throw new UnauthorizedException('SAML response missing signature');
    }

    // Extract SignedInfo (the canonical data that was signed)
    const signedInfoMatch = xml.match(
      /(<(?:[^:]+:)?SignedInfo[\s\S]+?<\/(?:[^:]+:)?SignedInfo>)/i,
    );
    if (!signedInfoMatch) {
      throw new UnauthorizedException('SAML response missing SignedInfo');
    }

    const signatureValue = sigValueMatch[1].replace(/\s/g, '');
    const signedInfo = signedInfoMatch[1];

    // Normalise the cert
    const certBody = certPem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');
    const normalizedCert = `-----BEGIN CERTIFICATE-----\n${certBody}\n-----END CERTIFICATE-----`;

    try {
      const verify = crypto.createVerify('RSA-SHA256');
      verify.update(signedInfo, 'utf8');
      const valid = verify.verify(normalizedCert, signatureValue, 'base64');

      if (!valid) {
        throw new UnauthorizedException('SAML signature verification failed');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException(
        `SAML signature error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  private purgeStalePendingRequests(): void {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes
    for (const [id, req] of pendingRequests) {
      if (req.issuedAt < cutoff) pendingRequests.delete(id);
    }
  }
}
