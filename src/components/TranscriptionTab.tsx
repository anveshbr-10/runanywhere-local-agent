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
}

export function TranscriptionTab() {
  const vadLoader = useModelLoader(ModelCategory.Audio, true);
  const sttLoader = useModelLoader(ModelCategory.SpeechRecognition, true);

  const [isRecording, setIsRecording] = useState(false);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [currentSegment, setCurrentSegment] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ totalSegments: 0, totalWords: 0, duration: 0 });

  const micRef = useRef<AudioCapture | null>(null);
  const vadUnsub = useRef<(() => void) | null>(null);
  const segmentIdRef = useRef(0);
  const startTimeRef = useRef<Date | null>(null);
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
      // Import STT from the ONNX package
      const { STT } = await import('@runanywhere/web-onnx');
      
      const result = await STT.transcribe(audioData);
      
      if (result.text && result.text.trim()) {
        const segment: TranscriptSegment = {
          id: segmentIdRef.current++,
          text: result.text.trim(),
          timestamp: startTime,
          duration: result.processingTimeMs,
        };

        setSegments((prev) => [...prev, segment]);
        setStats((prev) => ({
          totalSegments: prev.totalSegments + 1,
          totalWords: prev.totalWords + result.text.trim().split(/\s+/).length,
          duration: prev.duration + result.processingTimeMs,
        }));
      }
    } catch (err) {
      console.error('Transcription error:', err);
      setError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setCurrentSegment('');
      setIsProcessing(false);
    }
  }, []);

  const startRecording = useCallback(async () => {
    setSegments([]);
    setCurrentSegment('');
    setError(null);
    setStats({ totalSegments: 0, totalWords: 0, duration: 0 });
    segmentIdRef.current = 0;

    // Ensure models are loaded
    const anyMissing =
      !ModelManager.getLoadedModel(ModelCategory.Audio) ||
      !ModelManager.getLoadedModel(ModelCategory.SpeechRecognition);

    if (anyMissing) {
      const ok = await ensureModels();
      if (!ok) return;
    }

    setIsRecording(true);
    startTimeRef.current = new Date();

    const mic = new AudioCapture({ sampleRate: 16000 });
    micRef.current = mic;

    VAD.reset();

    vadUnsub.current = VAD.onSpeechActivity((activity) => {
      if (activity === SpeechActivity.Started) {
        setCurrentSegment('Listening...');
      } else if (activity === SpeechActivity.Ended) {
        const segment = VAD.popSpeechSegment();
        if (segment && segment.samples.length > 1600) {
          // Minimum 100ms of audio
          processAudioSegment(segment.samples, new Date(segment.startTime * 1000));
        }
      }
    });

    await mic.start(
      (chunk) => {
        VAD.processSamples(chunk);
      },
      (level) => {
        setAudioLevel(level);
      }
    );
  }, [ensureModels, processAudioSegment]);

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
    setStats({ totalSegments: 0, totalWords: 0, duration: 0 });
    segmentIdRef.current = 0;
  }, []);

  const exportTranscript = useCallback(() => {
    const text = segments
      .map((seg) => {
        const time = seg.timestamp.toLocaleTimeString();
        return `[${time}] ${seg.text}`;
      })
      .join('\n\n');

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [segments]);

  const copyToClipboard = useCallback(() => {
    const text = segments.map((seg) => seg.text).join(' ');
    navigator.clipboard.writeText(text).then(() => {
      alert('Transcript copied to clipboard!');
    });
  }, [segments]);

  const pendingLoaders = [
    { label: 'VAD', loader: vadLoader },
    { label: 'STT', loader: sttLoader },
  ].filter((l) => l.loader.state !== 'ready');

  return (
    <div className="tab-panel transcription-panel">
      {pendingLoaders.length > 0 && !isRecording && (
        <ModelBanner
          state={pendingLoaders[0].loader.state}
          progress={pendingLoaders[0].loader.progress}
          error={pendingLoaders[0].loader.error}
          onLoad={ensureModels}
          label={`Transcription (${pendingLoaders.map((l) => l.label).join(', ')})`}
        />
      )}

      {error && (
        <div className="model-banner">
          <span className="error-text">{error}</span>
        </div>
      )}

      <div className="transcription-header">
        <h2>Real-Time Transcription</h2>
        <p>Automatic speech-to-text with voice activity detection</p>
      </div>

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
            <button className="btn" onClick={copyToClipboard}>
              Copy Text
            </button>
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
          <span>Recording</span>
          <div className="audio-level-bar">
            <div className="audio-level-fill" style={{ width: `${audioLevel * 100}%` }} />
          </div>
        </div>
      )}

      {(segments.length > 0 || currentSegment) && (
        <div className="stats-bar">
          <span>{stats.totalSegments} segments</span>
          <span>{stats.totalWords} words</span>
          <span>
            {stats.duration > 0 ? `${(stats.duration / 1000).toFixed(1)}s processing` : ''}
          </span>
        </div>
      )}

      <div className="transcript-container" ref={listRef}>
        {segments.length === 0 && !currentSegment && (
          <div className="empty-state">
            <h3>Start Recording to Transcribe</h3>
            <p>Click the button above to begin real-time speech-to-text transcription</p>
            <ul className="feature-list">
              <li>Automatic speech detection with VAD</li>
              <li>Real-time transcription as you speak</li>
              <li>Export to text file</li>
              <li>100% private - all processing on-device</li>
            </ul>
          </div>
        )}

        {segments.map((segment) => (
          <div key={segment.id} className="transcript-segment">
            <div className="segment-time">{segment.timestamp.toLocaleTimeString()}</div>
            <div className="segment-text">{segment.text}</div>
          </div>
        ))}

        {currentSegment && (
          <div className="transcript-segment current">
            <div className="segment-time">{new Date().toLocaleTimeString()}</div>
            <div className="segment-text processing">{currentSegment}</div>
          </div>
        )}
      </div>
    </div>
  );
}
