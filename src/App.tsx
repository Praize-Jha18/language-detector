import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const GEMINI_PROXY_URL = '/.netlify/functions/gemini';
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
const HISTORY_KEY = 'lang_history_v1';
const HISTORY_LIMIT = 10;
const RETRY_DELAYS_MS = [800, 2000, 4000];

type LyricLine = { original: string; translated: string };
type Confidence = 'high' | 'medium' | 'low';
type SongSource = { uri: string; title?: string };

type Verification = {
  songTitle?: string;
  songArtist?: string;
  youtubeVideoId?: string;
  confidence: Confidence;
  evidence?: string;
  sources: SongSource[];
};

type Result = {
  detectedLanguage: string;
  translation: string;
  isSong: boolean;
  songTitle?: string;
  songArtist?: string;
  youtubeVideoId?: string;
  lines?: LyricLine[];
  verification?: Verification;
};

type HistoryItem = {
  id: string;
  timestamp: number;
  text: string;
  target: string;
  result: Result;
};

const TONES = [
  { id: 'literal', label: 'Literal', hint: 'Word-for-word, preserve structure.' },
  { id: 'neutral', label: 'Neutral', hint: 'Faithful, natural register.' },
  { id: 'casual', label: 'Casual', hint: 'Friendly, everyday speech.' },
  { id: 'formal', label: 'Formal', hint: 'Polite, professional register.' },
  { id: 'poetic', label: 'Poetic', hint: 'Preserve rhythm and imagery.' },
] as const;

type ToneId = (typeof TONES)[number]['id'];

const TARGET_LANGUAGES = [
  'English',
  'Spanish',
  'French',
  'German',
  'Italian',
  'Portuguese',
  'Dutch',
  'Russian',
  'Japanese',
  'Korean',
  'Chinese (Simplified)',
  'Arabic',
  'Hindi',
  'Yoruba',
  'Igbo',
  'Hausa',
  'Swahili',
];

const LANG_FLAGS: Record<string, string> = {
  English: '🇬🇧',
  Spanish: '🇪🇸',
  French: '🇫🇷',
  German: '🇩🇪',
  Italian: '🇮🇹',
  Portuguese: '🇵🇹',
  Dutch: '🇳🇱',
  Russian: '🇷🇺',
  Japanese: '🇯🇵',
  Korean: '🇰🇷',
  'Chinese (Simplified)': '🇨🇳',
  Arabic: '🇸🇦',
  Hindi: '🇮🇳',
  Yoruba: '🇳🇬',
  Igbo: '🇳🇬',
  Hausa: '🇳🇬',
  Swahili: '🇰🇪',
};

const LANG_TO_BCP47: Record<string, string> = {
  English: 'en-US',
  Spanish: 'es-ES',
  French: 'fr-FR',
  German: 'de-DE',
  Italian: 'it-IT',
  Portuguese: 'pt-PT',
  Dutch: 'nl-NL',
  Russian: 'ru-RU',
  Japanese: 'ja-JP',
  Korean: 'ko-KR',
  'Chinese (Simplified)': 'zh-CN',
  Arabic: 'ar-SA',
  Hindi: 'hi-IN',
  Yoruba: 'yo-NG',
  Igbo: 'ig-NG',
  Hausa: 'ha-NG',
  Swahili: 'sw-KE',
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    detectedLanguage: { type: 'STRING' },
    translation: { type: 'STRING' },
    isSong: { type: 'BOOLEAN' },
    songTitle: { type: 'STRING' },
    songArtist: { type: 'STRING' },
    youtubeVideoId: { type: 'STRING' },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          original: { type: 'STRING' },
          translated: { type: 'STRING' },
        },
        required: ['original', 'translated'],
      },
    },
  },
  required: ['detectedLanguage', 'translation', 'isSong'],
};

const YT_URL_RE =
  /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

function extractYoutubeId(input: string): string | null {
  const m = input.trim().match(YT_URL_RE);
  return m ? m[1] : null;
}

function encodeShare(payload: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeShare(b64: string): any | null {
  try {
    const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

let ytApiPromise: Promise<any> | null = null;
function loadYouTubeApi(): Promise<any> {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if ((window as any).YT && (window as any).YT.Player) {
      resolve((window as any).YT);
      return;
    }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    (window as any).onYouTubeIframeAPIReady = () => resolve((window as any).YT);
  });
  return ytApiPromise;
}

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

async function callGemini(body: object): Promise<any> {
  let lastErr = '';
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const res = await fetch(GEMINI_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, body }),
      });
      if (res.ok) return await res.json();
      lastErr = `${model} → ${res.status}: ${(await res.text()).slice(0, 200)}`;
      const retryable = res.status === 429 || res.status === 503 || res.status >= 500;
      if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw new Error(`All Gemini models failed. Last error: ${lastErr}`);
}

function extractJson(text: string): any | null {
  if (!text) return null;
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

type SyncedLine = { time: number; original: string; translated?: string };

async function fetchLrclib(
  title: string,
  artist: string,
): Promise<SyncedLine[] | null> {
  const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(
    artist,
  )}&track_name=${encodeURIComponent(title)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const synced: string | undefined = json?.syncedLyrics;
  if (!synced) return null;
  const lines: SyncedLine[] = [];
  for (const raw of synced.split(/\r?\n/)) {
    const m = raw.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
    if (!m) continue;
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0;
    const time = min * 60 + sec + frac;
    const text = m[4].trim();
    if (text) lines.push({ time, original: text });
  }
  return lines.length > 0 ? lines : null;
}

async function translateLines(
  lines: string[],
  target: string,
  toneLabel: string,
  toneHint: string,
): Promise<string[]> {
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const prompt = `Translate each numbered line below into ${target} in a "${toneLabel}" register: ${toneHint}
Return ONLY a JSON array of translated strings, in the same order. Same number of items as the input.

Lines:
${numbered}`;
  const data = await callGemini({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: { type: 'STRING' },
      },
      temperature: 0.2,
    },
  });
  const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) return lines.map(() => '');
  try {
    const arr = JSON.parse(txt);
    if (Array.isArray(arr)) return arr.map((s) => String(s));
  } catch {
    /* ignore */
  }
  return lines.map(() => '');
}

