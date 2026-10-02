import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { Button, Input, Spinner, TextField, useToast } from "heroui-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { api, type ReviewEvent } from "@/lib/api";
import {
  useDeleteEvent,
  useDeleteUpload,
  useEmailUpload,
  useRevokeShare,
  useSmsUpload,
  useUpdateEvent,
  useUploadEvents,
  useUploads,
} from "@/lib/queries";
import { downloadAndShareIcs } from "@/lib/ics";
import { PressCard, StatusChip } from "@/components/qc";
import { Container } from "@/components/container";

function utcDateParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) return null;
  const pct = Math.round(confidence * 100);
  const tone =
    confidence >= 0.8 ? "bg-green-950" : confidence >= 0.5 ? "bg-amber-950" : "bg-red-950";
  return (
    <View className={`${tone} rounded-full px-2 py-0.5 self-center`}>
      <Text className="text-white text-[10px] font-bold">{pct}%</Text>
    </View>
  );
}

/** Editable event row inside the review panel. */
function EventEditor({
  event,
  uploadId,
  onDeleted,
}: {
  event: ReviewEvent;
  uploadId: string;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const updateEvent = useUpdateEvent();
  const deleteEvent = useDeleteEvent();

  const { date: initialDate, time: initialTime } = utcDateParts(event.startTime);
  const [title, setTitle] = useState(event.title);
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(event.isAllDay ? "" : initialTime);
  const [showDate, setShowDate] = useState(false);
  const [showTime, setShowTime] = useState(false);

  const [dateObj, setDateObj] = useState<Date>(new Date(`${initialDate}T12:00:00Z`));
  const [timeObj, setTimeObj] = useState<Date>(
    new Date(`2026-01-01T${initialTime || "12:00"}:00Z`),
  );

  async function save() {
    if (!title.trim() || !date) {
      toast.show({ variant: "danger", label: "Title and date are required." });
      return;
    }
    try {
      await updateEvent.mutateAsync({
        eventId: event.id,
        uploadId,
        patch: { title: title.trim(), date, time },
      });
      toast.show({ variant: "success", label: "Saved — the .ics is up to date." });
    } catch (err) {
      toast.show({ variant: "danger", label: err instanceof Error ? err.message : "Save failed." });
    }
  }

  async function remove() {
    Alert.alert("Delete this event?", "The calendar file is regenerated immediately.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void deleteEvent
            .mutateAsync({ eventId: event.id, uploadId })
            .then(onDeleted)
            .catch((err) =>
              toast.show({
                variant: "danger",
                label: err instanceof Error ? err.message : "Delete failed.",
              }),
            ),
      },
    ]);
  }

  return (
    <View className="rounded-lg border border-neutral-800 bg-neutral-950 p-3 gap-2">
      <View className="flex-row items-center gap-2">
        <View className="flex-1">
          <Input value={title} onChangeText={setTitle} />
        </View>
        <ConfidenceBadge confidence={event.confidence} />
      </View>
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onPress={() => {
              if (!event.isAllDay) setShowTime((s) => !s);
              setShowDate((s) => !s);
            }}
          >
            <Button.Label>
              {date}
              {event.isAllDay ? " · all-day" : ` · ${time}`}
            </Button.Label>
          </Button>
        </View>
      </View>
      {showDate ? (
        <DateTimePicker
          value={dateObj}
          mode="date"
          onChange={(_, picked) => {
            setShowDate(false);
            if (picked) {
              setDateObj(picked);
              const pad = (n: number) => String(n).padStart(2, "0");
              setDate(
                `${picked.getFullYear()}-${pad(picked.getMonth() + 1)}-${pad(picked.getDate())}`,
              );
            }
          }}
        />
      ) : null}
      {showTime ? (
        <DateTimePicker
          value={timeObj}
          mode="time"
          is24Hour
          onChange={(_, picked) => {
            setShowTime(false);
            if (picked) {
              setTimeObj(picked);
              const pad = (n: number) => String(n).padStart(2, "0");
              setTime(`${pad(picked.getHours())}:${pad(picked.getMinutes())}`);
            }
          }}
        />
      ) : null}
      {event.sourceQuote ? (
        <Text className="text-xs text-neutral-500 italic">“{event.sourceQuote}”</Text>
      ) : null}
      <View className="flex-row gap-2">
        <Button
          size="sm"
          className="bg-[#c23326]"
          onPress={() => void save()}
          isDisabled={updateEvent.isPending}
        >
          {updateEvent.isPending ? (
            <Spinner size="sm" color="default" />
          ) : (
            <Button.Label>Save</Button.Label>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-red-900"
          onPress={() => void remove()}
        >
          <Button.Label className="text-red-400">Delete event</Button.Label>
        </Button>
      </View>
    </View>
  );
}

/** Expandable review panel for one upload. */
function ReviewPanel({ uploadId }: { uploadId: string }) {
  const { data, isPending, isError, error, refetch } = useUploadEvents(uploadId);
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  const events = (data?.events ?? []).filter((e) => !removed.has(e.id));

  return (
    <View className="gap-2 pt-1">
      {isPending ? (
        <View className="items-center py-3">
          <Spinner size="sm" color="default" />
        </View>
      ) : isError ? (
        <Text className="text-red-400 text-sm">
          {error instanceof Error ? error.message : "Could not load events."}
        </Text>
      ) : events.length === 0 ? (
        <Text className="text-neutral-500 text-sm">No events in this upload.</Text>
      ) : (
        events.map((e) => (
          <EventEditor
            key={e.id}
            event={e}
            uploadId={uploadId}
            onDeleted={() => setRemoved((prev) => new Set(prev).add(e.id))}
          />
        ))
      )}
      {events.length > 0 ? (
        <PressCard onPress={() => void refetch()} className="items-center py-1">
          <Text className="text-neutral-500 text-xs">Refresh</Text>
        </PressCard>
      ) : null}
    </View>
  );
}

export default function FilesScreen() {
  const uploads = useUploads(50);
  const deleteUpload = useDeleteUpload();
  const revokeShare = useRevokeShare();
  const emailUpload = useEmailUpload();
  const smsUpload = useSmsUpload();
  const { toast } = useToast();

  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const rows = uploads.data?.uploads ?? [];

  function confirm(title: string, message: string, onConfirm: () => void) {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Confirm", style: "destructive", onPress: onConfirm },
    ]);
  }

  async function copyShareLink(token: string) {
    try {
      await Clipboard.setStringAsync(`${api.serverUrl()}/s/${token}`);
      toast.show({ variant: "success", label: "Share link copied." });
    } catch {
      toast.show({ variant: "danger", label: "Could not copy the link." });
    }
  }

  async function download(token: string, fileName: string) {
    try {
      await downloadAndShareIcs(token, fileName);
    } catch (err) {
      toast.show({
        variant: "danger",
        label: err instanceof Error ? err.message : "Download failed.",
      });
    }
  }

  async function sendEmail() {
    if (!deliveryId) return;
    const value = email.trim();
    if (!value) {
      toast.show({ variant: "danger", label: "Please enter an email address." });
      return;
    }
    try {
      const res = await emailUpload.mutateAsync({ id: deliveryId, email: value });
      toast.show({ variant: "success", label: res.message });
      setDeliveryId(null);
      setEmail("");
    } catch (err) {
      toast.show({
        variant: "danger",
        label: err instanceof Error ? err.message : "Failed to send email.",
      });
    }
  }

  async function sendSms() {
    if (!deliveryId) return;
    const value = phone.trim();
    if (!value) {
      toast.show({ variant: "danger", label: "Please enter a phone number." });
      return;
    }
    try {
      const res = await smsUpload.mutateAsync({ id: deliveryId, phone: value });
      toast.show({ variant: "success", label: res.message });
      setDeliveryId(null);
      setPhone("");
    } catch (err) {
      toast.show({
        variant: "danger",
        label: err instanceof Error ? err.message : "Failed to send SMS.",
      });
    }
  }

  return (
    <Container className="bg-neutral-950">
      <View className="px-4 pt-6 pb-4">
        <Text className="text-3xl font-bold text-white mb-1">Your Files</Text>
        <Text className="text-neutral-400">
          Download, share, review, and manage your calendar files.
        </Text>
      </View>

      {uploads.isPending ? (
        <View className="items-center py-10">
          <Spinner size="lg" color="default" />
        </View>
      ) : rows.length === 0 ? (
        <View className="px-4 rounded-2xl border border-neutral-800 bg-neutral-900 p-10 items-center gap-3 mx-4">
          <Text className="text-5xl">📂</Text>
          <Text className="text-xl font-bold text-white">No files yet</Text>
          <Text className="text-neutral-400 text-center">
            Upload your first schedule to get started.
          </Text>
        </View>
      ) : (
        <View className="px-4 gap-4 pb-10">
          {rows.map((u) => {
            const completed = u.status === "completed" && u.shareToken;
            const isDeliveryTarget = deliveryId === u.id;
            const isReviewTarget = reviewId === u.id;
            return (
              <View
                key={u.id}
                className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 gap-3"
              >
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-row items-center gap-3 flex-1">
                    <Text className="text-3xl">🖼</Text>
                    <View className="flex-1">
                      <Text className="text-white font-medium text-sm" numberOfLines={1}>
                        {u.fileName}
                      </Text>
                      <Text className="text-neutral-500 text-xs">
                        {new Date(u.createdAt).toLocaleDateString()} · {u.fileType}
                      </Text>
                    </View>
                  </View>
                  <StatusChip status={u.status} />
                </View>

                {completed ? (
                  <View className="flex-row flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="bg-[#c23326]"
                      onPress={() => void download(u.shareToken!, u.fileName)}
                    >
                      <Button.Label>Download .ics</Button.Label>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onPress={() => setReviewId(isReviewTarget ? null : u.id)}
                    >
                      <Button.Label>
                        {isReviewTarget ? "Hide review" : "Review events"}
                      </Button.Label>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onPress={() => void copyShareLink(u.shareToken!)}
                    >
                      <Button.Label>Copy link</Button.Label>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onPress={() => setDeliveryId(isDeliveryTarget ? null : u.id)}
                    >
                      <Button.Label>
                        {isDeliveryTarget ? "Hide delivery" : "Email / SMS"}
                      </Button.Label>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-amber-900"
                      onPress={() =>
                        confirm(
                          "Revoke share link?",
                          "Anyone with the link will lose access immediately.",
                          () =>
                            void revokeShare.mutateAsync(u.id).catch((err) =>
                              toast.show({
                                variant: "danger",
                                label: err instanceof Error ? err.message : "Revoke failed.",
                              }),
                            ),
                        )
                      }
                    >
                      <Button.Label className="text-amber-400">Revoke share</Button.Label>
                    </Button>
                  </View>
                ) : null}

                {isReviewTarget ? <ReviewPanel uploadId={u.id} /> : null}

                {isDeliveryTarget ? (
                  <View className="gap-3 pt-1">
                    <TextField>
                      <Input
                        value={email}
                        onChangeText={setEmail}
                        placeholder="Email — you@example.com"
                        keyboardType="email-address"
                        autoCapitalize="none"
                      />
                      <Button
                        size="sm"
                        className="bg-[#c23326]"
                        isDisabled={emailUpload.isPending}
                        onPress={() => void sendEmail()}
                      >
                        <Button.Label>Send Email</Button.Label>
                      </Button>
                    </TextField>
                    <TextField>
                      <Input
                        value={phone}
                        onChangeText={setPhone}
                        placeholder="SMS — +15551234567"
                        keyboardType="phone-pad"
                      />
                      <Button
                        size="sm"
                        className="bg-[#c23326]"
                        isDisabled={smsUpload.isPending}
                        onPress={() => void sendSms()}
                      >
                        <Button.Label>Send SMS</Button.Label>
                      </Button>
                    </TextField>
                  </View>
                ) : null}

                <PressCard
                  onPress={() =>
                    confirm(
                      "Delete this upload?",
                      "The source file, extracted events, and calendar file will be removed.",
                      () =>
                        void deleteUpload.mutateAsync(u.id).catch((err) =>
                          toast.show({
                            variant: "danger",
                            label: err instanceof Error ? err.message : "Delete failed.",
                          }),
                        ),
                    )
                  }
                  className="self-start py-1"
                >
                  <Text className="text-red-400 text-xs font-bold">Delete</Text>
                </PressCard>
              </View>
            );
          })}
        </View>
      )}
    </Container>
  );
}
