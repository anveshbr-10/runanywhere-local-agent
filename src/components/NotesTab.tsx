import { useState, useRef, useEffect, useCallback } from 'react';
import { ModelCategory, ModelManager, AudioCapture, SpeechActivity } from '@runanywhere/web';
import { VAD } from '@runanywhere/web-onnx';
import { TextGeneration } from '@runanywhere/web-llamacpp';
import { useModelLoader } from '../hooks/useModelLoader';
import { ModelBanner } from './ModelBanner';

interface Note {
  id: number;
  title: string;
  content: string;
  summary?: string;
  timestamp: Date;
  tags: string[];
}

export function NotesTab() {
  const vadLoader = useModelLoader(ModelCategory.Audio, true);
  const sttLoader = useModelLoader(ModelCategory.SpeechRecognition, true);
  const llmLoader = useModelLoader(ModelCategory.Language, true);

  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const micRef = useRef<AudioCapture | null>(null);
  const vadUnsub = useRef<(() => void) | null>(null);
  const noteIdRef = useRef(0);
  const transcriptBufferRef = useRef<string[]>([]);

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
        transcriptBufferRef.current.push(result.text.trim());
        setCurrentTranscript(transcriptBufferRef.current.join(' '));
      }
    } catch (err) {
      console.error('Transcription error:', err);
      setError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setIsTranscribing(false);
    }
  }, []);

  const startRecording = useCallback(async () => {
    setCurrentTranscript('');
    setError(null);
    transcriptBufferRef.current = [];

    // Ensure models are loaded
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

  const stopRecording = useCallback(() => {
    micRef.current?.stop();
    vadUnsub.current?.();
    VAD.reset();
    setIsRecording(false);
    setAudioLevel(0);
  }, []);

  const saveNote = useCallback(async () => {
    if (!currentTranscript.trim()) return;

    // Ensure LLM is loaded for title generation
    if (!ModelManager.getLoadedModel(ModelCategory.Language)) {
      const ok = await llmLoader.ensure();
      if (!ok) return;
    }

    setIsSummarizing(true);

    try {
      // Generate title
      const titleResult = await TextGeneration.generate(
        `Generate a short, descriptive title (3-5 words) for this note:\n\n${currentTranscript}`,
        {
          maxTokens: 20,
          temperature: 0.5,
        }
      );

      const title = titleResult.text.trim().replace(/["']/g, '').slice(0, 50);

      // Extract potential tags
      const tagsResult = await TextGeneration.generate(
        `Extract 2-3 relevant tags from this text. Return only comma-separated tags, no explanation:\n\n${currentTranscript}`,
        {
          maxTokens: 30,
          temperature: 0.3,
        }
      );

      const tags = tagsResult.text
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
        .slice(0, 3);

      const newNote: Note = {
        id: noteIdRef.current++,
        title: title || 'Untitled Note',
        content: currentTranscript,
        timestamp: new Date(),
        tags,
      };

      setNotes((prev) => [newNote, ...prev]);
      setCurrentTranscript('');
      transcriptBufferRef.current = [];
      setSelectedNote(newNote);
    } catch (err) {
      console.error('Save error:', err);
      setError(err instanceof Error ? err.message : 'Failed to save note');
    } finally {
      setIsSummarizing(false);
    }
  }, [currentTranscript, llmLoader]);

  const summarizeNote = useCallback(async (note: Note) => {
    if (!ModelManager.getLoadedModel(ModelCategory.Language)) {
      const ok = await llmLoader.ensure();
      if (!ok) return;
    }

    setIsSummarizing(true);
    setSelectedNote(note);

    try {
      const result = await TextGeneration.generate(
        `Summarize this note in 2-3 concise sentences:\n\n${note.content}`,
        {
          maxTokens: 150,
          temperature: 0.5,
        }
      );

      const updatedNote = { ...note, summary: result.text.trim() };

      setNotes((prev) => prev.map((n) => (n.id === note.id ? updatedNote : n)));
      setSelectedNote(updatedNote);
    } catch (err) {
      console.error('Summary error:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate summary');
    } finally {
      setIsSummarizing(false);
    }
  }, [llmLoader]);

  const deleteNote = useCallback((noteId: number) => {
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    if (selectedNote?.id === noteId) {
      setSelectedNote(null);
    }
  }, [selectedNote]);

  const exportNotes = useCallback(() => {
    const text = notes
      .map((note) => {
        return `# ${note.title}\nDate: ${note.timestamp.toLocaleString()}\nTags: ${note.tags.join(', ')}\n\n${note.content}\n${note.summary ? `\nSummary: ${note.summary}` : ''}\n\n---\n`;
      })
      .join('\n');

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notes-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [notes]);

  const pendingLoaders = [
    { label: 'VAD', loader: vadLoader },
    { label: 'STT', loader: sttLoader },
    { label: 'LLM', loader: llmLoader },
  ].filter((l) => l.loader.state !== 'ready');

  return (
    <div className="tab-panel notes-panel">
      {pendingLoaders.length > 0 && !isRecording && (
        <ModelBanner
          state={pendingLoaders[0].loader.state}
          progress={pendingLoaders[0].loader.progress}
          error={pendingLoaders[0].loader.error}
          onLoad={ensureModels}
          label={`Notes (${pendingLoaders.map((l) => l.label).join(', ')})`}
        />
      )}

      {error && (
        <div className="model-banner">
          <span className="error-text">{error}</span>
        </div>
      )}

      <div className="notes-header">
        <h2>Smart Note-Taking</h2>
        <p>Voice notes with AI-powered organization and summarization</p>
      </div>

      <div className="notes-container">
        <div className="notes-sidebar">
          <div className="notes-sidebar-header">
            <h3>Notes ({notes.length})</h3>
            {notes.length > 0 && (
              <button className="btn btn-sm" onClick={exportNotes}>
                Export All
              </button>
            )}
          </div>

          {notes.length === 0 ? (
            <div className="empty-state">
              <p>No notes yet. Record a voice note to get started!</p>
            </div>
          ) : (
            <div className="notes-list">
              {notes.map((note) => (
                <div
                  key={note.id}
                  className={`note-item ${selectedNote?.id === note.id ? 'selected' : ''}`}
                  onClick={() => setSelectedNote(note)}
                >
                  <div className="note-item-title">{note.title}</div>
                  <div className="note-item-date">{note.timestamp.toLocaleDateString()}</div>
                  <div className="note-item-tags">
                    {note.tags.map((tag) => (
                      <span key={tag} className="tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="notes-main">
          {selectedNote ? (
            <div className="note-detail">
              <div className="note-detail-header">
                <h2>{selectedNote.title}</h2>
                <div className="note-detail-actions">
                  {!selectedNote.summary && (
                    <button
                      className="btn"
                      onClick={() => summarizeNote(selectedNote)}
                      disabled={isSummarizing}
                    >
                      {isSummarizing ? 'Summarizing...' : 'Summarize'}
                    </button>
                  )}
                  <button
                    className="btn btn-secondary"
                    onClick={() => deleteNote(selectedNote.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="note-detail-meta">
                <span>{selectedNote.timestamp.toLocaleString()}</span>
                {selectedNote.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>

              {selectedNote.summary && (
                <div className="note-summary">
                  <h4>Summary</h4>
                  <p>{selectedNote.summary}</p>
                </div>
              )}

              <div className="note-content">
                <h4>Full Content</h4>
                <p>{selectedNote.content}</p>
              </div>
            </div>
          ) : currentTranscript || isRecording ? (
            <div className="note-recording">
              <h3>Recording Note...</h3>

              {isRecording && (
                <div className="recording-indicator">
                  <div className="recording-dot" />
                  <span>Recording</span>
                  <div className="audio-level-bar">
                    <div className="audio-level-fill" style={{ width: `${audioLevel * 100}%` }} />
                  </div>
                </div>
              )}

              {isTranscribing && <p className="status-text">Transcribing...</p>}

              <div className="current-transcript">
                <p>{currentTranscript || 'Start speaking...'}</p>
              </div>

              <div className="recording-controls">
                {isRecording ? (
                  <button className="btn btn-warning" onClick={stopRecording}>
                    Stop Recording
                  </button>
                ) : (
                  <>
                    <button className="btn btn-primary" onClick={startRecording}>
                      Continue Recording
                    </button>
                    {currentTranscript && (
                      <button
                        className="btn btn-primary"
                        onClick={saveNote}
                        disabled={isSummarizing}
                      >
                        {isSummarizing ? 'Saving...' : 'Save Note'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <h3>Create a Voice Note</h3>
              <p>Click the button below to record a voice note</p>
              <ul className="feature-list">
                <li>Record voice notes with automatic transcription</li>
                <li>AI-generated titles and tags</li>
                <li>Smart summarization</li>
                <li>Organize and export your notes</li>
              </ul>
              <button className="btn btn-primary btn-lg" onClick={startRecording}>
                Record New Note
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
