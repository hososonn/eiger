import React from 'react';
import {
  FlatList,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { AnimalRecord } from './types';

const ANIMAL_ICONS: Record<string, string> = {
  ゾウ: '🐘', ライオン: '🦁', キリン: '🦒', ペンギン: '🐧',
  パンダ: '🐼', トラ: '🐯', クマ: '🐻', サル: '🐒', シマウマ: '🦓',
  カバ: '🦛', サイ: '🦏', フラミンゴ: '🦩', タコ: '🐙',
};

interface Props {
  records: AnimalRecord[];
  onNewRecord: () => void;
}

export default function DBScreen({ records, onNewRecord }: Props) {
  const renderItem = ({ item }: { item: AnimalRecord }) => {
    const dt       = new Date(item.timestamp);
    const dateStr  = dt.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
    const timeStr  = dt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const icon     = ANIMAL_ICONS[item.animal_type] ?? '🐾';
    const dataRows = Object.entries(item.data ?? {});

    return (
      <View style={styles.card}>
        {/* カードヘッダー */}
        <View style={styles.cardHeader}>
          <Text style={styles.animalIcon}>{icon}</Text>
          <View style={styles.cardTitle}>
            <Text style={styles.animalName}>
              {item.animal_type}
              {item.individual_name ? ` / ${item.individual_name}` : ''}
            </Text>
            <Text style={styles.recordId}>{item.id.slice(-6).toUpperCase()}</Text>
          </View>
          <Text style={styles.timestamp}>{dateStr}{'\n'}{timeStr}</Text>
        </View>

        {/* 記録データ */}
        <View style={styles.cardBody}>
          {dataRows.map(([k, v]) => (
            <View key={k} style={styles.dataRow}>
              <Text style={styles.dataLabel}>{k}</Text>
              <Text style={styles.dataValue}>
                {typeof v === 'object'
                  ? JSON.stringify(v).replace(/[{}"]/g, '').replace(/:/g, ': ')
                  : String(v)}
              </Text>
            </View>
          ))}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* ヘッダー */}
      <View style={styles.header}>
        <Text style={styles.title}>記録一覧</Text>
        <Text style={styles.count}>{records.length} 件</Text>
      </View>

      {records.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🗂</Text>
          <Text style={styles.emptyText}>まだ記録がありません</Text>
        </View>
      ) : (
        <FlatList
          data={records}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
        />
      )}

      {/* フッター */}
      <View style={styles.footer}>
        <TouchableOpacity style={styles.newBtn} onPress={onNewRecord}>
          <Text style={styles.newBtnText}>＋ 新規記録</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f2f5' },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e0e0e0',
  },
  title: { fontSize: 16, fontWeight: '700', color: '#333' },
  count: { fontSize: 13, color: '#888' },

  empty:     { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 14, color: '#aaa' },

  list: { padding: 12, gap: 12 },

  card: {
    backgroundColor: '#fff', borderRadius: 12,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 4, elevation: 2,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10,
    borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
  },
  animalIcon: { fontSize: 32 },
  cardTitle:  { flex: 1 },
  animalName: { fontSize: 15, fontWeight: '700', color: '#222' },
  recordId:   { fontSize: 11, color: '#bbb', marginTop: 2 },
  timestamp:  { fontSize: 11, color: '#888', textAlign: 'right', lineHeight: 16 },

  cardBody: { padding: 14, gap: 6 },
  dataRow:  { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  dataLabel: { fontSize: 12, fontWeight: '600', color: '#888', flex: 0.4 },
  dataValue: { fontSize: 13, color: '#333', flex: 0.6, textAlign: 'right' },

  footer: { padding: 16, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e0e0e0' },
  newBtn: {
    backgroundColor: '#1565c0', borderRadius: 10,
    paddingVertical: 14, alignItems: 'center',
  },
  newBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
