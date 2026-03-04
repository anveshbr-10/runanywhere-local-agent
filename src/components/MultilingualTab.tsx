import { useState, useRef, useEffect, useCallback } from 'react';
import { ModelCategory, ModelManager, AudioCapture, SpeechActivity } from '@runanywhere/web';
import { VAD } from '@runanywhere/web-onnx';
import { useModelLoader } from '../hooks/useModelLoader';
import { ModelBanner } from './ModelBanner';

interface TranscriptSegment {
  id: number;
  text: string;
  timestamp: Date;
  duration: number;
  language: string;
}

interface LanguageOption {
  code: string;
  name: string;
  nativeName: string;
  available: boolean;
  modelSize?: string;
  script?: string;
}

// Comprehensive list of Indian languages supported by Whisper
const INDIAN_LANGUAGES: LanguageOption[] = [
  { code: 'en', name: 'English', nativeName: 'English', available: true, modelSize: '105MB' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', available: false, modelSize: '~200MB', script: 'Devanagari' },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', available: false, modelSize: '~200MB', script: 'Kannada' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', available: false, modelSize: '~200MB', script: 'Tamil' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', available: false, modelSize: '~200MB', script: 'Telugu' },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', available: false, modelSize: '~200MB', script: 'Malayalam' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', available: false, modelSize: '~200MB', script: 'Bengali' },
  { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી', available: false, modelSize: '~200MB', script: 'Gujarati' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी', available: false, modelSize: '~200MB', script: 'Devanagari' },
  { code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', available: false, modelSize: '~200MB', script: 'Gurmukhi' },
  { code: 'ur', name: 'Urdu', nativeName: 'اُردُو', available: false, modelSize: '~200MB', script: 'Arabic' },
];

const KANNADA_DEMO_TEXT = `ಮಾದರಿ ಪಠ್ಯ (Sample Text):

"ನಮಸ್ಕಾರ, ಇದು ರನ್ ಅನಿವೇರ್ SDK ಬಳಸಿದ ಕನ್ನಡ ಭಾಷಣ ಗುರುತಿಸುವಿಕೆ ಡೆಮೋ"

Translation:
"Hello, this is a Kannada speech recognition demo using RunAnywhere SDK"`;

