import { useState, useRef, useEffect, useCallback } from 'react';
import { ModelCategory, ModelManager, AudioCapture } from '@runanywhere/web';
import { useModelLoader } from '../hooks/useModelLoader';
import { ModelBanner } from './ModelBanner';

interface TranscriptSegment {
  id: number;
  text: string;
  timestamp: Date;
  duration: number;
  confidence?: number;
  isEndpoint: boolean;
}

interface STTStreamingSession {
  acceptWaveform(samples: Float32Array, sampleRate?: number): void;
  inputFinished(): void;
  getResult(): { text: string; isEndpoint: boolean };
  reset(): void;
  destroy(): void;
}

function concatAudioChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

export function TranscriptionTab() {
  const sttLoader = useModelLoader(ModelCategory.SpeechRecognition, true);

  const [isRecording, setIsRecording] = useState(false);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [currentText, setCurrentText] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ 
    totalSegments: 0, 
    totalWords: 0, 
    sessionDuration: 0,
    avgConfidence: 0 
  });

  const micRef = useRef<AudioCapture | null>(null);
  const sessionRef = useRef<STTStreamingSession | null>(null);
  const segmentIdRef = useRef(0);
  const startTimeRef = useRef<Date | null>(null);
  const segmentStartRef = useRef<Date | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const confidenceBufferRef = useRef<number[]>([]);
  const audioChunksRef = useRef<Float32Array[]>([]);
  const previewBusyRef = useRef(false);
  const lastPreviewAtRef = useRef(0);

  // Auto-scroll to bottom
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [segments, currentText]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      micRef.current?.stop();
      sessionRef.current?.destroy();
    };
  }, []);

  const ensureModels = useCallback(async (): Promise<boolean> => {
    setError(null);
    const ok = await sttLoader.ensure();
    if (!ok) {
      setError('Failed to load STT model');
      return false;
    }
    return true;
  }, [sttLoader]);

  const calculateConfidence = (text: string): number => {
    // Heuristic confidence based on text characteristics
    if (!text || text.length < 2) return 0.5;
    
    const hasCapitalization = /[A-Z]/.test(text);
    const hasPunctuation = /[.!?,;:]/.test(text);
    const avgWordLength = text.split(' ').reduce((sum, word) => sum + word.length, 0) / text.split(' ').length;
    const hasNumbers = /\d/.test(text);
    
    let confidence = 0.7; // Base confidence
    if (hasCapitalization) confidence += 0.05;
    if (hasPunctuation) confidence += 0.05;
    if (avgWordLength > 4) confidence += 0.1;
    if (hasNumbers) confidence += 0.05;
    if (text.length > 20) confidence += 0.05;
    
    return Math.min(confidence, 1.0);
  };

  const startRecording = useCallback(async () => {
    setSegments([]);
    setCurrentText('');
    setError(null);
    setStats({ totalSegments: 0, totalWords: 0, sessionDuration: 0, avgConfidence: 0 });
    segmentIdRef.current = 0;
    confidenceBufferRef.current = [];
    audioChunksRef.current = [];
    previewBusyRef.current = false;
    lastPreviewAtRef.current = 0;

    // Ensure model is loaded
    const anyMissing = !ModelManager.getLoadedModel(ModelCategory.SpeechRecognition);

    if (anyMissing) {
      const ok = await ensureModels();
      if (!ok) return;
    }

    setIsRecording(true);
    startTimeRef.current = new Date();
    segmentStartRef.current = new Date();

    try {
      // Import STT dynamically
      const { STT } = await import('@runanywhere/web-onnx');
      
      // Only zipformer models support streaming sessions.
      const loadedSpeechModel = ModelManager.getLoadedModel(ModelCategory.SpeechRecognition);
      const canUseStreaming = Boolean(loadedSpeechModel?.id?.includes('zipformer'));

      // Create streaming session if the current STT model supports it.
      let session: STTStreamingSession | null = null;
      let streamingActive = false;
      if (canUseStreaming) {
        try {
          session = STT.createStreamingSession();
          sessionRef.current = session;
          streamingActive = true;
        } catch (streamErr) {
          console.warn('Streaming STT unavailable; falling back to buffered transcription.', streamErr);
          sessionRef.current = null;
        }
      }

      // Create audio capture
      const mic = new AudioCapture({ sampleRate: 16000 });
      micRef.current = mic;

      // Handle audio chunks with streaming STT
      const handleAudioChunk = (chunk: Float32Array) => {
        // Streaming path (zipformer model)
        if (session && streamingActive) {
          try {
            // Feed audio to streaming session
            session.acceptWaveform(chunk, 16000);

            // Get current result
            const result = session.getResult();

            if (result.text && result.text.trim()) {
              setCurrentText(result.text.trim());

              // If endpoint detected, save segment
              if (result.isEndpoint) {
                const segmentEndTime = new Date();
                const duration = segmentStartRef.current
                  ? segmentEndTime.getTime() - segmentStartRef.current.getTime()
                  : 0;

                const confidence = calculateConfidence(result.text);
                confidenceBufferRef.current.push(confidence);

                const segment: TranscriptSegment = {
                  id: segmentIdRef.current++,
                  text: result.text.trim(),
                  timestamp: segmentStartRef.current || new Date(),
                  duration,
                  confidence,
                  isEndpoint: true,
                };

                setSegments((prev) => [...prev, segment]);

                // Update stats
                const words = result.text.trim().split(/\s+/).length;
                setStats((prev) => {
                  const avgConf = confidenceBufferRef.current.reduce((a, b) => a + b, 0) / confidenceBufferRef.current.length;
                  return {
                    totalSegments: prev.totalSegments + 1,
                    totalWords: prev.totalWords + words,
                    sessionDuration: startTimeRef.current
                      ? Date.now() - startTimeRef.current.getTime()
                      : 0,
                    avgConfidence: avgConf,
                  };
                });

                // Reset for next segment
                session.reset();
                setCurrentText('');
                segmentStartRef.current = new Date();
              }
            }
            return;
          } catch (streamChunkErr) {
            console.warn('Streaming STT failed during capture; switching to buffered transcription.', streamChunkErr);
            streamingActive = false;
            try {
              session.destroy();
            } catch {
              // no-op
            }
            sessionRef.current = null;
          }
        }

        // Fallback path for offline-only STT models (e.g. whisper)
        audioChunksRef.current.push(chunk);
        const now = Date.now();
        const shouldUpdatePreview = now - lastPreviewAtRef.current > 1500;
        if (!shouldUpdatePreview || previewBusyRef.current) return;

        previewBusyRef.current = true;
        lastPreviewAtRef.current = now;

        const previewAudio = concatAudioChunks(audioChunksRef.current);
        void STT.transcribe(previewAudio, { sampleRate: 16000 })
          .then((result) => {
            if (result.text && result.text.trim()) {
              setCurrentText(result.text.trim());
            }
          })
          .catch((previewErr) => {
            console.warn('Preview transcription failed:', previewErr);
          })
          .finally(() => {
            previewBusyRef.current = false;
          });
      };

      // Start capturing with proper typing
      await mic.start(
        (chunk: Float32Array) => handleAudioChunk(chunk),
        (level: number) => setAudioLevel(level)
      );

    } catch (err) {
      console.error('Recording start error:', err);
      setError(err instanceof Error ? err.message : 'Failed to start recording');
      setIsRecording(false);
    }
  }, [ensureModels]);

  const stopRecording = useCallback(async () => {
    try {
      // Stop microphone
      micRef.current?.stop();

      // Finalize streaming session
      if (sessionRef.current) {
        sessionRef.current.inputFinished();
        
        // Get final result
        const finalResult = sessionRef.current.getResult();
        if (finalResult.text && finalResult.text.trim()) {
          const segmentEndTime = new Date();
          const duration = segmentStartRef.current 
            ? segmentEndTime.getTime() - segmentStartRef.current.getTime()
            : 0;

          const confidence = calculateConfidence(finalResult.text);
          confidenceBufferRef.current.push(confidence);

          const segment: TranscriptSegment = {
            id: segmentIdRef.current++,
            text: finalResult.text.trim(),
            timestamp: segmentStartRef.current || new Date(),
            duration,
            confidence,
            isEndpoint: true,
          };

          setSegments((prev) => [...prev, segment]);

          const words = finalResult.text.trim().split(/\s+/).length;
          setStats((prev) => {
            const avgConf = confidenceBufferRef.current.reduce((a, b) => a + b, 0) / confidenceBufferRef.current.length;
            return {
              totalSegments: prev.totalSegments + 1,
              totalWords: prev.totalWords + words,
              sessionDuration: startTimeRef.current 
                ? Date.now() - startTimeRef.current.getTime()
                : 0,
              avgConfidence: avgConf,
            };
          });
        }

        sessionRef.current.destroy();
        sessionRef.current = null;
      } else if (audioChunksRef.current.length > 0) {
        // Final pass for offline models
        const { STT } = await import('@runanywhere/web-onnx');
        const fullAudio = concatAudioChunks(audioChunksRef.current);
        const finalResult = await STT.transcribe(fullAudio, { sampleRate: 16000 });

        if (finalResult.text && finalResult.text.trim()) {
          const segmentEndTime = new Date();
          const duration = segmentStartRef.current
            ? segmentEndTime.getTime() - segmentStartRef.current.getTime()
            : 0;

          const confidence = calculateConfidence(finalResult.text);
          confidenceBufferRef.current.push(confidence);

          const segment: TranscriptSegment = {
            id: segmentIdRef.current++,
            text: finalResult.text.trim(),
            timestamp: segmentStartRef.current || new Date(),
            duration,
            confidence,
            isEndpoint: true,
          };

          setSegments((prev) => [...prev, segment]);

          const words = finalResult.text.trim().split(/\s+/).length;
          setStats((prev) => ({
            totalSegments: prev.totalSegments + 1,
            totalWords: prev.totalWords + words,
            sessionDuration: startTimeRef.current
              ? Date.now() - startTimeRef.current.getTime()
              : 0,
            avgConfidence: confidenceBufferRef.current.reduce((a, b) => a + b, 0) / confidenceBufferRef.current.length,
          }));
        }
      }

      setCurrentText('');
      setIsRecording(false);
      setAudioLevel(0);
    } catch (err) {
      console.error('Stop recording error:', err);
      setError(err instanceof Error ? err.message : 'Error stopping recording');
    }
  }, []);

  const clearTranscript = useCallback(() => {
    setSegments([]);
    setCurrentText('');
    setStats({ totalSegments: 0, totalWords: 0, sessionDuration: 0, avgConfidence: 0 });
    segmentIdRef.current = 0;
    confidenceBufferRef.current = [];
  }, []);

  const exportTranscript = useCallback(() => {
    const sessionTime = stats.sessionDuration / 1000;
    let text = `# Transcription Session\n`;
    text += `Date: ${new Date().toLocaleString()}\n`;
    text += `Duration: ${Math.floor(sessionTime / 60)}m ${Math.floor(sessionTime % 60)}s\n`;
    text += `Segments: ${stats.totalSegments}\n`;
    text += `Words: ${stats.totalWords}\n`;
    text += `Avg Confidence: ${(stats.avgConfidence * 100).toFixed(1)}%\n\n`;
    text += `---\n\n`;

    segments.forEach((seg) => {
      const time = seg.timestamp.toLocaleTimeString();
      const conf = seg.confidence ? ` (${(seg.confidence * 100).toFixed(0)}%)` : '';
      text += `[${time}]${conf} ${seg.text}\n\n`;
    });

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [segments, stats]);

  const copyToClipboard = useCallback(() => {
    const text = segments.map((seg) => seg.text).join(' ');
    navigator.clipboard.writeText(text).then(() => {
      alert('Transcript copied to clipboard!');
    });
  }, [segments]);

  const pendingLoaders = [{ label: 'STT', loader: sttLoader }].filter(
    (l) => l.loader.state !== 'ready'
  );

  return (
    <div className="tab-panel transcription-panel">
      {pendingLoaders.length > 0 && !isRecording && (
        <ModelBanner
          state={pendingLoaders[0].loader.state}
          progress={pendingLoaders[0].loader.progress}
          error={pendingLoaders[0].loader.error}
          onLoad={ensureModels}
          label="English STT (Streaming)"
        />
      )}

      {error && (
        <div className="model-banner">
          <span className="error-text">{error}</span>
        </div>
      )}

      <div className="transcription-header">
        <h2>Real-Time Speech Transcription</h2>
        <p>Advanced streaming STT with automatic endpoint detection</p>
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
          <span>Recording - Streaming STT Active</span>
          <div className="audio-level-bar">
            <div className="audio-level-fill" style={{ width: `${audioLevel * 100}%` }} />
          </div>
        </div>
      )}

      {(segments.length > 0 || currentText || isRecording) && (
        <div className="stats-bar">
          <span>{stats.totalSegments} segments</span>
          <span>{stats.totalWords} words</span>
          {stats.sessionDuration > 0 && (
            <span>
              {Math.floor(stats.sessionDuration / 1000 / 60)}m{' '}
              {Math.floor((stats.sessionDuration / 1000) % 60)}s
            </span>
          )}
          {stats.avgConfidence > 0 && (
            <span>~{(stats.avgConfidence * 100).toFixed(0)}% confidence</span>
          )}
        </div>
      )}

      <div className="transcript-container" ref={listRef}>
        {segments.length === 0 && !currentText && (
          <div className="empty-state">
            <h3>Advanced Streaming Transcription</h3>
            <p>Click Start to begin real-time speech-to-text</p>
            <ul className="feature-list">
              <li><strong>Streaming Architecture:</strong> Real-time processing without waiting</li>
              <li><strong>Automatic Endpoints:</strong> Smart sentence detection</li>
              <li><strong>Confidence Scoring:</strong> Quality metrics for each segment</li>
              <li><strong>Enhanced Accuracy:</strong> Optimized for English transcription</li>
              <li><strong>100% Private:</strong> All processing on-device</li>
            </ul>
          </div>
        )}

        {segments.map((segment) => (
          <div key={segment.id} className="transcript-segment enhanced">
            <div className="segment-header">
              <div className="segment-time">{segment.timestamp.toLocaleTimeString()}</div>
              {segment.confidence && (
                <div 
                  className="confidence-badge"
                  style={{ 
                    background: segment.confidence > 0.8 ? 'var(--green)' : 
                                segment.confidence > 0.6 ? '#F59E0B' : 'var(--red)' 
                  }}
                >
                  {(segment.confidence * 100).toFixed(0)}%
                </div>
              )}
            </div>
            <div className="segment-text">{segment.text}</div>
            {segment.duration > 0 && (
              <div className="segment-duration">{(segment.duration / 1000).toFixed(1)}s</div>
            )}
          </div>
        ))}

        {currentText && (
          <div className="transcript-segment current enhanced">
            <div className="segment-header">
              <div className="segment-time">{new Date().toLocaleTimeString()}</div>
              <div className="live-indicator">LIVE</div>
            </div>
            <div className="segment-text streaming">{currentText}</div>
          </div>
        )}
      </div>
    </div>
  );
}
