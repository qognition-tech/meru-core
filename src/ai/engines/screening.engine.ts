import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai.service';
import { PromptCategory } from '../entities/ai-prompt.entity';
import { CrmService } from '../../crm/crm.service';

/**
 * ScreeningEngine — AI-powered entity screening engine.
 * Handles background checks, sanctions screening, adverse media checks,
 * PEP screening, compliance verification, and risk scoring.
 */
export interface ScreeningRequest {
  tenantId: string;
  entityId?: string;
  entityName: string;
  entityType: 'individual' | 'organization' | 'vessel' | 'transaction';
  screeningTypes: ScreeningType[];
  metadata?: Record<string, any>;
  identities?: Array<{
    field: string;
    value: string;
    type: 'name' | 'alias' | 'document' | 'address' | 'date_of_birth' | 'nationality';
  }>;
}

export type ScreeningType =
  | 'sanctions'
  | 'pep'
  | 'adverse_media'
  | 'watchlist'
  | 'criminal'
  | 'financial'
  | 'identity_verification'
  | 'document_verification'
  | 'custom';

export interface ScreeningResult {
  screeningId: string;
  entityId?: string;
  status: 'clear' | 'hit' | 'review_required' | 'escalated' | 'error';
  riskScore: number; // 0-100
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  hits: ScreeningHit[];
  summary: string;
  recommendation?: string;
  completedAt?: Date;
}

export interface ScreeningHit {
  type: ScreeningType;
  source: string;
  matchName: string;
  matchScore: number; // 0-1
  details: string;
  severity: 'info' | 'warning' | 'alert';
  timestamp?: Date;
}

export interface EnhancedDueDiligenceRequest {
  tenantId: string;
  entityId: string;
  riskScore: number;
  triggerReason: string;
}

export interface RiskAssessment {
  entityId: string;
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  riskScore: number;
  riskFactors: Array<{
    factor: string;
    score: number;
    explanation: string;
  }>;
  mitigations: string[];
  requiresEDD: boolean;
}

@Injectable()
export class ScreeningEngine {
  private readonly logger = new Logger(ScreeningEngine.name);

  // Known risk indicators
  private readonly HIGH_RISK_COUNTRIES = [
    'IR', 'KP', 'SY', 'CU', 'VE', 'MM',
  ];

  constructor(
    private readonly aiService: AiService,
    private readonly crmService: CrmService,
  ) {}

  async screen(request: ScreeningRequest): Promise<ScreeningResult> {
    const result: ScreeningResult = {
      screeningId: `scr_${Date.now()}`,
      entityId: request.entityId,
      status: 'clear',
      riskScore: 0,
      riskLevel: 'low',
      hits: [],
      summary: '',
    };

    const hitResults: ScreeningHit[] = [];

    for (const screeningType of request.screeningTypes) {
      try {
        const response = await this.aiService.execute({
          category: 'compliance_analysis' as PromptCategory,
          key: `${screeningType}_screening`,
          input: JSON.stringify({
            entityName: request.entityName,
            entityType: request.entityType,
            identities: request.identities,
          }),
          context: {
            screeningType,
            metadata: request.metadata,
          },
          tenantId: request.tenantId,
        });

        try {
          const parsed = JSON.parse(response.result);
          if (parsed.hits && parsed.hits.length > 0) {
            hitResults.push(...parsed.hits.map((h: any) => ({
              type: screeningType,
              source: h.source || 'AI_Screening',
              matchName: h.matchName,
              matchScore: h.matchScore || 0.5,
              details: h.details || '',
              severity: h.severity || 'warning',
            })));
          }
        } catch {
          this.logger.warn(`Failed to parse screening response for ${screeningType}`);
        }
      } catch (error: any) {
        this.logger.error(`Screening ${screeningType} failed: ${error.message}`);
      }
    }

    result.hits = hitResults;
    result.riskScore = this.calculateRiskScore(hitResults, request);
    result.riskLevel = this.mapRiskLevel(result.riskScore);
    result.status = hitResults.length > 0 ? 'review_required' : 'clear';
    result.completedAt = new Date();

    // Generate summary
    result.summary = await this.generateScreeningSummary(result, request.tenantId);

    // Escalate if critical
    if (result.riskLevel === 'critical') {
      result.status = 'escalated';
      result.recommendation = 'IMMEDIATE REVIEW REQUIRED';
    }

    return result;
  }

  async performBatchScreening(
    tenantId: string,
    entities: Array<{ entityId: string; entityName: string; entityType: 'individual' | 'organization' }>,
    screeningTypes: ScreeningType[] = ['sanctions', 'pep', 'adverse_media', 'watchlist'],
  ): Promise<ScreeningResult[]> {
    const results: ScreeningResult[] = [];

    for (const entity of entities) {
      const result = await this.screen({
        tenantId,
        entityId: entity.entityId,
        entityName: entity.entityName,
        entityType: entity.entityType,
        screeningTypes,
      });
      results.push(result);
    }

    return results;
  }

