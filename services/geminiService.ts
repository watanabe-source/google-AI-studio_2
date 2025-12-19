
import { GoogleGenAI, Type } from "@google/genai";
import { AgendaItem, Indicator, FactEvidence, Decision } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
  });
};

export const analyzeNotice = async (file: File): Promise<AgendaItem[]> => {
  const base64Data = await fileToBase64(file);
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        parts: [
          { inlineData: { data: base64Data, mimeType: "application/pdf" } },
          { text: "株主総会の招集通知から議案を全て抽出してください。各議案について、議案番号（例：第1号議案）、タイトル、内容の要約を厳格に抽出してください。必ずJSON配列形式で返してください。" }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            number: { type: Type.STRING },
            title: { type: Type.STRING },
            description: { type: Type.STRING }
          },
          required: ["id", "number", "title", "description"]
        }
      }
    }
  });

  return JSON.parse(response.text);
};

export const extractIndicators = async (file: File, agendaItems: AgendaItem[]): Promise<Indicator[]> => {
  const base64Data = await fileToBase64(file);
  const agendaText = agendaItems.map(a => `${a.number}: ${a.title}`).join('\n');
  
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        parts: [
          { inlineData: { data: base64Data, mimeType: "application/pdf" } },
          { text: `提供された議決権行使ガイドラインから、以下の各議案を判断するために見るべき具体的指標（定量・定性）を抽出してください。指標がない場合は無理に推測せず、ガイドラインに記載があるもののみを抽出してください。\n\n対象議案:\n${agendaText}` }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            agendaId: { type: Type.STRING, description: "対応する議案のID" },
            metricName: { type: Type.STRING, description: "指標名（例：ROE, 社外取締役比率）" },
            threshold: { type: Type.STRING, description: "合格基準（例：5%以上, 1/3以上）" },
            description: { type: Type.STRING, description: "詳細な判定条件" }
          },
          required: ["id", "agendaId", "metricName", "threshold", "description"]
        }
      }
    }
  });

  return JSON.parse(response.text);
};

export const extractFactsFromFiles = async (
  files: File[], 
  agendaItems: AgendaItem[], 
  indicators: Indicator[],
  onProgress?: (current: number, total: number) => void
): Promise<FactEvidence[]> => {
  const allFacts: FactEvidence[] = [];
  const totalFiles = files.length;

  for (let i = 0; i < totalFiles; i++) {
    const file = files[i];
    if (onProgress) onProgress(i + 1, totalFiles);
    
    const base64Data = await fileToBase64(file);
    const indicatorList = indicators.map(ind => `${ind.metricName} (基準: ${ind.threshold})`).join('\n');
    
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            { inlineData: { data: base64Data, mimeType: "application/pdf" } },
            { text: `この資料から、以下の各指標に該当する具体的数値や事実を抽出してください。必ず「何ページに記載されているか」を特定してください。AIのサボりを防ぐため、必ず具体的な数値を記載し、空欄を避けてください。情報がない場合は「記載なし」としてください。\n\n資料名: ${file.name}\n\n対象指標:\n${indicatorList}` }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              agendaId: { type: Type.STRING },
              indicatorId: { type: Type.STRING },
              factualValue: { type: Type.STRING, description: "抽出された事実・数値" },
              evidenceSource: { type: Type.STRING, description: "ファイル名" },
              pageNumber: { type: Type.STRING, description: "記載ページ番号(数字のみ推奨)" }
            },
            required: ["id", "agendaId", "indicatorId", "factualValue", "evidenceSource", "pageNumber"]
          }
        }
      }
    });

    try {
      const fileFacts: FactEvidence[] = JSON.parse(response.text);
      // Filter out '記載なし' entries if we already have data for that indicator, 
      // or keep it if it's the only info we have.
      allFacts.push(...fileFacts);
    } catch (e) {
      console.warn(`Failed to parse response for file ${file.name}:`, e);
    }
  }

  // Deduplicate and prioritize actual values over "記載なし"
  const finalMap = new Map<string, FactEvidence>();
  allFacts.forEach(fact => {
    const key = fact.indicatorId;
    const existing = finalMap.get(key);
    if (!existing || (existing.factualValue === '記載なし' && fact.factualValue !== '記載なし')) {
      finalMap.set(key, fact);
    }
  });

  return Array.from(finalMap.values());
};

export const generateFinalDecision = async (
  agendaItems: AgendaItem[],
  indicators: Indicator[],
  facts: FactEvidence[]
): Promise<Decision[]> => {
  const contextData = {
    agendas: agendaItems.map(a => ({
      id: a.id,
      name: `${a.number} ${a.title}`,
      description: a.description,
      judgingCriteria: indicators.filter(i => i.agendaId === a.id).map(i => ({
        id: i.id,
        metric: i.metricName,
        threshold: i.threshold,
        fact: facts.find(f => f.indicatorId === i.id)?.factualValue || "不明"
      }))
    }))
  };

  const response = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: `以下の株主総会データ（議案、ガイドライン指標、および調査事実）に基づき、各議案に対するロジカルな賛否判断を行ってください。
1. 判断は「賛成」または「反対」の二択です。
2. 理由には必ず抽出された具体的な数値（ROE XX%など）を引用してください。
3. 指標が複数ある場合、総合的に判断してください。
4. 情報が不足している場合は、保守的に判断するか、不足を明記した上で暫定的な賛否を出してください。

データ:
${JSON.stringify(contextData, null, 2)}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            agendaId: { type: Type.STRING },
            isApproved: { type: Type.BOOLEAN, description: "賛成(true)または反対(false)" },
            reason: { type: Type.STRING, description: "結論の要約（1行）" },
            detailedLogic: { type: Type.STRING, description: "具体的数値を引用した詳細な論理的理由" }
          },
          required: ["agendaId", "isApproved", "reason", "detailedLogic"]
        }
      }
    }
  });

  return JSON.parse(response.text);
};
