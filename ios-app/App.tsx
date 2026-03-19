import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import * as Speech from 'expo-speech';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

type ScreenMode = 'chat' | 'db';
type VoiceState = 'idle' | 'recording' | 'thinking' | 'speaking';
type ChatRole = 'user' | 'assistant';
type DbRoute =
  | { name: 'home' }
  | { name: 'animal'; animal_type: string }
  | { name: 'individual'; animal_type: string; individual_name: string };

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

type RecordItem = {
  id: string;
  timestamp: string;
  animal_type: string;
  individual_name: string;
  data: Record<string, unknown>;
  raw_conversation: { role: ChatRole; content: string }[];
};

type GptResponse = {
  status: 'in_progress' | 'complete';
  assistant_message: string;
  record?: Omit<RecordItem, 'id' | 'timestamp' | 'raw_conversation'>;
};

const STORAGE_KEY = 'zoo_records';
const SILENCE_THRESHOLD_DB = -55;
const SILENCE_DURATION_MS = 1500;
const NO_SPEECH_RESET_MS = 12000;
const SPEECH_DELTA_DB = 12;
const BACKEND_BASE = process.env.EXPO_PUBLIC_BACKEND_BASE_URL ?? 'http://localhost:8000';

const SYSTEM_PROMPT = `
あなたは動物園の飼育記録アシスタントです。
日本語で短く丁寧に会話してください（1〜2文）。
不足項目がある場合は1問だけ質問してください。
動物種に応じて必要項目を判断してください。
ゾウの場合は individual_name を必須にしてください。

必ず次のJSONのみを返してください（Markdownや説明文は禁止）:
{
  "status": "in_progress" | "complete",
  "assistant_message": "読み上げる短文",
  "record": {
    "animal_type": "文字列",
    "individual_name": "文字列",
    "data": { "項目名": "値", "...": "..." }
  }
}
status が in_progress の場合は record を省略可。
status が complete の場合は record を必ず含めること。
`.trim();

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export default function App() {
  const [screen, setScreen] = useState<ScreenMode>('chat');
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [dbRoute, setDbRoute] = useState<DbRoute>({ name: 'home' });
  const [errorText, setErrorText] = useState('');
  const [micReady, setMicReady] = useState(false);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const speechStartedRef = useRef(false);
  const speechStartedAtRef = useRef<number | null>(null);
  const silenceStartedAtRef = useRef<number | null>(null);
  const noiseFloorRef = useRef(-60);
  const autoRestartBlockedRef = useRef(false);
  const speakingRef = useRef(false);

  useEffect(() => {
    const init = async () => {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as { records?: RecordItem[] }) : {};
      setRecords(parsed.records ?? []);

      const permission = await Audio.requestPermissionsAsync();
      setMicReady(permission.status === 'granted');
      addAssistantMessage('開始ボタンを押すと待機状態になります。');
    };
    void init();
  }, []);

  useEffect(() => {
    if (screen !== 'chat' || !isSessionActive || !micReady) {
      return;
    }
    if (voiceState === 'idle' && !recordingRef.current && !speakingRef.current && !autoRestartBlockedRef.current) {
      void startListening();
    }
  }, [isSessionActive, micReady, screen, voiceState]);

  useEffect(() => {
    return () => {
      Speech.stop();
    };
  }, []);

  const statusText = useMemo(() => {
    if (!isSessionActive) return '⏹️ 停止中';
    if (voiceState === 'recording') return '🔴 録音中';
    if (voiceState === 'thinking') return '💭 考え中...';
    if (voiceState === 'speaking') return '🗣️ 読み上げ中...';
    return '🎤 待機中';
  }, [isSessionActive, voiceState]);

  const addMessage = (role: ChatRole, content: string) => {
    setMessages((prev) => [...prev, { id: makeId(), role, content }]);
  };

  const addAssistantMessage = (content: string) => addMessage('assistant', content);

  const persistRecords = async (next: RecordItem[]) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ records: next }));
  };

  const stopListening = async () => {
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (!rec) return null;
    rec.setOnRecordingStatusUpdate(null);
    await rec.stopAndUnloadAsync();
    return rec.getURI();
  };

  const startListening = async () => {
    try {
      setErrorText('');
      speechStartedRef.current = false;
      speechStartedAtRef.current = null;
      silenceStartedAtRef.current = null;
      noiseFloorRef.current = -60;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(
        ({
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
          ios: {
            ...Audio.RecordingOptionsPresets.HIGH_QUALITY.ios,
            isMeteringEnabled: true,
          },
          android: {
            ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
          },
        } as any),
        onRecordingStatus,
        200
      );
      recordingRef.current = recording;
      setVoiceState('idle');
    } catch {
      setErrorText('録音開始に失敗しました。マイク権限を確認してください。');
    }
  };

  const onRecordingStatus = (status: any) => {
    if (!status.isRecording || typeof status.metering !== 'number') return;
    const now = Date.now();
    const level = status.metering;
    // 環境ノイズに追従して、固定しきい値＋相対差の両方で判定する
    const prevFloor = noiseFloorRef.current;
    const nextFloor = prevFloor * 0.92 + level * 0.08;
    noiseFloorRef.current = nextFloor;
    const dynamicThreshold = Math.max(SILENCE_THRESHOLD_DB, nextFloor + SPEECH_DELTA_DB);
    const isLoud = level > dynamicThreshold;

    if (!speechStartedRef.current && isLoud) {
      speechStartedRef.current = true;
      speechStartedAtRef.current = now;
      silenceStartedAtRef.current = null;
      setVoiceState('recording');
      return;
    }

    if (!speechStartedRef.current) {
      if (speechStartedAtRef.current === null) speechStartedAtRef.current = now;
      if (now - speechStartedAtRef.current > NO_SPEECH_RESET_MS) {
        void resetRecorderForIdle();
      }
      return;
    }

    if (isLoud) {
      silenceStartedAtRef.current = null;
      return;
    }

    if (silenceStartedAtRef.current === null) {
      silenceStartedAtRef.current = now;
      return;
    }

    if (now - silenceStartedAtRef.current >= SILENCE_DURATION_MS) {
      autoRestartBlockedRef.current = true;
      void finalizeAndProcess();
    }
  };

  const resetRecorderForIdle = async () => {
    await stopListening();
    setVoiceState('idle');
    autoRestartBlockedRef.current = false;
    void startListening();
  };

  const transcribeWithWhisper = async (audioUri: string): Promise<string> => {
    const formData = new FormData();
    formData.append('language', 'ja');
    formData.append('file', {
      uri: audioUri,
      name: 'voice.m4a',
      type: 'audio/m4a',
    } as unknown as Blob);

    const res = await fetch(`${BACKEND_BASE}/transcribe`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Whisper API エラー: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() ?? '';
  };

  const askGpt = async (nextUserText: string): Promise<GptResponse> => {
    const conv = messages
      .map((m) => ({ role: m.role, content: m.content }))
      .concat([{ role: 'user' as const, content: nextUserText }]);

    const res = await fetch(`${BACKEND_BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_prompt: SYSTEM_PROMPT,
        messages: conv,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`GPT API エラー: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as GptResponse;
    if (!data.status || !data.assistant_message) {
      throw new Error('GPTレスポンス形式が不正です。');
    }
    return data;
  };

  const speak = (text: string): Promise<void> => {
    return new Promise((resolve) => {
      setVoiceState('speaking');
      speakingRef.current = true;
      Speech.speak(text, {
        language: 'ja-JP',
        rate: 1,
        onDone: () => {
          speakingRef.current = false;
          resolve();
        },
        onStopped: () => {
          speakingRef.current = false;
          resolve();
        },
        onError: () => {
          speakingRef.current = false;
          resolve();
        },
      });
    });
  };

  const completeRecord = async (record: NonNullable<GptResponse['record']>) => {
    const item: RecordItem = {
      id: makeId(),
      timestamp: new Date().toISOString(),
      animal_type: record.animal_type || '不明',
      individual_name: record.individual_name || '不明',
      data: record.data || {},
      raw_conversation: [...messages.map((m) => ({ role: m.role, content: m.content }))],
    };
    const next = [item, ...records];
    setRecords(next);
    await persistRecords(next);
    setScreen('db');
  };

  const finalizeAndProcess = async () => {
    setVoiceState('thinking');
    try {
      const uri = await stopListening();
      if (!uri) throw new Error('録音データが取得できませんでした。');
      const transcript = await transcribeWithWhisper(uri);
      console.log('[whisper transcript]', transcript);
      if (!transcript) {
        addAssistantMessage('（無音でした。もう一度お願いします）');
        setVoiceState('idle');
        autoRestartBlockedRef.current = false;
        return;
      }

      addMessage('user', transcript);
      const gpt = await askGpt(transcript);
      addAssistantMessage(gpt.assistant_message);
      await speak(gpt.assistant_message);

      if (gpt.status === 'complete' && gpt.record) {
        await completeRecord(gpt.record);
      }
      setVoiceState('idle');
    } catch (err) {
      setVoiceState('idle');
      const msg = err instanceof Error ? err.message : '処理に失敗しました。';
      console.error('[voice flow error]', err);
      setErrorText(msg);
      addAssistantMessage('エラーが発生しました。もう一度お願いします。');
    } finally {
      autoRestartBlockedRef.current = false;
    }
  };

  const onToggleSession = async () => {
    if (!isSessionActive) {
      setErrorText('');
      setIsSessionActive(true);
      setVoiceState('idle');
      addAssistantMessage('待機を開始しました。話しかけてください。');
      return;
    }

    setIsSessionActive(false);
    autoRestartBlockedRef.current = true;
    Speech.stop();
    await stopListening();
    setVoiceState('idle');
    addAssistantMessage('待機を終了しました。');
  };

  const onNewRecord = () => {
    setScreen('chat');
    setMessages([]);
    addAssistantMessage('新しい記録を始めます。開始ボタンを押してください。');
    setVoiceState('idle');
    setIsSessionActive(false);
  };

  const renderChat = () => (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerEyebrow}>Zoo Voice Recorder</Text>
        <Text style={styles.headerTitle}>動物園 飼育記録</Text>
        <View style={styles.statusPill}>
          <Text style={styles.status}>{statusText}</Text>
        </View>
      </View>

      {errorText ? <Text style={styles.error}>{errorText}</Text> : null}

      <ScrollView
        contentContainerStyle={styles.chatList}
        showsVerticalScrollIndicator={false}
      >
        {messages.map((m) => (
          <View
            key={m.id}
            style={[
              styles.bubbleRow,
              m.role === 'user' ? styles.userRow : styles.assistantRow,
            ]}
          >
            <View style={[styles.avatar, m.role === 'user' ? styles.userAvatar : styles.assistantAvatar]}>
              <Text style={styles.avatarText}>{m.role === 'user' ? 'YOU' : 'AI'}</Text>
            </View>
            <View style={[styles.bubble, m.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
              <Text style={styles.bubbleRole}>{m.role === 'user' ? 'あなた' : 'アシスタント'}</Text>
              <Text style={styles.bubbleText}>{m.content}</Text>
            </View>
          </View>
        ))}
      </ScrollView>

      <TouchableOpacity
        style={[styles.primaryButton, isSessionActive ? styles.stopButton : null]}
        onPress={() => void onToggleSession()}
      >
        <Text style={styles.primaryButtonText}>{isSessionActive ? '終了' : '開始'}</Text>
      </TouchableOpacity>
      <View style={styles.buttonGap} />
      <TouchableOpacity
        style={styles.secondaryButton}
        onPress={() => {
          setDbRoute({ name: 'home' });
          setScreen('db');
        }}
      >
        <Text style={styles.secondaryButtonText}>DB一覧を見る</Text>
      </TouchableOpacity>
    </View>
  );

  const formatDateTime = (iso: string) => {
    const d = new Date(iso);
    const date = d.toLocaleDateString('ja-JP');
    const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
  };

  const getAvailableRecords = () => {
    return records;
  };

  const getAnimalTypes = () => {
    const all = getAvailableRecords();
    const types = Array.from(new Set(all.map((r) => r.animal_type))).filter(Boolean);
    // 要件: 「ゾウ」導線を出して3頭選択へ
    if (!types.includes('ゾウ')) types.unshift('ゾウ');
    return types;
  };

  const getIndividuals = (animal_type: string) => {
    const all = getAvailableRecords().filter((r) => r.animal_type === animal_type);
    if (animal_type === 'ゾウ') {
      // 固定3頭（要件のデモ導線）
      return ['ハナコ', 'タロウ', 'ミドリ'];
    }
    return Array.from(new Set(all.map((r) => r.individual_name))).filter(Boolean);
  };

  const getIndividualRecords = (animal_type: string, individual_name: string) => {
    const all = getAvailableRecords()
      .filter((r) => r.animal_type === animal_type && r.individual_name === individual_name)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return all;
  };

  const renderRecord = ({ item }: { item: RecordItem }) => (
    <View style={styles.recordCard}>
      <Text style={styles.recordTitle}>
        {item.animal_type} / {item.individual_name}
      </Text>
      <Text style={styles.recordMeta}>{formatDateTime(item.timestamp)}</Text>
      {Object.entries(item.data).map(([k, v]) => (
        <Text key={`${item.id}-${k}`} style={styles.recordItem}>
          {k}: {typeof v === 'string' ? v : JSON.stringify(v)}
        </Text>
      ))}
    </View>
  );

  const renderDb = () => (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerEyebrow}>Local Records</Text>
        <Text style={styles.headerTitle}>
          {dbRoute.name === 'home'
            ? '保存済み記録'
            : dbRoute.name === 'animal'
              ? dbRoute.animal_type
              : dbRoute.individual_name}
        </Text>
        {dbRoute.name !== 'home' && (
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => {
              if (dbRoute.name === 'individual') {
                setDbRoute({ name: 'animal', animal_type: dbRoute.animal_type });
                return;
              }
              setDbRoute({ name: 'home' });
            }}
          >
            <Text style={styles.backButtonText}>← 戻る</Text>
          </TouchableOpacity>
        )}
      </View>
      {dbRoute.name === 'home' && (
        <>
          <Text style={styles.sectionTitle}>動物種</Text>
          <View style={styles.grid}>
            {getAnimalTypes().map((t) => (
              <TouchableOpacity
                key={t}
                style={styles.gridCard}
                onPress={() => setDbRoute({ name: 'animal', animal_type: t })}
              >
                <Text style={styles.gridCardTitle}>{t}</Text>
                <Text style={styles.gridCardSub}>タップして個体一覧へ</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}

      {dbRoute.name === 'animal' && (
        <>
          <Text style={styles.sectionTitle}>個体を選択</Text>
          <View style={styles.grid}>
            {getIndividuals(dbRoute.animal_type).map((name) => (
              <TouchableOpacity
                key={name}
                style={styles.gridCard}
                onPress={() => setDbRoute({ name: 'individual', animal_type: dbRoute.animal_type, individual_name: name })}
              >
                <Text style={styles.gridCardTitle}>{name}</Text>
                <Text style={styles.gridCardSub}>データを見る</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}

      {dbRoute.name === 'individual' && (
        <>
          <Text style={styles.sectionTitle}>記録一覧</Text>
          <FlatList
            data={getIndividualRecords(dbRoute.animal_type, dbRoute.individual_name)}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={styles.detailCard}>
                <Text style={styles.detailMeta}>{formatDateTime(item.timestamp)}</Text>
                {Object.entries(item.data).map(([k, v]) => (
                  <View key={`${item.id}-detail-${k}`} style={styles.kvRow}>
                    <Text style={styles.kvKey}>{k}</Text>
                    <Text style={styles.kvVal}>{typeof v === 'string' ? v : JSON.stringify(v)}</Text>
                  </View>
                ))}
              </View>
            )}
            ListEmptyComponent={<Text style={styles.empty}>この個体の記録はまだありません。</Text>}
            contentContainerStyle={styles.dbList}
          />
        </>
      )}
      <TouchableOpacity style={styles.primaryButton} onPress={onNewRecord}>
        <Text style={styles.primaryButtonText}>＋ 新規記録</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        {screen === 'chat' ? renderChat() : renderDb()}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b1020' },
  screen: { flex: 1, paddingHorizontal: 16, paddingVertical: 12 },
  header: { marginBottom: 14 },
  headerEyebrow: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: '#8b9cff',
    marginBottom: 4,
  },
  headerTitle: { fontSize: 28, fontWeight: '800', color: '#e8edff' },
  backButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#2c3963',
    backgroundColor: '#111a34',
  },
  backButtonText: { color: '#cfdaff', fontWeight: '800', fontSize: 13 },
  statusPill: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(122, 162, 255, 0.2)',
    borderColor: 'rgba(122, 162, 255, 0.45)',
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  status: { fontSize: 14, color: '#dbe7ff', fontWeight: '700' },
  chatList: { paddingBottom: 20, gap: 10 },
  sectionTitle: { marginTop: 6, marginBottom: 10, color: '#c8d5ff', fontSize: 14, fontWeight: '800' },
  divider: { height: 1, backgroundColor: '#243052', marginVertical: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gridCard: {
    width: '48%',
    backgroundColor: '#121a31',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#27365f',
  },
  gridCardTitle: { fontSize: 16, fontWeight: '900', color: '#e7eeff' },
  gridCardSub: { marginTop: 6, fontSize: 12, color: '#97a9d9', fontWeight: '700' },
  bubbleRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  userRow: { justifyContent: 'flex-end' },
  assistantRow: { justifyContent: 'flex-start' },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  userAvatar: { backgroundColor: '#3b82f6' },
  assistantAvatar: { backgroundColor: '#8b5cf6' },
  avatarText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  bubble: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxWidth: '82%',
    borderWidth: 1,
  },
  userBubble: { backgroundColor: '#1e3a8a', borderColor: '#3b82f6' },
  assistantBubble: { backgroundColor: '#111a34', borderColor: '#2c3963' },
  bubbleRole: { fontSize: 11, fontWeight: '700', color: '#9db3ff', marginBottom: 4 },
  bubbleText: { fontSize: 15, color: '#edf2ff', lineHeight: 22 },
  primaryButton: {
    backgroundColor: '#4f7cff',
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    shadowColor: '#4f7cff',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  stopButton: {
    backgroundColor: '#dc2626',
    shadowColor: '#dc2626',
  },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  buttonGap: { height: 10 },
  secondaryButton: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#35508d',
    paddingVertical: 13,
    alignItems: 'center',
    backgroundColor: '#121a31',
  },
  secondaryButtonText: { color: '#b8c9ff', fontSize: 15, fontWeight: '700' },
  error: {
    color: '#ff7a7a',
    marginBottom: 8,
    textAlign: 'center',
    backgroundColor: 'rgba(255, 57, 57, 0.12)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 122, 122, 0.35)',
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  dbList: { paddingBottom: 12 },
  recordCard: {
    backgroundColor: '#121a31',
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#27365f',
  },
  recordTitle: { fontSize: 16, fontWeight: '800', color: '#e7eeff' },
  recordMeta: { fontSize: 12, color: '#97a9d9', marginTop: 4, marginBottom: 8 },
  recordItem: { fontSize: 14, color: '#cfdaff', marginBottom: 4 },
  empty: { textAlign: 'center', color: '#9eb0df', marginTop: 16 },
  detailCard: {
    backgroundColor: '#121a31',
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#27365f',
  },
  detailMeta: { fontSize: 12, color: '#97a9d9', fontWeight: '800', marginBottom: 10 },
  kvRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  kvKey: { width: 92, color: '#9db3ff', fontWeight: '900', fontSize: 13 },
  kvVal: { flex: 1, color: '#edf2ff', fontWeight: '700', fontSize: 13 },
});
