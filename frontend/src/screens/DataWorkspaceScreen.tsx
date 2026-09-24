import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
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
  createFolder,
  deleteFolder,
  deleteWorkspaceFile,
  downloadWorkspaceFileUrl,
  getFileContent,
  getFileVersions,
  getMyUploadRequests,
  getUploadTargets,
  listFolders,
  listWorkspaceFiles,
  saveFileContent,
  submitUploadRequest,
  uploadWorkspaceFile,
} from '../services/api';

type WsFile = {
  id: string;
  folder_id: string | null;
  original_name: string;
  format: string;
  current_version: number;
  row_count: number | null;
  size_bytes: number | null;
  updated_at?: string;
};

type Folder = {
  id: string;
  parent_id: string | null;
  name: string;
  created_at?: string;
  path: string;
};

type Target = {
  target_type: string;
  database: string | null;
  schema_name: string | null;
  table: string;
  label: string;
  enabled: boolean;
};

type MainTab = 'edit' | 'versions' | 'upload' | 'requests';

function humanSize(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(s?: string): string {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '—';
  }
}

function fileIcon(fmt: string): any {
  return fmt === 'xlsx' ? 'grid-outline' : fmt === 'json' ? 'code-outline' : 'document-text-outline';
}

// OneDrive-style colored glyphs by type.
function typeMeta(isFolder: boolean, fmt?: string): { icon: any; color: string } {
  if (isFolder) return { icon: 'folder', color: '#f2b807' };
  if (fmt === 'xlsx' || fmt === 'csv') return { icon: 'document-text', color: '#107c41' };
  if (fmt === 'json') return { icon: 'code-slash', color: '#7c3aed' };
  return { icon: 'document-text', color: '#2563eb' };
}

