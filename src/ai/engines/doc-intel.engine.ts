import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai.service';
import { PromptCategory } from '../entities/ai-prompt.entity';
import { DocumentsService } from '../../documents/documents.service';

/**
 * DocIntel Engine - Specialized AI for document intelligence.
 * Handles document parsing, OCR, classification, entity extraction,
 * redaction, summarization, and translation.
 */
export interface DocumentAnalysis {
  documentId: string;
  classification: {
    category: string;
    subCategory?: string;
    confidence: number;
  };
  entities: Array<{
    type: string;
    value: string;
    confidence: number;
    position?: { start: number; end: number };
  }>;
  summary: string;
  keyPhrases: string[];
  sentiment?: 'positive' | 'negative' | 'neutral';
  language?: string;
  piiDetected: Array<{
    type: string;
    value: string;
    redacted: boolean;
  }>;
  metadata: Record<string, any>;
}

export interface DocIntelRequest {
  tenantId: string;
  documentId: string;
  content?: string;
  mode: 'classify' | 'extract' | 'summarize' | 'redact' | 'full';
  options?: {
    detectPii?: boolean;
    translateTo?: string;
    extractFields?: string[];
    maxSummaryLength?: number;
  };
}

@Injectable()
export class DocIntelEngine {
  private readonly logger = new Logger(DocIntelEngine.name);

  constructor(
    private readonly aiService: AiService,
    private readonly documentsService: DocumentsService,
  ) {}

  async analyze(request: DocIntelRequest): Promise<DocumentAnalysis> {
    const document = await this.documentsService.findOne(
      request.documentId,
      request.tenantId,
      'system',
    );

    const content = request.content || document?.name || '';

    const result: DocumentAnalysis = {
      documentId: request.documentId,
      classification: { category: 'unknown', confidence: 0 },
      entities: [],
      summary: '',
      keyPhrases: [],
      piiDetected: [],
      metadata: {},
    };

    if (request.mode === 'classify' || request.mode === 'full') {
      const classification = await this.classifyDocument(
        request.tenantId,
        request.documentId,
      );
      result.classification = classification;
    }

    if (request.mode === 'extract' || request.mode === 'full') {
      const extraction = await this.extractEntities(
        request.tenantId,
        content,
        request.options?.extractFields,
      );
      result.entities = extraction.entities;
      result.keyPhrases = extraction.keyPhrases;
    }

    if (request.mode === 'summarize' || request.mode === 'full') {
      result.summary = await this.summarize(
        content,
        request.options?.maxSummaryLength,
      );
    }

    if (request.options?.detectPii) {
      result.piiDetected = await this.detectPii(content);
    }

    return result;
  }

  async classifyDocument(
    tenantId: string,
    documentId: string,
  ): Promise<DocumentAnalysis['classification']> {
    const response = await this.aiService.execute({
      category: 'document_analysis' as PromptCategory,
      key: 'doc_classification',
      input: documentId,
      tenantId,
    });

    try {
      const parsed = JSON.parse(response.result);
      return {
        category: parsed.category || 'unknown',
        subCategory: parsed.subCategory,
        confidence: parsed.confidence || 0.7,
      };
    } catch {
      return { category: response.result || 'unknown', confidence: 0.5 };
    }
  }

  async extractEntities(
    tenantId: string,
    content: string,
    fields?: string[],
  ): Promise<{
    entities: DocumentAnalysis['entities'];
    keyPhrases: string[];
  }> {
    const context: Record<string, any> = {};
    if (fields) context.extractFields = fields;

    const response = await this.aiService.execute({
      category: 'data_extraction' as PromptCategory,
      key: 'entity_extraction',
      input: content,
      context,
      tenantId,
    });

    try {
      const parsed = JSON.parse(response.result);
      return {
        entities: parsed.entities || [],
        keyPhrases: parsed.keyPhrases || [],
      };
    } catch {
      return { entities: [], keyPhrases: [] };
    }
  }

  async summarize(
    content: string,
    maxLength?: number,
  ): Promise<string> {
    const response = await this.aiService.execute({
      category: 'document_analysis' as PromptCategory,
      key: 'document_summarization',
      input: content,
      context: { maxLength: maxLength || 500 },
    });

    return response.result;
  }

  async detectPii(content: string): Promise<DocumentAnalysis['piiDetected']> {
    const response = await this.aiService.execute({
      category: 'compliance_analysis' as PromptCategory,
      key: 'pii_detection',
      input: content,
    });

    try {
      return JSON.parse(response.result).pii || [];
    } catch {
      return [];
    }
  }

  async redactDocument(
    tenantId: string,
    content: string,
    piiTypes?: string[],
  ): Promise<{ redactedContent: string; piiFound: number }> {
    const response = await this.aiService.execute({
      category: 'compliance_analysis' as PromptCategory,
      key: 'document_redaction',
      input: content,
      context: { piiTypes: piiTypes || ['email', 'phone', 'ssn', 'address'] },
      tenantId,
    });

    try {
      return JSON.parse(response.result);
    } catch {
      return { redactedContent: content, piiFound: 0 };
    }
  }

  async translateDocument(
    content: string,
    targetLanguage: string,
    sourceLanguage?: string,
  ): Promise<{ translated: string; detectedLanguage: string }> {
    const response = await this.aiService.execute({
      category: 'document_analysis' as PromptCategory,
      key: 'document_translation',
      input: content,
      context: { targetLanguage, sourceLanguage },
    });

    try {
      return JSON.parse(response.result);
    } catch {
      return { translated: response.result, detectedLanguage: sourceLanguage || 'unknown' };
    }
  }

  async compareDocuments(
    tenantId: string,
    documentId1: string,
    documentId2: string,
  ): Promise<{
    similarity: number;
    differences: Array<{ field: string; doc1: string; doc2: string }>;
    summary: string;
  }> {
    const response = await this.aiService.execute({
      category: 'document_analysis' as PromptCategory,
      key: 'document_comparison',
      input: JSON.stringify({ documentId1, documentId2 }),
      context: { mode: 'diff' },
      tenantId,
    });

    try {
      return JSON.parse(response.result);
    } catch {
      return { similarity: 0, differences: [], summary: response.result };
    }
  }
}