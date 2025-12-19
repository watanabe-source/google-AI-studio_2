
import { GoogleGenAI, Type } from "@google/genai";
import * as pdfjs from "pdfjs-dist";
import { AgendaItem, Indicator, FactEvidence, Decision } from "../types";

// PDF.js Workerの初期化
pdfjs.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@4.10.38/build/pdf.worker.mjs`;

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

/**
 * ブラウザ側でPDFからテキストを抽出します。
 * 巨大なPDF(66MB等)をBase64で送信する際の制限を回避し、AIの認識精度を安定させます。
 */
export const extractTextFromPdf = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(" ");
    fullText += `\n[PAGE: ${i}]\n${pageText}\n`;
  }
  return fullText;
};

export const analyzeNotice = async (pdfText: string): Promise<AgendaItem[]> => {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        parts: [
          { text: `以下の招集通知のテキストに基づき、議案を全て抽出してください。
引用する際は、必ずテキスト内の [PAGE: n] マーカーを参考にページ番号を特定してください。

---
招集通知テキスト:
${pdfText}

---
【タスク】
各議案について、議案番号（例：第1号議案）、タイトル、内容の要約を厳格に抽出してください。必ずJSON配列形式で返してください。IDは必ず議案番号の数字部分のみ（例：'1', '2'）としてください。` }
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
            id: { 
              type: Type.STRING, 
              description: "議案の通し番号（半角数字のみ）。例：第1号議案なら '1'、第2号議案なら '2'。紐付けに使用するため極めて重要です。" 
            },
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

export const extractIndicators = async (pdfText: string, agendaItems: AgendaItem[]): Promise<Indicator[]> => {
  const allIndicators: Indicator[] = [];

  for (const agenda of agendaItems) {
    const nextAgendaId = (parseInt(agenda.id) + 1).toString();
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            { text: `提供された議決権行使ガイドラインのテキストから、特定の議案を判断するために見るべき具体的指標（定量・定性）を抽出してください。
引用する際は、必ずテキスト内の [PAGE: n] マーカーを参考にページ番号を特定してください。

対象議案: [ID: ${agenda.id}] ${agenda.number}: ${agenda.title}
内容詳細: ${agenda.description}

---
ガイドラインテキスト:
${pdfText}

---
【重要な指示：情報の厳密な分離】
1. この議案に直接関連する指標のみを抽出してください。
2. 【厳禁】渡しているテキストはガイドライン全体ですが、あなたは『${agenda.number}』という特定の議案のみを担当しています。他の議案に関連する指標は、たとえテキスト内に記載があっても、絶対に今回の回答に含めないでください。
3. ガイドラインに記載がない場合は無理に推測せず、空の配列を返してください。
4. 出力する agendaId は、上記の [ID: ${agenda.id}] と完全に一致させてください。` }
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
              metricName: { type: Type.STRING },
              threshold: { type: Type.STRING },
              description: { type: Type.STRING }
            },
            required: ["id", "agendaId", "metricName", "threshold", "description"]
          }
        }
      }
    });

    try {
      const results: Indicator[] = JSON.parse(response.text);
      const fixedResults = results.map(r => ({ ...r, agendaId: agenda.id }));
      allIndicators.push(...fixedResults);
    } catch (e) {
      console.warn(`Failed to parse indicators for agenda ${agenda.number}:`, e);
    }
  }

  return allIndicators;
};

export const extractFactsFromTexts = async (
  docTexts: { name: string, text: string }[], 
  agendaItems: AgendaItem[], 
  indicators: Indicator[],
  onProgress?: (current: number, total: number) => void
): Promise<FactEvidence[]> => {
  const allFacts: FactEvidence[] = [];
  const totalDocs = docTexts.length;

  const indicatorListWithAgenda = indicators.map(ind => {
    const agenda = agendaItems.find(a => a.id === ind.agendaId);
    return `[議案: ${agenda?.number || ''}] [指標ID: ${ind.id}] [議案ID: ${ind.agendaId}] 指標名: ${ind.metricName} (基準: ${ind.threshold})`;
  }).join('\n');

  for (let i = 0; i < totalDocs; i++) {
    const doc = docTexts[i];
    if (onProgress) onProgress(i + 1, totalDocs);
    
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            { text: `以下の資料テキストから、各議案の指標に該当する具体的数値や事実を抽出してください。
引用する際は、必ずテキスト内の [PAGE: n] マーカーを参考にページ番号を特定してください。

資料名: ${doc.name}

対象指標リスト:
${indicatorListWithAgenda}

---
資料テキスト:
${doc.text}

---
【重要な指示】
1. 抽出結果には、必ず提供された 'agendaId' と 'indicatorId' をセットで正しく保持して返してください。
2. 具体的な数値を必ず記載してください。情報がない場合は「記載なし」としてください。
3. ページ番号は、テキスト内の [PAGE: n] マーカーから正確に抽出してください。` }
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
              factualValue: { type: Type.STRING },
              evidenceSource: { type: Type.STRING },
              pageNumber: { type: Type.STRING }
            },
            required: ["id", "agendaId", "indicatorId", "factualValue", "evidenceSource", "pageNumber"]
          }
        }
      }
    });

    try {
      const fileFacts: FactEvidence[] = JSON.parse(response.text);
      allFacts.push(...fileFacts);
    } catch (e) {
      console.warn(`Failed to parse response for file ${doc.name}:`, e);
    }
  }

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
    contents: `以下の株主総会データに基づき、各議案に対するロジカルな賛否判断を行ってください。

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
            isApproved: { type: Type.BOOLEAN },
            reason: { type: Type.STRING },
            detailedLogic: { type: Type.STRING }
          },
          required: ["agendaId", "isApproved", "reason", "detailedLogic"]
        }
      }
    }
  });

  return JSON.parse(response.text);
};
