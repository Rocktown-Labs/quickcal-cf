import { Link } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button, FieldError, Input, Label, Spinner, TextField, useToast } from "heroui-native";
import { useForm } from "@tanstack/react-form";
import z from "zod";
import { authClient } from "@/lib/auth-client";
import { AuthShell } from "@/components/auth-shell";
import { getErrorMessage } from "@/lib/form-error";

const signUpSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email address"),
  password: z.string().min(8, "Use at least 8 characters"),
});

export default function SignupScreen() {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  const form = useForm({
    defaultValues: { name: "", email: "", password: "" },
    validators: { onSubmit: signUpSchema },
    onSubmit: async ({ value }) => {
      setPending(true);
      const { error } = await authClient.signUp.email({
        name: value.name.trim(),
        email: value.email.trim(),
        password: value.password,
      });
      setPending(false);
      if (error) {
        toast.show({ variant: "danger", label: error.message || "Failed to create account" });
      } else {
        toast.show({
          variant: "success",
          label: "Account created — check your inbox to verify your email",
        });
      }
    },
  });

  return (
    <AuthShell
      title="Create Account"
      subtitle="Start with free manual events. Upgrade any time for AI extraction."
      footer={
        <Text className="text-neutral-400 text-sm">
          Already have an account?{" "}
          <Link href="/login" className="text-[#c23326] font-semibold">
            Sign in
          </Link>
        </Text>
      }
    >
      <View className="gap-4">
        <form.Field name="name">
          {(field) => (
            <TextField>
              <Label>Name</Label>
              <Input
                value={field.state.value}
                onBlur={field.handleBlur}
                onChangeText={field.handleChange}
                placeholder="John Doe"
                autoComplete="name"
                textContentType="name"
              />
              <FieldError isInvalid={field.state.meta.errors.length > 0}>
                {getErrorMessage(field.state.meta.errors[0]) ?? null}
              </FieldError>
            </TextField>
          )}
        </form.Field>

        <form.Field name="email">
          {(field) => (
            <TextField>
              <Label>Email</Label>
              <Input
                value={field.state.value}
                onBlur={field.handleBlur}
                onChangeText={field.handleChange}
                placeholder="you@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                textContentType="emailAddress"
              />
              <FieldError isInvalid={field.state.meta.errors.length > 0}>
                {getErrorMessage(field.state.meta.errors[0]) ?? null}
              </FieldError>
            </TextField>
          )}
        </form.Field>

        <form.Field name="password">
          {(field) => (
            <TextField>
              <Label>Password</Label>
              <Input
                value={field.state.value}
                onBlur={field.handleBlur}
                onChangeText={field.handleChange}
                placeholder="At least 8 characters"
                secureTextEntry
                autoComplete="password-new"
                textContentType="newPassword"
              />
              <FieldError isInvalid={field.state.meta.errors.length > 0}>
                {getErrorMessage(field.state.meta.errors[0]) ?? null}
              </FieldError>
            </TextField>
          )}
        </form.Field>

        <Button onPress={form.handleSubmit} isDisabled={pending} className="mt-1 bg-[#c23326]">
          {pending ? (
            <Spinner size="sm" color="default" />
          ) : (
            <Button.Label>Create Account</Button.Label>
          )}
        </Button>
      </View>
    </AuthShell>
  );
}