  async enhancedDueDiligence(
    request: EnhancedDueDiligenceRequest,
  ): Promise<{
    eddId: string;
    findings: Array<{
      area: string;
      finding: string;
      riskImplication: string;
      recommendation: string;
    }>;
    overallAssessment: string;
    enhancedMonitoringRequired: boolean;
  }> {
    const response = await this.aiService.execute({
      category: 'compliance_analysis' as PromptCategory,
      key: 'enhanced_due_diligence',
      input: JSON.stringify(request),
      tenantId: request.tenantId,
    });

    try {
      return JSON.parse(response.result);
    } catch {
      return {
        eddId: `edd_${Date.now()}`,
        findings: [],
        overallAssessment: 'Manual review required',
        enhancedMonitoringRequired: true,
      };
    }
  }

  async assessRisk(
    tenantId: string,
    entityId: string,
  ): Promise<RiskAssessment> {
    // Get entity data from CRM
    let entityData: any = {};
    try {
      entityData = await this.crmService.findEntityById(entityId);
    } catch {
      this.logger.warn(`Entity ${entityId} not found in CRM`);
    }

    const response = await this.aiService.execute({
      category: 'compliance_analysis' as PromptCategory,
      key: 'risk_assessment',
      input: JSON.stringify({
        entityId,
        entityData,
      }),
      tenantId,
    });

    try {
      const parsed = JSON.parse(response.result);
      return {
        entityId,
        overallRisk: parsed.overallRisk || 'medium',
        riskScore: parsed.riskScore || 50,
        riskFactors: parsed.riskFactors || [],
        mitigations: parsed.mitigations || [],
        requiresEDD: parsed.requiresEDD || false,
      };
    } catch {
      return {
        entityId,
        overallRisk: 'medium',
        riskScore: 50,
        riskFactors: [],
        mitigations: [],
        requiresEDD: false,
      };
    }
  }

  async verifyDocument(
    tenantId: string,
    documentType: string,
    documentData: Record<string, any>,
  ): Promise<{
    isAuthentic: boolean;
    confidence: number;
    issues: string[];
    verificationNotes: string;
  }> {
    const response = await this.aiService.execute({
      category: 'compliance_analysis' as PromptCategory,
      key: 'document_verification',
      input: JSON.stringify({ documentType, documentData }),
      tenantId,
    });

    try {
      return JSON.parse(response.result);
    } catch {
      return {
        isAuthentic: false,
        confidence: 0,
        issues: ['Unable to verify document'],
        verificationNotes: response.result,
      };
    }
  }

  async continuousMonitoring(
    tenantId: string,
    entityId: string,
  ): Promise<{
    status: 'clear' | 'alert' | 'monitor';
    lastCheck: Date;
    alerts: Array<{ type: string; description: string; severity: string }>;
  }> {
    const response = await this.aiService.execute({
      category: 'compliance_analysis' as PromptCategory,
      key: 'continuous_monitoring',
      input: JSON.stringify({ entityId }),
      tenantId,
    });

    try {
      const parsed = JSON.parse(response.result);
      return {
        status: parsed.status || 'clear',
        lastCheck: new Date(),
        alerts: parsed.alerts || [],
      };
    } catch {
      return {
        status: 'monitor',
        lastCheck: new Date(),
        alerts: [],
      };
    }
  }

  // ==================== PRIVATE HELPERS ====================

  private calculateRiskScore(hits: ScreeningHit[], request: ScreeningRequest): number {
    let score = 0;

    // Base score from hits
    for (const hit of hits) {
      score += hit.matchScore * 30;

      if (hit.severity === 'alert') score += 20;
      else if (hit.severity === 'warning') score += 10;
    }

    // Penalty for high risk countries
    if (request.identities) {
      const nationality = request.identities.find(i => i.type === 'nationality');
      if (nationality && this.HIGH_RISK_COUNTRIES.includes(nationality.value)) {
        score += 15;
      }
    }

    return Math.min(100, Math.max(0, score));
  }

  private mapRiskLevel(score: number): ScreeningResult['riskLevel'] {
    if (score >= 75) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 25) return 'medium';
    return 'low';
  }

  private async generateScreeningSummary(
    result: ScreeningResult,
    tenantId: string,
  ): Promise<string> {
    if (result.hits.length === 0) {
      return 'No adverse findings detected across all screening types. Entity appears to be low risk.';
    }

    try {
      const response = await this.aiService.execute({
        category: 'compliance_analysis' as PromptCategory,
        key: 'screening_summary',
        input: JSON.stringify({ hits: result.hits, riskScore: result.riskScore }),
        tenantId,
      });

      return response.result;
    } catch {
      const severity = result.hits.filter(h => h.severity === 'alert').length;
      const warnings = result.hits.filter(h => h.severity === 'warning').length;
      return `${result.hits.length} hits found: ${severity} alerts, ${warnings} warnings. Risk Score: ${result.riskScore}/100.`;
    }
  }
}