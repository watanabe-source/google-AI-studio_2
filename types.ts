
export enum Step {
  NOTICE_ANALYSIS = 0,
  GUIDELINE_INDICATORS = 1,
  DATA_EXTRACTION = 2,
  FINAL_DECISION = 3,
  EXPORT = 4
}

export interface AgendaItem {
  id: string;
  number: string;
  title: string;
  description: string;
}

export interface Indicator {
  id: string;
  agendaId: string;
  metricName: string;
  threshold: string;
  description: string;
}

export interface FactEvidence {
  id: string;
  agendaId: string;
  indicatorId: string;
  factualValue: string;
  evidenceSource: string;
  pageNumber: string;
}

export interface Decision {
  agendaId: string;
  isApproved: boolean;
  reason: string;
  detailedLogic: string;
}

export interface AppState {
  currentStep: Step;
  noticeFile: File | null;
  guidelineFile: File | null;
  evidenceFiles: File[];
  
  pdfTextCache: Record<string, string>; // fileName -> extractedText
  
  agendaItems: AgendaItem[];
  indicators: Indicator[];
  facts: FactEvidence[];
  decisions: Decision[];
  
  isProcessing: boolean;
  error: string | null;
}
