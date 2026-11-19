type AnalyticsEvent =
  | "signup_completed"
  | "login_completed"
  | "google_signin_started"
  | "onboarding_completed"
  | "extraction_started"
  | "extraction_completed"
  | "extraction_failed"
  | "manual_events_created"
  | "checkout_clicked";
type Props = {
  method?: "email" | "google";
  outcome?: "completed" | "skipped" | "failed" | "no_events";
  interval?: "monthly" | "annual";
};

declare global {
  interface Window {
    traks?: (name: string, props?: Record<string, string>) => void;
  }
}

// Accept only fixed categories. Never pass user, document, or token data.
export function track(name: AnalyticsEvent, props?: Props): void {
  if (typeof window === "undefined") return;
  try {
    const cleanProps = props
      ? (Object.fromEntries(
          Object.entries(props).filter(([, value]) => value !== undefined),
        ) as Record<string, string>)
      : undefined;
    window.traks?.(name, cleanProps);
  } catch {
    // Analytics must never break signup/login/checkout.
  }
}