function pcm16ToWavBlob(pcmBase64: string, sampleRate = 24000): Blob {
  const bin = atob(pcmBase64);
  const pcm = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
  const dataLen = pcm.length;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);
  new Uint8Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

const TTS_MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];

async function geminiTTS(text: string, voiceName = 'Aoede'): Promise<Blob> {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
      },
    },
  };
  let lastErr = '';
  for (const model of TTS_MODELS) {
    const res = await fetch(GEMINI_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, body }),
    });
    if (!res.ok) {
      lastErr = `${model} → ${res.status}`;
      continue;
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      const inlineData = p?.inlineData ?? p?.inline_data;
      if (inlineData?.data) {
        return pcm16ToWavBlob(inlineData.data);
      }
    }
    lastErr = `${model} → no audio in response`;
  }
  throw new Error(`Gemini TTS unavailable. ${lastErr}`);
}

async function translateWord(word: string, sourceLang: string, target: string): Promise<string> {
  const prompt = `Translate the single ${sourceLang} word "${word}" into ${target}. Return ONLY the translation (one or two words max, no quotes, no commentary). If it's a name or has no translation, return it unchanged.`;
  const data = await callGemini({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0 },
  });
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
}

async function translateOnly(text: string, target: string, toneLabel: string, toneHint: string): Promise<string> {
  const prompt = `Translate the following text into ${target} in a "${toneLabel}" register: ${toneHint}
Return ONLY the translation as plain text — no quotes, no commentary, no markdown.

Text:
"""${text}"""`;
  const data = await callGemini({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 },
  });
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
}

async function fetchLyricsForYoutube(
  videoId: string,
): Promise<{ title: string; artist: string; lyrics: string } | null> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const prompt = `You are given a YouTube video URL of a song. Use Google Search to:
1. Identify the exact song title and artist for ${url}.
2. Find the FULL lyrics from a reputable lyrics source (Genius, AZLyrics, Musixmatch, etc.).

Return ONLY a JSON object (no markdown):
{
  "title": "exact song title",
  "artist": "primary artist",
  "lyrics": "the full lyrics, with line breaks preserved as \\n"
}

If you cannot find the lyrics, return: {"title": "", "artist": "", "lyrics": ""}`;

  let data;
  try {
    data = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1 },
    });
  } catch {
    return null;
  }

  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p: any) => p?.text)
    .filter(Boolean)
    .join('\n');
  const parsed = extractJson(text);
  if (!parsed || !parsed.lyrics) return null;
  return {
    title: parsed.title || '',
    artist: parsed.artist || '',
    lyrics: parsed.lyrics,
  };
}

async function findYoutubeVideoId(title: string, artist: string): Promise<string | null> {
  const prompt = `Find a YouTube video for "${title}" by ${artist} that ALLOWS EMBEDDING. Search YouTube directly.

Strongly prefer (in order):
1. The artist's auto-generated audio channel: "${artist} - Topic" — these are uploaded by YouTube Music and are almost always embeddable.
2. The official music video on the artist's main channel.
3. Any high-quality official audio upload from the artist.

Avoid: live performances, fan covers, third-party lyric videos, region-locked uploads, and music videos by major labels that commonly disable embedding (e.g. Vevo for some artists).

Reply with ONLY the 11-character YouTube video ID — nothing else, no URL, no quotes. If you cannot find a clear embeddable match, reply exactly: NONE`;
  try {
    const data = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0 },
    });
    const text =
      (data?.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p?.text)
        .filter(Boolean)
        .join(' ')
        .trim() ?? '';
    if (/^NONE/i.test(text)) return null;
    const direct = text.match(/^[A-Za-z0-9_-]{11}$/);
    if (direct) return direct[0];
    const inUrl = text.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/);
    if (inUrl) return inUrl[1];
    const anywhere = text.match(/[A-Za-z0-9_-]{11}/);
    return anywhere ? anywhere[0] : null;
  } catch {
    return null;
  }
}

async function verifySong(lyrics: string): Promise<Verification | null> {
  const snippet = lyrics.slice(0, 600);
  const prompt = `You are identifying a song from its lyrics by SEARCHING THE WEB. Do not rely on memory.

Steps:
1. Pick 1-2 of the MOST DISTINCTIVE phrases from the lyrics below (avoid generic phrases like "I love you" or "baby" — pick unusual word combinations).
2. Search the web for those exact phrases in quotes.
3. Cross-check at least 2 sources (e.g. lyric sites, Wikipedia, official YouTube). The same title/artist must appear consistently.
4. Only then commit to an answer.

Confidence rules:
- "high": multiple sources agree on the same title + artist, and the lyrics match verbatim.
- "medium": one strong source, OR sources mostly agree but lyrics paraphrase slightly.
- "low": cannot find consistent matches — DO NOT GUESS. Leave fields blank.

Return ONLY a JSON object (no markdown, no commentary):
{
  "songTitle": "exact title or empty string",
  "songArtist": "primary artist or empty string",
  "youtubeVideoId": "11-char ID from a youtube.com/watch?v=ID URL you actually saw in search results, or empty string",
  "confidence": "high" | "medium" | "low",
  "evidence": "1 short sentence describing what you found"
}

Lyrics to identify:
"""
${snippet}
"""`;

  let data;
  try {
    data = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1 },
    });
  } catch {
    return null;
  }

  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p: any) => p?.text)
    .filter(Boolean)
    .join('\n');
  const parsed = extractJson(text);
  if (!parsed) return null;

  const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const sources: SongSource[] = [];
  for (const chunk of groundingChunks) {
    const uri = chunk?.web?.uri;
    if (uri) sources.push({ uri, title: chunk?.web?.title });
  }

  const confidence: Confidence =
    parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
      ? parsed.confidence
      : 'low';

  let videoId =
    typeof parsed.youtubeVideoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(parsed.youtubeVideoId)
      ? parsed.youtubeVideoId
      : undefined;

  if (!videoId && confidence !== 'low' && parsed.songTitle && parsed.songArtist) {
    const fallback = await findYoutubeVideoId(parsed.songTitle, parsed.songArtist);
    if (fallback && /^[A-Za-z0-9_-]{11}$/.test(fallback)) videoId = fallback;
  }

  return {
    songTitle: parsed.songTitle || undefined,
    songArtist: parsed.songArtist || undefined,
    youtubeVideoId: videoId,
    confidence,
    evidence: parsed.evidence || undefined,
    sources,
  };
}

function LanguageSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      const idx = Math.max(0, options.indexOf(value));
      setHighlight(idx);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, options, value]);

  useEffect(() => {
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  function pick(lang: string) {
    onChange(lang);
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlight]) pick(filtered[highlight]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className={`lang-select${open ? ' open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className="lang-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open ? 'true' : 'false'}
      >
        <span className="lang-flag" aria-hidden="true">{LANG_FLAGS[value] ?? '🌐'}</span>
        <span className="lang-name">{value}</span>
        <span className="lang-chevron" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="lang-panel">
          <input
            ref={searchRef}
            className="lang-search"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKey}
            placeholder="Search languages…"
            aria-label="Search languages"
          />
          <ul className="lang-list" ref={listRef}>
            {filtered.length === 0 && <li className="lang-empty">No matches</li>}
            {filtered.map((opt, i) => {
              const isActive = i === highlight;
              const isSelected = opt === value;
              return (
                <li
                  key={opt}
                  className={`lang-option${isActive ? ' active' : ''}${isSelected ? ' selected' : ''}`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(opt)}
                >
                  <span className="lang-flag" aria-hidden="true">{LANG_FLAGS[opt] ?? '🌐'}</span>
                  <span className="lang-name">{opt}</span>
                  {isSelected && <span className="lang-check" aria-hidden="true">✓</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function WordifiedText({
  text,
  sourceLang,
  target,
  cache,
  onLookup,
}: {
  text: string;
  sourceLang: string;
  target: string;
  cache: Record<string, string | 'loading' | 'error'>;
  onLookup: (word: string) => void;
}) {
  const [openWord, setOpenWord] = useState<string | null>(null);
  const tokens = useMemo(() => text.split(/(\s+)/), [text]);
  const cleanWord = (raw: string) => raw.replace(/^[^\p{L}\p{N}'’-]+|[^\p{L}\p{N}'’-]+$/gu, '');

  return (
    <span className="wordified">
      {tokens.map((tok, i) => {
        if (/^\s+$/.test(tok)) return tok;
        const clean = cleanWord(tok);
        if (!clean) return tok;
        const cached = cache[`${sourceLang}|${clean.toLowerCase()}`];
        const isOpen = openWord === `${i}:${clean}`;
        return (
          <span key={i} className="word-wrap">
            <button
              type="button"
              className={`word${isOpen ? ' open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                const key = `${i}:${clean}`;
                setOpenWord((cur) => (cur === key ? null : key));
                if (!cached || cached === 'error') onLookup(clean);
              }}
            >
              {tok}
            </button>
            {isOpen && (
              <span className="word-pop" role="tooltip">
                <span className="word-pop-orig">{clean}</span>
                <span className="word-pop-arrow">→</span>
                <span className="word-pop-tr">
                  {!cached && '…'}
                  {cached === 'loading' && '…'}
                  {cached === 'error' && 'failed'}
                  {cached && cached !== 'loading' && cached !== 'error' && cached}
                </span>
                <span className="word-pop-target">{target}</span>
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

type Theme = 'dark' | 'light';

function loadTheme(): Theme {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function App() {
  const [text, setText] = useState('');
  const [target, setTarget] = useState('English');
  const [tone, setTone] = useState<ToneId>('neutral');
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [speaking, setSpeaking] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [shareCopied, setShareCopied] = useState(false);
  const [explanations, setExplanations] = useState<Record<number, string | 'loading'>>({});
  const [extraTargets, setExtraTargets] = useState<string[]>([]);
  const [extraTranslations, setExtraTranslations] = useState<Record<string, string | 'loading' | 'error'>>({});
  const [showAddTarget, setShowAddTarget] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [wordCache, setWordCache] = useState<Record<string, string | 'loading' | 'error'>>({});
  const [karaoke, setKaraoke] = useState<{ status: 'idle' | 'loading' | 'ready' | 'unavailable'; lines: SyncedLine[] }>({ status: 'idle', lines: [] });
  const [karaokeMode, setKaraokeMode] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const playerRef = useRef<any>(null);
  const playerPollRef = useRef<number | null>(null);
  const karaokeListRef = useRef<HTMLOListElement>(null);
  const karaokeFetchedRef = useRef<string>('');
  const [embedError, setEmbedError] = useState<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith('#s=')) return;
    const decoded = decodeShare(hash.slice(3));
    if (!decoded) return;
    if (typeof decoded.text === 'string') setText(decoded.text);
    if (typeof decoded.target === 'string') setTarget(decoded.target);
    if (typeof decoded.tone === 'string') setTone(decoded.tone);
    if (decoded.result && typeof decoded.result === 'object') setResult(decoded.result);
  }, []);

  useEffect(() => {
    if (!result) return;
    const hash = '#s=' + encodeShare({ text, target, tone, result });
    if (hash.length < 6000) {
      window.history.replaceState(null, '', hash);
    }
  }, [result, text, target, tone]);

  async function copyShareLink() {
    if (!result) return;
    const hash = '#s=' + encodeShare({ text, target, tone, result });
    const url = `${window.location.origin}${window.location.pathname}${hash}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1800);
    } catch {
      setError('Could not copy. URL is in the address bar already.');
    }
  }

  function pushHistory(item: HistoryItem) {
    setHistory((prev) => {
      const next = [item, ...prev].slice(0, HISTORY_LIMIT);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }

  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    setHistory([]);
  }

  function restore(item: HistoryItem) {
    setText(item.text);
    setTarget(item.target);
    setResult(item.result);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const audioElRef = useRef<HTMLAudioElement | null>(null);

  function speakBrowser(content: string, lang: string) {
    if (!('speechSynthesis' in window)) {
      setError('Speech synthesis not supported in this browser.');
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(content);
    utter.lang = LANG_TO_BCP47[lang] ?? 'en-US';
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utter);
  }

  function speak(content: string, lang: string) {
    speakBrowser(content, lang);
  }

  async function speakPremium(content: string, lang: string) {
    stopSpeaking();
    setSpeaking(true);
    try {
      const blob = await geminiTTS(`Speak the following ${lang} text naturally: ${content}`);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioElRef.current = audio;
      audio.onended = () => {
        setSpeaking(false);
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => {
        setSpeaking(false);
        URL.revokeObjectURL(url);
      };
      await audio.play();
    } catch (e: any) {
      setSpeaking(false);
      setError(`Premium voice failed (${e?.message ?? 'unknown'}). Using browser voice.`);
      speakBrowser(content, lang);
    }
  }

  function stopSpeaking() {
    window.speechSynthesis.cancel();
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current = null;
    }
    setSpeaking(false);
  }

  function exportAnki() {
    if (!result?.lines || result.lines.length === 0) return;
    const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = result.lines.map((l) => `${escape(l.original)},${escape(l.translated)}`);
    const csv = `Front,Back\n${rows.join('\n')}\n`;
    const slug = (result.songTitle || result.detectedLanguage || 'lyrics')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug || 'lyrics'}-anki.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function loadFromYoutube(videoId: string) {
    setError(null);
    setResult(null);
    setLoading(true);
    setLoadingStage('Fetching lyrics from YouTube…');
    try {
      const fetched = await fetchLyricsForYoutube(videoId);
      if (!fetched || !fetched.lyrics) {
        throw new Error("Couldn't find lyrics for that video. Try pasting them manually.");
      }
      setText(fetched.lyrics);
      await analyze(fetched.lyrics);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to fetch lyrics.');
      setLoading(false);
      setLoadingStage('');
    }
  }

  async function analyzeImage(file: File) {
    setError(null);
    setResult(null);

    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('Image must be under 8 MB.');
      return;
    }

    setLoading(true);
    setLoadingStage('Reading image…');
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(new Error('Could not read image.'));
        r.readAsDataURL(file);
      });
      const base64 = dataUrl.split(',')[1];
      const mimeType = file.type;

      setLoadingStage('Reading text & translating…');
      const toneInfo = TONES.find((t) => t.id === tone) ?? TONES[1];
      const visionPrompt = `Look at this image. Extract any visible text (signs, menus, captions, lyrics, etc.) preserving line breaks. Then:
1. Detect the language (full English name).
2. Translate the extracted text into ${target} in a "${toneInfo.label}" register: ${toneInfo.hint}
3. Decide if it's clearly song lyrics. If so, also provide a per-line breakdown ("lines"). Leave songTitle, songArtist, youtubeVideoId BLANK.

If no text is visible in the image, set translation to "(no text detected)" and detectedLanguage to "Unknown".`;

      const data = await callGemini({
        contents: [
          {
            parts: [
              { text: visionPrompt },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      });

      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) throw new Error('Empty response from Gemini.');
      const parsed = JSON.parse(content) as Result;
      parsed.songTitle = undefined;
      parsed.songArtist = undefined;
      parsed.youtubeVideoId = undefined;

      setText(parsed.translation ? `[Image] ${parsed.detectedLanguage}` : '[Image]');

      if (parsed.isSong && parsed.lines) {
        setLoadingStage('Identifying song via web search…');
        const lyricsForSearch = parsed.lines.map((l) => l.original).join('\n');
        const verification = await verifySong(lyricsForSearch);
        if (verification) {
          parsed.verification = verification;
          if (verification.confidence !== 'low') {
            parsed.songTitle = verification.songTitle;
            parsed.songArtist = verification.songArtist;
            parsed.youtubeVideoId = verification.youtubeVideoId;
          }
        }
      }

      setResult(parsed);
      setExplanations({});
      setExtraTranslations({});
      fetchedExtrasRef.current = new Set();
      pushHistory({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        text: `[Image: ${file.name}]`,
        target,
        result: parsed,
      });
    } catch (e: any) {
      setError(e?.message ?? 'Image analysis failed.');
    } finally {
      setLoading(false);
      setLoadingStage('');
    }
  }

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);

  function pickAudioMime(): string {
    const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (const m of opts) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) return m;
    }
    return 'audio/webm';
  }

  async function startRecording() {
    setError(null);
    if (recorderRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickAudioMime();
      const recorder = new MediaRecorder(stream, { mimeType });
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimerRef.current) {
          window.clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        setRecordSeconds(0);
        const blob = new Blob(recordedChunksRef.current, { type: mimeType });
        recorderRef.current = null;
        setRecording(false);
        if (blob.size > 0) await analyzeAudio(blob, mimeType);
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);
    } catch (e: any) {
      setError(`Microphone error: ${e?.message ?? 'permission denied or unsupported'}`);
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
  }

  async function analyzeAudio(blob: Blob, mimeType: string) {
    setError(null);
    setResult(null);
    setLoading(true);
    setLoadingStage('Transcribing & translating audio…');
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(new Error('Could not read audio.'));
        r.readAsDataURL(blob);
      });
      const base64 = dataUrl.split(',')[1];
      const toneInfo = TONES.find((t) => t.id === tone) ?? TONES[1];
      const audioPrompt = `Listen to this audio. Transcribe what is spoken or sung in its original language, preserving line breaks where natural. Then:
1. Detect the language (full English name).
2. Translate into ${target} in a "${toneInfo.label}" register: ${toneInfo.hint}
3. If it sounds like song lyrics (singing, chorus, music), set isSong=true and provide a per-line breakdown ("lines"). Leave songTitle/songArtist/youtubeVideoId BLANK.
If no speech is heard, set translation to "(no speech detected)" and detectedLanguage to "Unknown".`;

      const data = await callGemini({
        contents: [
          {
            parts: [
              { text: audioPrompt },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      });

      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) throw new Error('Empty response from Gemini.');
      const parsed = JSON.parse(content) as Result;
      parsed.songTitle = undefined;
      parsed.songArtist = undefined;
      parsed.youtubeVideoId = undefined;

      if (parsed.isSong && parsed.lines) {
        setLoadingStage('Identifying song via web search…');
        const lyricsForSearch = parsed.lines.map((l) => l.original).join('\n');
        const verification = await verifySong(lyricsForSearch);
        if (verification) {
          parsed.verification = verification;
          if (verification.confidence !== 'low') {
            parsed.songTitle = verification.songTitle;
            parsed.songArtist = verification.songArtist;
            parsed.youtubeVideoId = verification.youtubeVideoId;
          }
        }
      }

      setText(`[Audio: ${Math.round(blob.size / 1024)} KB]`);
      setResult(parsed);
      setExplanations({});
      setExtraTranslations({});
      fetchedExtrasRef.current = new Set();
      pushHistory({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        text: '[Audio recording]',
        target,
        result: parsed,
      });
    } catch (e: any) {
      setError(e?.message ?? 'Audio analysis failed.');
    } finally {
      setLoading(false);
      setLoadingStage('');
    }
  }

  useEffect(() => {
    if (!result?.isSong || !result.songTitle || !result.songArtist) {
      setKaraoke({ status: 'idle', lines: [] });
      setKaraokeMode(false);
      return;
    }
    const key = `${result.songTitle}|${result.songArtist}|${target}|${tone}`;
    if (karaokeFetchedRef.current === key) return;
    karaokeFetchedRef.current = key;
    setKaraoke({ status: 'loading', lines: [] });
    (async () => {
      const synced = await fetchLrclib(result.songTitle!, result.songArtist!);
      if (!synced) {
        setKaraoke({ status: 'unavailable', lines: [] });
        return;
      }
      const toneInfo = TONES.find((t) => t.id === tone) ?? TONES[1];
      try {
        const translations = await translateLines(
          synced.map((l) => l.original),
          target,
          toneInfo.label,
          toneInfo.hint,
        );
        const merged: SyncedLine[] = synced.map((l, i) => ({
          ...l,
          translated: translations[i] || '',
        }));
        setKaraoke({ status: 'ready', lines: merged });
      } catch {
        setKaraoke({ status: 'ready', lines: synced });
      }
    })();
  }, [result, target, tone]);

  useEffect(() => {
    setEmbedError(null);
    if (!result?.youtubeVideoId) return;
    let cancelled = false;
    let player: any = null;
    (async () => {
      const YT = await loadYouTubeApi();
      if (cancelled) return;
      try {
        player = new YT.Player('karaoke-player', {
          events: {
            onReady: () => {
              playerRef.current = player;
            },
            onError: (e: any) => {
              setEmbedError(typeof e?.data === 'number' ? e.data : -1);
            },
          },
        });
      } catch {
        /* construction failed */
      }
    })();
    return () => {
      cancelled = true;
      try {
        player?.destroy?.();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
    };
  }, [result?.youtubeVideoId]);

  useEffect(() => {
    if (!karaokeMode || karaoke.status !== 'ready' || embedError !== null) return;
    if (playerPollRef.current) window.clearInterval(playerPollRef.current);
    playerPollRef.current = window.setInterval(() => {
      const player = playerRef.current;
      if (!player?.getCurrentTime) return;
      try {
        const t = player.getCurrentTime();
        if (typeof t !== 'number') return;
        const lines = karaoke.lines;
        let idx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].time <= t) idx = i;
          else break;
        }
        setActiveIdx(idx);
      } catch {
        /* ignore */
      }
    }, 200);
    return () => {
      if (playerPollRef.current) {
        window.clearInterval(playerPollRef.current);
        playerPollRef.current = null;
      }
    };
  }, [karaokeMode, karaoke, embedError]);

  useEffect(() => {
    if (!karaokeMode || activeIdx < 0) return;
    const list = karaokeListRef.current;
    const el = list?.children[activeIdx] as HTMLElement | undefined;
    if (!el || !list) return;
    const top = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
    list.scrollTo({ top, behavior: 'smooth' });
  }, [activeIdx, karaokeMode]);

  function lookupWord(word: string) {
    if (!result) return;
    const key = `${result.detectedLanguage}|${word.toLowerCase()}`;
    if (wordCache[key] && wordCache[key] !== 'error') return;
    setWordCache((prev) => ({ ...prev, [key]: 'loading' }));
    translateWord(word, result.detectedLanguage, target)
      .then((t) => setWordCache((prev) => ({ ...prev, [key]: t || word })))
      .catch(() => setWordCache((prev) => ({ ...prev, [key]: 'error' })));
  }

  function onImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) analyzeImage(file);
    e.target.value = '';
  }

  function onTextareaPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          analyzeImage(file);
          return;
        }
      }
    }
    const pasted = e.clipboardData.getData('text');
    if (!pasted) return;
    const ytId = extractYoutubeId(pasted);
    if (ytId) {
      e.preventDefault();
      loadFromYoutube(ytId);
      return;
    }
    if (pasted.trim().length >= 12) {
      setTimeout(() => {
        analyze(pasted);
      }, 0);
    }
  }

  function onTextareaDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      e.preventDefault();
      analyzeImage(file);
    }
  }

  async function analyze(textOverride?: string) {
    setError(null);
    setResult(null);

    const inputText = textOverride ?? text;
    if (!inputText.trim()) {
      setError('Please paste some text.');
      return;
    }

    setLoading(true);
    setLoadingStage('Detecting & translating…');
    try {
      const toneInfo = TONES.find((t) => t.id === tone) ?? TONES[1];
      const prompt = `Analyze the following text.

1. Detect its language (full English name, e.g. "Spanish").
2. Translate the entire text into ${target} in a "${toneInfo.label}" register: ${toneInfo.hint}
3. Decide if it is clearly song lyrics (multiple lines, repetition, chorus-like structure, etc.). If it is, also:
   - Provide a per-line breakdown ("lines") where each entry has the original line and its ${target} translation (same "${toneInfo.label}" register). Skip empty lines.
   - Leave songTitle, songArtist, and youtubeVideoId BLANK — a separate web-search step will identify the song. Do not guess.

If it is NOT a song, set isSong to false and omit "lines".

Text:
"""${inputText}"""`;

      const data = await callGemini({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      });

      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) throw new Error('Empty response from Gemini.');

      const parsed = JSON.parse(content) as Result;
      parsed.songTitle = undefined;
      parsed.songArtist = undefined;
      parsed.youtubeVideoId = undefined;

      if (parsed.isSong) {
        setLoadingStage('Identifying song via web search…');
        const verification = await verifySong(inputText);
        if (verification) {
          parsed.verification = verification;
          if (verification.confidence !== 'low') {
            parsed.songTitle = verification.songTitle;
            parsed.songArtist = verification.songArtist;
            parsed.youtubeVideoId = verification.youtubeVideoId;
          }
        }
      }

      setResult(parsed);
      setExplanations({});
      setExtraTranslations({});
      fetchedExtrasRef.current = new Set();
      pushHistory({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        text: inputText,
        target,
        result: parsed,
      });
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong.');
    } finally {
      setLoading(false);
      setLoadingStage('');
    }
  }

  const fetchedExtrasRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!result?.translation) return;
    const toneInfo = TONES.find((t) => t.id === tone) ?? TONES[1];
    const sourceText = result.lines?.length
      ? result.lines.map((l) => l.original).join('\n')
      : text;
    extraTargets.forEach((lang) => {
      const key = `${lang}|${tone}|${sourceText.length}`;
      if (fetchedExtrasRef.current.has(key)) return;
      fetchedExtrasRef.current.add(key);
      setExtraTranslations((prev) => ({ ...prev, [lang]: 'loading' }));
      translateOnly(sourceText, lang, toneInfo.label, toneInfo.hint)
        .then((t) => setExtraTranslations((prev) => ({ ...prev, [lang]: t })))
        .catch(() => setExtraTranslations((prev) => ({ ...prev, [lang]: 'error' })));
    });
  }, [result, extraTargets, tone, text]);

  function addExtraTarget(lang: string) {
    if (lang === target || extraTargets.includes(lang) || extraTargets.length >= 2) return;
    setExtraTargets((prev) => [...prev, lang]);
    setShowAddTarget(false);
  }

  function removeExtraTarget(lang: string) {
    setExtraTargets((prev) => prev.filter((l) => l !== lang));
    setExtraTranslations((prev) => {
      const next = { ...prev };
      delete next[lang];
      return next;
    });
  }

  async function explainLine(index: number) {
    if (!result?.lines || !result.lines[index]) return;
    if (explanations[index]) return;
    const line = result.lines[index];
    const context = result.lines
      .map((l, i) => `${i === index ? '>>> ' : '    '}${l.original}`)
      .join('\n');
    setExplanations((prev) => ({ ...prev, [index]: 'loading' }));
    try {
      const songCtx = result.songTitle
        ? ` from "${result.songTitle}"${result.songArtist ? ` by ${result.songArtist}` : ''}`
        : '';
      const prompt = `Explain the marked (>>>) line${songCtx} in plain ${target}. Cover idioms, slang, cultural references, double meanings, or imagery a casual listener might miss. 2-3 sentences max. Plain text, no markdown.

${context}

Marked line: "${line.original}"`;
      const data = await callGemini({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
      });
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
      setExplanations((prev) => ({ ...prev, [index]: text || 'No extra context found.' }));
    } catch (e: any) {
      setExplanations((prev) => ({ ...prev, [index]: `Couldn't load: ${e?.message ?? 'error'}` }));
    }
  }

  const songQuery =
    result?.isSong && (result.songTitle || result.songArtist)
      ? `${result.songTitle ?? ''} ${result.songArtist ?? ''}`.trim()
      : null;

  return (
    <div className="App">
      <header className="header">
        <div className="header-row">
          <h1>Language Detector</h1>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
        <p className="tagline">
          Paste any text — detect the language, translate it, and play it back if it's a song.
        </p>
      </header>

      <main className="main">
        <label className="field">
          <span>Paste text, lyrics, a YouTube link, or drop an image</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onTextareaPaste}
            onDrop={onTextareaDrop}
            onDragOver={(e) => e.preventDefault()}
            placeholder="Paste here — auto-runs on paste. Drop a YouTube URL to fetch lyrics, or drop / paste an image to translate text from it."
            rows={8}
          />
          <div className="image-row">
            <label className="image-btn">
              📷 Translate from image
              <input
                type="file"
                accept="image/*"
                onChange={onImagePick}
                className="hidden-input"
              />
            </label>
            {recording ? (
              <button type="button" className="image-btn recording" onClick={stopRecording}>
                ⏹ Stop ({recordSeconds}s)
              </button>
            ) : (
              <button type="button" className="image-btn" onClick={startRecording} disabled={loading}>
                🎤 Record audio
              </button>
            )}
            <span className="muted">or drop / paste an image above</span>
          </div>
        </label>

        <div className="field">
          <span>Translate to</span>
          <LanguageSelect value={target} onChange={setTarget} options={TARGET_LANGUAGES} />
          <div className="extra-targets">
            {extraTargets.map((lang) => (
              <span key={lang} className="extra-chip">
                <span aria-hidden="true">{LANG_FLAGS[lang] ?? '🌐'}</span>
                {lang}
                <button
                  type="button"
                  onClick={() => removeExtraTarget(lang)}
                  aria-label={`Remove ${lang}`}
                >
                  ×
                </button>
              </span>
            ))}
            {extraTargets.length < 2 && !showAddTarget && (
              <button
                type="button"
                className="ghost extra-add"
                onClick={() => setShowAddTarget(true)}
              >
                + Also translate to…
              </button>
            )}
            {showAddTarget && (
              <div className="extra-picker">
                <LanguageSelect
                  value={
                    TARGET_LANGUAGES.find(
                      (l) => l !== target && !extraTargets.includes(l),
                    ) ?? target
                  }
                  onChange={addExtraTarget}
                  options={TARGET_LANGUAGES.filter(
                    (l) => l !== target && !extraTargets.includes(l),
                  )}
                />
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setShowAddTarget(false)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="field">
          <span>Tone</span>
          <div className="tone-pills">
            {TONES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tone-pill${tone === t.id ? ' active' : ''}`}
                onClick={() => setTone(t.id)}
                title={t.hint}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <button type="button" className="primary" onClick={() => analyze()} disabled={loading}>
          {loading ? loadingStage || 'Analyzing…' : 'Detect & Translate'}
        </button>

        {error && <div className="error">{error}</div>}

        {result && (
          <section
            className={`result${result.youtubeVideoId ? ' has-backdrop' : ''}`}
            style={
              result.youtubeVideoId && /^[A-Za-z0-9_-]{11}$/.test(result.youtubeVideoId)
                ? ({
                    ['--backdrop' as any]: `url(https://img.youtube.com/vi/${result.youtubeVideoId}/hqdefault.jpg)`,
                  } as React.CSSProperties)
                : undefined
            }
          >
            <div className="row">
              <span className="label">Detected language</span>
              <span className="value">{result.detectedLanguage}</span>
              <button type="button" className="ghost share-btn" onClick={copyShareLink}>
                {shareCopied ? '✓ Copied' : '🔗 Share'}
              </button>
            </div>

            <div className="row block">
              <div className="row-head">
                <span className="label">Translation ({target})</span>
                <div className="speak-controls">
                  {speaking ? (
                    <button type="button" className="ghost" onClick={stopSpeaking}>
                      ⏹ Stop
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => speak(text, result.detectedLanguage)}
                        title={`Browser voice — ${result.detectedLanguage}`}
                      >
                        🔊 Original
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => speak(result.translation, target)}
                        title={`Browser voice — ${target}`}
                      >
                        🔊 Translation
                      </button>
                      <button
                        type="button"
                        className="ghost premium"
                        onClick={() => speakPremium(result.translation, target)}
                        title="Premium AI voice (better for tonal/African languages)"
                      >
                        🎙 Premium
                      </button>
                    </>
                  )}
                </div>
              </div>
              <p className="translation">{result.translation}</p>
            </div>

            {extraTargets.map((lang) => {
              const t = extraTranslations[lang];
              return (
                <div className="row block extra-row" key={lang}>
                  <span className="label">
                    <span aria-hidden="true">{LANG_FLAGS[lang] ?? '🌐'}</span> Translation ({lang})
                  </span>
                  <p className="translation">
                    {t === 'loading' && <em className="muted">Translating…</em>}
                    {t === 'error' && <em className="muted">Failed to translate.</em>}
                    {t && t !== 'loading' && t !== 'error' && t}
                  </p>
                </div>
              );
            })}

            {result.isSong && result.lines && result.lines.length > 0 && (
              <div className="lines">
                <div className="row-head">
                  <span className="label">Line by line</span>
                  <button type="button" className="ghost" onClick={exportAnki} title="Download as Anki-compatible CSV">
                    📥 Anki CSV
                  </button>
                </div>
                <ol className="lines-list">
                  {result.lines.map((line, i) => {
                    const exp = explanations[i];
                    return (
                      <li key={i}>
                        <div className="line-original">
                          <WordifiedText
                            text={line.original}
                            sourceLang={result.detectedLanguage}
                            target={target}
                            cache={wordCache}
                            onLookup={lookupWord}
                          />
                        </div>
                        <div className="line-translated">{line.translated}</div>
                        <button
                          type="button"
                          className="explain-btn"
                          onClick={() => explainLine(i)}
                          disabled={exp === 'loading'}
                          title="Explain this line"
                        >
                          {exp === 'loading' ? '…' : '💡'}
                        </button>
                        {exp && exp !== 'loading' && (
                          <div className="line-explanation">{exp}</div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}

            {result.isSong && (
              <div className="song">
                <h3>Looks like a song 🎵</h3>
                {result.verification ? (
                  <p className={`confidence confidence-${result.verification.confidence}`}>
                    {result.verification.confidence === 'high' && '✓ Verified via web search'}
                    {result.verification.confidence === 'medium' && '~ Likely match (web search)'}
                    {result.verification.confidence === 'low' && '⚠ Could not confidently identify this song'}
                  </p>
                ) : (
                  <p className="confidence confidence-low">⚠ Web search unavailable — no verified match.</p>
                )}
                {(result.songTitle || result.songArtist) && (
                  <p>
                    <strong>{result.songTitle ?? 'Unknown title'}</strong>
                    {result.songArtist ? ` — ${result.songArtist}` : ''}
                  </p>
                )}
                {result.verification?.evidence && (
                  <p className="muted evidence">{result.verification.evidence}</p>
                )}
                {result.verification &&
                  result.verification.confidence !== 'low' &&
                  !result.youtubeVideoId && (
                    <p className="muted">
                      Found the song but couldn't locate an embeddable YouTube video. Use the buttons below to play it elsewhere.
                    </p>
                  )}
                {result.youtubeVideoId &&
                  result.verification &&
                  result.verification.confidence !== 'low' &&
                  /^[A-Za-z0-9_-]{11}$/.test(result.youtubeVideoId) && (
                    <>
                      <div className={`player${embedError !== null ? ' failed' : ''}`}>
                        <iframe
                          id="karaoke-player"
                          title="Song player"
                          src={`https://www.youtube.com/embed/${result.youtubeVideoId}?enablejsapi=1&modestbranding=1&origin=${encodeURIComponent(window.location.origin)}`}
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                        />
                        {embedError !== null && (
                          <div className="embed-overlay">
                            <p className="embed-overlay-msg">
                              ⚠ This video can't be embedded
                              {embedError === 101 || embedError === 150
                                ? ' — the uploader disabled embedding.'
                                : embedError === 100
                                ? ' — video not found or removed.'
                                : '.'}
                            </p>
                            <a
                              className="link-pill"
                              href={`https://www.youtube.com/watch?v=${result.youtubeVideoId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              ▶ Open on YouTube
                            </a>
                          </div>
                        )}
                      </div>
                      {embedError === null && (
                        <a
                          className="muted player-fallback"
                          href={`https://www.youtube.com/watch?v=${result.youtubeVideoId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Embed says "unavailable"? Open on YouTube ↗
                        </a>
                      )}
                      {embedError === null && karaoke.status === 'loading' && (
                        <p className="muted">Loading synced lyrics…</p>
                      )}
                      {embedError === null && karaoke.status === 'unavailable' && (
                        <p className="muted">No synced lyrics available for this track on LRCLIB.</p>
                      )}
                      {embedError === null && karaoke.status === 'ready' && (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => setKaraokeMode((k) => !k)}
                        >
                          {karaokeMode ? '← Back to translation view' : '🎤 Karaoke mode'}
                        </button>
                      )}
                      {embedError === null && karaokeMode && karaoke.status === 'ready' && (
                        <ol className="karaoke-list" ref={karaokeListRef}>
                          {karaoke.lines.map((line, i) => (
                            <li
                              key={i}
                              className={`karaoke-line${i === activeIdx ? ' active' : ''}${i < activeIdx ? ' past' : ''}`}
                              onClick={() => playerRef.current?.seekTo?.(line.time, true)}
                            >
                              <div className="karaoke-original">{line.original}</div>
                              {line.translated && (
                                <div className="karaoke-translated">{line.translated}</div>
                              )}
                            </li>
                          ))}
                        </ol>
                      )}
                    </>
                  )}
                {result.verification && result.verification.sources.length > 0 && (
                  <details className="sources">
                    <summary>Sources ({result.verification.sources.length})</summary>
                    <ul>
                      {result.verification.sources.map((src, i) => (
                        <li key={i}>
                          <a href={src.uri} target="_blank" rel="noopener noreferrer">
                            {src.title || src.uri}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {songQuery && (
                  <div className="song-links">
                    <a
                      className="link-pill"
                      href={`https://www.youtube.com/results?search_query=${encodeURIComponent(songQuery)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      ▶ YouTube
                    </a>
                    <a
                      className="link-pill"
                      href={`https://music.youtube.com/search?q=${encodeURIComponent(songQuery)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      ▶ YouTube Music
                    </a>
                    <a
                      className="link-pill"
                      href={`https://open.spotify.com/search/${encodeURIComponent(songQuery)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      ▶ Spotify
                    </a>
                    <a
                      className="link-pill"
                      href={`https://www.google.com/search?q=${encodeURIComponent(songQuery)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      🔎 Google
                    </a>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {history.length > 0 && (
          <section className="history">
            <div className="history-head">
              <span className="label">Recent</span>
              <button type="button" className="ghost" onClick={clearHistory}>
                Clear
              </button>
            </div>
            <ul className="history-list">
              {history.map((item) => (
                <li key={item.id}>
                  <button type="button" className="history-item" onClick={() => restore(item)}>
                    <div className="history-meta">
                      <span>{item.result.detectedLanguage} → {item.target}</span>
                      <span className="muted">
                        {new Date(item.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <div className="history-snippet">{item.text.slice(0, 120)}{item.text.length > 120 ? '…' : ''}</div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
