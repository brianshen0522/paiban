import type {
  DiskInfo,
  LibraryItem,
  Me,
  MovieDetail,
  MovieSummary,
  Notification,
  Settings,
  SettingsInfo,
  SourceHealth,
  StorageItem,
  Torrent,
  Usage,
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
};

export type SearchResult = { items: MovieSummary[]; total: number; page: number; pageSize: number };
export type StorageView = { usage: Usage; items: StorageItem[] };
export type AdminSettings = { settings: Settings; info: SettingsInfo; sources: SourceHealth[] };
export type AdminStorage = { usage: Usage; items: StorageItem[]; disk: DiskInfo };

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
