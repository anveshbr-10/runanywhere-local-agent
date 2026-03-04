import { useState, useRef, useEffect, useCallback } from 'react';
import { ModelCategory, ModelManager, AudioCapture, SpeechActivity } from '@runanywhere/web';
import { VAD } from '@runanywhere/web-onnx';
import { TextGeneration } from '@runanywhere/web-llamacpp';
import { useModelLoader } from '../hooks/useModelLoader';
import { ModelBanner } from './ModelBanner';

interface TranscriptSegment {
  timestamp: Date;
  text: string;
}

interface Meeting {
  id: number;
  title: string;
  startTime: Date;
  endTime?: Date;
  transcript: TranscriptSegment[];
  summary?: string;
  actionItems?: string[];
  participants?: string[];
}

const MEETING_SUMMARY_PROMPT = `Analyze this meeting transcript and provide:
1. A brief summary (2-3 sentences)
2. Key discussion points (bullet points)
3. Action items (if any, with bullet points)
4. Important decisions made

Keep it concise and organized.

Transcript:
`;

export function MeetingTab() {
  const vadLoader = useModelLoader(ModelCategory.Audio, true);
  const sttLoader = useModelLoader(ModelCategory.SpeechRecognition, true);
  const llmLoader = useModelLoader(ModelCategory.Language, true);

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [currentMeeting, setCurrentMeeting] = useState<Meeting | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [currentTranscript, setCurrentTranscript] = useState('');

  const micRef = useRef<AudioCapture | null>(null);
  const vadUnsub = useRef<(() => void) | null>(null);
  const meetingIdRef = useRef(0);
  const transcriptBufferRef = useRef<TranscriptSegment[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [currentMeeting?.transcript]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      micRef.current?.stop();
      vadUnsub.current?.();
    };
  }, []);

  const ensureModels = useCallback(async (): Promise<boolean> => {
    setError(null);
    const results = await Promise.all([
      vadLoader.ensure(),
      sttLoader.ensure(),
      llmLoader.ensure(),
    ]);
    if (!results.every(Boolean)) {
      setError('Failed to load required models');
      return false;
    }
    return true;
  }, [vadLoader, sttLoader, llmLoader]);

  const processAudioSegment = useCallback(async (audioData: Float32Array) => {
    setIsTranscribing(true);

    try {
      const { STT } = await import('@runanywhere/web-onnx');
      const result = await STT.transcribe(audioData);

      if (result.text && result.text.trim()) {
        const segment: TranscriptSegment = {
          timestamp: new Date(),
          text: result.text.trim(),
        };

        transcriptBufferRef.current.push(segment);

        setCurrentMeeting((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            transcript: [...prev.transcript, segment],
          };
        });

        setCurrentTranscript(result.text.trim());
      }
    } catch (err) {
      console.error('Transcription error:', err);
      setError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setIsTranscribing(false);
    }
  }, []);

  const startMeeting = useCallback(async () => {
    setError(null);
    setCurrentTranscript('');
    transcriptBufferRef.current = [];

    // Ensure models are loaded
    const anyMissing =
      !ModelManager.getLoadedModel(ModelCategory.Audio) ||
      !ModelManager.getLoadedModel(ModelCategory.SpeechRecognition);

    if (anyMissing) {
      const ok = await ensureModels();
      if (!ok) return;
    }

    const newMeeting: Meeting = {
      id: meetingIdRef.current++,
      title: `Meeting ${new Date().toLocaleString()}`,
      startTime: new Date(),
      transcript: [],
    };

    setCurrentMeeting(newMeeting);
    setIsRecording(true);

    const mic = new AudioCapture({ sampleRate: 16000 });
    micRef.current = mic;

    VAD.reset();

    vadUnsub.current = VAD.onSpeechActivity((activity) => {
      if (activity === SpeechActivity.Ended) {
        const segment = VAD.popSpeechSegment();
        if (segment && segment.samples.length > 1600) {
          processAudioSegment(segment.samples);
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
  }, [ensureModels, processAudioSegment]);

  const stopMeeting = useCallback(() => {
    micRef.current?.stop();
    vadUnsub.current?.();
    VAD.reset();
    setIsRecording(false);
    setAudioLevel(0);
    setCurrentTranscript('');

    if (currentMeeting) {
      const completedMeeting = {
        ...currentMeeting,
        endTime: new Date(),
      };

      setMeetings((prev) => [completedMeeting, ...prev]);
      setCurrentMeeting(null);
      setSelectedMeeting(completedMeeting);
    }
  }, [currentMeeting]);

  const generateSummary = useCallback(async (meeting: Meeting) => {
    if (!ModelManager.getLoadedModel(ModelCategory.Language)) {
      const ok = await llmLoader.ensure();
      if (!ok) return;
    }

    setIsSummarizing(true);
    setSelectedMeeting(meeting);

    try {
      const transcriptText = meeting.transcript
        .map((seg) => `[${seg.timestamp.toLocaleTimeString()}] ${seg.text}`)
        .join('\n');

      const result = await TextGeneration.generate(MEETING_SUMMARY_PROMPT + transcriptText, {
        maxTokens: 500,
        temperature: 0.5,
      });

      // Extract action items from summary
      const summaryText = result.text;
      const actionItemsMatch = summaryText.match(/action items?:?\s*\n((?:[-•*]\s*.+\n?)+)/i);
      const actionItems = actionItemsMatch
        ? actionItemsMatch[1]
            .split('\n')
            .map((item) => item.replace(/^[-•*]\s*/, '').trim())
            .filter((item) => item.length > 0)
        : [];

      const updatedMeeting: Meeting = {
        ...meeting,
        summary: summaryText,
        actionItems: actionItems.length > 0 ? actionItems : undefined,
      };

      setMeetings((prev) => prev.map((m) => (m.id === meeting.id ? updatedMeeting : m)));
      setSelectedMeeting(updatedMeeting);
    } catch (err) {
      console.error('Summary error:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate summary');
    } finally {
      setIsSummarizing(false);
    }
  }, [llmLoader]);

  const deleteMeeting = useCallback((meetingId: number) => {
    setMeetings((prev) => prev.filter((m) => m.id !== meetingId));
    if (selectedMeeting?.id === meetingId) {
      setSelectedMeeting(null);
    }
  }, [selectedMeeting]);

  const exportMeeting = useCallback((meeting: Meeting) => {
    const duration = meeting.endTime
      ? Math.round((meeting.endTime.getTime() - meeting.startTime.getTime()) / 1000 / 60)
      : 0;

    let text = `# ${meeting.title}\n\n`;
    text += `Start: ${meeting.startTime.toLocaleString()}\n`;
    if (meeting.endTime) {
      text += `End: ${meeting.endTime.toLocaleString()}\n`;
      text += `Duration: ${duration} minutes\n`;
    }
    text += `\n## Transcript\n\n`;

    meeting.transcript.forEach((seg) => {
      text += `[${seg.timestamp.toLocaleTimeString()}] ${seg.text}\n\n`;
    });

    if (meeting.summary) {
      text += `\n## Summary\n\n${meeting.summary}\n\n`;
    }

    if (meeting.actionItems && meeting.actionItems.length > 0) {
      text += `\n## Action Items\n\n`;
      meeting.actionItems.forEach((item) => {
        text += `- ${item}\n`;
      });
    }

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meeting-${meeting.startTime.toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const pendingLoaders = [
    { label: 'VAD', loader: vadLoader },
    { label: 'STT', loader: sttLoader },
    { label: 'LLM', loader: llmLoader },
  ].filter((l) => l.loader.state !== 'ready');

  return (
    <div className="tab-panel meeting-panel">
      {pendingLoaders.length > 0 && !isRecording && (
        <ModelBanner
          state={pendingLoaders[0].loader.state}
          progress={pendingLoaders[0].loader.progress}
          error={pendingLoaders[0].loader.error}
          onLoad={ensureModels}
          label={`Meeting (${pendingLoaders.map((l) => l.label).join(', ')})`}
        />
      )}

      {error && (
        <div className="model-banner">
          <span className="error-text">{error}</span>
        </div>
      )}

      <div className="meeting-header">
        <h2>Meeting Assistant</h2>
        <p>Record meetings, generate transcripts, and create summaries with action items</p>
      </div>

      <div className="meeting-container">
        <div className="meeting-sidebar">
          <div className="meeting-sidebar-header">
            <h3>Meetings ({meetings.length})</h3>
          </div>

          {meetings.length === 0 ? (
            <div className="empty-state">
              <p>No meetings yet. Start a meeting to begin!</p>
            </div>
          ) : (
            <div className="meeting-list">
              {meetings.map((meeting) => (
                <div
                  key={meeting.id}
                  className={`meeting-item ${selectedMeeting?.id === meeting.id ? 'selected' : ''}`}
                  onClick={() => setSelectedMeeting(meeting)}
                >
                  <div className="meeting-item-title">{meeting.title}</div>
                  <div className="meeting-item-date">
                    {meeting.startTime.toLocaleString()}
                  </div>
                  <div className="meeting-item-meta">
                    {meeting.transcript.length} segments
                    {meeting.summary && ' • Summarized'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="meeting-main">
          {currentMeeting ? (
            <div className="meeting-active">
              <div className="meeting-active-header">
                <h2>{currentMeeting.title}</h2>
                <button className="btn btn-warning" onClick={stopMeeting}>
                  End Meeting
                </button>
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

              <div className="meeting-transcript" ref={listRef}>
                {currentMeeting.transcript.length === 0 ? (
                  <p className="status-text">Listening for speech...</p>
                ) : (
                  currentMeeting.transcript.map((seg, idx) => (
                    <div key={idx} className="transcript-segment">
                      <div className="segment-time">{seg.timestamp.toLocaleTimeString()}</div>
                      <div className="segment-text">{seg.text}</div>
                    </div>
                  ))
                )}

                {isTranscribing && (
                  <div className="transcript-segment current">
                    <div className="segment-time">{new Date().toLocaleTimeString()}</div>
                    <div className="segment-text processing">Transcribing...</div>
                  </div>
                )}
              </div>
            </div>
          ) : selectedMeeting ? (
            <div className="meeting-detail">
              <div className="meeting-detail-header">
                <h2>{selectedMeeting.title}</h2>
                <div className="meeting-detail-actions">
                  <button className="btn" onClick={() => exportMeeting(selectedMeeting)}>
                    Export
                  </button>
                  {!selectedMeeting.summary && (
                    <button
                      className="btn btn-primary"
                      onClick={() => generateSummary(selectedMeeting)}
                      disabled={isSummarizing}
                    >
                      {isSummarizing ? 'Generating...' : 'Generate Summary'}
                    </button>
                  )}
                  <button
                    className="btn btn-secondary"
                    onClick={() => deleteMeeting(selectedMeeting.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="meeting-detail-meta">
                <span>Start: {selectedMeeting.startTime.toLocaleString()}</span>
                {selectedMeeting.endTime && (
                  <span>
                    Duration:{' '}
                    {Math.round(
                      (selectedMeeting.endTime.getTime() - selectedMeeting.startTime.getTime()) /
                        1000 /
                        60
                    )}{' '}
                    minutes
                  </span>
                )}
                <span>{selectedMeeting.transcript.length} segments</span>
              </div>

              {selectedMeeting.summary && (
                <div className="meeting-summary">
                  <h3>Summary</h3>
                  <div className="summary-text">{selectedMeeting.summary}</div>
                </div>
              )}

              {selectedMeeting.actionItems && selectedMeeting.actionItems.length > 0 && (
                <div className="meeting-actions">
                  <h3>Action Items</h3>
                  <ul>
                    {selectedMeeting.actionItems.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="meeting-transcript-section">
                <h3>Transcript</h3>
                <div className="meeting-transcript">
                  {selectedMeeting.transcript.map((seg, idx) => (
                    <div key={idx} className="transcript-segment">
                      <div className="segment-time">{seg.timestamp.toLocaleTimeString()}</div>
                      <div className="segment-text">{seg.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <h3>Start a Meeting</h3>
              <p>Click the button below to begin recording</p>
              <ul className="feature-list">
                <li>Automatic transcription in real-time</li>
                <li>AI-generated summaries</li>
                <li>Extract action items automatically</li>
                <li>Export transcripts and summaries</li>
              </ul>
              <button className="btn btn-primary btn-lg" onClick={startMeeting}>
                Start New Meeting
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