export default function DataWorkspaceScreen() {
  const { token } = useAuth();
  const { theme } = useTheme();
  const st = useMemo(() => makeStyles(theme), [theme]);

  const [files, setFiles] = useState<WsFile[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<WsFile | null>(null);
  const [tab, setTab] = useState<MainTab>('edit');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderErr, setFolderErr] = useState<string | null>(null);
  const [createMenu, setCreateMenu] = useState(false);
  const [sortKey, setSortKey] = useState<'name' | 'modified' | 'size'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [navView, setNavView] = useState<'files' | 'uploads'>('files');

  const loadAll = useCallback(async () => {
    if (!token) return;
    try {
      const [fileData, folderData] = await Promise.all([listWorkspaceFiles(token), listFolders(token)]);
      setFiles(fileData);
      setFolders(folderData);
      setSelected((cur) => (cur ? fileData.find((f: WsFile) => f.id === cur.id) ?? null : null));
    } catch (e: any) {
      setError(e.message);
    }
  }, [token]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // ── File picking (web-first: hidden DOM input) ──
  const pickFile = () => {
    if (typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.xlsx,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !token) return;
      setBusy(true);
      setError(null);
      try {
        const created = await uploadWorkspaceFile(token, file, currentFolderId);
        await loadAll();
        setSelected(created);
        setTab('edit');
      } catch (e: any) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    };
    input.click();
  };

  const openNewFolder = () => {
    setNewFolderName('');
    setFolderErr(null);
    setNewFolderOpen(true);
  };

  const submitNewFolder = async () => {
    if (!token) return;
    const name = newFolderName.trim();
    if (!name) {
      setFolderErr('Please enter a folder name.');
      return;
    }
    setFolderBusy(true);
    setFolderErr(null);
    try {
      await createFolder(token, name, currentFolderId);
      setNewFolderOpen(false);
      await loadAll();
    } catch (e: any) {
      setFolderErr(e.message);
    } finally {
      setFolderBusy(false);
    }
  };

  const removeFolder = async (id: string) => {
    if (!token) return;
    try {
      await deleteFolder(token, id);
      await loadAll();
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Current-folder view (Finder-style navigation) ──
  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;
  const q = search.trim().toLowerCase();

  const subFolders = folders
    .filter((f) => f.parent_id === currentFolderId)
    .filter((f) => (q ? f.name.toLowerCase().includes(q) : true))
    .sort((a, b) => a.name.localeCompare(b.name));

  const folderFiles = files
    .filter((f) => (f.folder_id ?? null) === currentFolderId)
    .filter((f) => (q ? f.original_name.toLowerCase().includes(q) : true));

  // Breadcrumb chain from root to current folder
  const crumbs: Folder[] = [];
  let walk: Folder | null = currentFolder;
  while (walk) {
    crumbs.unshift(walk);
    walk = folders.find((f) => f.id === walk!.parent_id) ?? null;
  }

  const isEmpty = subFolders.length === 0 && folderFiles.length === 0;

  const downloadFile = (f: WsFile) => {
    if (typeof window === 'undefined') return;
    fetch(downloadWorkspaceFileUrl(f.id), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.blob())
      .then((b) => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(b);
        link.download = f.original_name;
        link.click();
      });
  };

  const toggleSort = (k: 'name' | 'modified' | 'size') => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };

  const sortedFiles = [...folderFiles].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'name') cmp = a.original_name.localeCompare(b.original_name);
    else if (sortKey === 'size') cmp = (a.size_bytes ?? 0) - (b.size_bytes ?? 0);
    else cmp = new Date(a.updated_at ?? 0).getTime() - new Date(b.updated_at ?? 0).getTime();
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const doUpload = () => { setCreateMenu(false); pickFile(); };
  const doNewFolder = () => { setCreateMenu(false); openNewFolder(); };

  const SortHead = ({ label, k, style }: { label: string; k: 'name' | 'modified' | 'size'; style?: any }) => (
    <TouchableOpacity style={[st.thBtn, style]} onPress={() => toggleSort(k)} activeOpacity={0.6}>
      <Text style={st.th}>{label}</Text>
      {sortKey === k && (
        <Ionicons name={sortDir === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} color={theme.textSub} />
      )}
    </TouchableOpacity>
  );

  return (
    <View style={st.page}>
      <View style={st.content}>
      {error && (
        <View style={st.errorBar}>
          <Text style={st.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => setError(null)}><Text style={st.errorClose}>✕</Text></TouchableOpacity>
        </View>
      )}

      {!selected ? (
        /* ── OneDrive-style layout: left rail + file list ── */
        <View style={st.odRoot}>
          {/* Left nav rail */}
          <View style={st.rail}>
            <View>
              <TouchableOpacity style={st.createBtn} activeOpacity={0.9} onPress={() => setCreateMenu((v) => !v)}>
                <Ionicons name="add" size={18} color="#fff" />
                <Text style={st.createBtnText}>Create or upload</Text>
              </TouchableOpacity>
              {createMenu && (
                <View style={st.createMenu}>
                  <TouchableOpacity style={st.menuItem} onPress={doNewFolder}>
                    <Ionicons name="folder-outline" size={16} color={theme.accent} />
                    <Text style={st.menuItemText}>Folder</Text>
                  </TouchableOpacity>
                  <View style={st.menuDivider} />
                  <TouchableOpacity style={st.menuItem} onPress={doUpload}>
                    <Ionicons name="cloud-upload-outline" size={16} color={theme.accent} />
                    <Text style={st.menuItemText}>Files upload</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            <View style={{ marginTop: 8 }}>
              <TouchableOpacity style={[st.navItem, navView === 'files' && st.navItemActive]} onPress={() => setNavView('files')} activeOpacity={0.7}>
                <Ionicons name="folder" size={18} color={navView === 'files' ? theme.accent : theme.textSub} />
                <Text style={[st.navText, navView === 'files' && st.navTextActive]}>My files</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[st.navItem, navView === 'uploads' && st.navItemActive]} onPress={() => setNavView('uploads')} activeOpacity={0.7}>
                <Ionicons name="cloud-upload-outline" size={18} color={navView === 'uploads' ? theme.accent : theme.textSub} />
                <Text style={[st.navText, navView === 'uploads' && st.navTextActive]}>Uploads</Text>
              </TouchableOpacity>
              <View style={[st.navItem, { opacity: 0.5 }]}>
                <Ionicons name="trash-outline" size={18} color={theme.textSub} />
                <Text style={st.navText}>Recycle bin</Text>
              </View>
            </View>
          </View>

          {/* Main area */}
          <View style={st.odMain}>
            {navView === 'uploads' ? (
              <>
                <Text style={st.crumb}>Uploads</Text>
                <View style={st.tableCard}>
                  <RequestsTab />
                </View>
              </>
            ) : (
            <>
            <View style={st.odTopbar}>
              <View style={st.breadcrumb}>
                <TouchableOpacity onPress={() => setCurrentFolderId(null)}>
                  <Text style={[st.crumb, currentFolderId === null && st.crumbActive]}>My files</Text>
                </TouchableOpacity>
                {crumbs.map((c) => (
                  <View key={c.id} style={st.crumbRow}>
                    <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
                    <TouchableOpacity onPress={() => setCurrentFolderId(c.id)}>
                      <Text style={[st.crumb, c.id === currentFolderId && st.crumbActive]} numberOfLines={1}>{c.name}</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
              <View style={st.searchWrap}>
                <Ionicons name="search-outline" size={15} color={theme.textMuted} />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search"
                  placeholderTextColor={theme.textMuted}
                  style={st.searchInput}
                />
              </View>
            </View>

            <View style={st.tableCard}>
              <View style={st.thead}>
                <SortHead label="Name" k="name" style={st.colName} />
                <SortHead label="Modified" k="modified" style={st.colDate} />
                <SortHead label="File size" k="size" style={st.colNum} />
                <Text style={[st.th, st.colType]}>Type</Text>
                <View style={st.colActions} />
              </View>

              <ScrollView style={{ flex: 1 }}>
                {isEmpty && (
                  <View style={st.emptyBig}>
                    <Ionicons name="cloud-upload-outline" size={54} color={theme.textMuted} />
                    <Text style={st.emptyBigTitle}>{q ? `No results for “${search}”` : 'This folder is empty'}</Text>
                    {!q && <Text style={st.emptyBigSub}>Drag files here or use “Create or upload”.</Text>}
                  </View>
                )}

                {subFolders.map((folder) => {
                  const m = typeMeta(true);
                  return (
                    <TouchableOpacity key={folder.id} style={st.trow} activeOpacity={0.6} onPress={() => setCurrentFolderId(folder.id)}>
                      <View style={[st.tName, st.colName]}>
                        <Ionicons name={m.icon} size={24} color={m.color} />
                        <Text style={st.nameText} numberOfLines={1}>{folder.name}</Text>
                      </View>
                      <Text style={[st.td, st.colDate]}>{fmtDate(folder.created_at)}</Text>
                      <Text style={[st.td, st.colNum]}>—</Text>
                      <Text style={[st.td, st.colType]}>Folder</Text>
                      <View style={st.colActions}>
                        <TouchableOpacity onPress={() => removeFolder(folder.id)} style={st.rowActionBtn}>
                          <Ionicons name="trash-outline" size={16} color={theme.textMuted} />
                        </TouchableOpacity>
                      </View>
                    </TouchableOpacity>
                  );
                })}

                {sortedFiles.map((f) => {
                  const m = typeMeta(false, f.format);
                  return (
                    <TouchableOpacity key={f.id} style={st.trow} activeOpacity={0.6} onPress={() => { setSelected(f); setTab('edit'); }}>
                      <View style={[st.tName, st.colName]}>
                        <Ionicons name={m.icon} size={24} color={m.color} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={st.nameText} numberOfLines={1}>{f.original_name}</Text>
                          <Text style={st.nameSub}>v{f.current_version} · {f.row_count ?? 0} rows</Text>
                        </View>
                      </View>
                      <Text style={[st.td, st.colDate]}>{fmtDate(f.updated_at)}</Text>
                      <Text style={[st.td, st.colNum]}>{humanSize(f.size_bytes)}</Text>
                      <Text style={[st.td, st.colType]}>{f.format.toUpperCase()}</Text>
                      <View style={st.colActions}>
                        <TouchableOpacity onPress={() => downloadFile(f)} style={st.rowActionBtn}>
                          <Ionicons name="download-outline" size={16} color={theme.textSub} />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={async () => { await deleteWorkspaceFile(token!, f.id); loadAll(); }} style={st.rowActionBtn}>
                          <Ionicons name="trash-outline" size={16} color={theme.textMuted} />
                        </TouchableOpacity>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
            </>
            )}
          </View>
        </View>
      ) : (
        /* ── Full-width file editor ── */
        <View style={st.editorPane}>
          <View style={st.editorHeader}>
            <TouchableOpacity style={st.backBtn} onPress={() => setSelected(null)} activeOpacity={0.7}>
              <Ionicons name="arrow-back" size={18} color={theme.accent} />
              <Text style={st.backBtnText}>Files</Text>
            </TouchableOpacity>
            <View style={[st.rowIcon, { backgroundColor: theme.accentBg }]}>
              <Ionicons name={fileIcon(selected.format)} size={16} color={theme.accent} />
            </View>
            <Text style={st.editorTitle} numberOfLines={1}>{selected.original_name}</Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity style={st.smallBtn} onPress={() => downloadFile(selected)}>
              <Ionicons name="download-outline" size={14} color={theme.accent} />
              <Text style={st.smallBtnText}>Download</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[st.smallBtn, { borderColor: theme.errorText }]}
              onPress={async () => { await deleteWorkspaceFile(token!, selected.id); setSelected(null); loadAll(); }}
            >
              <Text style={[st.smallBtnText, { color: theme.errorText }]}>Delete</Text>
            </TouchableOpacity>
          </View>

          <View style={st.tabBar}>
            {([
              ['edit', 'Preview / Edit', 'create-outline'],
              ['versions', 'Versions', 'time-outline'],
              ['upload', 'Upload to table', 'push-outline'],
              ['requests', 'My requests', 'list-outline'],
            ] as [MainTab, string, any][]).map(([key, label, icon]) => (
              <TouchableOpacity
                key={key}
                style={[st.tab, tab === key && st.tabActive]}
                onPress={() => setTab(key)}
              >
                <Ionicons name={icon} size={15} color={tab === key ? theme.accent : theme.textSub} />
                <Text style={[st.tabText, tab === key && st.tabTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={{ flex: 1 }}>
            {tab === 'edit' && <EditTab key={selected.id + selected.current_version} file={selected} onSaved={loadAll} />}
            {tab === 'versions' && <VersionsTab file={selected} />}
            {tab === 'upload' && <UploadTab file={selected} />}
            {tab === 'requests' && <RequestsTab />}
          </View>
        </View>
      )}
      </View>

      {/* New folder modal (OneDrive-style) */}
      <Modal visible={newFolderOpen} transparent animationType="fade" onRequestClose={() => setNewFolderOpen(false)}>
        <Pressable style={st.modalOverlay} onPress={() => !folderBusy && setNewFolderOpen(false)}>
          <Pressable style={st.modalCard} onPress={(e) => e.stopPropagation()}>
            <View style={st.modalHeader}>
              <View style={[st.fileIconWrap, { backgroundColor: theme.chipBg }]}>
                <Ionicons name="folder" size={18} color={theme.accent} />
              </View>
              <Text style={st.modalTitle}>Create a folder</Text>
            </View>
            {currentFolder && (
              <Text style={st.modalSub}>Inside “{currentFolder.name}”</Text>
            )}
            <TextInput
              value={newFolderName}
              onChangeText={(v) => { setNewFolderName(v); setFolderErr(null); }}
              placeholder="Folder name"
              placeholderTextColor={theme.textMuted}
              style={st.modalInput}
              autoFocus
              onSubmitEditing={submitNewFolder}
            />
            {folderErr && <Text style={st.modalErr}>{folderErr}</Text>}
            <View style={st.modalActions}>
              <TouchableOpacity
                style={[st.modalBtn, st.modalCancel]}
                onPress={() => setNewFolderOpen(false)}
                disabled={folderBusy}
              >
                <Text style={st.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[st.modalBtn, st.modalCreate, (!newFolderName.trim() || folderBusy) && { opacity: 0.55 }]}
                onPress={submitNewFolder}
                disabled={!newFolderName.trim() || folderBusy}
              >
                {folderBusy
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={st.modalCreateText}>Create</Text>}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ── Edit tab: spreadsheet-style grid ─────────────────────────────────────────

const ROWNUM_W = 52;
const ACTION_W = 48;
const COL_MIN = 120;
const COL_MAX = 340;
const CHAR_W = 8; // approx px per char at 13px font

function EditTab({ file, onSaved }: { file: WsFile; onSaved: () => void }) {
  const { token } = useAuth();
  const { theme } = useTheme();
  const st = useMemo(() => makeStyles(theme), [theme]);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [cellEdit, setCellEdit] = useState<{ ri: number; col: string; value: string } | null>(null);
  const [headerEdit, setHeaderEdit] = useState<{ idx: number; value: string } | null>(null);
  const [widthOverride, setWidthOverride] = useState<Record<string, number>>({});
  const [delimMode, setDelimMode] = useState<'auto' | 'comma' | 'tab' | 'semicolon' | 'pipe' | 'custom'>('auto');
  const [customDelim, setCustomDelim] = useState('');
  const [usedDelim, setUsedDelim] = useState<string | null>(null);
  const isCsv = file.format === 'csv';

  const delimParam =
    delimMode === 'auto' ? undefined : delimMode === 'custom' ? (customDelim || undefined) : delimMode;

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const c = await getFileContent(token!, file.id, undefined, isCsv ? delimParam : undefined);
        setColumns(c.columns);
        setRows(c.rows);
        setUsedDelim(c.delimiter ?? null);
      } catch (e: any) {
        setMsg(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [file.id, token, delimParam, isCsv]);

  // Content-aware column widths: size to the longest of header + a sample of
  // values, clamped so huge values don't blow out the layout (they get the
  // expand editor instead).
  const colWidths = useMemo(() => {
    const sample = rows.slice(0, 60);
    const w: Record<string, number> = {};
    for (const c of columns) {
      let longest = c.length;
      for (const r of sample) {
        const len = r[c] == null ? 0 : String(r[c]).length;
        if (len > longest) longest = len;
      }
      w[c] = Math.max(COL_MIN, Math.min(COL_MAX, longest * CHAR_W + 24));
    }
    return w;
  }, [columns, rows]);

  // A column is numeric if every non-empty sampled value parses as a number →
  // right-align it (spreadsheet convention) for readable value comparison.
  const numericCols = useMemo(() => {
    const sample = rows.slice(0, 60);
    const set = new Set<string>();
    for (const c of columns) {
      let sawValue = false;
      let allNum = true;
      for (const r of sample) {
        const v = r[c];
        if (v == null || String(v).trim() === '') continue;
        sawValue = true;
        if (isNaN(Number(String(v).replace(/,/g, '')))) { allNum = false; break; }
      }
      if (sawValue && allNum) set.add(c);
    }
    return set;
  }, [columns, rows]);

  const setCell = (ri: number, col: string, val: string) => {
    setRows((prev) => {
      const next = [...prev];
      next[ri] = { ...next[ri], [col]: val };
      return next;
    });
  };
  const renameColumn = (idx: number, val: string) => {
    setColumns((prev) => {
      const old = prev[idx];
      const next = [...prev];
      next[idx] = val;
      setRows((rs) => rs.map((r) => {
        const { [old]: v, ...rest } = r;
        return { ...rest, [val]: v };
      }));
      return next;
    });
  };
  const addRow = () => setRows((prev) => [...prev, Object.fromEntries(columns.map((c) => [c, '']))]);
  const deleteRow = (ri: number) => setRows((prev) => prev.filter((_, i) => i !== ri));

  const widthOf = (c: string) => widthOverride[c] ?? colWidths[c] ?? COL_MIN;

  // Excel-style drag-to-resize (web). Grabs the handle on a column's right edge
  // and updates that column's width live while dragging.
  const startResize = (c: string, clientX: number) => {
    if (Platform.OS !== 'web') return;
    const startX = clientX;
    const startW = widthOf(c);
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(60, Math.round(startW + (ev.clientX - startX)));
      setWidthOverride((prev) => ({ ...prev, [c]: next }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const applyHeaderEdit = () => {
    if (!headerEdit) return;
    const name = headerEdit.value.trim();
    const old = columns[headerEdit.idx];
    if (name && name !== old && !columns.includes(name)) renameColumn(headerEdit.idx, name);
    setHeaderEdit(null);
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      // Preserve the file's delimiter (e.g. keep a TSV tab-separated).
      await saveFileContent(token!, file.id, columns, rows, 'Edited in workspace', isCsv ? (usedDelim ?? undefined) : undefined);
      setMsg('Saved as a new version.');
      onSaved();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <ActivityIndicator style={{ marginTop: 40 }} color={theme.accent} />;

  return (
    <View style={{ flex: 1 }}>
      <View style={st.editToolbar}>
        <TouchableOpacity style={st.toolBtn} onPress={addRow}>
          <Ionicons name="add" size={15} color={theme.text} />
          <Text style={st.toolBtnText}>Add row</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[st.toolBtn, st.primaryBtn]} onPress={save} disabled={saving}>
          <Ionicons name="save-outline" size={14} color="#fff" />
          <Text style={[st.toolBtnText, { color: '#fff' }]}>{saving ? 'Saving…' : 'Save version'}</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <Text style={st.gridCount}>{rows.length} rows · {columns.length} cols</Text>
        {msg && <Text style={st.savedMsg}>{msg}</Text>}
      </View>

      {isCsv && (
        <View style={st.delimBar}>
          <Text style={st.delimLabel}>Delimiter</Text>
          <View style={{ width: 220 }}>
            <Dropdown
              z={20}
              value={delimMode}
              placeholder="Auto-detect"
              options={[
                { value: 'auto', label: usedDelim && delimMode === 'auto'
                  ? `Auto (detected ${usedDelim === '\t' ? 'Tab' : usedDelim === ',' ? 'Comma' : usedDelim === ';' ? 'Semicolon' : usedDelim === '|' ? 'Pipe' : usedDelim})`
                  : 'Auto-detect' },
                { value: 'comma', label: 'Comma  ,' },
                { value: 'tab', label: 'Tab  ⇥' },
                { value: 'semicolon', label: 'Semicolon  ;' },
                { value: 'pipe', label: 'Pipe  |' },
                { value: 'custom', label: 'Custom…' },
              ]}
              onSelect={(v) => setDelimMode(v as typeof delimMode)}
            />
          </View>
          {delimMode === 'custom' && (
            <TextInput
              value={customDelim}
              onChangeText={(v) => setCustomDelim(v.slice(0, 1))}
              placeholder="char"
              placeholderTextColor={theme.textMuted}
              style={st.delimInput}
              maxLength={1}
            />
          )}
        </View>
      )}

      <ScrollView horizontal style={st.gridScroll} contentContainerStyle={{ flexGrow: 1 }}>
        <ScrollView style={{ flex: 1 }} nestedScrollEnabled>
          <View>
            {/* Header row (sticky on web) */}
            <View style={[st.gridRow, st.headerRow]}>
              <View style={[st.cell, st.rowNumCell, { width: ROWNUM_W }]}>
                <Text style={st.headerCellText}>#</Text>
              </View>
              {columns.map((c, ci) => (
                <View key={ci} style={[st.cell, st.headerCell, { width: widthOf(c) }]}>
                  <View
                    style={st.headerLabelBtn}
                    {...(Platform.OS === 'web'
                      ? ({ onDoubleClick: () => setHeaderEdit({ idx: ci, value: c }), title: 'Double-click to rename' } as any)
                      : {})}
                  >
                    <Text style={st.headerLabel} numberOfLines={1}>{c}</Text>
                  </View>
                  <View
                    style={st.resizeHandle}
                    {...(Platform.OS === 'web'
                      ? ({ onMouseDown: (e: any) => { e.preventDefault(); startResize(c, e.clientX); } } as any)
                      : {})}
                  />
                </View>
              ))}
              <View style={[st.cell, st.actionCell, { width: ACTION_W }]} />
            </View>

            {/* Data rows */}
            {rows.map((r, ri) => (
              <View key={ri} style={[st.gridRow, ri % 2 === 1 && st.zebra]}>
                <View style={[st.cell, st.rowNumCell, { width: ROWNUM_W }]}>
                  <Text style={st.rowNumText}>{ri + 1}</Text>
                </View>
                {columns.map((c, ci) => {
                  const raw = r[c] == null ? '' : String(r[c]);
                  const big = raw.length > 40;
                  const num = numericCols.has(c);
                  return (
                    <View key={ci} style={[st.cell, st.dataCell, { width: widthOf(c) }]}>
                      <TextInput
                        value={raw}
                        onChangeText={(v) => setCell(ri, c, v)}
                        style={[st.cellInput, num && st.cellInputNum]}
                        numberOfLines={1}
                      />
                      {big && (
                        <TouchableOpacity
                          style={st.expandBtn}
                          onPress={() => setCellEdit({ ri, col: c, value: raw })}
                        >
                          <Ionicons name="expand-outline" size={12} color={theme.textSub} />
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
                <TouchableOpacity style={[st.cell, st.actionCell, { width: ACTION_W }]} onPress={() => deleteRow(ri)}>
                  <Ionicons name="trash-outline" size={14} color={theme.errorText} />
                </TouchableOpacity>
              </View>
            ))}
            {rows.length === 0 && <Text style={st.emptyHint}>No rows yet. Use “Add row”.</Text>}
          </View>
        </ScrollView>
      </ScrollView>

      {/* Rename column header */}
      <Modal visible={!!headerEdit} transparent animationType="fade" onRequestClose={() => setHeaderEdit(null)}>
        <Pressable style={st.modalOverlay} onPress={() => setHeaderEdit(null)}>
          <Pressable style={st.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={st.modalTitle}>Rename column</Text>
            <TextInput
              value={headerEdit?.value ?? ''}
              onChangeText={(v) => setHeaderEdit((h) => (h ? { ...h, value: v } : h))}
              style={st.modalInput}
              placeholder="Column name"
              placeholderTextColor={theme.textMuted}
              autoFocus
              onSubmitEditing={applyHeaderEdit}
            />
            <View style={st.modalActions}>
              <TouchableOpacity style={[st.modalBtn, st.modalCancel]} onPress={() => setHeaderEdit(null)}>
                <Text style={st.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[st.modalBtn, st.modalCreate]} onPress={applyHeaderEdit}>
                <Text style={st.modalCreateText}>Rename</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Full-value cell editor (for long values) */}
      <Modal visible={!!cellEdit} transparent animationType="fade" onRequestClose={() => setCellEdit(null)}>
        <Pressable style={st.modalOverlay} onPress={() => setCellEdit(null)}>
          <Pressable style={[st.modalCard, { maxWidth: 560 }]} onPress={(e) => e.stopPropagation()}>
            <Text style={st.modalTitle}>Edit “{cellEdit?.col}”</Text>
            <Text style={st.modalSub}>Row {cellEdit ? cellEdit.ri + 1 : ''}</Text>
            <TextInput
              value={cellEdit?.value ?? ''}
              onChangeText={(v) => setCellEdit((c) => (c ? { ...c, value: v } : c))}
              style={[st.modalInput, { height: 160, textAlignVertical: 'top' }]}
              multiline
              autoFocus
            />
            <View style={st.modalActions}>
              <TouchableOpacity style={[st.modalBtn, st.modalCancel]} onPress={() => setCellEdit(null)}>
                <Text style={st.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[st.modalBtn, st.modalCreate]}
                onPress={() => {
                  if (cellEdit) setCell(cellEdit.ri, cellEdit.col, cellEdit.value);
                  setCellEdit(null);
                }}
              >
                <Text style={st.modalCreateText}>Apply</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ── Versions tab ─────────────────────────────────────────────────────────────

function VersionsTab({ file }: { file: WsFile }) {
  const { token } = useAuth();
  const { theme } = useTheme();
  const st = useMemo(() => makeStyles(theme), [theme]);
  const [versions, setVersions] = useState<any[]>([]);

  useEffect(() => {
    getFileVersions(token!, file.id).then(setVersions).catch(() => {});
  }, [file.id, file.current_version, token]);

  return (
    <ScrollView style={{ flex: 1, padding: 16 }}>
      {versions.map((v) => (
        <View key={v.version} style={st.versionRow}>
          <View style={st.versionBadge}><Text style={st.versionBadgeText}>v{v.version}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={st.versionNote}>{v.note ?? 'Version'}</Text>
            <Text style={st.versionMeta}>
              {v.row_count ?? 0} rows · {humanSize(v.size_bytes)} · {new Date(v.created_at).toLocaleString()}
            </Text>
          </View>
          {v.version === file.current_version && <Text style={st.currentTag}>current</Text>}
        </View>
      ))}
    </ScrollView>
  );
}

// ── Reusable dropdown ────────────────────────────────────────────────────────

type Opt = { value: string; label: string };

function Dropdown({
  value, placeholder, options, onSelect, disabled, z,
}: {
  value: string; placeholder: string; options: Opt[];
  onSelect: (v: string) => void; disabled?: boolean; z?: number;
}) {
  const { theme } = useTheme();
  const st = useMemo(() => makeStyles(theme), [theme]);
  const [open, setOpen] = useState(false);
  const sel = options.find((o) => o.value === value);
  return (
    <View style={{ zIndex: open ? 100 : z ?? 1 }}>
      <TouchableOpacity
        style={[st.dd, disabled && st.ddDisabled]}
        disabled={disabled}
        activeOpacity={0.8}
        onPress={() => setOpen((o) => !o)}
      >
        <Text style={sel ? st.ddValue : st.ddPlaceholder} numberOfLines={1}>
          {sel ? sel.label : placeholder}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={theme.textSub} />
      </TouchableOpacity>
      {open && !disabled && (
        <View style={st.ddMenu}>
          <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
            {options.length === 0 && <Text style={st.ddEmpty}>No options available</Text>}
            {options.map((o) => (
              <TouchableOpacity key={o.value} style={st.ddItem} onPress={() => { onSelect(o.value); setOpen(false); }}>
                <Text style={[st.ddItemText, o.value === value && { color: theme.accent, fontWeight: '700' }]}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

// ── Upload tab: governed upload to a table ───────────────────────────────────

const TYPE_LABELS: Record<string, string> = { bigquery: '🔷  BigQuery', postgres: '🐘  PostgreSQL', oracle: '🟠  Oracle (coming soon)' };

function UploadTab({ file }: { file: WsFile }) {
  const { token } = useAuth();
  const { theme } = useTheme();
  const st = useMemo(() => makeStyles(theme), [theme]);

  const [targets, setTargets] = useState<Target[]>([]);
  const [targetType, setTargetType] = useState('');
  const [database, setDatabase] = useState('');
  const [table, setTable] = useState('');
  const [mode, setMode] = useState<'append' | 'upsert'>('append');
  const [keyCols, setKeyCols] = useState<string>('');
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [result, setResult] = useState<any>(null);

  const columns: string[] = (file as any).column_meta?.map?.((m: any) => m.name) ?? [];

  useEffect(() => {
    getUploadTargets(token!).then(setTargets).catch(() => {});
  }, [token]);

  // Cascading options derived from the flat target list.
  const typeOptions: Opt[] = [
    { value: 'bigquery', label: TYPE_LABELS.bigquery },
    { value: 'postgres', label: TYPE_LABELS.postgres },
    { value: 'oracle', label: TYPE_LABELS.oracle },
  ].filter((o) => o.value === 'oracle' || targets.some((t) => t.target_type === o.value && t.enabled));

  const dbOptions: Opt[] = Array.from(
    new Set(targets.filter((t) => t.target_type === targetType && t.enabled && t.database).map((t) => t.database as string)),
  ).map((d) => ({ value: d, label: d }));

  const tableOptions: Opt[] = targets
    .filter((t) => t.target_type === targetType && t.database === database && t.enabled)
    .map((t) => ({ value: t.table, label: t.table }));

  const isOracle = targetType === 'oracle';
  const isBq = targetType === 'bigquery';
  const chosen = targets.find(
    (t) => t.target_type === targetType && t.database === database && t.table === table,
  );
  const ready = !!chosen && !isOracle && (mode !== 'upsert' || keyCols.trim().length > 0);

  const onType = (v: string) => { setTargetType(v); setDatabase(''); setTable(''); };
  const onDb = (v: string) => { setDatabase(v); setTable(''); };

  const submit = async () => {
    if (!chosen) return;
    setSubmitting(true);
    setReport(null);
    setResult(null);
    try {
      const resp = await submitUploadRequest(token!, {
        file_id: file.id,
        target_type: chosen.target_type,
        database: chosen.database,
        schema_name: chosen.schema_name ?? 'public',
        table: chosen.table,
        write_mode: mode,
        key_columns: mode === 'upsert' ? keyCols.split(',').map((s) => s.trim()).filter(Boolean) : null,
        justification: justification || null,
      });
      if (resp.status === 'failed') setReport(resp.validation_report);
      else setResult(resp);
    } catch (e: any) {
      setReport({ summary: e.message, errors: [] });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1, padding: 16 }} contentContainerStyle={{ maxWidth: 640 }}>
      <Text style={st.label}>Target type</Text>
      <Dropdown
        z={4}
        value={targetType}
        placeholder="Select BigQuery, PostgreSQL or Oracle"
        options={typeOptions}
        onSelect={onType}
      />

      {!isOracle && targetType !== '' && (
        <>
          <Text style={st.label}>{isBq ? 'Dataset' : 'Database'}</Text>
          <Dropdown
            z={3}
            value={database}
            placeholder={isBq ? 'Select a dataset' : 'Select a database'}
            options={dbOptions}
            onSelect={onDb}
          />
        </>
      )}

      {!isOracle && database !== '' && (
        <>
          <Text style={st.label}>Table</Text>
          <Dropdown
            z={2}
            value={table}
            placeholder="Select a table"
            options={tableOptions}
            onSelect={setTable}
          />
        </>
      )}

      {isOracle && (
        <View style={st.reportBox}>
          <Text style={st.reportTitle}>Oracle support is coming soon.</Text>
        </View>
      )}

      {!isOracle && (
        <>
          <Text style={st.label}>Write mode</Text>
          <View style={st.modeRow}>
            <TouchableOpacity style={[st.modeBtn, mode === 'append' && st.modeBtnActive]} onPress={() => setMode('append')}>
              <Text style={[st.modeBtnText, mode === 'append' && { color: theme.accent }]}>Insert (append)</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[st.modeBtn, mode === 'upsert' && st.modeBtnActive]} onPress={() => setMode('upsert')}>
              <Text style={[st.modeBtnText, mode === 'upsert' && { color: theme.accent }]}>Upsert</Text>
            </TouchableOpacity>
          </View>

          {mode === 'upsert' && (
            <>
              <Text style={st.label}>Key column(s) — comma separated</Text>
              <TextInput
                value={keyCols}
                onChangeText={setKeyCols}
                placeholder={columns.length ? `e.g. ${columns[0]}` : 'e.g. id'}
                placeholderTextColor={theme.textMuted}
                style={st.input}
              />
            </>
          )}

          <Text style={st.label}>Justification</Text>
          <TextInput
            value={justification}
            onChangeText={setJustification}
            placeholder="Why is this data being added?"
            placeholderTextColor={theme.textMuted}
            style={[st.input, { height: 64 }]}
            multiline
          />

          <TouchableOpacity
            style={[st.submitBtn, (!ready || submitting) && { opacity: 0.5 }]}
            onPress={submit}
            disabled={!ready || submitting}
          >
            <Text style={st.submitBtnText}>{submitting ? 'Validating…' : 'Validate & submit for approval'}</Text>
          </TouchableOpacity>
        </>
      )}

      {result && (
        <View style={st.successBox}>
          <Text style={st.successText}>
            ✓ Validation passed. Request submitted (status: {result.status}). An admin will review it.
          </Text>
        </View>
      )}

      {report && (
        <View style={st.reportBox}>
          <Text style={st.reportTitle}>Validation failed — {report.summary}</Text>
          {(report.errors ?? []).slice(0, 50).map((e: any, i: number) => (
            <Text key={i} style={st.reportErr}>
              {e.row != null ? `Row ${e.row + 1}` : 'File'}{e.column ? ` · ${e.column}` : ''} — {e.message}
            </Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ── Requests tab ─────────────────────────────────────────────────────────────

function RequestsTab() {
  const { token } = useAuth();
  const { theme } = useTheme();
  const st = useMemo(() => makeStyles(theme), [theme]);
  const [reqs, setReqs] = useState<any[]>([]);

  useEffect(() => {
    getMyUploadRequests(token!).then(setReqs).catch(() => {});
  }, [token]);

  const statusColor = (s: string) =>
    s === 'completed' ? '#10b981' : s === 'pending' ? '#f59e0b' : s === 'rejected' || s === 'failed' ? theme.errorText : theme.textSub;

  return (
    <ScrollView style={{ flex: 1, padding: 16 }}>
      {reqs.length === 0 && <Text style={st.emptyHint}>No upload requests yet.</Text>}
      {reqs.map((r) => (
        <View key={r.id ?? Math.random()} style={st.reqRow}>
          <View style={{ flex: 1 }}>
            <Text style={st.reqTitle}>{r.file_name} → {r.target_database}.{r.target_table}</Text>
            <Text style={st.reqMeta}>{r.target_type} · {r.write_mode}{r.key_columns?.length ? ` · keys: ${r.key_columns.join(', ')}` : ''}</Text>
            {r.result?.error && <Text style={st.reqError}>{r.result.error}</Text>}
            {r.result && !r.result.error && (
              <Text style={st.reqOk}>
                {r.result.inserted != null ? `inserted ${r.result.inserted}, updated ${r.result.updated ?? 0}` : `affected ${r.result.affected ?? 0}`}
              </Text>
            )}
            {r.review_note && <Text style={st.reqMeta}>Note: {r.review_note}</Text>}
          </View>
          <Text style={[st.reqStatus, { color: statusColor(r.status) }]}>{r.status}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: Theme) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: t.bg, paddingVertical: 20, paddingHorizontal: 24 },
    content: { flex: 1, width: '100%', maxWidth: 1360, alignSelf: 'center' },

    // ── OneDrive shell ──
    odRoot: { flex: 1, flexDirection: 'row' },
    rail: { width: 220, paddingRight: 16 },
    createBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: t.accent, borderRadius: 24, paddingVertical: 11, paddingHorizontal: 16 },
    createBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    createMenu: { marginTop: 6, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingVertical: 4, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } },
    menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 14 },
    menuItemText: { fontSize: 13, color: t.text, fontWeight: '600' },
    menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginVertical: 2 },
    navItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 8, marginTop: 2 },
    navItemActive: { backgroundColor: t.accentBg },
    navText: { fontSize: 14, color: t.textSub, fontWeight: '600' },
    navTextActive: { color: t.text, fontWeight: '700' },
    odMain: { flex: 1, gap: 14 },
    odTopbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
    thBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },

    errorBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: t.errorBg, borderRadius: 10, padding: 10, marginBottom: 12 },
    errorText: { color: t.errorText, fontSize: 13, flex: 1 },
    errorClose: { color: t.errorText, fontWeight: '800', paddingHorizontal: 8 },

    fileIconWrap: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

    // ── Browser ──
    browser: { flex: 1, gap: 14 },
    toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 },
    breadcrumb: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
    crumbRow: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 220 },
    crumb: { fontSize: 20, color: t.textSub, fontWeight: '800' },
    crumbActive: { color: t.text },
    toolbarActions: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 10, height: 38, minWidth: 200 },
    searchInput: { flex: 1, fontSize: 13, color: t.text, paddingVertical: 0, outlineStyle: 'none' as any },
    ghostBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, borderRadius: 8, paddingHorizontal: 14, height: 38 },
    ghostBtnText: { fontSize: 13, fontWeight: '700', color: t.accent },
    primaryCta: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.accent, borderRadius: 8, paddingHorizontal: 16, height: 38 },
    primaryCtaText: { fontSize: 13, fontWeight: '700', color: '#fff' },

    tableCard: { flex: 1, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 12, overflow: 'hidden' },
    thead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.inputBg },
    th: { fontSize: 11, fontWeight: '800', color: t.textSub, textTransform: 'uppercase', letterSpacing: 0.5 },
    trow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border },
    td: { fontSize: 13, color: t.textSub },
    colName: { flex: 4, minWidth: 200 },
    colType: { flex: 1, minWidth: 70 },
    colNum: { flex: 1.4, minWidth: 90 },
    colDate: { flex: 2, minWidth: 120 },
    colActions: { width: 84, flexDirection: 'row', justifyContent: 'flex-end', gap: 4 },
    tName: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    rowIcon: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    nameText: { fontSize: 14, fontWeight: '600', color: t.text },
    nameSub: { fontSize: 11, color: t.textMuted, marginTop: 1 },
    rowActionBtn: { padding: 7, borderRadius: 6 },
    emptyHint: { fontSize: 12, color: t.textMuted, padding: 16, lineHeight: 18, textAlign: 'center' },
    emptyBig: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 80 },
    emptyBigTitle: { fontSize: 16, fontWeight: '700', color: t.textSub },
    emptyBigSub: { fontSize: 13, color: t.textMuted },

    // ── Editor ──
    editorPane: { flex: 1 },
    editorHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
    backBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: t.surface } as any,
    backBtnText: { fontSize: 13, fontWeight: '700', color: t.accent },
    editorTitle: { fontSize: 18, fontWeight: '800', color: t.text, maxWidth: 520 },
    smallBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
    smallBtnText: { fontSize: 12, fontWeight: '600', color: t.accent },

    tabBar: { flexDirection: 'row', gap: 4, borderBottomWidth: 1, borderBottomColor: t.border, marginBottom: 8 },
    tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
    tabActive: { borderBottomColor: t.accent },
    tabText: { fontSize: 13, color: t.textSub, fontWeight: '600' },
    tabTextActive: { color: t.accent },

    editToolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    toolBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
    primaryBtn: { backgroundColor: t.accent, borderColor: t.accent },
    toolBtnText: { fontSize: 12, fontWeight: '700', color: t.text },
    gridCount: { fontSize: 11, color: t.textMuted, fontWeight: '600' },
    savedMsg: { fontSize: 12, color: '#10b981', fontWeight: '600' },
    delimBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap', zIndex: 30, position: 'relative' },
    delimLabel: { fontSize: 11, fontWeight: '800', color: t.textSub, textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 2 },
    delimChip: { borderWidth: 1, borderColor: t.border, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: t.surface },
    delimChipActive: { borderColor: t.accentBorder, backgroundColor: t.accentBg },
    delimChipText: { fontSize: 12, fontWeight: '600', color: t.textSub },
    delimInput: { borderWidth: 1, borderColor: t.accentBorder, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 4, width: 56, fontSize: 13, color: t.text, backgroundColor: t.surface, outlineStyle: 'none' as any, textAlign: 'center' },
    delimDetected: { fontSize: 11, color: t.textMuted, marginLeft: 4 },

    gridScroll: { flex: 1, borderWidth: 1, borderColor: t.border, borderRadius: 10, backgroundColor: t.surface },
    gridRow: { flexDirection: 'row', alignItems: 'stretch', minHeight: 34 },
    headerRow: { position: 'sticky' as any, top: 0, zIndex: 2 },
    zebra: { backgroundColor: t.inputBg },
    cell: {
      borderRightWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      justifyContent: 'center',
      overflow: 'hidden',
    },
    headerCell: { backgroundColor: t.chipBg, flexDirection: 'row', alignItems: 'center', position: 'relative' },
    headerLabelBtn: { flex: 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 8, cursor: 'pointer' as any },
    headerLabel: { fontSize: 12, fontWeight: '800', color: t.text },
    resizeHandle: { position: 'absolute', top: 0, bottom: 0, right: 0, width: 6, cursor: 'col-resize' as any, backgroundColor: 'transparent', zIndex: 3 },
    headerCellText: { fontWeight: '800', color: t.textSub, fontSize: 11, textAlign: 'center' },
    dataCell: { flexDirection: 'row', alignItems: 'center' },
    cellInput: { flex: 1, minWidth: 0, fontSize: 13, color: t.text, paddingHorizontal: 10, paddingVertical: 7, outlineStyle: 'none' as any },
    cellInputNum: { textAlign: 'right', fontVariant: ['tabular-nums'] as any },
    expandBtn: { paddingHorizontal: 6, height: '100%', justifyContent: 'center' },
    rowNumCell: { backgroundColor: t.inputBg, alignItems: 'center', position: 'sticky' as any, left: 0, zIndex: 1 },
    rowNumText: { fontSize: 11, color: t.textMuted, fontWeight: '600' },
    actionCell: { alignItems: 'center', backgroundColor: 'transparent' },

    label: { fontSize: 12, fontWeight: '700', color: t.textSub, marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
    dd: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 12, height: 42, backgroundColor: t.surface },
    ddDisabled: { opacity: 0.5 },
    ddValue: { fontSize: 14, color: t.text, flex: 1 },
    ddPlaceholder: { fontSize: 14, color: t.textMuted, flex: 1 },
    ddMenu: { position: 'absolute', top: 46, left: 0, right: 0, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingVertical: 4, shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
    ddItem: { paddingHorizontal: 12, paddingVertical: 10 },
    ddItemText: { fontSize: 14, color: t.text },
    ddEmpty: { fontSize: 13, color: t.textMuted, padding: 12 },
    targetList: { gap: 6 },
    targetChip: { borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: t.surface },
    targetChipActive: { borderColor: t.accentBorder, backgroundColor: t.accentBg },
    targetChipDisabled: { opacity: 0.45 },
    targetChipText: { fontSize: 13, color: t.text },
    modeRow: { flexDirection: 'row', gap: 8 },
    modeBtn: { borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: t.surface },
    modeBtnActive: { borderColor: t.accentBorder, backgroundColor: t.accentBg },
    modeBtnText: { fontSize: 13, fontWeight: '600', color: t.textSub, textTransform: 'capitalize' },
    input: { borderWidth: 1, borderColor: t.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: t.text, backgroundColor: t.surface },
    submitBtn: { backgroundColor: t.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 18 },
    submitBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

    successBox: { backgroundColor: '#052e16', borderRadius: 10, padding: 12, marginTop: 14 },
    successText: { color: '#4ade80', fontSize: 13 },
    reportBox: { backgroundColor: t.errorBg, borderRadius: 10, padding: 12, marginTop: 14, gap: 4 },
    reportTitle: { color: t.errorText, fontWeight: '700', fontSize: 13, marginBottom: 4 },
    reportErr: { color: t.errorText, fontSize: 12 },

    versionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: t.border, paddingVertical: 10 },
    versionBadge: { backgroundColor: t.accentBg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
    versionBadgeText: { color: t.accent, fontWeight: '800', fontSize: 12 },
    versionNote: { fontSize: 13, color: t.text, fontWeight: '600' },
    versionMeta: { fontSize: 11, color: t.textMuted, marginTop: 2 },
    currentTag: { fontSize: 11, color: '#10b981', fontWeight: '700' },

    reqRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, marginBottom: 8 },
    reqTitle: { fontSize: 13, fontWeight: '700', color: t.text },
    reqMeta: { fontSize: 11, color: t.textMuted, marginTop: 2 },
    reqError: { fontSize: 11, color: t.errorText, marginTop: 2 },
    reqOk: { fontSize: 11, color: '#10b981', marginTop: 2 },
    reqStatus: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },

    modalOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
    modalCard: { width: '100%', maxWidth: 420, backgroundColor: t.surface, borderRadius: 16, padding: 20, gap: 12, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 30, shadowOffset: { width: 0, height: 12 } },
    modalHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    modalTitle: { fontSize: 17, fontWeight: '800', color: t.text },
    modalSub: { fontSize: 12, color: t.textMuted, marginTop: -4 },
    modalInput: { borderWidth: 1, borderColor: t.accentBorder, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14, color: t.text, backgroundColor: t.inputBg, outlineStyle: 'none' as any },
    modalErr: { fontSize: 12, color: t.errorText },
    modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
    modalBtn: { borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, minWidth: 92, alignItems: 'center' },
    modalCancel: { backgroundColor: t.inputBg },
    modalCancelText: { fontSize: 13, fontWeight: '700', color: t.textSub },
    modalCreate: { backgroundColor: t.accent },
    modalCreateText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  });
}
