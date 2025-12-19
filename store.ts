
import { create } from 'zustand';
import { Step, AppState, AgendaItem, Indicator, FactEvidence, Decision } from './types';

interface AppActions {
  setStep: (step: Step) => void;
  setNoticeFile: (file: File | null) => void;
  setGuidelineFile: (file: File | null) => void;
  addEvidenceFiles: (files: File[]) => void;
  removeEvidenceFile: (index: number) => void;
  
  setPdfTextCache: (fileName: string, text: string) => void;
  
  setAgendaItems: (items: AgendaItem[]) => void;
  setIndicators: (indicators: Indicator[]) => void;
  setFacts: (facts: FactEvidence[]) => void;
  setDecisions: (decisions: Decision[]) => void;
  
  setProcessing: (status: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState: AppState = {
  currentStep: Step.NOTICE_ANALYSIS,
  noticeFile: null,
  guidelineFile: null,
  evidenceFiles: [],
  pdfTextCache: {},
  agendaItems: [],
  indicators: [],
  facts: [],
  decisions: [],
  isProcessing: false,
  error: null,
};

export const useAppStore = create<AppState & AppActions>((set) => ({
  ...initialState,
  
  setStep: (step) => set({ currentStep: step }),
  setNoticeFile: (file) => set({ noticeFile: file }),
  setGuidelineFile: (file) => set({ guidelineFile: file }),
  addEvidenceFiles: (files) => set((state) => ({ evidenceFiles: [...state.evidenceFiles, ...files] })),
  removeEvidenceFile: (index) => set((state) => ({ 
    evidenceFiles: state.evidenceFiles.filter((_, i) => i !== index) 
  })),
  
  setPdfTextCache: (fileName, text) => set((state) => ({
    pdfTextCache: { ...state.pdfTextCache, [fileName]: text }
  })),
  
  setAgendaItems: (items) => set({ agendaItems: items }),
  setIndicators: (indicators) => set({ indicators: indicators }),
  setFacts: (facts) => set({ facts: facts }),
  setDecisions: (decisions) => set({ decisions: decisions }),
  
  setProcessing: (status) => set({ isProcessing: status }),
  setError: (error) => set({ error: error }),
  reset: () => set(initialState),
}));
