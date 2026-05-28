import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { OpenAI } from 'openai';

// ── Types ─────────────────────────────────────────────────────────────────

export type DocumentKind =
  | 'passport'
  | 'national_id'
  | 'payslip'
  | 'bank_statement'
  | 'employment_contract'
  | 'skills_assessment'
  | 'trade_invoice'
  | 'bill_of_lading'
  | 'police_clearance'
  | 'health_assessment'
  | 'unknown';

export interface DocIntelRequest {
  tenantId: string;
  documentId: string;
  kind: DocumentKind;
  fileBuffer?: Buffer;
  base64Image?: string;
  fileUrl?: string;
  mimeType: string;
}

export interface ExtractedField {
  key: string;
  value: string | null;
  confidence: number;
}

export interface FraudSignal {
  type: 'exif_anomaly' | 'font_inconsistency' | 'duplicate_document' | 'metadata_mismatch' | 'ai_confidence_low';
  severity: 'low' | 'medium' | 'high';
  details: string;
}

export interface DocIntelResult {
  documentId: string;
  kind: DocumentKind;
  extractedFields: ExtractedField[];
  rawText?: string;
  fraudSignals: FraudSignal[];
  overallConfidence: number;
  fraudRisk: 'none' | 'low' | 'medium' | 'high';
  contentHash: string;
  processedAt: Date;
  modelUsed: string;
}

// ── Field specs per kind ──────────────────────────────────────────────────

const EXTRACTION_SPECS: Record<DocumentKind, string[]> = {
  passport: ['passportNumber', 'firstName', 'lastName', 'dateOfBirth', 'nationality', 'issueDate', 'expiryDate', 'placeOfBirth', 'sex', 'mrz1', 'mrz2'],
  national_id: ['idNumber', 'firstName', 'lastName', 'dateOfBirth', 'nationality', 'issueDate', 'expiryDate', 'address'],
  payslip: ['employeeName', 'employerId', 'periodStart', 'periodEnd', 'grossPay', 'netPay', 'taxWithheld', 'currency'],
  bank_statement: ['accountName', 'accountNumber', 'bsb', 'institution', 'statementPeriod', 'openingBalance', 'closingBalance', 'currency'],
  employment_contract: ['employerName', 'employerAbn', 'employeeName', 'positionTitle', 'anzscoCode', 'startDate', 'salary', 'employmentType'],
  skills_assessment: ['assessingBody', 'applicantName', 'occupation', 'anzscoCode', 'assessmentDate', 'outcome', 'referenceNumber'],
  trade_invoice: ['invoiceNumber', 'seller', 'buyer', 'invoiceDate', 'goods', 'hsCode', 'value', 'currency', 'shipmentOrigin', 'shipmentDestination', 'incoterms'],
  bill_of_lading: ['blNumber', 'vesselName', 'voyageNumber', 'portOfLoading', 'portOfDischarge', 'shipper', 'consignee', 'cargoDescription', 'containerNumbers', 'shipmentDate'],
  police_clearance: ['issueCountry', 'issueDate', 'applicantName', 'dateOfBirth', 'referenceNumber', 'outcome', 'issuingAuthority'],
  health_assessment: ['hapId', 'applicantName', 'examDate', 'outcome', 'conditions', 'examinationCenter'],
  unknown: ['text'],
};

// ── DocIntelEngine ─────────────────────────────────────────────────────────

@Injectable()
export class DocIntelEngine {
  private readonly logger = new Logger(DocIntelEngine.name);
  private readonly openai: OpenAI | null;

  // SHA-256 hashes only — no document content stored in memory.
  // Production: persist to Redis or a dedicated table for cross-session dedup.
  private readonly seenHashes = new Set<string>();

