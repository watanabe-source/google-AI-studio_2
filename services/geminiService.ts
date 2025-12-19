
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

/**
 * Step 2: ガイドライン抽出
 * 各議案ごとにループを回してAPIを叩くことで、他議案との混同を防ぎ、精度の高い抽出を実現します。
 */
export const extractIndicators = async (file: File, agendaItems: AgendaItem[]): Promise<Indicator[]> => {
  const base64Data = await fileToBase64(file);
  const allIndicators: Indicator[] = [];

  for (const agenda of agendaItems) {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            { inlineData: { data: base64Data, mimeType: "application/pdf" } },
            { text: `提供された議決権行使ガイドラインから、特定の議案を判断するために見るべき具体的指標（定量・定性）を抽出してください。
            
対象議案: [ID: ${agenda.id}] ${agenda.number}: ${agenda.title}
内容詳細: ${agenda.description}

【指示】
1. この議案に直接関連する指標のみを抽出してください。
2. 他の議案の指標と混同しないようにしてください。
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
              agendaId: { type: Type.STRING, description: "対応する議案のID。必ず入力のIDを使用すること" },
              metricName: { type: Type.STRING, description: "指標名（例：ROE, 社外取締役比率）" },
              threshold: { type: Type.STRING, description: "合格基準（例：5%以上, 1/3以上）" },
              description: { type: Type.STRING, description: "詳細な判定条件" }
            },
            required: ["id", "agendaId", "metricName", "threshold", "description"]
          }
        }
      }
    });

    try {
      const results: Indicator[] = JSON.parse(response.text);
      allIndicators.push(...results);
    } catch (e) {
      console.warn(`Failed to parse indicators for agenda ${agenda.number}:`, e);
    }
  }

  return allIndicators;
};

/**
 * Step 3: 事実・エビデンス抽出
 * AIがどの議案のどの指標を探しているか明確にするため、プレフィックスを付与してプロンプトを構成します。
 */
export const extractFactsFromFiles = async (
  files: File[], 
  agendaItems: AgendaItem[], 
  indicators: Indicator[],
  onProgress?: (current: number, total: number) => void
): Promise<FactEvidence[]> => {
  const allFacts: FactEvidence[] = [];
  const totalFiles = files.length;

  // 指標リストに議案名を付与して、AIの認識を強化
  const indicatorListWithAgenda = indicators.map(ind => {
    const agenda = agendaItems.find(a => a.id === ind.agendaId);
    return `[議案: ${agenda?.number || ''}] [指標ID: ${ind.id}] [議案ID: ${ind.agendaId}] 指標名: ${ind.metricName} (基準: ${ind.threshold})`;
  }).join('\n');

  for (let i = 0; i < totalFiles; i++) {
    const file = files[i];
    if (onProgress) onProgress(i + 1, totalFiles);
    
    const base64Data = await fileToBase64(file);
    
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            { inlineData: { data: base64Data, mimeType: "application/pdf" } },
            { text: `提供された資料から、以下の各議案の指標に該当する具体的数値や事実を抽出してください。

【重要な指示】
1. 各指標に対して「どの議案の指標か」を正確に認識してください。
2. 抽出結果には、必ず提供された 'agendaId' と 'indicatorId' をセットで正しく保持して返してください。
3. AIのサボりを防ぐため、具体的な数値を必ず記載してください。情報がない場合は「記載なし」としてください。
4. 必ず「何ページに記載されているか」を特定してください。

資料名: ${file.name}

対象指標リスト:
${indicatorListWithAgenda}` }
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
              agendaId: { type: Type.STRING, description: "対応する議案のID。必ず指示されたIDを保持すること" },
              indicatorId: { type: Type.STRING, description: "対応する指標のID。必ず指示されたIDを保持すること" },
              factualValue: { type: Type.STRING, description: "抽出された事実・数値" },
              evidenceSource: { type: Type.STRING, description: "ファイル名" },
              pageNumber: { type: Type.STRING, description: "記載ページ番号" }
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
      console.warn(`Failed to parse response for file ${file.name}:`, e);
    }
  }

  // 重複排除と「記載なし」のフィルタリングロジック（実際の値を優先）
  const finalMap = new Map<string, FactEvidence>();
  allFacts.forEach(fact => {
    const key = fact.indicatorId;
    const existing = finalMap.get(key);
    // すでに値がある場合は「記載なし」で上書きしない。値があるもの同士なら最新を優先。
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
