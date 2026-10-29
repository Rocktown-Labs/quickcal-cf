import type { ReactNode } from "react";
import { Body } from "@react-email/body";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Html } from "@react-email/html";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";

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
          background: "#0a0a0a",
          fontFamily: "Arial, Helvetica, sans-serif",
          padding: "32px 0",
        }}
      >
        <Preview>{preview}</Preview>
        <Container
          style={{
            maxWidth: "600px",
            margin: "0 auto",
            background: "#161616",
            borderRadius: "12px",
            overflow: "hidden",
          }}
        >
          <Section style={{ background: "#c23326", padding: "24px 32px" }}>
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
          <Section style={{ padding: "32px" }}>{children}</Section>
          <Section style={{ borderTop: "1px solid #333333", padding: "24px 32px" }}>
            {footer ?? (
              <Text
                style={{
                  color: "#666666",
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
