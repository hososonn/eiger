import React, { useEffect, useRef } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { AppState, Message } from './types';

interface Props {
  appState: AppState;
  statusLabel: string;
  messages: Message[];
  isStopped: boolean;
  volumeDb: number;
  onToggleStop: () => void;
  onShowDB: () => void;
}

const STATUS_EMOJI: Record<AppState, string> = {
  calibrating: '🎙',
  waiting:     '🎤',
  recording:   '🔴',
  thinking:    '💭',
  idle:        '⏸',
};

export default function ChatScreen({
  appState, statusLabel, messages, isStopped, volumeDb, onToggleStop, onShowDB,
}: Props) {
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
  }, [messages]);

  // dBFS (-60〜0) → 0〜100% のバー幅
  const volumePct = Math.min(Math.max((volumeDb + 60) / 60 * 100, 0), 100);

  const statusBgColor =
    appState === 'recording' ? '#ffebee' :
    appState === 'thinking'  ? '#e3f2fd' :
    appState === 'calibrating' ? '#fff8e1' :
    '#e8f5e9';
  const statusBorderColor =
    appState === 'recording' ? '#ffcdd2' :
    appState === 'thinking'  ? '#bbdefb' :
    appState === 'calibrating' ? '#ffe082' :
    '#c8e6c9';

  return (
    <SafeAreaView style={styles.container}>
      {/* ヘッダー */}
      <View style={styles.header}>
        <Text style={styles.title}>動物園 飼育記録</Text>
        <TouchableOpacity style={styles.navBtn} onPress={onShowDB}>
          <Text style={styles.navBtnText}>📋 記録一覧</Text>
        </TouchableOpacity>
      </View>

      {/* ステータスバー */}
      <View style={[styles.statusBar, { backgroundColor: statusBgColor, borderBottomColor: statusBorderColor }]}>
        <Text style={styles.statusEmoji}>{STATUS_EMOJI[appState]}</Text>
        <Text style={styles.statusText}>{statusLabel}</Text>
      </View>

      {/* 音量バー */}
      <View style={styles.volumeTrack}>
        <View style={[styles.volumeFill, { width: `${volumePct}%` as `${number}%`,
          backgroundColor: appState === 'recording' ? '#ef5350' : '#66bb6a' }]} />
      </View>

      {/* チャットログ */}
      <ScrollView
        ref={scrollRef}
        style={styles.chatLog}
        contentContainerStyle={styles.chatLogContent}
      >
        {messages.length === 0 ? (
          <View style={styles.emptyHint}>
            <Text style={styles.emptyIcon}>🎙️</Text>
            <Text style={styles.emptyText}>
              マイクに向かって話しかけると{'\n'}記録が始まります
            </Text>
          </View>
        ) : (
          messages.map((msg, i) => (
            <View
              key={i}
              style={[
                styles.bubbleRow,
                msg.role === 'user' ? styles.userRow : styles.assistantRow,
              ]}
            >
              <Text style={styles.avatar}>
                {msg.role === 'user' ? '👤' : '🤖'}
              </Text>
              <View style={msg.role === 'user' ? styles.userBubble : styles.aiBubble}>
                <Text style={msg.role === 'user' ? styles.userText : styles.aiText}>
                  {msg.content}
                </Text>
                <Text style={styles.bubbleTime}>
                  {new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* フッター：停止/再開 */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.stopBtn, isStopped && styles.resumeBtn]}
          onPress={onToggleStop}
        >
          <Text style={styles.stopBtnText}>{isStopped ? '▶ 再開' : '⏹ 停止'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f2f5' },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e0e0e0',
  },
  title:      { fontSize: 16, fontWeight: '700', color: '#333' },
  navBtn:     { backgroundColor: '#f5f5f5', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  navBtnText: { fontSize: 13, color: '#555' },

  statusBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1,
  },
  statusEmoji: { fontSize: 18 },
  statusText:  { fontSize: 13, fontWeight: '600', color: '#444' },

  volumeTrack: { height: 3, backgroundColor: '#e0e0e0' },
  volumeFill:  { height: 3, borderRadius: 2 },

  chatLog:        { flex: 1 },
  chatLogContent: { padding: 16, gap: 12 },

  emptyHint: { alignItems: 'center', paddingTop: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 14, color: '#aaa', textAlign: 'center', lineHeight: 22 },

  bubbleRow:    { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 8 },
  userRow:      { flexDirection: 'row-reverse' },
  assistantRow: {},
  avatar:       { fontSize: 22 },

  userBubble: {
    maxWidth: '75%', borderRadius: 16, borderBottomRightRadius: 4,
    backgroundColor: '#1565c0', padding: 12,
  },
  aiBubble: {
    maxWidth: '75%', borderRadius: 16, borderBottomLeftRadius: 4,
    backgroundColor: '#fff', padding: 12,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 3, elevation: 2,
  },
  userText:   { fontSize: 15, lineHeight: 22, color: '#fff' },
  aiText:     { fontSize: 15, lineHeight: 22, color: '#222' },
  bubbleTime: { fontSize: 10, color: '#ffffff88', marginTop: 4, textAlign: 'right' },

  footer:  { padding: 16, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e0e0e0' },
  stopBtn: {
    backgroundColor: '#546e7a', borderRadius: 10,
    paddingVertical: 14, alignItems: 'center',
  },
  resumeBtn:    { backgroundColor: '#2e7d32' },
  stopBtnText:  { color: '#fff', fontSize: 15, fontWeight: '600' },
});
