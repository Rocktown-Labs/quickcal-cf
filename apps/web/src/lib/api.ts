import { ENV } from "../env.public";

const BASE = ENV.PUBLIC_SERVER_URL;

export function getApiKey(): string | null {
  try {
    return localStorage.getItem("qc_api_key");
  } catch {
    return null;
  }
}

export function setApiKey(key: string | null) {
  try {
    if (key) localStorage.setItem("qc_api_key", key);
    else localStorage.removeItem("qc_api_key");
  } catch {
    // storage unavailable — session cookies still work
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { form?: FormData; json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const key = getApiKey();
  if (key) headers.set("Authorization", `Bearer ${key}`);

  let body: BodyInit | undefined;
  if (init.form) {
    body = init.form;
  } else if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    body,
    credentials: "include",
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    const message =
      (payload as { message?: string } | null)?.message ??
      (payload as { error?: string } | null)?.error ??
      `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return res.json() as Promise<T>;
}

export type UploadStatus = "pending" | "processing" | "completed" | "failed" | "no_events";

export interface StatusResponse {
  uploadId: string;
  status: UploadStatus;
  eventCount: number;
  failureReason: string | null;
  result: {
    uploadId: string;
    eventCount: number;
    status: UploadStatus;
    shareToken?: string;
    downloadPath?: string;
  } | null;
}

export interface UploadSummary {
  id: string;
  fileName: string;
  fileType: string;
  status: UploadStatus;
  shareToken: string | null;
  createdAt: string;
}

export interface DashboardStats {
  totalUploads: number;
  completedUploads: number;
  totalEvents: number;
  recentUploads: Array<{
    id: string;
    fileName: string;
    status: string;
    failureReason: string | null;
    createdAt: string;
  }>;
}

export interface Profile {
  id: string;
  name: string;
  email: string;
  phoneNumber: string | null;
  isOnboarded: boolean;
  isPremium: boolean;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface SharedSchedule {
  fileName: string;
  eventCount: number;
  events: Array<{
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    startTime: string;
    endTime: string | null;
    isAllDay: boolean;
  }>;
  downloadPath: string;
}

export const api = {
  createUpload(file: File): Promise<{ uploadId: string; runId: string; status: UploadStatus }> {
    const form = new FormData();
    form.append("file", file);
    return request("/api/uploads", { method: "POST", form });
  },
  uploadStatusById(uploadId: string): Promise<StatusResponse> {
    return request(`/api/uploads/${uploadId}/status`);
  },
  uploadStatusByRun(runId: string): Promise<StatusResponse> {
    return request(`/api/uploads/by-run/${runId}/status`);
  },
  deleteUpload(id: string): Promise<{ message: string }> {
    return request(`/api/uploads/${id}`, { method: "DELETE" });
  },
  revokeShare(id: string): Promise<{ message: string }> {
    return request(`/api/uploads/${id}/share/revoke`, { method: "POST" });
  },
  listUploads(limit = 20): Promise<{ uploads: UploadSummary[] }> {
    return request(`/api/uploads?limit=${limit}`);
  },
  stats(): Promise<DashboardStats> {
    return request("/api/dashboard/stats");
  },
  me(): Promise<Profile> {
    return request("/api/user/me");
  },
  updateMe(body: { phoneNumber?: string; isOnboarded?: boolean }): Promise<Profile> {
    return request("/api/user/me", { method: "PATCH", json: body });
  },
  emailUpload(uploadId: string, email: string): Promise<{ message: string }> {
    return request(`/api/uploads/${uploadId}/email`, { method: "POST", json: { email } });
  },
  smsUpload(uploadId: string, phone: string): Promise<{ message: string }> {
    return request(`/api/uploads/${uploadId}/sms`, { method: "POST", json: { phone } });
  },
  manualEvent(body: {
    title: string;
    date: string;
    time?: string;
    description?: string;
    timezone?: string;
  }): Promise<{ eventId: string; icsContent: string; fileName: string }> {
    return request("/api/manual-event", { method: "POST", json: body });
  },
  listKeys(): Promise<{ keys: ApiKeySummary[] }> {
    return request("/api/keys");
  },
  createKey(body: {
    name: string;
    expiresInDays?: number;
  }): Promise<ApiKeySummary & { key: string }> {
    return request("/api/keys", { method: "POST", json: body });
  },
  deleteKey(id: string): Promise<{ message: string }> {
    return request(`/api/keys/${id}`, { method: "DELETE" });
  },
  share(token: string): Promise<SharedSchedule> {
    return request(`/api/share/${token}`);
  },
  serverUrl(): string {
    return BASE;
  },
};