  constructor(private readonly configService: ConfigService) {
    const apiKey = configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async process(request: DocIntelRequest): Promise<DocIntelResult> {
    const startMs = Date.now();
    const fraudSignals: FraudSignal[] = [];

    // 1. Content hash — privacy-preserved duplicate detection
    const contentHash = this.hashContent(request);
    if (this.seenHashes.has(contentHash)) {
      fraudSignals.push({
        type: 'duplicate_document',
        severity: 'high',
        details: 'Identical document content previously submitted (cross-tenant duplicate detected)',
      });
    }
    this.seenHashes.add(contentHash);

    // 2. EXIF / format checks
    fraudSignals.push(...this.checkExifAnomalies(request));

    // 3. AI extraction
    let extractedFields: ExtractedField[] = [];
    let rawText = '';
    let overallConfidence = 0;
    let modelUsed = 'stub';

    if (this.openai && (request.base64Image || request.fileUrl)) {
      try {
        const result = await this.extractWithVision(request);
        extractedFields = result.fields;
        rawText = result.rawText;
        overallConfidence = result.confidence;
        modelUsed = result.model;

        if (overallConfidence < 0.5) {
          fraudSignals.push({
            type: 'ai_confidence_low',
            severity: 'medium',
            details: `AI confidence ${(overallConfidence * 100).toFixed(0)}% — document may be illegible or tampered`,
          });
        }

        fraudSignals.push(...this.checkFieldConsistency(extractedFields, request.kind));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Vision extraction failed for ${request.documentId}: ${msg}`);
        modelUsed = 'error';
      }
    } else {
      extractedFields = this.stubExtraction(request.kind);
      overallConfidence = 0.5;
    }

    const fraudRisk = this.computeFraudRisk(fraudSignals);

    this.logger.log(
      `DocIntel ${request.documentId} kind=${request.kind} conf=${overallConfidence.toFixed(2)} risk=${fraudRisk} ${Date.now() - startMs}ms`,
    );

    return {
      documentId: request.documentId,
      kind: request.kind,
      extractedFields,
      rawText: rawText || undefined,
      fraudSignals,
      overallConfidence,
      fraudRisk,
      contentHash,
      processedAt: new Date(),
      modelUsed,
    };
  }

  // ── Vision extraction ─────────────────────────────────────────────────────

  private async extractWithVision(request: DocIntelRequest): Promise<{
    fields: ExtractedField[];
    rawText: string;
    confidence: number;
    model: string;
  }> {
    const fieldKeys = EXTRACTION_SPECS[request.kind] ?? EXTRACTION_SPECS.unknown;
    const model = 'gpt-4o';

    const systemPrompt = `You are a document intelligence system for regulatory compliance.
Extract the following fields precisely. Return ONLY valid JSON:
{
  "rawText": "<full text from document>",
  "confidence": <0.0-1.0>,
  "fields": { ${fieldKeys.map((f) => `"${f}": "<value or null>"`).join(', ')} }
}
Never invent values. Set null if a field is absent. If you suspect tampering, set confidence below 0.5.`;

    const imageContent: OpenAI.Chat.ChatCompletionContentPart = request.base64Image
      ? { type: 'image_url', image_url: { url: `data:${request.mimeType};base64,${request.base64Image}`, detail: 'high' } }
      : { type: 'image_url', image_url: { url: request.fileUrl!, detail: 'high' } };

    const response = await this.openai!.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [imageContent, { type: 'text', text: `Document kind: ${request.kind}` }] },
      ],
      max_tokens: 1500,
      temperature: 0,
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    let parsed: { rawText?: string; confidence?: number; fields?: Record<string, string | null> };

    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      parsed = { rawText: raw, confidence: 0.3, fields: {} };
    }

    return {
      fields: fieldKeys.map((key) => ({
        key,
        value: parsed.fields?.[key] ?? null,
        confidence: parsed.fields?.[key] != null ? (parsed.confidence ?? 0.7) : 0,
      })),
      rawText: parsed.rawText ?? '',
      confidence: parsed.confidence ?? 0.5,
      model,
    };
  }

  // ── Fraud checks ──────────────────────────────────────────────────────────

  private checkExifAnomalies(request: DocIntelRequest): FraudSignal[] {
    const signals: FraudSignal[] = [];

    if (request.kind === 'passport' && request.mimeType === 'image/gif') {
      signals.push({ type: 'exif_anomaly', severity: 'high', details: 'Passport submitted as GIF — unexpected format' });
    }

    if (request.base64Image && request.kind === 'passport' && request.base64Image.length < 68000) {
      signals.push({ type: 'exif_anomaly', severity: 'low', details: 'Image unusually small for a passport scan' });
    }

    return signals;
  }

  private checkFieldConsistency(fields: ExtractedField[], kind: DocumentKind): FraudSignal[] {
    const signals: FraudSignal[] = [];
    const get = (key: string) => fields.find((f) => f.key === key)?.value ?? null;

    if (kind === 'passport') {
      const issueDate = get('issueDate');
      const expiryDate = get('expiryDate');
      if (issueDate && expiryDate) {
        const issue = new Date(issueDate);
        const expiry = new Date(expiryDate);
        if (expiry <= issue) {
          signals.push({ type: 'font_inconsistency', severity: 'high', details: 'Passport expiry is not after issue date — likely tampered' });
        }
        const yearsValid = (expiry.getTime() - issue.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        if (yearsValid > 12 || yearsValid < 1) {
          signals.push({ type: 'font_inconsistency', severity: 'medium', details: `Validity period ${yearsValid.toFixed(1)} years is outside normal range` });
        }
      }

      const dob = get('dateOfBirth');
      if (dob) {
        const age = (Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        if (age < 0 || age > 120) {
          signals.push({ type: 'metadata_mismatch', severity: 'high', details: `Date of birth implies implausible age ${age.toFixed(0)}` });
        }
      }
    }

    if (kind === 'employment_contract') {
      const salary = get('salary');
      if (salary) {
        const num = parseFloat(salary.replace(/[^0-9.]/g, ''));
        if (num < 10_000 || num > 10_000_000) {
          signals.push({ type: 'metadata_mismatch', severity: 'medium', details: `Salary ${salary} outside plausible range` });
        }
      }
    }

    return signals;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private computeFraudRisk(signals: FraudSignal[]): DocIntelResult['fraudRisk'] {
    const high = signals.filter((s) => s.severity === 'high').length;
    const med = signals.filter((s) => s.severity === 'medium').length;
    if (high >= 1) return 'high';
    if (med >= 2) return 'medium';
    if (med >= 1 || signals.length > 0) return 'low';
    return 'none';
  }

  private hashContent(request: DocIntelRequest): string {
    const input = request.base64Image ?? request.fileUrl ?? request.fileBuffer?.toString('base64') ?? '';
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  private stubExtraction(kind: DocumentKind): ExtractedField[] {
    return (EXTRACTION_SPECS[kind] ?? []).map((key) => ({ key, value: `[stub:${key}]`, confidence: 0.5 }));
  }

  computeContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
