import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

// ローカルのバックエンドURL（Mac の IP に合わせて変更）
const API_BASE = 'http://localhost:8000';

type Segment = { start: number; end: number; text: string };

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [language, setLanguage] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState('');
  const recordingRef = useRef<Audio.Recording | null>(null);

  useEffect(() => {
    Audio.requestPermissionsAsync();
  }, []);

  const startRecording = async () => {
    try {
      setError('');
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setIsRecording(true);
    } catch (e) {
      setError('録音の開始に失敗しました');
    }
  };

  const stopAndTranscribe = async () => {
    if (!recordingRef.current) return;
    setIsRecording(false);
    setIsLoading(true);
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      if (!uri) throw new Error('録音ファイルが見つかりません');

      const formData = new FormData();
      formData.append('file', {
        uri,
        name: 'recording.m4a',
        type: 'audio/m4a',
      } as unknown as Blob);

      const res = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      const data = await res.json();
      setTranscript(data.text);
      setLanguage(data.language);
      setSegments(data.segments ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '文字起こしに失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Whisper 音声認識</Text>

      <TouchableOpacity
        style={[styles.button, isRecording && styles.buttonActive]}
        onPress={isRecording ? stopAndTranscribe : startRecording}
        disabled={isLoading}
      >
        {isLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>
            {isRecording ? '■ 停止して文字起こし' : '● 録音開始'}
          </Text>
        )}
      </TouchableOpacity>

      {error !== '' && <Text style={styles.error}>{error}</Text>}

      {transcript !== '' && (
        <View style={styles.result}>
          <Text style={styles.label}>
            文字起こし結果 {language ? `(${language})` : ''}
          </Text>
          <Text style={styles.transcript}>{transcript}</Text>
          {segments.length > 0 && (
            <>
              <Text style={[styles.label, { marginTop: 12 }]}>セグメント</Text>
              {segments.map((seg, i) => (
                <Text key={i} style={styles.segment}>
                  [{seg.start.toFixed(1)}s – {seg.end.toFixed(1)}s] {seg.text}
                </Text>
              ))}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 32,
  },
  button: {
    backgroundColor: '#2563eb',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonActive: {
    backgroundColor: '#dc2626',
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  error: {
    color: '#dc2626',
    marginTop: 16,
    textAlign: 'center',
  },
  result: {
    marginTop: 24,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  label: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 8,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  transcript: {
    fontSize: 16,
    lineHeight: 24,
    color: '#111',
  },
  segment: {
    fontSize: 13,
    color: '#374151',
    marginBottom: 4,
  },
});
