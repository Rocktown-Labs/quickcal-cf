import { ENV } from "../env.public";
import { captureApiFailure } from "./observability";

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
  const { form, json, ...rest } = init;
  const headers = new Headers(rest.headers);
  const key = getApiKey();
  if (key) headers.set("Authorization", `Bearer ${key}`);

  let body: BodyInit | undefined;
  if (form) {
    body = form;
  } else if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  } else {
    body = rest.body ?? undefined;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...rest,
      headers,
      body,
      credentials: "include",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    captureApiFailure(path, 0);
    throw new ApiError(0, "Network error — check your connection and try again.");
  }

  if (!res.ok) {
    if (res.status >= 500) captureApiFailure(path, res.status);
    const payload = await res.json().catch(() => null);
    const message =
      (payload as { message?: string } | null)?.message ??
      (payload as { error?: string } | null)?.error ??
      `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }

  // 204/empty bodies are successful mutations, not JSON parse errors.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
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
  useCase: string | null;
  calendarApp: string | null;
  isOnboarded: boolean;
  isPremium: boolean;
  freeCredits: number;
  calendarFeedPath: string | null;
  webhookSecret: string;
  emailEnabled: boolean;
  smsEnabled: boolean;
}

export type UseCase = "class" | "work" | "conference" | "events" | "other";
export type CalendarApp = "google" | "apple" | "outlook" | "other";

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

export interface DirectEvent {
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  location?: string;
  description?: string;
}

export interface ReviewEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startTime: string;
  endTime: string | null;
  isAllDay: boolean;
  confidence: number | null;
  sourceQuote: string | null;
}

export const api = {
  createUpload(
    file: File,
    callbackUrl?: string,
  ): Promise<{ uploadId: string; runId: string; status: UploadStatus }> {
    const form = new FormData();
    form.append("file", file);
    if (callbackUrl) form.append("callbackUrl", callbackUrl);
    return request("/api/uploads", { method: "POST", form });
  },
  createUploadFromUrl(
    url: string,
    callbackUrl?: string,
  ): Promise<{ uploadId: string; runId: string; status: UploadStatus }> {
    return request("/api/uploads/from-url", {
      method: "POST",
      json: { url, ...(callbackUrl ? { callbackUrl } : {}) },
    });
  },
  createUploadFromText(
    content: string,
    title?: string,
    callbackUrl?: string,
  ): Promise<{ uploadId: string; runId: string; status: UploadStatus }> {
    return request("/api/uploads/text", {
      method: "POST",
      json: { content, ...(title ? { title } : {}), ...(callbackUrl ? { callbackUrl } : {}) },
    });
  },
  createDirectEvents(
    events: DirectEvent[],
    name?: string,
  ): Promise<{
    uploadId: string;
    status: "completed";
    eventCount: number;
    shareToken: string;
    downloadPath: string;
  }> {
    return request("/api/uploads/events", {
      method: "POST",
      json: { events, ...(name ? { name } : {}) },
    });
  },
  listUploadEvents(uploadId: string): Promise<{ events: ReviewEvent[] }> {
    return request(`/api/uploads/${encodeURIComponent(uploadId)}/events`);
  },
  updateEvent(
    eventId: string,
    patch: Partial<Pick<DirectEvent, "title" | "date" | "time" | "location">>,
  ): Promise<ReviewEvent> {
    return request(`/api/events/${encodeURIComponent(eventId)}`, { method: "PATCH", json: patch });
  },
  deleteEvent(eventId: string): Promise<{ message: string }> {
    return request(`/api/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  },
  rotateCalendarFeed(): Promise<{ feedPath: string }> {
    return request("/api/calendar/rotate", { method: "POST" });
  },
  uploadStatusById(uploadId: string): Promise<StatusResponse> {
    return request(`/api/uploads/${encodeURIComponent(uploadId)}/status`);
  },
  uploadStatusByRun(runId: string): Promise<StatusResponse> {
    return request(`/api/uploads/by-run/${encodeURIComponent(runId)}/status`);
  },
  deleteUpload(id: string): Promise<{ message: string }> {
    return request(`/api/uploads/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  revokeShare(id: string): Promise<{ message: string }> {
    return request(`/api/uploads/${encodeURIComponent(id)}/share/revoke`, { method: "POST" });
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
  updateMe(body: {
    phoneNumber?: string;
    useCase?: UseCase | UseCase[];
    calendarApp?: CalendarApp;
    isOnboarded?: boolean;
  }): Promise<Profile> {
    return request("/api/user/me", { method: "PATCH", json: body });
  },
  emailUpload(uploadId: string, email: string): Promise<{ message: string }> {
    return request(`/api/uploads/${encodeURIComponent(uploadId)}/email`, {
      method: "POST",
      json: { email },
    });
  },
  smsUpload(uploadId: string, phone: string): Promise<{ message: string }> {
    return request(`/api/uploads/${encodeURIComponent(uploadId)}/sms`, {
      method: "POST",
      json: { phone },
    });
  },
  manualEvent(body: {
    title: string;
    date: string;
    time?: string;
    description?: string;
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
    return request(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  share(token: string): Promise<SharedSchedule> {
    return request(`/api/share/${encodeURIComponent(token)}`);
  },
  serverUrl(): string {
    return BASE;
  },
};
