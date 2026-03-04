import { useState, useEffect } from 'react';
import { initSDK, getAccelerationMode } from './runanywhere';
import { ChatTab } from './components/ChatTab';
import { VisionTab } from './components/VisionTab';
import { VoiceTab } from './components/VoiceTab';
import { ToolsTab } from './components/ToolsTab';
import { SymptomCheckerTab } from './components/SymptomCheckerTab';
import { TranscriptionTab } from './components/TranscriptionTab';
import { NotesTab } from './components/NotesTab';
import { MeetingTab } from './components/MeetingTab';
import { MultilingualTab } from './components/MultilingualTab';

type Tab = 'chat' | 'vision' | 'voice' | 'tools' | 'symptom' | 'transcription' | 'notes' | 'meeting' | 'multilingual';

export function App() {
  const [sdkReady, setSdkReady] = useState(false);
  const [sdkError, setSdkError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('chat');

  useEffect(() => {
    initSDK()
      .then(() => setSdkReady(true))
      .catch((err) => setSdkError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (sdkError) {
    return (
      <div className="app-loading">
        <h2>SDK Error</h2>
        <p className="error-text">{sdkError}</p>
      </div>
    );
  }

  if (!sdkReady) {
    return (
      <div className="app-loading">
        <div className="spinner" />
        <h2>Loading RunAnywhere SDK...</h2>
        <p>Initializing on-device AI engine</p>
      </div>
    );
  }

  const accel = getAccelerationMode();

  return (
    <div className="app">
      <header className="app-header">
        <h1>RunAnywhere AI</h1>
        {accel && <span className="badge">{accel === 'webgpu' ? 'WebGPU' : 'CPU'}</span>}
      </header>

      <nav className="tab-bar">
        <button className={activeTab === 'chat' ? 'active' : ''} onClick={() => setActiveTab('chat')}>
          Chat
        </button>
        <button className={activeTab === 'symptom' ? 'active' : ''} onClick={() => setActiveTab('symptom')}>
          Symptoms
        </button>
        <button className={activeTab === 'transcription' ? 'active' : ''} onClick={() => setActiveTab('transcription')}>
          Transcription
        </button>
        <button className={activeTab === 'multilingual' ? 'active' : ''} onClick={() => setActiveTab('multilingual')}>
          Multilingual
        </button>
        <button className={activeTab === 'notes' ? 'active' : ''} onClick={() => setActiveTab('notes')}>
          Notes
        </button>
        <button className={activeTab === 'meeting' ? 'active' : ''} onClick={() => setActiveTab('meeting')}>
          Meetings
        </button>
        <button className={activeTab === 'vision' ? 'active' : ''} onClick={() => setActiveTab('vision')}>
          Vision
        </button>
        <button className={activeTab === 'voice' ? 'active' : ''} onClick={() => setActiveTab('voice')}>
          Voice
        </button>
        <button className={activeTab === 'tools' ? 'active' : ''} onClick={() => setActiveTab('tools')}>
          Tools
        </button>
      </nav>

      <main className="tab-content">
        {activeTab === 'chat' && <ChatTab />}
        {activeTab === 'symptom' && <SymptomCheckerTab />}
        {activeTab === 'transcription' && <TranscriptionTab />}
        {activeTab === 'multilingual' && <MultilingualTab />}
        {activeTab === 'notes' && <NotesTab />}
        {activeTab === 'meeting' && <MeetingTab />}
        {activeTab === 'vision' && <VisionTab />}
        {activeTab === 'voice' && <VoiceTab />}
        {activeTab === 'tools' && <ToolsTab />}
      </main>
    </div>
  );
}
