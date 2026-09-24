import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { Theme, useTheme } from '../context/ThemeContext';
import {
  approveUploadRequest,
  approveUser,
  getAdminPasswordResets,
  getAdminUploadHistory,
  getAdminUploadRequests,
  getPendingUsers,
  rejectUploadRequest,
  rejectUser,
  resolvePasswordReset,
} from '../services/api';

type Tab = 'pending' | 'history';

const STATUS_COLORS: Record<string, string> = {
  completed: '#16a34a',
  approved: '#16a34a',
  rejected: '#ef4444',
  failed: '#ef4444',
};

export default function AdminScreen() {
  const { token } = useAuth();
  const { theme } = useTheme();
  const styles = makeStyles(theme);

  const [tab, setTab] = useState<Tab>('pending');
  const [users, setUsers] = useState<any[]>([]);
  const [uploads, setUploads] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [resets, setResets] = useState<any[]>([]);
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!token) return;
    const [u, up, h, r] = await Promise.allSettled([
      getPendingUsers(token),
      getAdminUploadRequests(token),
      getAdminUploadHistory(token),
      getAdminPasswordResets(token),
    ]);
    if (u.status === 'fulfilled') setUsers(u.value);
    if (up.status === 'fulfilled') setUploads(up.value);
    if (h.status === 'fulfilled') setHistory(h.value);
    if (r.status === 'fulfilled') setResets(r.value);
  }, [token]);

  useEffect(() => {
    fetchAll().finally(() => setLoading(false));
  }, [fetchAll]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  };

  const run = async (key: string, fn: () => Promise<any>) => {
    if (!token) return;
    setBusy(key);
    setError(null);
    try {
      await fn();
      await fetchAll();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const approveUpload = (id: string) =>
    run(id + '-approve', async () => {
      const updated = await approveUploadRequest(token!, id);
      if (updated?.status === 'failed') {
        setError(`Upload failed: ${updated?.result?.error ?? 'validation failed at approval'}`);
      }
    });

  const setPassword = (id: string) => {
    const pw = resetPasswords[id]?.trim();
    if (!pw) { setError('Enter a new password first.'); return; }
    run(id + '-reset', async () => {
      await resolvePasswordReset(token!, id, pw);
      setResetPasswords((prev) => { const n = { ...prev }; delete n[id]; return n; });
    });
  };

  const Btn = ({ label, k, onPress, kind }: { label: string; k: string; onPress: () => void; kind: 'ok' | 'no' }) => (
    <TouchableOpacity
      style={[styles.btn, kind === 'ok' ? styles.btnOk : styles.btnNo]}
      onPress={onPress}
      disabled={busy === k}
      activeOpacity={0.85}
    >
      {busy === k
        ? <ActivityIndicator size="small" color={kind === 'ok' ? '#fff' : '#ef4444'} />
        : <Text style={kind === 'ok' ? styles.btnOkText : styles.btnNoText}>{label}</Text>}
    </TouchableOpacity>
  );

  const Section = ({ title, count, children }: { title: string; count: number; children: React.ReactNode }) => (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <View style={styles.badge}><Text style={styles.badgeText}>{count}</Text></View>
      </View>
      {children}
    </View>
  );

  const uploadSummary = (req: any) => {
    const errCount = req.validation_report?.errors?.length ?? 0;
    return `Mode: ${req.write_mode}`
      + (req.key_columns?.length ? ` · keys: ${req.key_columns.join(', ')}` : '')
      + ` · validation: ${req.validation_status ?? 'n/a'}${errCount ? ` (${errCount} issues)` : ''}`;
  };

  const totalPending = users.length + uploads.length + resets.length;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.tabs}>
        {(['pending', 'history'] as Tab[]).map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'pending' ? `Pending (${totalPending})` : 'Upload history'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {error && <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View>}

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.accent} />
      ) : tab === 'pending' ? (
        <>
          {totalPending === 0 && <Text style={styles.empty}>All clear — nothing waiting for review.</Text>}

          {uploads.length > 0 && (
            <Section title="Data uploads" count={uploads.length}>
              {uploads.map((req) => (
                <View key={req.id} style={styles.card}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{req.user_email}</Text>
                  <Text style={styles.cardSub}>{req.file_name} → {req.target_database}.{req.target_table} ({req.target_type})</Text>
                  <Text style={styles.cardSub}>{uploadSummary(req)}</Text>
                  <Text style={styles.cardNote} numberOfLines={2}>
                    {req.justification ? `"${req.justification}"` : 'No justification provided'}
                  </Text>
                  <View style={styles.row}>
                    <Btn label="Approve & load" k={req.id + '-approve'} kind="ok" onPress={() => approveUpload(req.id)} />
                    <Btn label="Reject" k={req.id + '-reject'} kind="no"
                      onPress={() => run(req.id + '-reject', () => rejectUploadRequest(token!, req.id))} />
                  </View>
                </View>
              ))}
            </Section>
          )}

          {users.length > 0 && (
            <Section title="New users" count={users.length}>
              {users.map((u) => (
                <View key={u.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{[u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || u.email}</Text>
                  <Text style={styles.cardSub}>{u.email}{u.username ? ` · @${u.username}` : ''}</Text>
                  <View style={styles.row}>
                    <Btn label="Approve" k={u.id + '-approve'} kind="ok"
                      onPress={() => run(u.id + '-approve', () => approveUser(token!, u.id))} />
                    <Btn label="Reject" k={u.id + '-reject'} kind="no"
                      onPress={() => run(u.id + '-reject', () => rejectUser(token!, u.id))} />
                  </View>
                </View>
              ))}
            </Section>
          )}

          {resets.length > 0 && (
            <Section title="Password resets" count={resets.length}>
              {resets.map((r) => (
                <View key={r.id} style={styles.card}>
                  <Text style={styles.cardTitle}>{r.user_email}</Text>
                  <View style={styles.row}>
                    <TextInput
                      style={styles.input}
                      placeholder="New temporary password"
                      placeholderTextColor={theme.textMuted}
                      secureTextEntry
                      value={resetPasswords[r.id] ?? ''}
                      onChangeText={(v) => setResetPasswords((prev) => ({ ...prev, [r.id]: v }))}
                    />
                    <Btn label="Set password" k={r.id + '-reset'} kind="ok" onPress={() => setPassword(r.id)} />
                  </View>
                </View>
              ))}
            </Section>
          )}
        </>
      ) : history.length === 0 ? (
        <Text style={styles.empty}>No reviewed uploads yet.</Text>
      ) : (
        history.map((req) => (
          <View key={req.id} style={styles.card}>
            <View style={styles.row}>
              <Text style={[styles.cardTitle, { flex: 1 }]} numberOfLines={1}>{req.user_email}</Text>
              <Text style={[styles.status, { color: STATUS_COLORS[req.status] ?? theme.textSub }]}>{req.status}</Text>
            </View>
            <Text style={styles.cardSub}>{req.file_name} → {req.target_database}.{req.target_table} ({req.target_type})</Text>
            <Text style={styles.cardSub}>{new Date(req.created_at).toLocaleString()} · {req.write_mode}</Text>
            {req.result && (
              <Text style={styles.cardNote} numberOfLines={3}>
                {req.result.error ?? Object.entries(req.result).map(([k, v]) => `${k}: ${v}`).join(' · ')}
              </Text>
            )}
          </View>
        ))
      )}
    </ScrollView>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.bg },
  content: { padding: 16, gap: 12, maxWidth: 900, width: '100%', alignSelf: 'center' },
  tabs: { flexDirection: 'row', backgroundColor: t.toggleBg, borderRadius: 10, padding: 4, gap: 4 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  tabActive: { backgroundColor: t.toggleActive },
  tabText: { fontSize: 13, fontWeight: '600', color: t.textSub },
  tabTextActive: { color: t.text },
  error: { backgroundColor: t.errorBg, borderRadius: 8, padding: 10 },
  errorText: { color: t.errorText, fontSize: 13 },
  empty: { color: t.textSub, textAlign: 'center', marginTop: 40, fontSize: 14 },
  section: { gap: 8 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: t.text },
  badge: { backgroundColor: t.accent, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  card: { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 12, padding: 14, gap: 6 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: t.text },
  cardSub: { fontSize: 12, color: t.textSub },
  cardNote: { fontSize: 12, color: t.textMuted, fontStyle: 'italic' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  status: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  input: {
    flex: 1, minWidth: 160, borderWidth: 1, borderColor: t.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, color: t.text, backgroundColor: t.inputBg,
  },
  btn: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, minWidth: 90, alignItems: 'center' },
  btnOk: { backgroundColor: t.accent },
  btnNo: { borderWidth: 1, borderColor: '#fecaca', backgroundColor: 'transparent' },
  btnOkText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  btnNoText: { color: '#ef4444', fontWeight: '700', fontSize: 13 },
});