export function MultilingualTab() {
  const vadLoader = useModelLoader(ModelCategory.Audio, true);
  const sttLoader = useModelLoader(ModelCategory.SpeechRecognition, true);

  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  const [isRecording, setIsRecording] = useState(false);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [currentSegment, setCurrentSegment] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  const micRef = useRef<AudioCapture | null>(null);
  const vadUnsub = useRef<(() => void) | null>(null);
  const segmentIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [segments, currentSegment]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      micRef.current?.stop();
      vadUnsub.current?.();
    };
  }, []);

  const ensureModels = useCallback(async (): Promise<boolean> => {
    setError(null);
    const results = await Promise.all([vadLoader.ensure(), sttLoader.ensure()]);
    if (!results.every(Boolean)) {
      setError('Failed to load required models');
      return false;
    }
    return true;
  }, [vadLoader, sttLoader]);

  const processAudioSegment = useCallback(async (audioData: Float32Array, startTime: Date) => {
    setIsProcessing(true);
    setCurrentSegment('Transcribing...');

    try {
      const { STT } = await import('@runanywhere/web-onnx');
      const result = await STT.transcribe(audioData);

      if (result.text && result.text.trim()) {
        const segment: TranscriptSegment = {
          id: segmentIdRef.current++,
          text: result.text.trim(),
          timestamp: startTime,
          duration: result.processingTimeMs,
          language: selectedLanguage,
        };

        setSegments((prev) => [...prev, segment]);
      }
    } catch (err) {
      console.error('Transcription error:', err);
      setError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setCurrentSegment('');
      setIsProcessing(false);
    }
  }, [selectedLanguage]);

  const startRecording = useCallback(async () => {
    const language = INDIAN_LANGUAGES.find((l) => l.code === selectedLanguage);
    
    if (!language?.available) {
      setError(`${language?.name || 'Selected language'} model is not available yet. Currently only English is supported.`);
      setShowInfo(true);
      return;
    }

    setSegments([]);
    setCurrentSegment('');
    setError(null);
    segmentIdRef.current = 0;

    const anyMissing =
      !ModelManager.getLoadedModel(ModelCategory.Audio) ||
      !ModelManager.getLoadedModel(ModelCategory.SpeechRecognition);

    if (anyMissing) {
      const ok = await ensureModels();
      if (!ok) return;
    }

    setIsRecording(true);

    const mic = new AudioCapture({ sampleRate: 16000 });
    micRef.current = mic;

    VAD.reset();

    vadUnsub.current = VAD.onSpeechActivity((activity) => {
      if (activity === SpeechActivity.Started) {
        setCurrentSegment('Listening...');
      } else if (activity === SpeechActivity.Ended) {
        const segment = VAD.popSpeechSegment();
        if (segment && segment.samples.length > 1600) {
          processAudioSegment(segment.samples, new Date(segment.startTime * 1000));
        }
      }
    });

    await mic.start(
      (chunk: Float32Array) => {
        VAD.processSamples(chunk);
      },
      (level: number) => {
        setAudioLevel(level);
      }
    );
  }, [selectedLanguage, ensureModels, processAudioSegment]);

  const stopRecording = useCallback(() => {
    micRef.current?.stop();
    vadUnsub.current?.();
    VAD.reset();
    setIsRecording(false);
    setCurrentSegment('');
    setAudioLevel(0);
  }, []);

  const clearTranscript = useCallback(() => {
    setSegments([]);
    setCurrentSegment('');
    segmentIdRef.current = 0;
  }, []);

  const exportTranscript = useCallback(() => {
    const text = segments
      .map((seg) => {
        const time = seg.timestamp.toLocaleTimeString();
        return `[${time}] [${seg.language.toUpperCase()}] ${seg.text}`;
      })
      .join('\n\n');

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-multilingual-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [segments]);

  const selectedLang = INDIAN_LANGUAGES.find((l) => l.code === selectedLanguage);

  const pendingLoaders = [
    { label: 'VAD', loader: vadLoader },
    { label: 'STT', loader: sttLoader },
  ].filter((l) => l.loader.state !== 'ready');

  return (
    <div className="tab-panel multilingual-panel">
      {pendingLoaders.length > 0 && !isRecording && (
        <ModelBanner
          state={pendingLoaders[0].loader.state}
          progress={pendingLoaders[0].loader.progress}
          error={pendingLoaders[0].loader.error}
          onLoad={ensureModels}
          label={`Multilingual (${pendingLoaders.map((l) => l.label).join(', ')})`}
        />
      )}

      {error && (
        <div className="model-banner">
          <span className="error-text">{error}</span>
        </div>
      )}

      <div className="multilingual-header">
        <h2>Multilingual Speech Recognition</h2>
        <p>Support for Indian languages including Kannada (ಕನ್ನಡ)</p>
        <button className="btn btn-sm" onClick={() => setShowInfo(!showInfo)}>
          {showInfo ? 'Hide' : 'Show'} Setup Guide
        </button>
      </div>

      {showInfo && (
        <div className="info-box">
          <h3>🌍 Multilingual Support Architecture</h3>
          
          <div className="info-section">
            <h4>Current Status:</h4>
            <ul>
              <li>✅ <strong>English</strong>: Fully supported with sherpa-onnx Whisper Tiny</li>
              <li>⏳ <strong>Kannada & Other Indian Languages</strong>: Architecture ready, awaiting models</li>
            </ul>
          </div>

          <div className="info-section">
            <h4>How to Add Kannada Support:</h4>
            <ol>
              <li><strong>Get the model</strong>: Download fine-tuned Kannada Whisper from HuggingFace:
                <code>vasista22/whisper-kannada-tiny</code> or <code>steja/whisper-small-kannada</code>
              </li>
              <li><strong>Convert to ONNX</strong>: Use sherpa-onnx conversion tools to create .onnx files</li>
              <li><strong>Package for web</strong>: Create .tar.gz archive with model files</li>
              <li><strong>Upload</strong>: Host on HuggingFace or CDN</li>
              <li><strong>Register</strong>: Add to <code>src/runanywhere.ts</code> model catalog</li>
            </ol>
          </div>

          <div className="info-section">
            <h4>Kannada Example Text:</h4>
            <div className="kannada-demo">
              <pre>{KANNADA_DEMO_TEXT}</pre>
            </div>
          </div>

          <div className="info-section">
            <h4>Technical Requirements:</h4>
            <ul>
              <li>Model Format: sherpa-onnx compatible ONNX</li>
              <li>Sample Rate: 16kHz mono audio</li>
              <li>Languages: Any Whisper-supported language (100+ languages)</li>
              <li>Model Size: ~75-200MB depending on quality tier</li>
            </ul>
          </div>

          <div className="info-section">
            <h4>Resources:</h4>
            <ul>
              <li>🔗 <a href="https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/index.html" target="_blank">Sherpa-ONNX Whisper Models</a></li>
              <li>🔗 <a href="https://huggingface.co/vasista22/whisper-kannada-tiny" target="_blank">Kannada Whisper Model (HF)</a></li>
              <li>🔗 <a href="https://github.com/k2-fsa/sherpa-onnx" target="_blank">Sherpa-ONNX GitHub</a></li>
            </ul>
          </div>
        </div>
      )}

      <div className="language-selector">
        <h3>Select Language:</h3>
        <div className="language-grid">
          {INDIAN_LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              className={`language-card ${selectedLanguage === lang.code ? 'selected' : ''} ${!lang.available ? 'disabled' : ''}`}
              onClick={() => lang.available && setSelectedLanguage(lang.code)}
              disabled={!lang.available}
            >
              <div className="language-card-header">
                <span className="language-name">{lang.name}</span>
                {lang.available ? (
                  <span className="status-badge available">Available</span>
                ) : (
                  <span className="status-badge coming-soon">Coming Soon</span>
                )}
              </div>
              <div className="language-card-native">{lang.nativeName}</div>
              {lang.script && <div className="language-card-script">Script: {lang.script}</div>}
              {lang.modelSize && <div className="language-card-size">{lang.modelSize}</div>}
            </button>
          ))}
        </div>
      </div>

      {selectedLang && (
        <div className="selected-language-info">
          <strong>Selected:</strong> {selectedLang.name} ({selectedLang.nativeName})
          {!selectedLang.available && (
            <span className="info-text"> - Model not yet available. See setup guide above.</span>
          )}
        </div>
      )}

      <div className="transcription-controls">
        {!isRecording ? (
          <button className="btn btn-primary btn-lg" onClick={startRecording}>
            Start Recording
          </button>
        ) : (
          <button className="btn btn-warning btn-lg" onClick={stopRecording}>
            Stop Recording
          </button>
        )}

        {segments.length > 0 && !isRecording && (
          <>
            <button className="btn" onClick={exportTranscript}>
              Export
            </button>
            <button className="btn btn-secondary" onClick={clearTranscript}>
              Clear
            </button>
          </>
        )}
      </div>

      {isRecording && (
        <div className="recording-indicator">
          <div className="recording-dot" />
          <span>Recording in {selectedLang?.name}</span>
          <div className="audio-level-bar">
            <div className="audio-level-fill" style={{ width: `${audioLevel * 100}%` }} />
          </div>
        </div>
      )}

      <div className="transcript-container" ref={listRef}>
        {segments.length === 0 && !currentSegment && (
          <div className="empty-state">
            <h3>Multilingual Transcription Ready</h3>
            <p>Select a language and start recording</p>
            <ul className="feature-list">
              <li>Support for 11 Indian languages planned</li>
              <li>Automatic script detection</li>
              <li>Real-time transcription</li>
              <li>Export with language tags</li>
            </ul>
          </div>
        )}

        {segments.map((segment) => (
          <div key={segment.id} className="transcript-segment multilingual">
            <div className="segment-header">
              <div className="segment-time">{segment.timestamp.toLocaleTimeString()}</div>
              <div className="segment-lang-badge">{segment.language.toUpperCase()}</div>
            </div>
            <div className="segment-text">{segment.text}</div>
          </div>
        ))}

        {currentSegment && (
          <div className="transcript-segment current">
            <div className="segment-header">
              <div className="segment-time">{new Date().toLocaleTimeString()}</div>
              <div className="segment-lang-badge">{selectedLanguage.toUpperCase()}</div>
            </div>
            <div className="segment-text processing">{currentSegment}</div>
          </div>
        )}
      </div>
    </div>
  );
}
