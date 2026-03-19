import React, { useEffect, useRef, useState } from 'react';
import { Audio } from 'expo-av';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import ChatScreen from './ChatScreen';
import DBScreen from './DBScreen';
import { AppState, Message, AnimalRecord, Role } from './types';

// ══════════════════════════════════════════
//  定数
// ══════════════════════════════════════════
const CALIBRATION_MS         = 1500;
const CALIBRATION_DB_MARGIN  = 12;   // ノイズフロア + 12 dBFS を閾値に
const MIN_THRESHOLD_DB       = -40;  // 閾値の下限
const MAX_THRESHOLD_DB       = -15;  // 閾値の上限
const SPEECH_ONSET_MS        = 80;   // 発話確定までの継続時間
const SILENCE_DURATION_MS    = 2000; // 無音でセグメント確定
const MIN_RECORD_MS          = 600;  // 最短録音時間
const STORAGE_KEY            = 'zoo_records_v1';
const METERING_INTERVAL_MS   = 50;

const API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? '';

// ══════════════════════════════════════════
//  システムプロンプト
// ══════════════════════════════════════════
const SYSTEM_PROMPT = `あなたは動物園の飼育記録アシスタントです。
飼育員が話した内容から飼育記録を作成する手伝いをします。

【ルール】
- 常に簡潔・丁寧な日本語で返答してください（1〜2文以内）
- 動物種が分かったら、その動物に適した記録項目を決定してください
- ゾウの場合、個体名の確認を最初に行ってください
- 不足している情報は1項目ずつ自然な会話で質問してください
- 記録に必要な最低項目：体調、食事量、排泄、特記事項
- 全項目が揃ったら必ずJSON形式で以下を返してください（他のテキストは不要）:
{"status":"complete","record":{"animal_type":"動物種","individual_name":"個体名（不明の場合は空文字）","data":{"体調":"...","食欲":"...","食事量":"...","排泄":"...","行動":"...","特記事項":"..."}}}

【注意】
- 音声で読み上げるため絵文字は使わないでください
- completeのJSON以外では絶対にJSONを返さないでください`;

