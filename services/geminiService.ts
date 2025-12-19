
import { GoogleGenAI, Type } from "@google/genai";
import * as pdfjs from "pdfjs-dist";
import { AgendaItem, Indicator, FactEvidence, Decision } from "../types";

// PDF.js Workerの初期化
pdfjs.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@4.10.38/build/pdf.worker.mjs`;

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

/**
 * ブラウザ側でPDFからテキストを抽出します。
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

/**
 * テキストをページマーカー [PAGE: n] に基づいて指定されたページ数のチャンクに分割します。
 */
const splitTextIntoPageChunks = (text: string, pagesPerChunk: number): { start: number, end: number, text: string }[] => {
  const pageMatches = Array.from(text.matchAll(/\[PAGE:\s*(\d+)\]/g));
  if (pageMatches.length === 0) return [{ start: 1, end: 1, text }];

  const chunks: { start: number, end: number, text: string }[] = [];
  for (let i = 0; i < pageMatches.length; i += pagesPerChunk) {
    const startMatch = pageMatches[i];
    const endIdx = Math.min(i + pagesPerChunk - 1, pageMatches.length - 1);
    const endMatch = pageMatches[endIdx];
    
    const startPos = startMatch.index!;
    const nextStartIdx = endIdx + 1;
    const endPos = nextStartIdx < pageMatches.length ? pageMatches[nextStartIdx].index! : text.length;
    
    chunks.push({
      start: parseInt(startMatch[1]),
      end: parseInt(endMatch[1]),
      text: text.substring(startPos, endPos)
    });
  }
  return chunks;
};

export const analyzeNotice = async (pdfText: string): Promise<AgendaItem[]> => {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        parts: [
          { text: `以下の招集通知のテキストに基づき、議案を全て抽出してください。
必ずテキスト内の [PAGE: n] マーカーを参考にページ番号を特定してください。

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
            id: { type: Type.STRING, description: "議案番号の数字部分のみ（例: '1'）" },
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
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            { text: `提供された議決権行使ガイドラインのテキストから、特定の議案を判断するために見るべき具体的指標（定量・定性）を抽出してください。

対象議案: [ID: ${agenda.id}] ${agenda.number}: ${agenda.title}

---
ガイドラインテキスト:
${pdfText}

---
【指示】
1. この議案に直接関連する指標のみを抽出してください。
2. 他の議案に関連する指標は絶対に含めないでください。
3. 出力する agendaId は、[ID: ${agenda.id}] と完全に一致させてください。` }
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
      console.warn(`Failed to parse indicators for agenda ${agenda.id}:`, e);
    }
  }

  return allIndicators;
};

/**
 * Step 3: 事実・エビデンス抽出
 * 刷新: 「資料 × 50ページチャンク」の一括解析（バッチ処理）方式。
 */
