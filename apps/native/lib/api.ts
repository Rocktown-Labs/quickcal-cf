import { authClient } from "./auth-client";
import { ENV } from "../src/env";

const BASE = normalizeBaseUrl(ENV.EXPO_PUBLIC_SERVER_URL, "EXPO_PUBLIC_SERVER_URL");
const WEB_BASE = normalizeBaseUrl(ENV.EXPO_PUBLIC_WEB_URL, "EXPO_PUBLIC_WEB_URL");

function normalizeBaseUrl(value: string, name: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  return trimmed;
}

/** The web app origin (public share pages, auth emails) — not the API origin. */
export function webUrl(): string {
  return WEB_BASE;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Fetch wrapper that carries the Better-Auth session cookie from
 * SecureStore (the expo plugin manages the cookie jar; we just attach it).
 */
export async function apiFetch(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  let body: BodyInit | null | undefined = init.body;

  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }

  try {
    const cookie = await authClient.getCookie();
    if (cookie) headers.set("cookie", cookie);
  } catch (error) {
    // No session yet — public and auth endpoints still work. Surface the
    // cause in development instead of turning it into a confusing 401.
    if (__DEV__) console.warn("[api] could not read auth cookie", error);
  }

  // Bound hung requests on poor mobile networks. 120s still allows large
  // uploads while preventing an indefinite pending mutation.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const forwardAbort = () => controller.abort();
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    return await fetch(`${BASE}${path}`, { ...init, headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", forwardAbort);
  }
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    const message = payload?.message ?? payload?.error ?? `Request failed (${res.status})`;
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

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** React Native FormData file part. */
export type RnFilePart = { uri: string; name: string; type: string };

export const api = {
  createUpload(
    file: RnFilePart,
  ): Promise<{ uploadId: string; runId: string; status: UploadStatus }> {
    const form = new FormData();
    form.append("file", file as unknown as Blob);
    return request("/api/uploads", { method: "POST", body: form });
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
    patch: Partial<Pick<DirectEvent, "title" | "date" | "time">>,
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
  share(token: string): Promise<{
    fileName: string;
    eventCount: number;
    downloadPath: string;
    events: Array<{
      id: string;
      title: string;
      description: string | null;
      location: string | null;
      startTime: string;
      endTime: string | null;
      isAllDay: boolean;
    }>;
  }> {
    return request(`/api/share/${encodeURIComponent(token)}`);
  },
  serverUrl(): string {
    return BASE;
  },
};
