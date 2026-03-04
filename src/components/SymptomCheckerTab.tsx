import { useState, useRef, useEffect, useCallback } from 'react';
import { ModelCategory } from '@runanywhere/web';
import { TextGeneration } from '@runanywhere/web-llamacpp';
import { useModelLoader } from '../hooks/useModelLoader';
import { ModelBanner } from './ModelBanner';

interface SymptomAnalysis {
  symptoms: string;
  analysis: string;
  possibleConditions?: string[];
  recommendations?: string[];
  disclaimer?: string;
  stats?: { tokens: number; tokPerSec: number; latencyMs: number };
}

const MEDICAL_SYSTEM_PROMPT = `You are a helpful medical symptom analyzer assistant. Your role is to:
1. Listen carefully to patient symptoms
2. Provide general information about possible conditions
3. Suggest home remedies and self-care measures when appropriate
4. Always recommend seeking professional medical care for serious symptoms

IMPORTANT DISCLAIMERS:
- You are NOT a replacement for professional medical advice
- Always encourage patients to consult healthcare providers
- For emergencies (chest pain, difficulty breathing, severe bleeding, etc.), immediately advise calling emergency services
- Provide general educational information only

Format your response as:
**Possible Conditions:** [List potential conditions based on symptoms]
**General Information:** [Educational info about the conditions]
**Home Care Recommendations:** [Self-care measures if appropriate]
**When to Seek Medical Care:** [Warning signs requiring immediate attention]
**Disclaimer:** This is general information only. Please consult a healthcare provider for proper diagnosis and treatment.`;

export function SymptomCheckerTab() {
  const loader = useModelLoader(ModelCategory.Language);
  const [history, setHistory] = useState<SymptomAnalysis[]>([]);
  const [input, setInput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [currentAnalysis, setCurrentAnalysis] = useState('');
  const cancelRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when analysis changes
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [history, currentAnalysis]);

  const analyzeSymptoms = useCallback(async () => {
    const symptoms = input.trim();
    if (!symptoms || analyzing) return;

    // Ensure model is loaded
    if (loader.state !== 'ready') {
      const ok = await loader.ensure();
      if (!ok) return;
    }

    setInput('');
    setAnalyzing(true);
    setCurrentAnalysis('');

    // Build the prompt with medical context
    const prompt = `${MEDICAL_SYSTEM_PROMPT}

Patient's symptoms: ${symptoms}

Please provide a comprehensive analysis following the format specified above:`;

    try {
      const { stream, result: resultPromise, cancel } = await TextGeneration.generateStream(prompt, {
        maxTokens: 1024,
        temperature: 0.7,
        topP: 0.9,
      });
      cancelRef.current = cancel;

      let accumulated = '';
      for await (const token of stream) {
        accumulated += token;
        setCurrentAnalysis(accumulated);
      }

      const result = await resultPromise;
      const finalText = result.text || accumulated;
      
      // Add to history
      setHistory((prev) => [
        ...prev,
        {
          symptoms,
          analysis: finalText,
          stats: {
            tokens: result.tokensUsed,
            tokPerSec: result.tokensPerSecond,
            latencyMs: result.latencyMs,
          },
        },
      ]);
      
      setCurrentAnalysis('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setHistory((prev) => [
        ...prev,
        {
          symptoms,
          analysis: `Error analyzing symptoms: ${msg}. Please try again or consult a healthcare provider.`,
        },
      ]);
      setCurrentAnalysis('');
    } finally {
      cancelRef.current = null;
      setAnalyzing(false);
    }
  }, [input, analyzing, loader]);

  const handleCancel = () => {
    cancelRef.current?.();
  };

  const clearHistory = () => {
    setHistory([]);
  };

  return (
    <div className="tab-panel symptom-panel">
      <ModelBanner
        state={loader.state}
        progress={loader.progress}
        error={loader.error}
        onLoad={loader.ensure}
        label="Medical AI"
      />

      <div className="symptom-header">
        <h2>Local Medical Symptom Checker</h2>
        <p className="disclaimer">
          This tool provides general health information only. It is not a substitute for professional medical advice, 
          diagnosis, or treatment. Always seek the advice of your physician or other qualified health provider with any 
          questions you may have regarding a medical condition.
        </p>
      </div>

      <div className="analysis-list" ref={listRef}>
        {history.length === 0 && !currentAnalysis && (
          <div className="empty-state">
            <h3>Describe Your Symptoms</h3>
            <p>Enter your symptoms below to receive general health information and recommendations.</p>
            <div className="example-symptoms">
              <strong>Examples:</strong>
              <ul>
                <li>"I have a headache and feel dizzy"</li>
                <li>"Sore throat, cough, and fever for 2 days"</li>
                <li>"Stomach pain after eating"</li>
                <li>"Trouble sleeping and feeling anxious"</li>
              </ul>
            </div>
          </div>
        )}

        {history.map((item, i) => (
          <div key={i} className="symptom-analysis">
            <div className="symptom-input">
              <strong>Symptoms:</strong> {item.symptoms}
            </div>
            <div className="symptom-response">
              <div className="analysis-text">{item.analysis}</div>
              {item.stats && (
                <div className="analysis-stats">
                  Generated {item.stats.tokens} tokens at {item.stats.tokPerSec.toFixed(1)} tok/s
                </div>
              )}
            </div>
          </div>
        ))}

        {currentAnalysis && (
          <div className="symptom-analysis">
            <div className="symptom-input">
              <strong>Symptoms:</strong> {input}
            </div>
            <div className="symptom-response">
              <div className="analysis-text analyzing">{currentAnalysis || 'Analyzing...'}</div>
            </div>
          </div>
        )}
      </div>

      <div className="symptom-controls">
        {history.length > 0 && !analyzing && (
          <button type="button" className="btn btn-secondary" onClick={clearHistory}>
            Clear History
          </button>
        )}
      </div>

      <form
        className="symptom-input-form"
        onSubmit={(e) => { e.preventDefault(); analyzeSymptoms(); }}
      >
        <textarea
          placeholder="Describe your symptoms in detail... (e.g., headache for 3 days, fever, body aches)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={analyzing}
          rows={3}
        />
        <div className="input-actions">
          {analyzing ? (
            <button type="button" className="btn btn-warning" onClick={handleCancel}>
              Stop Analysis
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
              Analyze Symptoms
            </button>
          )}
        </div>
      </form>

      <div className="emergency-notice">
        <strong>⚠️ Emergency Warning:</strong> If you are experiencing chest pain, difficulty breathing, 
        severe bleeding, or other life-threatening symptoms, call emergency services immediately (911 in US) 
        or go to the nearest emergency room.
      </div>
    </div>
  );
}
