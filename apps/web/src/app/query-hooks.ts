import { useQuery } from '@tanstack/react-query';
import type { MediaResourceKind } from '@reelforge/core';

import { useApi } from './api-context';

export const queryKeys = {
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  templates: ['templates'] as const,
  template: (id: string) => ['templates', id] as const,
  resources: (kind?: MediaResourceKind) => ['resources', kind ?? 'all'] as const,
  settings: ['settings'] as const,
  voices: (provider: string) => ['voices', provider] as const,
  jobs: ['jobs'] as const,
  job: (id: string) => ['jobs', id] as const,
};

export function useProjects() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.projects, queryFn: api.listProjects });
}

export function useProject(id: string) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.project(id), queryFn: () => api.getProject(id), enabled: Boolean(id) });
}

export function useTemplates() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.templates, queryFn: api.listTemplates });
}

export function useTemplate(id: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.template(id ?? ''), queryFn: () => api.getTemplate(id ?? ''), enabled: Boolean(id) });
}

export function useResources(kind?: MediaResourceKind) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.resources(kind), queryFn: () => api.listResources(kind) });
}

export function useSettings() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.settings, queryFn: api.getSettings });
}

export function useVoices(provider: 'google' | 'elevenlabs', enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.voices(provider), queryFn: () => api.listVoices(provider, 'vi-VN'), enabled });
}

export function useJobs() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.jobs, queryFn: api.listJobs, refetchInterval: 15_000 });
}