export const extractFactsFromTexts = async (
  docTexts: { name: string, text: string }[], 
  agendaItems: AgendaItem[], 
  indicators: Indicator[],
  onProgress?: (current: number, total: number, message?: string) => void
): Promise<FactEvidence[]> => {
  const finalFacts: Map<string, FactEvidence> = new Map();
  const PAGES_PER_CHUNK = 50; // Gemini 3 Pro の能力を活かし、大きな塊で処理

  // 指標リストの文字列化
  const indicatorSearchList = indicators.map(ind => {
    const agenda = agendaItems.find(a => a.id === ind.agendaId);
    return `[指標ID: ${ind.id}] 指標名: ${ind.metricName} (基準: ${ind.threshold}, 関連議案: ${agenda?.number || ''})`;
  }).join('\n');

  // 全体の総ステップ数を計算（資料数 * チャンク数）
  let totalChunksCount = 0;
  const docsWithChunks = docTexts.map(doc => {
    const chunks = splitTextIntoPageChunks(doc.text, PAGES_PER_CHUNK);
    totalChunksCount += chunks.length;
    return { doc, chunks };
  });

  let currentChunkIdx = 0;

  for (const { doc, chunks } of docsWithChunks) {
    for (const chunk of chunks) {
      currentChunkIdx++;
      const progressMsg = `${doc.name} (${chunk.start}〜${chunk.end}ページ) を一括スキャン中...`;
      if (onProgress) onProgress(currentChunkIdx, totalChunksCount, progressMsg);

      const response = await ai.models.generateContent({
        model: "gemini-3-pro-preview",
        contents: [
          {
            parts: [
              { text: `提供された資料の特定ページ範囲から、複数の判断指標に関する具体的数値を「一括で」探し出してください。

【対象資料・範囲】
資料名: ${doc.name}
対象ページ: ${chunk.start}ページ 〜 ${chunk.end}ページ

【調査対象指標リスト】
${indicatorSearchList}

---
【重要な探索・抽出指示】
1. 徹底調査: 有価証券報告書やCG報告書の場合、特に『コーポレート・ガバナンスの状況』『役員の状況』『財務諸表』のセクションを重点的に確認し、ROE、女性役員数、役員報酬、社外取締役比率、政策保有株式などの数値を漏らさず抽出してください。
2. 効率的な回答: このページ範囲に該当する情報が「全くない」指標については、JSONの回答に含めないでください。
3. 数値の具体性: 「基準を満たす」といった曖昧な表現ではなく、「ROE 8.5%」「女性役員2名（比率15.4%）」など、具体的な実数値を優先して抽出してください。
4. ページ番号: テキスト内の [PAGE: n] マーカーから、その事実が記載されている正確なページを特定してください。
5. IDの厳守: 返却する 'indicatorId' は、リストにある [指標ID: xxx] の数値を「一文字も変えずに」そのまま使用してください。

---
対象ページテキスト:
${chunk.text}` }
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
                indicatorId: { type: Type.STRING, description: "抽出元の [指標ID: xxx] の値をそのまま返す" },
                factualValue: { type: Type.STRING, description: "抽出された具体的な事実・数値" },
                pageNumber: { type: Type.STRING, description: "マーカーに基づく正確なページ番号" }
              },
              required: ["indicatorId", "factualValue", "pageNumber"]
            }
          }
        }
      });

      try {
        const results: any[] = JSON.parse(response.text);
        
        results.forEach(res => {
          const indicatorId = res.indicatorId?.toString().trim();
          const val = res.factualValue?.trim();
          if (!indicatorId || !val || val === '記載なし') return;

          const indicator = indicators.find(i => i.id === indicatorId);
          if (!indicator) return;

          const formattedValue = `${doc.name} (p.${res.pageNumber}): ${val}`;
          const existingFact = finalFacts.get(indicatorId);

          if (!existingFact) {
            finalFacts.set(indicatorId, {
              id: Math.random().toString(36).substr(2, 9),
              agendaId: indicator.agendaId,
              indicatorId: indicatorId,
              factualValue: formattedValue,
              evidenceSource: doc.name,
              pageNumber: res.pageNumber
            });
          } else {
            // 既に「記載なし」が入っているか、新しい情報であれば追記
            if (existingFact.factualValue === '記載なし') {
              existingFact.factualValue = formattedValue;
              existingFact.evidenceSource = doc.name;
              existingFact.pageNumber = res.pageNumber;
            } else if (!existingFact.factualValue.includes(val)) {
              existingFact.factualValue += `\n${formattedValue}`;
              existingFact.evidenceSource += `, ${doc.name}`;
              existingFact.pageNumber += `, ${res.pageNumber}`;
            }
          }
        });
      } catch (e) {
        console.warn(`Failed to parse results for chunk ${doc.name} p.${chunk.start}-${chunk.end}`, e);
      }
    }
  }

  // もし一度も事実が見つからなかった指標があれば「記載なし」として補完
  indicators.forEach(ind => {
    if (!finalFacts.has(ind.id)) {
      finalFacts.set(ind.id, {
        id: Math.random().toString(36).substr(2, 9),
        agendaId: ind.agendaId,
        indicatorId: ind.id,
        factualValue: '記載なし',
        evidenceSource: '-',
        pageNumber: '-'
      });
    }
  });

  return Array.from(finalFacts.values());
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
