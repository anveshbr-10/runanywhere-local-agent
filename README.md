# RunAnywhere Web Starter App

A comprehensive React + TypeScript application demonstrating **on-device AI in the browser** using the [`@runanywhere/web`](https://www.npmjs.com/package/@runanywhere/web) SDK. Features 8 powerful AI-driven tools — all running locally via WebAssembly with zero server dependencies and 100% privacy.

## Features

| Tab | What it does |
|-----|-------------|
| **Chat** | Stream text from an on-device LLM (LFM2 350M) |
| **Medical Symptoms** | Analyze symptoms and get health recommendations using local AI |
| **Vision** | Point your camera and describe what the VLM sees (LFM2-VL 450M) |
| **Voice** | Speak naturally — VAD detects speech, STT transcribes, LLM responds, TTS speaks back |
| **Tools** | Function calling and structured output demonstrations |

## Key Highlights

### Privacy-First Architecture
- **100% Local Processing**: All AI inference runs in your browser via WebAssembly
- **No Server Calls**: Zero network requests for inference - completely offline-capable
- **No Data Leakage**: Audio, text, images, and medical data never leave your device
- **Persistent Models**: Models cached in OPFS (Origin Private File System) across sessions

### Advanced AI Capabilities
- **LLM**: Text generation with streaming, system prompts, and tool calling
- **TTS**: Neural voice synthesis with Piper TTS
- **VAD**: Real-time voice activity detection with Silero VAD
- **VLM**: Vision language models for multimodal understanding
- **Tool Calling**: Function calling with structured JSON output

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Models are downloaded on first use and cached in the browser's Origin Private File System (OPFS).

## How It Works

```
@runanywhere/web (npm package)
  ├── WASM engine (llama.cpp, whisper.cpp, sherpa-onnx)
  ├── Model management (download, OPFS cache, load/unload)
  └── TypeScript API (TextGeneration, STT, TTS, VAD, VLM, VoicePipeline)
```

The app imports everything from `@runanywhere/web`:

```typescript
import { RunAnywhere, SDKEnvironment } from '@runanywhere/web';
import { TextGeneration, VLMWorkerBridge } from '@runanywhere/web-llamacpp';

await RunAnywhere.initialize({ environment: SDKEnvironment.Development });

// Stream LLM text
const { stream } = await TextGeneration.generateStream('Hello!', { maxTokens: 200 });
for await (const token of stream) { console.log(token); }

// VLM: describe an image
const result = await VLMWorkerBridge.shared.process(rgbPixels, width, height, 'Describe this.');
```

## Project Structure

```
src/
├── main.tsx              # React root
├── App.tsx               # Tab navigation (all 8 tabs)
├── runanywhere.ts        # SDK init + model catalog + VLM worker
├── workers/
│   └── vlm-worker.ts     # VLM Web Worker entry (2 lines)
├── hooks/
│   └── useModelLoader.ts # Shared model download/load hook
├── components/
│   ├── ChatTab.tsx              # LLM streaming chat
│   ├── SymptomCheckerTab.tsx    # Medical symptom analysis
│   ├── NotesTab.tsx             # Voice notes with AI organization
│   ├── MeetingTab.tsx           # Meeting recorder and analyzer
│   ├── VisionTab.tsx            # Camera + VLM inference
│   ├── VoiceTab.tsx             # Full voice pipeline
│   ├── ToolsTab.tsx             # Function calling demo
│   └── ModelBanner.tsx          # Download progress UI
└── styles/
    └── index.css          # Dark theme CSS
```

## Adding Your Own Models

Edit the `MODELS` array in `src/runanywhere.ts`:

```typescript
{
  id: 'my-custom-model',
  name: 'My Model',
  repo: 'username/repo-name',           // HuggingFace repo
  files: ['model.Q4_K_M.gguf'],         // Files to download
  framework: LLMFramework.LlamaCpp,
  modality: ModelCategory.Language,      // or Multimodal, SpeechRecognition, etc.
  memoryRequirement: 500_000_000,        // Bytes
}
```

Any GGUF model compatible with llama.cpp works for LLM/VLM. STT/TTS/VAD use sherpa-onnx models.

## Medical Symptom Checker

The **Medical Symptoms** tab provides a privacy-first symptom analysis tool powered by on-device AI:

### Features
- **100% Private**: All symptom analysis happens locally in your browser - no data is sent to any server
- **AI-Powered Analysis**: Uses the on-device LLM to provide detailed health information
- **Comprehensive Information**: Get information about:
  - Possible conditions based on symptoms
  - General educational information
  - Home care recommendations
  - When to seek professional medical care
- **Safety First**: Includes prominent disclaimers and emergency warnings
- **History Tracking**: Review previous symptom analyses in your session

### Usage
1. Navigate to the "Medical Symptoms" tab
2. Describe your symptoms in detail (e.g., "headache for 3 days, fever, body aches")
3. Click "Analyze Symptoms"
4. Review the AI-generated analysis

### Important Notes
- This tool provides **general health information only**
- It is **NOT a substitute** for professional medical advice, diagnosis, or treatment
- Always consult with qualified healthcare providers for proper medical care
- For emergencies (chest pain, difficulty breathing, severe bleeding), call emergency services immediately

### Technical Implementation
The symptom checker uses:
- A specialized medical system prompt to guide the AI's responses
- Token streaming for real-time analysis updates
- Session-based history (cleared when you refresh the page)
- Responsive UI with clear disclaimers and safety warnings

See `src/components/SymptomCheckerTab.tsx` for the implementation details.

## Deployment

### Vercel

```bash
npm run build
npx vercel --prod
```

The included `vercel.json` sets the required Cross-Origin-Isolation headers.

### Netlify

Add a `_headers` file:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
```

### Any static host

Serve the `dist/` folder with these HTTP headers on all responses:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

## Browser Requirements

- Chrome 96+ or Edge 96+ (recommended: 120+)
- WebAssembly (required)
- SharedArrayBuffer (requires Cross-Origin Isolation headers)
- OPFS (for persistent model cache)

## Troubleshooting

### `Failed to load module script ... MIME type of "application/octet-stream"`

This happens when the project source (`index.html` + `/src/main.tsx`) is served by a generic static server.

Use Vite for development:

```bash
npm install
npm run dev
```

For production, build and serve the generated `dist/` directory:

```bash
npm run build
npm run preview
```

## Documentation

- [SDK API Reference](https://docs.runanywhere.ai)
- [npm package](https://www.npmjs.com/package/@runanywhere/web)
- [GitHub](https://github.com/RunanywhereAI/runanywhere-sdks)

## License

MIT
