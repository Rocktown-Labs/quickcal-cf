import { Link } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button, FieldError, Input, Label, Spinner, TextField, useToast } from "heroui-native";
import { useForm } from "@tanstack/react-form";
import z from "zod";
import { authClient } from "@/lib/auth-client";
import { AuthShell } from "@/components/auth-shell";
import { getErrorMessage } from "@/lib/form-error";

const signInSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email address"),
  password: z.string().min(1, "Password is required").min(8, "Use at least 8 characters"),
});

export default function LoginScreen() {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  const form = useForm({
    defaultValues: { email: "", password: "" },
    validators: { onSubmit: signInSchema },
    onSubmit: async ({ value }) => {
      setPending(true);
      const { error } = await authClient.signIn.email({
        email: value.email.trim(),
        password: value.password,
      });
      setPending(false);
      if (error) {
        toast.show({ variant: "danger", label: error.message || "Failed to sign in" });
      } else {
        toast.show({ variant: "success", label: "Welcome back!" });
      }
    },
  });

  return (
    <AuthShell
      title="Welcome Back"
      subtitle="Sign in to extract calendar events from your images."
      footer={
        <View className="items-center gap-2">
          <Text className="text-neutral-400 text-sm">
            Need an account?{" "}
            <Link href="/signup" className="text-[#c23326] font-semibold">
              Sign up
            </Link>
          </Text>
          <Link href="/forgot-password" className="text-neutral-500 text-sm">
            Forgot your password?
          </Link>
        </View>
      }
    >
      <form.Subscribe>
        {() => (
          <View className="gap-4">
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
                    placeholder="••••••••"
                    secureTextEntry
                    autoComplete="password"
                    textContentType="password"
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
                <Button.Label>Sign In</Button.Label>
              )}
            </Button>

            <View className="items-center py-1">
              <Text className="text-neutral-500 text-xs uppercase">Or continue with</Text>
            </View>

            <Button
              variant="outline"
              onPress={() => {
                void authClient.signIn.social({
                  provider: "google",
                  callbackURL: "/",
                });
              }}
            >
              <Button.Label>Continue with Google</Button.Label>
            </Button>
          </View>
        )}
      </form.Subscribe>
    </AuthShell>
  );
}
