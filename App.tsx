
import React, { useState } from 'react';
import { useAppStore } from './store';
import { Step } from './types';
import { Stepper } from './components/Stepper';
import { 
  extractTextFromPdf, 
  analyzeNotice, 
  extractIndicators, 
  extractFactsFromTexts, 
  generateFinalDecision 
} from './services/geminiService';
import { 
  UploadIcon, 
  FileTextIcon, 
  ArrowRightIcon, 
  CheckIcon, 
  XIcon, 
  DownloadIcon,
  AlertCircleIcon
} from './components/Icons';

const App: React.FC = () => {
  const store = useAppStore();
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');

  const getCachedText = async (file: File): Promise<string> => {
    if (store.pdfTextCache[file.name]) {
      return store.pdfTextCache[file.name];
    }
    const text = await extractTextFromPdf(file);
    store.setPdfTextCache(file.name, text);
    return text;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'notice' | 'guideline' | 'evidence') => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    if (type === 'notice') store.setNoticeFile(files[0]);
    else if (type === 'guideline') store.setGuidelineFile(files[0]);
    else if (type === 'evidence') store.addEvidenceFiles(files);
  };

  const processStep1 = async () => {
    if (!store.noticeFile) return;
    store.setProcessing(true);
    store.setError(null);
    try {
      const text = await getCachedText(store.noticeFile);
      const items = await analyzeNotice(text);
      store.setAgendaItems(items);
      store.setStep(Step.GUIDELINE_INDICATORS);
    } catch (err) {
      store.setError('招集通知の解析中にエラーが発生しました。資料が読み取れないか、制限を超えている可能性があります。');
      console.error(err);
    } finally {
      store.setProcessing(false);
    }
  };

  const processStep2 = async () => {
    if (!store.guidelineFile) return;
    store.setProcessing(true);
    store.setError(null);
    try {
      const text = await getCachedText(store.guidelineFile);
      const indicators = await extractIndicators(text, store.agendaItems);
      store.setIndicators(indicators);
      store.setStep(Step.DATA_EXTRACTION);
    } catch (err) {
      store.setError('ガイドラインの抽出中にエラーが発生しました。');
      console.error(err);
    } finally {
      store.setProcessing(false);
    }
  };

  const processStep3 = async () => {
    if (store.evidenceFiles.length === 0 && !store.noticeFile) return;
    store.setProcessing(true);
    store.setError(null);
    setProgress(0);
    setStatusMessage('ドキュメントのテキストを準備中...');
    
    try {
      const filesToProcess = store.noticeFile ? [store.noticeFile, ...store.evidenceFiles] : store.evidenceFiles;
      
      const textsToProcess: { name: string, text: string }[] = [];
      for (let i = 0; i < filesToProcess.length; i++) {
        const file = filesToProcess[i];
        setStatusMessage(`${file.name} を読み込み中...`);
        const text = await getCachedText(file);
        textsToProcess.push({ name: file.name, text });
      }

      const allFacts = await extractFactsFromTexts(
        textsToProcess, 
        store.agendaItems, 
        store.indicators,
        (current, total, msg) => {
          setProgress(Math.round((current / total) * 100));
          if (msg) setStatusMessage(msg);
        }
      );
      
      store.setFacts(allFacts);
      store.setStep(Step.FINAL_DECISION);
    } catch (err) {
      store.setError('事実情報の抽出中にエラーが発生しました。ファイルサイズが大きすぎるか、形式が正しくない可能性があります。');
      console.error(err);
    } finally {
      store.setProcessing(false);
      setProgress(0);
      setStatusMessage('');
    }
  };

  const processStep4 = async () => {
    store.setProcessing(true);
    store.setError(null);
    try {
      const decisions = await generateFinalDecision(store.agendaItems, store.indicators, store.facts);
      store.setDecisions(decisions);
      store.setStep(Step.EXPORT);
    } catch (err) {
      store.setError('最終判断の生成中にエラーが発生しました。');
      console.error(err);
    } finally {
      store.setProcessing(false);
    }
  };

  const exportToCSV = () => {
    const headers = ['議案番号', '議案名', '賛否', '結論概要', '判断理由詳細', '指標', '抽出された数値/事実', '根拠資料', 'ページ'];
    const rows: string[][] = [];

    store.agendaItems.forEach(agenda => {
      const decision = store.decisions.find(d => d.agendaId === agenda.id);
      const agendaIndicators = store.indicators.filter(i => i.agendaId === agenda.id);
      
      if (agendaIndicators.length === 0) {
        rows.push([
          agenda.number,
          agenda.title,
          decision?.isApproved ? '賛成' : '反対',
          decision?.reason || '',
          decision?.detailedLogic?.replace(/\n/g, ' ') || '',
          '指標なし',
          '-',
          '-',
          '-'
        ]);
      } else {
        agendaIndicators.forEach(indicator => {
          const fact = store.facts.find(f => f.indicatorId === indicator.id);
          rows.push([
            agenda.number,
            agenda.title,
            decision?.isApproved ? '賛成' : '反対',
            decision?.reason || '',
            decision?.detailedLogic?.replace(/\n/g, ' ') || '',
            `${indicator.metricName} (${indicator.threshold})`,
            fact?.factualValue || '記載なし',
            fact?.evidenceSource || '-',
            fact?.pageNumber || '-'
          ]);
        });
      }
    });

    const csvContent = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `議決権行使判断レポート_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl w-full">
        <header className="mb-12 text-center animate-in fade-in slide-in-from-top-4 duration-700">
          <div className="inline-block p-2 px-4 bg-blue-100 text-blue-700 rounded-full text-xs font-bold mb-4 uppercase tracking-widest">
            Voter Decision Support MVP
          </div>
          <h1 className="text-4xl font-extrabold text-slate-900 tracking-tight mb-2">
            議決権行使判断支援システム
          </h1>
          <p className="text-lg text-slate-600">
            招集通知・ガイドライン・有報をAIが統合解析
          </p>
        </header>

        <main className="bg-white rounded-3xl shadow-2xl p-10 border border-slate-200 transition-all duration-500">
          <Stepper currentStep={store.currentStep} />

          {store.error && (
            <div className="mb-8 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-red-700 animate-in fade-in zoom-in-95">
              <AlertCircleIcon className="shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">処理中にエラーが発生しました</p>
                <p className="text-sm opacity-90">{store.error}</p>
              </div>
            </div>
          )}

          {/* STEP 1: Notice Analysis */}
          {store.currentStep === Step.NOTICE_ANALYSIS && (
            <div className="space-y-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                  <FileTextIcon className="text-blue-600" />
                  Step 1: 招集通知の解析
                </h2>
                <span className="text-xs font-medium text-slate-400">PDFファイルを1つ選択してください</span>
              </div>
              <div className="border-2 border-dashed border-slate-200 rounded-2xl p-12 text-center transition-all hover:border-blue-400 hover:bg-blue-50 group bg-slate-50">
                <input
                  type="file"
                  id="notice-upload"
                  className="hidden"
                  accept=".pdf"
                  onChange={(e) => handleFileChange(e, 'notice')}
                />
                <label htmlFor="notice-upload" className="cursor-pointer">
                  <UploadIcon className="mx-auto w-16 h-16 text-slate-300 mb-4 group-hover:text-blue-500 transition-colors" />
                  <p className="text-slate-600 font-bold text-lg">招集通知PDFをアップロード</p>
                  <p className="text-slate-400 text-sm mt-2">クリックまたはドラッグ＆ドロップ</p>
                  {store.noticeFile && (
                    <div className="mt-6 p-3 bg-white border border-blue-200 text-blue-700 rounded-xl shadow-sm inline-flex items-center gap-2 font-medium">
                      <FileTextIcon className="w-4 h-4" />
                      {store.noticeFile.name}
                    </div>
                  )}
                </label>
              </div>
              <div className="flex justify-end pt-4">
                <button
                  onClick={processStep1}
                  disabled={!store.noticeFile || store.isProcessing}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold py-4 px-10 rounded-2xl flex items-center gap-2 transition-all shadow-lg shadow-blue-200 active:scale-95"
                >
                  {store.isProcessing ? '解析中...' : '議案抽出を開始'}
                  {!store.isProcessing && <ArrowRightIcon />}
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: Guideline Indicators */}
          {store.currentStep === Step.GUIDELINE_INDICATORS && (
            <div className="space-y-6 animate-in slide-in-from-right-4 duration-500">
              <h2 className="text-2xl font-bold text-slate-800 mb-6 flex items-center gap-2">
                <CheckIcon className="text-green-600" />
                Step 2: ガイドライン指標の特定
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                  <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2">
                    <CheckIcon className="w-4 h-4" /> 抽出された議案 ({store.agendaItems.length})
                  </h3>
                  <div className="space-y-6 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                    {store.agendaItems.map((item) => {
                      const agendaIndicators = store.indicators.filter(i => i.agendaId === item.id);
                      return (
                        <div key={item.id} className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm transition-all hover:border-blue-300">
                          <span className="text-xs font-bold text-blue-600 block mb-1">{item.number}</span>
                          <p className="text-sm font-bold text-slate-800 mb-3">{item.title}</p>
                          
                          {agendaIndicators.length > 0 ? (
                            <div className="space-y-2 mt-2 border-t pt-3 border-slate-50">
                              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">特定された指標:</p>
                              {agendaIndicators.map(ind => (
                                <div key={ind.id} className="text-[11px] bg-blue-50/50 p-2 rounded-lg border border-blue-100/50 text-slate-700">
                                  <span className="font-bold text-blue-600 mr-1">指標:</span> {ind.metricName}
                                  <div className="mt-1 text-[10px] text-slate-400">基準: {ind.threshold}</div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-[10px] text-slate-300 italic mt-2">指標はまだ抽出されていません</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="flex flex-col justify-center">
                  <div className="border-2 border-dashed border-slate-200 rounded-2xl p-10 text-center transition-all hover:border-blue-400 hover:bg-blue-50 bg-slate-50">
                    <input
                      type="file"
                      id="guideline-upload"
                      className="hidden"
                      accept=".pdf"
                      onChange={(e) => handleFileChange(e, 'guideline')}
                    />
                    <label htmlFor="guideline-upload" className="cursor-pointer">
                      <UploadIcon className="mx-auto w-12 h-12 text-slate-300 mb-4" />
                      <p className="text-slate-600 font-bold">判断ガイドラインをアップロード</p>
                      {store.guidelineFile && (
                        <div className="mt-4 p-2 bg-white text-blue-600 rounded-lg text-sm font-medium border border-blue-100 shadow-sm truncate">
                          {store.guidelineFile.name}
                        </div>
                      )}
                    </label>
                  </div>
                </div>
              </div>
              <div className="flex justify-between pt-8 border-t border-slate-100">
                <button onClick={() => store.setStep(Step.NOTICE_ANALYSIS)} className="text-slate-400 hover:text-slate-600 font-bold transition-colors">戻る</button>
                <button
                  onClick={processStep2}
                  disabled={!store.guidelineFile || store.isProcessing}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 text-white font-bold py-4 px-10 rounded-2xl flex items-center gap-2 transition-all shadow-lg"
                >
                  {store.isProcessing ? '判定基準を抽出中...' : '判断指標を抽出'}
                  {!store.isProcessing && <ArrowRightIcon />}
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: Data Extraction */}
          {store.currentStep === Step.DATA_EXTRACTION && (
            <div className="space-y-6 animate-in slide-in-from-right-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                  <FileTextIcon className="text-blue-600" />
                  Step 3: 数値・事実情報の抽出
                </h2>
                <div className="bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-1 rounded-md border border-amber-200">
                  高精度解析モード: 資料を細分化してスキャンします
                </div>
              </div>
              <p className="text-slate-500 text-sm mb-6">有価証券報告書やCG報告書などの資料を読み込ませ、各ファイルごとに数値を検索します。</p>
              
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-1 space-y-4">
                  <div className="bg-blue-50 p-5 rounded-2xl border border-blue-100">
                    <h3 className="font-bold text-blue-800 text-sm mb-4">対象とする判断指標:</h3>
                    <div className="space-y-6 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                      {store.agendaItems.map((agenda) => {
                        const agendaIndicators = store.indicators.filter(i => i.agendaId === agenda.id);
                        if (agendaIndicators.length === 0) return null;
                        return (
                          <div key={agenda.id} className="space-y-2 pb-4 border-b border-blue-100 last:border-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-black bg-blue-600 text-white px-1.5 py-0.5 rounded leading-none">{agenda.id}</span>
                              <div className="text-[11px] font-bold text-slate-700 truncate">{agenda.title}</div>
                            </div>
                            <div className="space-y-2 pl-4">
                              {agendaIndicators.map(ind => (
                                <div key={ind.id} className="bg-white p-2.5 rounded-xl border border-blue-100 shadow-sm text-[11px]">
                                  <div className="font-bold text-slate-800 mb-1">{ind.metricName}</div>
                                  <div className="text-blue-600 bg-blue-50 px-2 py-0.5 rounded inline-block font-bold border border-blue-50/50">
                                    基準: {ind.threshold}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                      {store.indicators.length === 0 && (
                        <div className="text-center py-10 text-slate-400 text-xs italic">
                          判断指標が抽出されていません。
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-2 space-y-4">
                  <div className="border-2 border-dashed border-slate-200 rounded-2xl p-8 bg-slate-50 text-center">
                    <input
                      type="file"
                      id="evidence-upload"
                      className="hidden"
                      multiple
                      accept=".pdf"
                      onChange={(e) => handleFileChange(e, 'evidence')}
                    />
                    <label htmlFor="evidence-upload" className="cursor-pointer group">
                      <UploadIcon className="mx-auto w-10 h-10 text-slate-300 mb-3 group-hover:text-blue-500" />
                      <p className="text-slate-600 font-bold">追加資料 (有報・CG報告書等)</p>
                      <p className="text-xs text-slate-400 mt-1">※招集通知は自動的に解析対象に含まれます</p>
                    </label>
                    {store.evidenceFiles.length > 0 && (
                      <div className="mt-6 text-left">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">選択済みのファイル</p>
                          <span className="text-[10px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full font-bold">{store.evidenceFiles.length} files</span>
                        </div>
                        <div className="space-y-2 max-h-40 overflow-y-auto">
                          {store.evidenceFiles.map((f, idx) => (
                            <div key={idx} className="bg-white p-2.5 rounded-xl flex justify-between items-center shadow-sm border border-slate-100 group/item">
                              <span className="text-xs text-slate-700 font-medium truncate flex-1 mr-4">{f.name}</span>
                              <button onClick={() => store.removeEvidenceFile(idx)} className="text-slate-300 hover:text-red-500 transition-colors p-1">
                                <XIcon className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {store.isProcessing && (
                    <div className="bg-blue-600/10 p-5 rounded-2xl border border-blue-200 shadow-inner">
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-xs font-black text-blue-700 uppercase tracking-widest">AI分析中...</span>
                        <span className="text-sm font-bold text-blue-700">{progress}%</span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-3 mb-4 overflow-hidden">
                        <div className="bg-blue-600 h-full rounded-full transition-all duration-500 shadow-sm" style={{ width: `${progress}%` }}></div>
                      </div>
                      <div className="flex items-start gap-3 p-3 bg-white/50 rounded-xl border border-blue-100/50">
                        <div className="mt-1 animate-spin w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full shrink-0"></div>
                        <p className="text-[11px] text-blue-800 leading-relaxed font-medium">
                          {statusMessage || "精密スキャン準備中..."}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-between pt-8 border-t border-slate-100">
                <button onClick={() => store.setStep(Step.GUIDELINE_INDICATORS)} className="text-slate-400 hover:text-slate-600 font-bold transition-colors">戻る</button>
                <button
                  onClick={processStep3}
                  disabled={store.isProcessing}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 text-white font-bold py-4 px-10 rounded-2xl flex items-center gap-2 transition-all shadow-lg"
                >
                  {store.isProcessing ? '高精度抽出を実行中...' : '抽出プロセスを開始'}
                  {!store.isProcessing && <ArrowRightIcon />}
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: Final Decision */}
          {store.currentStep === Step.FINAL_DECISION && (
            <div className="space-y-8 animate-in slide-in-from-right-4">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                  <CheckIcon className="text-green-600" />
                  Step 4: 総合賛否判断の生成
                </h2>
                <span className="text-xs font-bold px-3 py-1 bg-green-100 text-green-700 rounded-full">エビデンス抽出完了</span>
              </div>
              
              <div className="space-y-6">
                {store.agendaItems.map((agenda) => {
                  const agendaIndicators = store.indicators.filter(i => i.agendaId === agenda.id);
                  return (
                    <div key={agenda.id} className="border border-slate-100 rounded-3xl overflow-hidden bg-slate-50 shadow-sm transition-all hover:shadow-md">
                      <div className="bg-slate-800 px-6 py-4 flex justify-between items-center">
                        <div>
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-0.5">議案番号</span>
                          <h3 className="text-white font-bold">{agenda.number}: {agenda.title}</h3>
                        </div>
                      </div>
                      <div className="p-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {agendaIndicators.map(ind => {
                            const fact = store.facts.find(f => f.indicatorId === ind.id);
                            return (
                              <div key={ind.id} className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm relative overflow-hidden group">
                                <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-20 transition-opacity">
                                  <FileTextIcon className="w-12 h-12" />
                                </div>
                                <div className="font-bold text-slate-800 text-sm mb-1">{ind.metricName}</div>
                                <div className="text-[10px] text-slate-400 font-bold mb-3 uppercase">判定基準: {ind.threshold}</div>
                                <div className="bg-blue-50/50 p-3 rounded-xl border border-blue-50">
                                  <p className="text-xs text-blue-800 font-medium leading-relaxed whitespace-pre-wrap">
                                    <span className="font-bold text-blue-600 mr-1 block mb-1">抽出された事実・数値:</span>
                                    {fact?.factualValue || '資料に記載なし'}
                                  </p>
                                  {fact && fact.factualValue !== '記載なし' && (
                                    <div className="mt-3 pt-2 border-t border-blue-100/50 flex flex-wrap gap-2">
                                      {fact.evidenceSource.split(', ').map((src, i) => (
                                        <span key={i} className="text-[10px] font-bold text-blue-400 bg-white/60 px-2 py-1 rounded-md border border-blue-100">
                                          {src}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                          {agendaIndicators.length === 0 && (
                            <div className="md:col-span-2 text-center py-6 text-slate-400 italic text-sm">
                              この議案に関する特定の判断指標はガイドラインから抽出されませんでした。
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-between pt-10 border-t border-slate-100">
                <button onClick={() => store.setStep(Step.DATA_EXTRACTION)} className="text-slate-400 hover:text-slate-600 font-bold transition-colors">戻る</button>
                <button
                  onClick={processStep4}
                  disabled={store.isProcessing}
                  className="bg-green-600 hover:bg-green-700 disabled:bg-slate-200 text-white font-bold py-5 px-12 rounded-2xl flex items-center gap-2 transition-all shadow-xl shadow-green-100"
                >
                  {store.isProcessing ? '論理モデルで判定中...' : '総合判断ロジックを実行'}
                  {!store.isProcessing && <CheckIcon />}
                </button>
              </div>
            </div>
          )}

          {/* STEP 5: Export */}
          {store.currentStep === Step.EXPORT && (
            <div className="space-y-10 animate-in fade-in duration-700">
              <div className="text-center max-w-2xl mx-auto">
                <div className="inline-flex items-center justify-center w-20 h-20 bg-green-100 text-green-600 rounded-full mb-6">
                  <CheckIcon className="w-10 h-10" />
                </div>
                <h2 className="text-3xl font-extrabold text-slate-900 mb-2">解析レポート完成</h2>
                <p className="text-slate-500">全ての議案に対して、ガイドラインと事実に基づいた論理的な判断が完了しました。</p>
              </div>

              <div className="grid grid-cols-1 gap-6">
                {store.decisions.map((decision) => {
                  const agenda = store.agendaItems.find(a => a.id === decision.agendaId);
                  return (
                    <div key={decision.agendaId} className={`relative border-2 rounded-3xl p-8 overflow-hidden transition-all hover:shadow-lg ${decision.isApproved ? 'border-green-100 bg-green-50/30' : 'border-red-100 bg-red-50/30'}`}>
                      <div className={`absolute top-0 right-0 px-8 py-2 font-black text-xs uppercase tracking-widest rounded-bl-2xl shadow-sm ${decision.isApproved ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
                        {decision.isApproved ? 'APPROVE (賛成)' : 'OPPOSE (反対)'}
                      </div>
                      
                      <div className="mb-6">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">{agenda?.number}</span>
                        <h3 className="text-xl font-bold text-slate-900 pr-24">{agenda?.title}</h3>
                        <p className="text-slate-600 font-bold mt-2 text-sm">{decision.reason}</p>
                      </div>

                      <div className="bg-white/80 backdrop-blur-sm p-6 rounded-2xl border border-white shadow-sm">
                        <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 border-b border-slate-100 pb-2">判定ロジック詳細</h4>
                        <p className="text-sm leading-relaxed text-slate-800 whitespace-pre-wrap">{decision.detailedLogic}</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-col sm:flex-row gap-6 justify-center items-center py-10 border-t border-slate-100">
                <button
                  onClick={exportToCSV}
                  className="w-full sm:w-auto bg-slate-900 hover:bg-black text-white font-bold py-5 px-12 rounded-2xl flex items-center justify-center gap-3 transition-all shadow-xl active:scale-95"
                >
                  <DownloadIcon className="w-5 h-5" />
                  判定レポート(CSV)をダウンロード
                </button>
                <button
                  onClick={() => store.reset()}
                  className="text-slate-400 hover:text-slate-900 font-bold transition-colors text-sm underline underline-offset-4"
                >
                  新しい解析を開始する
                </button>
              </div>
            </div>
          )}
        </main>

        <footer className="mt-12 text-center text-slate-400 text-sm font-medium">
          &copy; {new Date().getFullYear()} Voter Decision Support MVP - 高精度AI議決権行使支援
        </footer>
      </div>
      
      {/* Loading Overlay */}
      {store.isProcessing && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md z-50 flex items-center justify-center animate-in fade-in duration-300">
          <div className="bg-white p-10 rounded-3xl shadow-2xl text-center max-w-sm w-full">
            <div className="relative w-20 h-20 mx-auto mb-6">
              <div className="absolute inset-0 border-4 border-blue-100 rounded-full"></div>
              <div className="absolute inset-0 border-4 border-blue-600 rounded-full border-t-transparent animate-spin"></div>
            </div>
            <p className="font-bold text-slate-900 text-lg mb-2">AIが高精度解析中...</p>
            <div className="text-slate-500 text-sm space-y-2">
              <p>巨大なドキュメントをページごとに細分化し、1項目ずつ執念深くスキャンしています。</p>
              {progress > 0 && (
                <div className="mt-4">
                  <div className="w-full bg-slate-100 rounded-full h-2 mb-2">
                    <div className="bg-blue-600 h-2 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
                  </div>
                  <p className="text-[10px] font-bold text-blue-600 uppercase tracking-tighter">
                    {statusMessage || `進捗: ${progress}%`}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
