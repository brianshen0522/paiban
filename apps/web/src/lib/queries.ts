import type {
  CandidateList,
  DiskInfo,
  Export,
  LibraryItem,
  Me,
  MovieDetail,
  MovieSummary,
  Notification,
  ServiceStatus,
  Settings,
  SettingsInfo,
  SourceHealth,
  StorageFinding,
  StorageItem,
  SubtitleDetail,
  Task,
  Torrent,
  Usage,
  Workspace,
} from '@paiban/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';

export const keys = {
  me: ['me'] as const,
  storage: ['storage'] as const,
  torrents: (scope: 'mine' | 'all') => ['torrents', scope] as const,
  library: ['library'] as const,
  notifications: ['notifications'] as const,
  movie: (id: number) => ['movie', id] as const,
  search: (params: string) => ['search', params] as const,
  adminSettings: ['admin', 'settings'] as const,
  adminStorage: ['admin', 'storage'] as const,
  adminSystem: ['admin', 'system'] as const,
  workspace: (torrentId: string) => ['workspace', torrentId] as const,
  candidates: (torrentId: string) => ['candidates', torrentId] as const,
  subtitle: (id: string) => ['subtitle', id] as const,
  media: (id: string) => ['media', id] as const,
  peaks: (mediaId: string) => ['media', mediaId, 'peaks'] as const,
  speech: (mediaId: string) => ['media', mediaId, 'speech'] as const,
  exports: ['exports'] as const,
};

export type SearchResult = { items: MovieSummary[]; total: number; page: number; pageSize: number };
export type StorageView = { usage: Usage; items: StorageItem[] };
export type AdminSettings = { settings: Settings; info: SettingsInfo; sources: SourceHealth[] };
export type AdminStorage = {
  usage: Usage;
  items: StorageItem[];
  disk: DiskInfo;
  findings: StorageFinding[];
  rescan: Task | null;
};
export type AdminSystem = { services: ServiceStatus[]; tasks: Task[]; disk: DiskInfo };

export const useMe = () =>
  useQuery({ queryKey: keys.me, queryFn: () => get<Me>('/api/auth/me'), retry: false, staleTime: 60_000 });
export const useStorage = () => useQuery({ queryKey: keys.storage, queryFn: () => get<StorageView>('/api/storage') });
export const useTorrents = (scope: 'mine' | 'all' = 'mine') =>
  useQuery({
    queryKey: keys.torrents(scope),
    queryFn: () => get<Torrent[]>(`/api/torrents?scope=${scope}`),
    refetchInterval: scope === 'all' ? 5000 : false,
  });
export const useLibrary = () => useQuery({ queryKey: keys.library, queryFn: () => get<LibraryItem[]>('/api/library') });
export const useNotifications = () =>
  useQuery({
    queryKey: keys.notifications,
    queryFn: () => get<{ items: Notification[]; unread: number }>('/api/notifications'),
  });
export const useMovie = (id: number) =>
  useQuery({ queryKey: keys.movie(id), queryFn: () => get<MovieDetail>(`/api/yts/movies/${id}`), retry: false });
export const useSearch = (params: string) =>
  useQuery({
    queryKey: keys.search(params),
    queryFn: () => get<SearchResult>(`/api/yts/movies?${params}`),
    retry: false,
    placeholderData: (prev) => prev,
  });
export const useAdminSettings = () =>
  useQuery({ queryKey: keys.adminSettings, queryFn: () => get<AdminSettings>('/api/admin/settings') });
export const useAdminStorage = () =>
  useQuery({ queryKey: keys.adminStorage, queryFn: () => get<AdminStorage>('/api/admin/storage') });
export const useAdminSystem = () =>
  useQuery({
    queryKey: keys.adminSystem,
    queryFn: () => get<AdminSystem>('/api/admin/system'),
    // Heartbeats are not pushed (docs/04-api.md, "即時更新"): the page polls while it is open.
    refetchInterval: 10_000,
  });
export const useWorkspace = (torrentId: string) =>
  useQuery({
    queryKey: keys.workspace(torrentId),
    queryFn: () => get<Workspace>(`/api/library/${torrentId}`),
    retry: false,
  });
export const useCandidates = (torrentId: string) =>
  useQuery({
    queryKey: keys.candidates(torrentId),
    queryFn: () => get<CandidateList>(`/api/torrents/${torrentId}/candidates`),
    retry: false,
  });
export const useSubtitle = (id: string | null) =>
  useQuery({
    queryKey: keys.subtitle(id ?? ''),
    queryFn: () => get<SubtitleDetail>(`/api/subtitles/${id}`),
    enabled: !!id,
    retry: false,
    // The workbench owns the document once it is loaded; subtitle events decide when to reload it.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
export const useExports = () => useQuery({ queryKey: keys.exports, queryFn: () => get<Export[]>('/api/exports') });
