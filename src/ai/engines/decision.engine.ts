import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai.service';
import { PromptCategory } from '../entities/ai-prompt.entity';

/**
 * DecisionEngine — AI-powered decision support engine.
 * Handles case decision recommendations, risk-based adjudication,
 * triage automation, approval routing, and compliance decision logic.
 */
export interface DecisionRequest {
  tenantId: string;
  caseId?: string;
  entityId?: string;
  decisionType: DecisionType;
  context: Record<string, any>;
  evidence?: Array<{
    type: string;
    content: string;
    source: string;
    weight?: number;
  }>;
  policyRules?: string[];
  constraints?: Record<string, any>;
}

export type DecisionType =
  | 'case_adjudication'
  | 'risk_assessment'
  | 'triage'
  | 'approval_routing'
  | 'eligibility'
  | 'compliance_check'
  | 'fraud_detection'
  | 'custom';

export interface DecisionResult {
  decisionId: string;
  recommendation: 'approve' | 'deny' | 'refer' | 'pending_review' | 'escalate';
  confidence: number; // 0-1
  reasoning: string;
  riskScore?: number;
  conditions?: string[];
  requiredActions?: string[];
  alternativeOptions?: Array<{
    option: string;
    risk: string;
    benefit: string;
  }>;
  policyReferences?: string[];
  slaDeadline?: Date;
}

export interface TriageResult {
  triageId: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  assignedTeam?: string;
  routingReason: string;
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  suggestedSLA: number; // hours
  automatableActions: string[];
}

export interface ApprovalDecision {
  approvalId: string;
  autoApproved: boolean;
  requiredApprovers: string[];
  routingPath: Array<{
    level: number;
    approver: string;
    type: 'automatic' | 'manual' | 'conditional';
    condition?: string;
  }>;
  estimatedResolutionTime: number; // hours
}

export interface FraudAssessment {
  fraudScore: number; // 0-100
  flags: Array<{
    type: string;
    description: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
  }>;
  recommendation: 'clear' | 'review' | 'block' | 'investigate';
  patterns: string[];
}

@Injectable()
export class DecisionEngine {
  private readonly logger = new Logger(DecisionEngine.name);

  constructor(private readonly aiService: AiService) {}

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const response = await this.aiService.execute({
      category: 'decision_support' as PromptCategory,
      key: `${request.decisionType}_decision`,
      input: JSON.stringify({
        context: request.context,
        evidence: request.evidence,
      }),
      context: {
        decisionType: request.decisionType,
        policyRules: request.policyRules,
        constraints: request.constraints,
      },
      tenantId: request.tenantId,
    });

