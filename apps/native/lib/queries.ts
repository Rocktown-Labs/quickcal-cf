import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RnFilePart, type UploadStatus } from "./api";

export const queryKeys = {
  me: ["me"] as const,
  stats: ["stats"] as const,
  uploads: ["uploads"] as const,
  keys: ["keys"] as const,
  uploadStatus: (runId: string) => ["uploadStatus", runId] as const,
};

const TERMINAL: ReadonlySet<UploadStatus> = new Set(["completed", "failed", "no_events"]);

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: api.me,
  });
}

export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: api.stats,
  });
}

export function useUploads(limit = 50) {
  return useQuery({
    queryKey: [...queryKeys.uploads, limit],
    queryFn: () => api.listUploads(limit),
  });
}

/**
 * Polls processing status every 2s until the upload reaches a terminal
 * state — the native twin of the web uploader's polling loop.
 */
export function useUploadStatus(runId: string | null) {
  return useQuery({
    queryKey: queryKeys.uploadStatus(runId ?? ""),
    queryFn: () => api.uploadStatusByRun(runId!),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && TERMINAL.has(data.status)) return false;
      return 2000;
    },
  });
}

export function useCreateUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: RnFilePart) => api.createUpload(file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.uploads });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useDeleteUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteUpload(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.uploads });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useRevokeShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeShare(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.uploads });
    },
  });
}

export function useManualEvent() {
  return useMutation({
    mutationFn: api.manualEvent,
  });
}

export function useEmailUpload() {
  return useMutation({
    mutationFn: ({ id, email }: { id: string; email: string }) => api.emailUpload(id, email),
  });
}

export function useSmsUpload() {
  return useMutation({
    mutationFn: ({ id, phone }: { id: string; phone: string }) => api.smsUpload(id, phone),
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: queryKeys.keys,
    queryFn: api.listKeys,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createKey({ name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.keys });
    },
  });
}

export function useDeleteApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteKey(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.keys });
    },
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.updateMe,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}
