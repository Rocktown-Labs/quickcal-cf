import * as Haptics from "expo-haptics";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Share, Text as RNText, View } from "react-native";
import { Button, Input, Label, Spinner, Text, TextArea, TextField, useToast } from "heroui-native";
import Animated, { FadeInDown, FadeInUp } from "react-native-reanimated";
import { api, type DirectEvent, type RnFilePart, type StatusResponse } from "@/lib/api";
import {
  useCreateDirectEvents,
  useCreateTextUpload,
  useCreateUpload,
  useCreateUrlUpload,
  useEmailUpload,
  useMe,
  useSmsUpload,
  useUploadStatus,
} from "@/lib/queries";
import { downloadAndShareIcs, shareIcsContent } from "@/lib/ics";
import { authClient } from "@/lib/auth-client";
import { PressCard, ProgressBar, Pulse } from "@/components/qc";

const STEPS = [
  "Analyzing source",
  "Detecting dates & times",
  "Extracting event details",
  "Formatting calendar data",
] as const;

type UploadState = "idle" | "processing" | "error" | "complete";
type Tab = "ai" | "text" | "manual";

interface ManualRow {
  title: string;
  date: Date;
  time: Date | null;
  endTime: Date | null;
  location: string;
  description: string;
}

export function Uploader() {
  const router = useRouter();
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>("ai");
  const [state, setState] = useState<UploadState>("idle");

  // AI ingestion (file / URL / text)
  const createUpload = useCreateUpload();
  const createUrlUpload = useCreateUrlUpload();
  const createTextUpload = useCreateTextUpload();
  const [runId, setRunId] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [errorTitle, setErrorTitle] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [complete, setComplete] = useState<StatusResponse | null>(null);

  // URL tab input
  const [urlValue, setUrlValue] = useState("");

  // Text tab inputs
  const [textContent, setTextContent] = useState("");
  const [textTitle, setTextTitle] = useState("");

  // Manual multi-event builder
  const createDirectEvents = useCreateDirectEvents();
  const [manualRows, setManualRows] = useState<ManualRow[]>([]);
  const [rowTitle, setRowTitle] = useState("");
  const [rowDate, setRowDate] = useState<Date | null>(null);
  const [rowTime, setRowTime] = useState<Date | null>(null);
  const [rowEndTime, setRowEndTime] = useState<Date | null>(null);
  const [rowLocation, setRowLocation] = useState("");
  const [rowDescription, setRowDescription] = useState("");
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);

  // Delivery
  const emailUpload = useEmailUpload();
  const smsUpload = useSmsUpload();
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [deliveryEmail, setDeliveryEmail] = useState("");
  const [deliveryPhone, setDeliveryPhone] = useState("");

  const me = useMe();
  const isPremium = me.data?.isPremium ?? false;
  const freeCredits = me.data?.freeCredits ?? 0;
  const canIngest = isPremium || freeCredits > 0;

  const statusQuery = useUploadStatus(runId);
  const status = statusQuery.data ?? null;

  // Steps advance every 3s while processing (mirrors the web uploader).
  useEffect(() => {
    if (state !== "processing") return;
    const timer = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
    }, 3000);
    return () => clearInterval(timer);
  }, [state]);

  // Terminal state → complete or error screen (with haptics).
  useEffect(() => {
    if (state !== "processing" || !status) return;
    if (status.status === "completed" && status.result) {
      setComplete(status);
      setState("complete");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (status.status === "no_events") {
      setErrorTitle("No calendar events found");
      setErrorMessage(
        status.failureReason ??
          "That source looked valid, but QuickCalAI could not find any dates or times to turn into events.",
      );
      setState("error");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else if (status.status === "failed") {
      setErrorTitle("Processing failed");
      setErrorMessage(
        status.failureReason ?? "QuickCalAI could not finish processing this upload.",
      );
      setState("error");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [state, status]);

  const progressPct = useMemo(
    () => Math.min(Math.round(((stepIndex + 1) / STEPS.length) * 100), 99),
    [stepIndex],
  );

  const shareToken = complete?.result?.shareToken ?? null;
  const eventCount = complete?.eventCount ?? 0;

  // ── Shared actions ────────────────────────────────────────────────────────

  function showErrorToast(err: unknown, fallback: string) {
    const message = err instanceof Error ? err.message : fallback;
    toast.show({ variant: "danger", label: message });
  }

  async function runIngestion(
    displayName: string,
    start: () => Promise<{ runId: string; uploadId: string }>,
  ) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setFileName(displayName);
    setStepIndex(0);
    setState("processing");
    try {
      const res = await start();
      setUploadId(res.uploadId);
      setRunId(res.runId);
    } catch (err) {
      setErrorTitle("Upload failed");
      setErrorMessage(err instanceof Error ? err.message : "Please try again.");
      setState("error");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // A refused free credit should update the gate on next render.
      void me.refetch();
    }
  }

  async function pickAndUpload() {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["image/*", "application/pdf"],
      copyToCacheDirectory: true,
    });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) return;

    if ((asset.size ?? 0) > 10 * 1024 * 1024) {
      toast.show({ variant: "danger", label: "File exceeds the 10MB limit." });
      return;
    }

    const file: RnFilePart = {
      uri: asset.uri,
      name: asset.name ?? "upload",
      type: asset.mimeType ?? "application/octet-stream",
    };

    await runIngestion(asset.name ?? "upload", () => createUpload.mutateAsync(file));
  }

  async function startUrlUpload() {
    const url = urlValue.trim();
    if (!/^https:\/\//i.test(url)) {
      toast.show({
        variant: "danger",
        label: "Paste an https:// link to an image, PDF, or text file.",
      });
      return;
    }
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* validated above */
    }
    await runIngestion(host, () => createUrlUpload.mutateAsync(url));
  }

  async function startTextUpload() {
    if (!textContent.trim()) {
      toast.show({ variant: "danger", label: "Paste some schedule text first." });
      return;
    }
    const title = textTitle.trim() || "Pasted text";
    await runIngestion(title, () =>
      createTextUpload.mutateAsync({ content: textContent, title: title || undefined }),
    );
  }

  function reset() {
    setState("idle");
    setRunId(null);
    setUploadId(null);
    setComplete(null);
    setStepIndex(0);
    setFileName("");
    setDeliveryOpen(false);
  }

  async function downloadIcs() {
    if (!shareToken) {
      toast.show({ variant: "danger", label: "The calendar file is not ready yet." });
      return;
    }
    try {
      await downloadAndShareIcs(shareToken, fileName);
    } catch (err) {
      showErrorToast(err, "Download failed.");
    }
  }

  async function copyShareLink() {
    if (!shareToken) return;
    try {
      await Clipboard.setStringAsync(`${api.serverUrl()}/s/${shareToken}`);
      toast.show({ variant: "success", label: "Share link copied." });
    } catch {
      toast.show({ variant: "danger", label: "Could not copy the share link." });
    }
  }

  async function deviceShare() {
    if (!shareToken) return;
    try {
      await Share.share({
        message: `Check out this calendar schedule: ${api.serverUrl()}/s/${shareToken}`,
      });
    } catch {
      // User dismissed the share sheet — nothing to do.
    }
  }

  async function sendEmail() {
    if (!uploadId) return;
    const email = deliveryEmail.trim();
    if (!email) {
      toast.show({ variant: "danger", label: "Please enter an email address." });
      return;
    }
    try {
      const res = await emailUpload.mutateAsync({ id: uploadId, email });
      toast.show({ variant: "success", label: res.message });
    } catch (err) {
      showErrorToast(err, "Failed to send email.");
    }
  }

  async function sendSms() {
    if (!uploadId) return;
    const phone = deliveryPhone.trim();
    if (!phone) {
      toast.show({ variant: "danger", label: "Please enter a phone number." });
      return;
    }
    try {
      const res = await smsUpload.mutateAsync({ id: uploadId, phone });
      toast.show({ variant: "success", label: res.message });
    } catch (err) {
      showErrorToast(err, "Failed to send SMS.");
    }
  }

  // ── Manual builder ─────────────────────────────────────────────────────────

  const pad = (n: number) => String(n).padStart(2, "0");
  const rowDateStr = rowDate
    ? `${rowDate.getFullYear()}-${pad(rowDate.getMonth() + 1)}-${pad(rowDate.getDate())}`
    : "";
  const rowTimeStr = rowTime ? `${pad(rowTime.getHours())}:${pad(rowTime.getMinutes())}` : "";
  const rowEndStr = rowEndTime
    ? `${pad(rowEndTime.getHours())}:${pad(rowEndTime.getMinutes())}`
    : "";

  function rowToEvent(row: ManualRow): DirectEvent {
    const date = `${row.date.getFullYear()}-${pad(row.date.getMonth() + 1)}-${pad(row.date.getDate())}`;
    return {
      title: row.title,
      date,
      time: row.time ? `${pad(row.time.getHours())}:${pad(row.time.getMinutes())}` : "",
      endTime: row.endTime ? `${pad(row.endTime.getHours())}:${pad(row.endTime.getMinutes())}` : "",
      location: row.location || "",
      description: row.description || "",
    };
  }

  function addManualRow() {
    if (!rowTitle.trim() || !rowDate) {
      toast.show({
        variant: "danger",
        label: "Fill in at least title and date, then add to the list.",
      });
      return;
    }
    setManualRows((rows) => [
      ...rows,
      {
        title: rowTitle.trim(),
        date: rowDate,
        time: rowTime,
        endTime: rowEndTime,
        location: rowLocation.trim(),
        description: rowDescription.trim(),
      },
    ]);
    setRowTitle("");
    setRowDate(null);
    setRowTime(null);
    setRowEndTime(null);
    setRowLocation("");
    setRowDescription("");
  }

  async function submitManualRows() {
    const rows = [...manualRows];
    if (rowTitle.trim() && rowDate) {
      rows.push({
        title: rowTitle.trim(),
        date: rowDate,
        time: rowTime,
        endTime: rowEndTime,
        location: rowLocation.trim(),
        description: rowDescription.trim(),
      });
    }
    if (rows.length === 0) {
      toast.show({ variant: "danger", label: "Add at least one event (title + date)." });
      return;
    }
    try {
      const res = await createDirectEvents.mutateAsync({
        events: rows.map(rowToEvent),
        name: `${rows.length} manual event${rows.length === 1 ? "" : "s"}`,
      });
      setManualRows([]);
      setRowTitle("");
      setRowDate(null);
      setRowTime(null);
      setRowEndTime(null);
      setRowLocation("");
      setRowDescription("");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setFileName(`${res.eventCount} manual event${res.eventCount === 1 ? "" : "s"}`);
      setUploadId(res.uploadId);
      setComplete({
        uploadId: res.uploadId,
        status: "completed",
        eventCount: res.eventCount,
        failureReason: null,
        result: {
          uploadId: res.uploadId,
          eventCount: res.eventCount,
          status: "completed",
          shareToken: res.shareToken,
          downloadPath: res.downloadPath,
        },
      });
      setState("complete");
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showErrorToast(err, "Failed to create events.");
    }
  }

  async function upgradeToPremium() {
    try {
      await authClient.subscription.upgrade({
        plan: "premium",
        successUrl: "quickcal-cf://settings",
        cancelUrl: "quickcal-cf://settings",
      });
    } catch (err) {
      showErrorToast(err, "Could not open checkout. Try again from Settings.");
    }
  }

  // ── Idle ──────────────────────────────────────────────────────────────────

  if (state === "idle") {
    return (
      <View className="gap-6">
        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <Text className="text-2xl font-bold text-white">AI Calendar Extraction</Text>
            {isPremium ? (
              <View className="bg-[#c23326] rounded-full px-3 py-1">
                <Text className="text-white text-xs font-bold">PREMIUM</Text>
              </View>
            ) : null}
          </View>
          <Text className="text-neutral-400">
            Turn a photo, PDF, pasted text, or a link into calendar events — or build events by
            hand.
          </Text>
        </View>

        {/* Tab switcher */}
        <View className="flex-row bg-neutral-900 p-1 rounded-xl border border-neutral-800 self-start">
          {(["ai", "text", "manual"] as const).map((key) => {
            const active = tab === key;
            return (
              <PressCard
                key={key}
                onPress={() => setTab(key)}
                className={`px-3 py-2 rounded-lg ${active ? "bg-[#c23326]" : ""}`}
              >
                <Text className={`text-xs font-bold ${active ? "text-white" : "text-neutral-400"}`}>
                  {key === "ai" ? "⚡ AI" : key === "text" ? "📋 Paste" : "✏️ Manual"}
                </Text>
              </PressCard>
            );
          })}
        </View>

        {tab === "ai" ? (
          canIngest ? (
            <View className="gap-3">
              <PressCard
                onPress={() => void pickAndUpload()}
                className="rounded-2xl border-2 border-dashed border-neutral-800 py-12 items-center bg-neutral-900/50"
              >
                <Text className="text-3xl mb-3">📤</Text>
                <Text className="text-lg font-bold text-white">Choose a photo or PDF</Text>
                <Text className="text-neutral-400 mt-1">Supports JPEG, PNG, WebP, and PDF</Text>
                <Text className="text-neutral-500 mt-3 text-sm">Up to 10MB</Text>
              </PressCard>
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <Input
                    value={urlValue}
                    onChangeText={setUrlValue}
                    placeholder="…or paste an https:// link"
                    keyboardType="url"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                <Button
                  className="bg-[#c23326]"
                  onPress={() => void startUrlUpload()}
                  isDisabled={createUrlUpload.isPending}
                >
                  {createUrlUpload.isPending ? (
                    <Spinner size="sm" color="default" />
                  ) : (
                    <Button.Label>Fetch</Button.Label>
                  )}
                </Button>
              </View>
              {!isPremium ? (
                <Text className="text-neutral-400 text-xs text-center">
                  🎁 {freeCredits} free AI extraction{freeCredits === 1 ? "" : "s"} left — Premium
                  unlocks unlimited.
                </Text>
              ) : null}
            </View>
          ) : (
            <View className="rounded-2xl border border-neutral-800 bg-neutral-900/50 py-12 items-center gap-3">
              <Text className="text-5xl">👑</Text>
              <Text className="text-xl font-bold text-white">
                You've used your free AI extraction
              </Text>
              <Text className="text-neutral-400 text-center px-8">
                Upgrade to Premium for unlimited AI extraction from images, PDFs, text, and URLs.
              </Text>
              <Button className="bg-[#c23326]" size="lg" onPress={() => void upgradeToPremium()}>
                <Button.Label>Upgrade to Premium</Button.Label>
              </Button>
            </View>
          )
        ) : tab === "text" ? (
          canIngest ? (
            <View className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-5 gap-4">
              <Text className="text-neutral-400 text-sm">
                Paste a schedule as plain text, Markdown, or CSV — the AI reads the dates and times
                for you.
              </Text>
              <TextField>
                <Label>Title (optional)</Label>
                <Input
                  value={textTitle}
                  onChangeText={setTextTitle}
                  placeholder="Fall class schedule"
                />
              </TextField>
              <TextField>
                <Label>Schedule text</Label>
                <TextArea
                  value={textContent}
                  onChangeText={setTextContent}
                  placeholder={
                    "Mon 10/5: Biology 101 at 9:00 AM in Room 214\nTue 10/6: Study group 3-5pm @ library"
                  }
                />
              </TextField>
              <Button
                className="bg-[#c23326]"
                size="lg"
                onPress={() => void startTextUpload()}
                isDisabled={createTextUpload.isPending}
              >
                {createTextUpload.isPending ? (
                  <Spinner size="sm" color="default" />
                ) : (
                  <Button.Label>⚡ Extract Events from Text</Button.Label>
                )}
              </Button>
            </View>
          ) : (
            <View className="rounded-2xl border border-neutral-800 bg-neutral-900/50 py-12 items-center gap-3">
              <Text className="text-5xl">👑</Text>
              <Text className="text-xl font-bold text-white">Free AI extraction used</Text>
              <Text className="text-neutral-400 text-center px-8">
                Upgrade to Premium to extract events from pasted text too.
              </Text>
              <Button className="bg-[#c23326]" size="lg" onPress={() => void upgradeToPremium()}>
                <Button.Label>Upgrade to Premium</Button.Label>
              </Button>
            </View>
          )
        ) : (
          <View className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-5 gap-4">
            <TextField>
              <Label>Event Title *</Label>
              <Input value={rowTitle} onChangeText={setRowTitle} placeholder="Meeting with John" />
            </TextField>
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button variant="outline" className="h-10" onPress={() => setShowDatePicker(true)}>
                  <Button.Label>{rowDate ? rowDateStr : "Pick a date *"}</Button.Label>
                </Button>
              </View>
              <View className="flex-1">
                <Button variant="outline" className="h-10" onPress={() => setShowTimePicker(true)}>
                  <Button.Label>{rowTime ? rowTimeStr : "Pick time"}</Button.Label>
                </Button>
              </View>
              <View className="flex-1">
                <Button
                  variant="outline"
                  className="h-10"
                  onPress={() => setShowEndTimePicker(true)}
                >
                  <Button.Label>{rowEndTime ? rowEndStr : "End time"}</Button.Label>
                </Button>
              </View>
            </View>
            {showDatePicker ? (
              <DateTimePicker
                value={rowDate ?? new Date()}
                mode="date"
                onChange={(_, picked) => {
                  setShowDatePicker(false);
                  if (picked) setRowDate(picked);
                }}
              />
            ) : null}
            {showTimePicker ? (
              <DateTimePicker
                value={rowTime ?? new Date()}
                mode="time"
                is24Hour
                onChange={(_, picked) => {
                  setShowTimePicker(false);
                  if (picked) setRowTime(picked);
                }}
              />
            ) : null}
            {showEndTimePicker ? (
              <DateTimePicker
                value={rowEndTime ?? rowTime ?? new Date()}
                mode="time"
                is24Hour
                onChange={(_, picked) => {
                  setShowEndTimePicker(false);
                  if (picked) setRowEndTime(picked);
                }}
              />
            ) : null}
            <TextField>
              <Label>Location (optional)</Label>
              <Input value={rowLocation} onChangeText={setRowLocation} placeholder="Room 214" />
            </TextField>
            <TextField>
              <Label>Description</Label>
              <TextArea
                value={rowDescription}
                onChangeText={setRowDescription}
                placeholder="Event details…"
              />
            </TextField>
            <Button variant="outline" onPress={() => addManualRow()}>
              <Button.Label>＋ Add to list</Button.Label>
            </Button>

            {manualRows.length > 0 ? (
              <View className="gap-2">
                {manualRows.map((row, i) => (
                  <PressCard
                    key={`${row.title}-${i}`}
                    onPress={() => setManualRows((rows) => rows.filter((_, idx) => idx !== i))}
                    className="rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-2.5 flex-row items-center gap-3"
                  >
                    <View className="flex-1">
                      <Text className="text-white text-sm font-semibold" numberOfLines={1}>
                        {row.title}
                      </Text>
                      <Text className="text-neutral-500 text-xs">
                        {rowDateStrFor(row)}
                        {row.time
                          ? ` · ${pad(row.time.getHours())}:${pad(row.time.getMinutes())}`
                          : ""}
                        {row.location ? ` · ${row.location}` : ""}
                      </Text>
                    </View>
                    <Text className="text-red-400 text-xs font-bold">Remove</Text>
                  </PressCard>
                ))}
              </View>
            ) : null}

            <Button
              className="bg-[#c23326]"
              size="lg"
              onPress={() => void submitManualRows()}
              isDisabled={createDirectEvents.isPending}
            >
              {createDirectEvents.isPending ? (
                <Spinner size="sm" color="default" />
              ) : (
                <Button.Label>
                  📅 Create {manualRows.length > 0 ? manualRows.length : ""} Calendar Event
                  {manualRows.length === 1 ? "" : "s"}
                </Button.Label>
              )}
            </Button>
            <Text className="text-neutral-500 text-xs text-center">
              Free — no AI involved. The .ics is ready instantly.
            </Text>
          </View>
        )}
      </View>
    );
  }

  // ── Processing ────────────────────────────────────────────────────────────

  if (state === "processing") {
    return (
      <View className="gap-4">
        <Text className="text-xl font-bold text-white">AI extracts details instantly</Text>

        <View className="bg-neutral-900 p-4 rounded-xl border border-neutral-800 flex-row items-center gap-4">
          <View className="w-10 h-10 bg-[#c23326] rounded-lg items-center justify-center">
            <Text className="text-lg">🖼</Text>
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-white" numberOfLines={1}>
              {fileName}
            </Text>
            <Text className="text-xs text-neutral-500">Processing with AI…</Text>
          </View>
          <Spinner size="sm" color="default" />
        </View>

        <Pulse className="bg-[#c23326] rounded-xl p-3 flex-row items-center justify-center gap-2">
          <Text className="text-sm font-bold text-white">⚡ AI Processing in Progress</Text>
        </Pulse>

        <View className="gap-1">
          <View className="flex-row justify-between px-1 mb-1">
            <Text className="text-xs text-neutral-500">Processing…</Text>
            <Text className="text-xs font-semibold text-[#c23326]">{progressPct}%</Text>
          </View>
          <ProgressBar progress={progressPct} />
        </View>

        <View className="gap-2">
          {STEPS.map((label, i) => {
            const done = i < stepIndex;
            const current = i === stepIndex;
            return (
              <Animated.View
                key={label}
                entering={FadeInDown.delay(i * 60)}
                className={`flex-row items-center gap-3 p-3 rounded-xl ${
                  current ? "bg-[#c23326]/10 border border-[#c23326]/30" : ""
                }`}
              >
                <View
                  className={`w-8 h-8 rounded-lg items-center justify-center ${
                    done ? "bg-[#22c55e]" : current ? "bg-[#c23326]" : "bg-neutral-900"
                  }`}
                >
                  <Text className="text-sm text-white">{done ? "✓" : "•"}</Text>
                </View>
                <Text
                  className={`flex-1 text-sm ${done || current ? "text-white font-semibold" : "text-neutral-500"}`}
                >
                  {label}
                </Text>
                {current ? <Spinner size="sm" color="default" /> : null}
                {done ? (
                  <Text className="text-xs font-medium text-[#22c55e]">✓ Complete</Text>
                ) : null}
              </Animated.View>
            );
          })}
        </View>

        <Pulse className="bg-neutral-900 rounded-xl py-6 items-center border border-neutral-800">
          <Text className="text-5xl font-black text-[#c23326]">…</Text>
          <Text className="text-sm text-neutral-500 mt-2">Events Detected</Text>
        </Pulse>
      </View>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────

  if (state === "error") {
    return (
      <Animated.View
        entering={FadeInUp.springify().dampingRatio(1)}
        className="bg-neutral-900 p-6 rounded-2xl border border-neutral-800 items-center gap-3"
      >
        <Text className="text-5xl">⚠️</Text>
        <Text className="text-xl font-bold text-white">{errorTitle}</Text>
        <Text className="text-neutral-400 text-center px-4">{errorMessage}</Text>
        <View className="flex-row gap-3 mt-2">
          <Button className="bg-[#c23326]" onPress={reset}>
            <Button.Label>↻ Try another source</Button.Label>
          </Button>
          <Button variant="outline" onPress={() => router.push("/files")}>
            <Button.Label>View files</Button.Label>
          </Button>
        </View>
      </Animated.View>
    );
  }

  // ── Complete ──────────────────────────────────────────────────────────────

  return (
    <Animated.View entering={FadeInDown.springify().dampingRatio(1)} className="gap-4">
      <Text className="text-xl font-bold text-white">Download your .ics and you're done</Text>

      <Animated.View
        entering={FadeInDown.springify().dampingRatio(1)}
        className="bg-[#22c55e]/10 p-4 rounded-xl border border-[#22c55e]/30 flex-row items-center gap-4"
      >
        <View className="w-10 h-10 bg-[#22c55e] rounded-lg items-center justify-center">
          <Text className="text-lg text-white">✓</Text>
        </View>
        <View className="flex-1">
          <Text className="text-lg font-bold text-[#22c55e]">Processing Complete!</Text>
          <Text className="text-white">{eventCount} events ready to download</Text>
        </View>
      </Animated.View>

      <View className="gap-3">
        <PressCard
          onPress={() => void downloadIcs()}
          className="bg-[#c23326] rounded-xl p-4 flex-row items-center gap-3"
        >
          <View className="w-10 h-10 rounded-lg bg-white/15 items-center justify-center">
            <Text className="text-lg">📥</Text>
          </View>
          <View className="flex-1">
            <Text className="text-white font-bold">Download .ics File</Text>
            <Text className="text-white/80 text-sm">Import to any calendar app</Text>
          </View>
        </PressCard>

        <View className="flex-row gap-3">
          <PressCard
            onPress={() => void copyShareLink()}
            className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl p-4 items-center"
          >
            <Text className="text-lg">📋</Text>
            <Text className="text-white font-bold text-sm">Copy Link</Text>
          </PressCard>
          <PressCard
            onPress={() => void deviceShare()}
            className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl p-4 items-center"
          >
            <Text className="text-lg">🔗</Text>
            <Text className="text-white font-bold text-sm">Share Link</Text>
          </PressCard>
          <PressCard
            onPress={() => setDeliveryOpen((o) => !o)}
            className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl p-4 items-center"
          >
            <Text className="text-lg">✉️</Text>
            <Text className="text-white font-bold text-sm">Email or SMS</Text>
          </PressCard>
        </View>

        <PressCard
          onPress={() => router.push("/files")}
          className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex-row items-center gap-3"
        >
          <View className="w-10 h-10 rounded-lg bg-white/15 items-center justify-center">
            <Text className="text-lg">🔍</Text>
          </View>
          <View className="flex-1">
            <Text className="text-white font-bold">Review &amp; edit events</Text>
            <Text className="text-white/80 text-sm">
              Fix titles, dates, and times before importing
            </Text>
          </View>
        </PressCard>

        {deliveryOpen && uploadId ? (
          <Animated.View
            entering={FadeInDown.springify().dampingRatio(1)}
            className="bg-neutral-900 p-4 rounded-xl border border-neutral-800 gap-3"
          >
            <TextField>
              <Label>Email</Label>
              <Input
                value={deliveryEmail}
                onChangeText={setDeliveryEmail}
                placeholder="you@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Button
                className="bg-[#c23326]"
                size="sm"
                isDisabled={emailUpload.isPending}
                onPress={() => void sendEmail()}
              >
                <Button.Label>Send Email</Button.Label>
              </Button>
            </TextField>
            <TextField>
              <Label>Phone Number</Label>
              <Input
                value={deliveryPhone}
                onChangeText={setDeliveryPhone}
                placeholder="+1 (555) 123-4567"
                keyboardType="phone-pad"
              />
              <Button
                className="bg-[#c23326]"
                size="sm"
                isDisabled={smsUpload.isPending}
                onPress={() => void sendSms()}
              >
                <Button.Label>Send SMS</Button.Label>
              </Button>
            </TextField>
          </Animated.View>
        ) : null}
      </View>

      <View className="bg-neutral-900 p-4 rounded-xl border border-neutral-800 flex-row items-center gap-4">
        <View className="w-10 h-10 bg-[#c23326] rounded-lg items-center justify-center">
          <Text className="text-lg">📅</Text>
        </View>
        <View className="flex-1">
          <Text className="text-white font-semibold" numberOfLines={1}>
            {fileName.replace(/\.[^/.]+$/, "")}-events.ics
          </Text>
          <Text className="text-neutral-400 text-sm">{eventCount} events • Ready to import</Text>
        </View>
      </View>

      <PressCard onPress={reset} className="items-center py-2">
        <RNText className="text-neutral-500 text-sm">Start another upload</RNText>
      </PressCard>
    </Animated.View>
  );
}

function rowDateStrFor(row: { date: Date }): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${row.date.getFullYear()}-${pad(row.date.getMonth() + 1)}-${pad(row.date.getDate())}`;
}