    try {
      const parsed = JSON.parse(response.result);
      return {
        decisionId: `dec_${Date.now()}`,
        recommendation: parsed.recommendation || 'pending_review',
        confidence: parsed.confidence || 0,
        reasoning: parsed.reasoning || 'AI-powered decision recommendation',
        riskScore: parsed.riskScore,
        conditions: parsed.conditions,
        requiredActions: parsed.requiredActions,
        alternativeOptions: parsed.alternativeOptions,
        policyReferences: parsed.policyReferences,
      };
    } catch {
      return {
        decisionId: `dec_${Date.now()}`,
        recommendation: 'refer',
        confidence: 0,
        reasoning: response.result,
      };
    }
  }

  async triageCase(
    tenantId: string,
    caseId: string,
    caseData: Record<string, any>,
  ): Promise<TriageResult> {
    const response = await this.aiService.execute({
      category: 'decision_support' as PromptCategory,
      key: 'case_triage',
      input: JSON.stringify({ caseId, caseData }),
      tenantId,
    });

    try {
      const parsed = JSON.parse(response.result);
      return {
        triageId: `triage_${Date.now()}`,
        priority: parsed.priority || 'medium',
        category: parsed.category || 'general',
        assignedTeam: parsed.assignedTeam,
        routingReason: parsed.routingReason || 'AI-based triage routing',
        estimatedComplexity: parsed.estimatedComplexity || 'moderate',
        suggestedSLA: parsed.suggestedSLA || 48,
        automatableActions: parsed.automatableActions || [],
      };
    } catch {
      return {
        triageId: `triage_${Date.now()}`,
        priority: 'medium',
        category: 'general',
        routingReason: 'Default AI triage routing',
        estimatedComplexity: 'moderate',
        suggestedSLA: 48,
        automatableActions: [],
      };
    }
  }

  async determineApprovalPath(
    tenantId: string,
    request: {
      entityType: string;
      decisionContext: Record<string, any>;
      riskLevel: string;
      amount?: number;
    },
  ): Promise<ApprovalDecision> {
    const response = await this.aiService.execute({
      category: 'decision_support' as PromptCategory,
      key: 'approval_routing',
      input: JSON.stringify(request),
      tenantId,
    });

    try {
      const parsed = JSON.parse(response.result);
      return {
        approvalId: `appr_${Date.now()}`,
        autoApproved: parsed.autoApproved || false,
        requiredApprovers: parsed.requiredApprovers || [],
        routingPath: parsed.routingPath || [
          { level: 1, approver: 'supervisor', type: 'manual' },
        ],
        estimatedResolutionTime: parsed.estimatedResolutionTime || 24,
      };
    } catch {
      return {
        approvalId: `appr_${Date.now()}`,
        autoApproved: request.riskLevel === 'low',
        requiredApprovers: ['supervisor'],
        routingPath: [{ level: 1, approver: 'supervisor', type: 'manual' }],
        estimatedResolutionTime: 24,
      };
    }
  }

  async detectFraud(
    tenantId: string,
    entityId: string,
    transactionData: Record<string, any>,
  ): Promise<FraudAssessment> {
    const response = await this.aiService.execute({
      category: 'decision_support' as PromptCategory,
      key: 'fraud_detection',
      input: JSON.stringify({ entityId, transactionData }),
      tenantId,
    });

    try {
      const parsed = JSON.parse(response.result);
      return {
        fraudScore: parsed.fraudScore || 0,
        flags: parsed.flags || [],
        recommendation: parsed.recommendation || 'clear',
        patterns: parsed.patterns || [],
      };
    } catch {
      return {
        fraudScore: 0,
        flags: [],
        recommendation: 'review',
        patterns: [],
      };
    }
  }

  async evaluateEligibility(
    tenantId: string,
    entityId: string,
    criteria: Record<string, any>,
  ): Promise<{
    eligible: boolean;
    score: number;
    passedCriteria: string[];
    failedCriteria: string[];
    recommendations: string[];
  }> {
    const response = await this.aiService.execute({
      category: 'decision_support' as PromptCategory,
      key: 'eligibility_check',
      input: JSON.stringify({ entityId, criteria }),
      tenantId,
    });

    try {
      return JSON.parse(response.result);
    } catch {
      return {
        eligible: false,
        score: 0,
        passedCriteria: [],
        failedCriteria: ['Unable to evaluate automatically'],
        recommendations: ['Manual verification required'],
      };
    }
  }

  async generateDecisionRationale(
    tenantId: string,
    decision: DecisionResult,
    format: 'summary' | 'detailed' | 'legal' = 'detailed',
  ): Promise<string> {
    const response = await this.aiService.execute({
      category: 'decision_support' as PromptCategory,
      key: 'decision_rationale',
      input: JSON.stringify({ decision, format }),
      tenantId,
    });

    return response.result;
  }

  async batchDecisions(
    tenantId: string,
    decisions: DecisionRequest[],
  ): Promise<DecisionResult[]> {
    const results: DecisionResult[] = [];

    for (const request of decisions) {
      const result = await this.decide(request);
      results.push(result);

      // If auto-approve or auto-deny with high confidence, trigger workflow action
      if (result.recommendation === 'approve' && result.confidence >= 0.95) {
        await this.handleAutoDecision(tenantId, request, result);
      }
    }

    return results;
  }

  private async handleAutoDecision(
    tenantId: string,
    request: DecisionRequest,
    result: DecisionResult,
  ): Promise<void> {
    try {
      this.logger.log(
        `Auto-${result.recommendation} for case ${request.caseId} with confidence ${result.confidence}`,
      );

      // Trigger workflow status update
      // Log auto-decision for downstream workflow processing
      if (request.caseId) {
        this.logger.log(
          `Queueing workflow update for case ${request.caseId}: ${result.recommendation}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Auto-decision workflow update failed: ${error.message}`,
      );
    }
  }
}