// ══════════════════════════════════════════
//  録音オプション（メタリング有効）
// ══════════════════════════════════════════
const RECORDING_OPTIONS: Audio.RecordingOptions = {
  ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

// ══════════════════════════════════════════
//  OpenAI API
// ══════════════════════════════════════════
async function transcribeAudio(uri: string): Promise<string> {
  const form = new FormData();
  form.append('file', { uri, name: 'audio.m4a', type: 'audio/m4a' } as unknown as Blob);
  form.append('model', 'gpt-4o-transcribe');
  form.append('language', 'ja');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper ${res.status}`);
  const json = await res.json();
  return (json.text as string) ?? '';
}

async function chatCompletion(messages: Message[]): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      temperature: 0.4,
      max_tokens: 300,
    }),
  });
  if (!res.ok) throw new Error(`GPT ${res.status}`);
  const json = await res.json();
  return (json.choices[0].message.content as string).trim();
}

// ══════════════════════════════════════════
//  Storage
// ══════════════════════════════════════════
async function getDB(): Promise<{ records: AnimalRecord[] }> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as { records: AnimalRecord[] };
  } catch { /* ignore */ }
  return { records: [] };
}

async function persistRecord(
  record: Omit<AnimalRecord, 'id' | 'timestamp' | 'raw_conversation'>,
  conversation: Message[],
): Promise<void> {
  const db = await getDB();
  db.records.push({
    id: 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    timestamp: new Date().toISOString(),
    ...record,
    raw_conversation: [...conversation],
  });
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

// ══════════════════════════════════════════
//  App
// ══════════════════════════════════════════
export default function App() {
  const [screen, setScreen]       = useState<'chat' | 'db'>('chat');
  const [appState, setAppState]   = useState<AppState>('idle');
  const [statusLabel, setStatusLabel] = useState('');
  const [messages, setMessages]   = useState<Message[]>([]);
  const [records, setRecords]     = useState<AnimalRecord[]>([]);
  const [isStopped, setIsStopped] = useState(false);
  const [volumeDb, setVolumeDb]   = useState(-160);

  // ── Refs（クロージャの stale 化を防ぐ） ──
  const conversationRef    = useRef<Message[]>([]);
  const recordingRef       = useRef<Audio.Recording | null>(null);
  const meteringTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const thresholdRef       = useRef(MIN_THRESHOLD_DB);
  const appStateRef        = useRef<AppState>('idle');
  const isStoppedRef       = useRef(false);
  const isSpeakingRef      = useRef(false);
  const isPollingRef       = useRef(false); // メタリング多重呼び出し防止
  // VAD
  const speechOnsetTimeRef  = useRef<number | null>(null);
  const silenceStartTimeRef = useRef<number | null>(null);
  const recordStartTimeRef  = useRef(0);

  // ── ヘルパー ──
  const syncState = (s: AppState) => {
    appStateRef.current = s;
    setAppState(s);
    const labels: Record<AppState, string> = {
      calibrating: '環境音を計測中...',
      waiting:     '待機中 — 話しかけてください',
      recording:   '録音中...',
      thinking:    '考え中...',
      idle:        '停止中',
    };
    setStatusLabel(labels[s]);
  };

  const addMessage = (role: Role, content: string) =>
    setMessages(prev => [...prev, { role, content }]);

  // ── 初期化 ──
  useEffect(() => {
    if (!API_KEY) {
      setStatusLabel('EXPO_PUBLIC_OPENAI_API_KEY が未設定です (.env を確認)');
      return;
    }
    Audio.requestPermissionsAsync().then(({ granted }) => {
      if (granted) startSession();
      else setStatusLabel('マイクの許可が必要です');
    });
    return () => {
      stopMeteringLoop();
      recordingRef.current?.stopAndUnloadAsync().catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── セッション ──
  const startSession = async () => {
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    resetConversation();
    await calibrateNoiseFloor();
    if (!isStoppedRef.current) startWaiting();
  };

  const calibrateNoiseFloor = async () => {
    syncState('calibrating');
    const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
    const samples: number[] = [];
    const start = Date.now();
    await new Promise<void>(resolve => {
      const iv = setInterval(async () => {
        if (Date.now() - start >= CALIBRATION_MS) { clearInterval(iv); resolve(); return; }
        const s = await recording.getStatusAsync();
        if (s.isRecording && s.metering != null) samples.push(s.metering);
      }, METERING_INTERVAL_MS);
    });
    await recording.stopAndUnloadAsync();
    if (samples.length > 0) {
      samples.sort((a, b) => a - b);
      const trimmed = samples.slice(0, Math.floor(samples.length * 0.9));
      const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
      thresholdRef.current = Math.max(
        Math.min(avg + CALIBRATION_DB_MARGIN, MAX_THRESHOLD_DB),
        MIN_THRESHOLD_DB,
      );
      console.log(`[VAD] floor=${avg.toFixed(1)}dBFS → threshold=${thresholdRef.current.toFixed(1)}dBFS`);
    }
  };

  const startWaiting = async () => {
    if (isStoppedRef.current) return;
    speechOnsetTimeRef.current  = null;
    silenceStartTimeRef.current = null;
    const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
    recordingRef.current    = recording;
    recordStartTimeRef.current = Date.now();
    syncState('waiting');
    startMeteringLoop();
  };

  // ── メタリングループ（VAD） ──
  const startMeteringLoop = () => {
    stopMeteringLoop();
    meteringTimerRef.current = setInterval(handleMeteringTick, METERING_INTERVAL_MS);
  };

  const stopMeteringLoop = () => {
    if (meteringTimerRef.current) {
      clearInterval(meteringTimerRef.current);
      meteringTimerRef.current = null;
    }
  };

  const handleMeteringTick = async () => {
    if (isPollingRef.current || isSpeakingRef.current || isStoppedRef.current) return;
    const state = appStateRef.current;
    if (state !== 'waiting' && state !== 'recording') return;
    if (!recordingRef.current) return;

    isPollingRef.current = true;
    try {
      const status = await recordingRef.current.getStatusAsync();
      if (!status.isRecording || status.metering == null) return;

      const db  = status.metering;
      const thr = thresholdRef.current;
      const now = Date.now();
      setVolumeDb(db);

      if (state === 'waiting') {
        if (db > thr) {
          if (!speechOnsetTimeRef.current) {
            speechOnsetTimeRef.current = now;
          } else if (now - speechOnsetTimeRef.current >= SPEECH_ONSET_MS) {
            // 発話確定 → recording 状態へ
            speechOnsetTimeRef.current = null;
            recordStartTimeRef.current = now;
            syncState('recording');
          }
        } else {
          speechOnsetTimeRef.current = null;
        }
      } else { // recording
        if (db > thr) {
          silenceStartTimeRef.current = null;
        } else {
          if (!silenceStartTimeRef.current) {
            silenceStartTimeRef.current = now;
          } else if (
            now - silenceStartTimeRef.current >= SILENCE_DURATION_MS &&
            now - recordStartTimeRef.current  >= MIN_RECORD_MS
          ) {
            stopMeteringLoop();
            await stopAndProcess();
          }
        }
      }
    } finally {
      isPollingRef.current = false;
    }
  };

  // ── 録音停止 → Whisper → GPT → TTS ──
  const stopAndProcess = async () => {
    if (!recordingRef.current) return;
    syncState('thinking');
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      if (!uri) throw new Error('URI missing');

      const text = await transcribeAudio(uri);
      if (!text.trim()) { if (!isStoppedRef.current) startWaiting(); return; }

      addMessage('user', text);
      const reply = await processChat(text);
      addMessage('assistant', reply);
      await speakAsync(reply);
      if (!isStoppedRef.current && appStateRef.current !== 'idle') startWaiting();
    } catch (e) {
      console.error(e);
      if (!isStoppedRef.current) startWaiting();
    }
  };

  const processChat = async (userText: string): Promise<string> => {
    const updated: Message[] = [...conversationRef.current, { role: 'user', content: userText }];
    conversationRef.current = updated;
    const reply = await chatCompletion(updated);
    conversationRef.current = [...conversationRef.current, { role: 'assistant', content: reply }];

    // complete JSON 検出
    const match = reply.match(/\{[\s\S]*"status"\s*:\s*"complete"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { status: string; record: Omit<AnimalRecord, 'id' | 'timestamp' | 'raw_conversation'> };
        if (parsed.status === 'complete' && parsed.record) {
          await persistRecord(parsed.record, conversationRef.current);
          const db = await getDB();
          setRecords([...db.records].reverse());
          setTimeout(() => { syncState('idle'); setScreen('db'); }, 1800);
          return '記録を保存しました。ありがとうございます。';
        }
      } catch { /* ignore */ }
    }
    return reply;
  };

  const speakAsync = (text: string) =>
    new Promise<void>(resolve => {
      isSpeakingRef.current = true;
      Speech.speak(text, {
        language: 'ja',
        rate: 1.05,
        onDone:    () => { isSpeakingRef.current = false; resolve(); },
        onError:   () => { isSpeakingRef.current = false; resolve(); },
        onStopped: () => { isSpeakingRef.current = false; resolve(); },
      });
    });

  const resetConversation = () => {
    conversationRef.current = [];
    setMessages([]);
    setTimeout(() => {
      const greeting = 'どうぞ、記録を始めてください。';
      addMessage('assistant', greeting);
    }, 300);
  };

  // ── 停止 / 再開 ──
  const handleToggleStop = async () => {
    if (!isStopped) {
      isStoppedRef.current = true;
      setIsStopped(true);
      stopMeteringLoop();
      await recordingRef.current?.stopAndUnloadAsync().catch(() => {});
      recordingRef.current = null;
      Speech.stop();
      isSpeakingRef.current = false;
      syncState('idle');
    } else {
      isStoppedRef.current = false;
      setIsStopped(false);
      startWaiting();
    }
  };

  const handleGoToChat = () => {
    setScreen('chat');
    resetConversation();
    if (appStateRef.current === 'idle') startWaiting();
  };

  // DB 表示時にレコードを読み込む
  useEffect(() => {
    if (screen === 'db') getDB().then(db => setRecords([...db.records].reverse()));
  }, [screen]);

  // ── レンダリング ──
  if (screen === 'db') {
    return <DBScreen records={records} onNewRecord={handleGoToChat} />;
  }

  return (
    <>
      <StatusBar style="dark" />
      <ChatScreen
        appState={appState}
        statusLabel={statusLabel}
        messages={messages}
        isStopped={isStopped}
        volumeDb={volumeDb}
        onToggleStop={handleToggleStop}
        onShowDB={() => setScreen('db')}
      />
    </>
  );
}
