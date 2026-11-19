import type { ReactNode } from "react";
import { Body } from "@react-email/body";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Html } from "@react-email/html";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import { EMAIL_COLORS } from "../theme";

export interface EmailShellProps {
  preview: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function EmailShell({ preview, children, footer }: EmailShellProps) {
  return (
    <Html lang="en">
      <Head />
      <Body
        style={{
          margin: 0,
          background: EMAIL_COLORS.page,
          fontFamily: "Arial, Helvetica, sans-serif",
          padding: "32px 0",
        }}
      >
        <Preview>{preview}</Preview>
        <Container
          style={{
            maxWidth: "600px",
            margin: "0 auto",
            background: EMAIL_COLORS.card,
            borderRadius: "12px",
            overflow: "hidden",
          }}
        >
          <Section style={{ background: EMAIL_COLORS.brand, padding: "24px 32px" }}>
            <Text
              style={{
                color: "#ffffff",
                fontSize: "24px",
                fontWeight: "bold",
                margin: 0,
              }}
            >
              QuickCalAI
            </Text>
          </Section>
          <Section style={{ padding: "32px", color: EMAIL_COLORS.foreground, lineHeight: "1.6" }}>
            {children}
          </Section>
          <Section style={{ borderTop: `1px solid ${EMAIL_COLORS.border}`, padding: "24px 32px" }}>
            {footer ?? (
              <Text
                style={{
                  color: EMAIL_COLORS.faint,
                  fontSize: "12px",
                  textAlign: "center",
                  margin: 0,
                }}
              >
                QuickCalAI. Making schedule sharing effortless.
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
