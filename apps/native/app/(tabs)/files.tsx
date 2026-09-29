import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { Button, Input, Label, Spinner, TextField, useToast } from "heroui-native";
import { api } from "@/lib/api";
import {
  useDeleteUpload,
  useEmailUpload,
  useRevokeShare,
  useSmsUpload,
  useUploads,
} from "@/lib/queries";
import { downloadAndShareIcs } from "@/lib/ics";
import { PressCard, StatusChip } from "@/components/qc";
import { Container } from "@/components/container";

export default function FilesScreen() {
  const uploads = useUploads(50);
  const deleteUpload = useDeleteUpload();
  const revokeShare = useRevokeShare();
  const emailUpload = useEmailUpload();
  const smsUpload = useSmsUpload();
  const { toast } = useToast();

  const [deliveryId, setDeliveryId] = useState<string | null>(null);
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
          Download, share, and manage your processed calendar files.
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

                {isDeliveryTarget ? (
                  <View className="gap-3 pt-1">
                    <TextField>
                      <Label>Email</Label>
                      <Input
                        value={email}
                        onChangeText={setEmail}
                        placeholder="you@example.com"
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
                      <Label>Phone Number</Label>
                      <Input
                        value={phone}
                        onChangeText={setPhone}
                        placeholder="+15551234567"
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
