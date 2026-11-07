import { renderEmail } from "./render";
import { AnnouncementEmail, type AnnouncementEmailProps } from "./templates/announcement";
import {
  ProcessingCompleteEmail,
  type ProcessingCompleteEmailProps,
} from "./templates/processing-complete";
import { WelcomeEmail, type WelcomeEmailProps } from "./templates/welcome";

export function renderWelcomeEmail(props: WelcomeEmailProps) {
  return renderEmail(WelcomeEmail(props));
}

export function renderProcessingCompleteEmail(props: ProcessingCompleteEmailProps) {
  return renderEmail(ProcessingCompleteEmail(props));
}

export function renderAnnouncementEmail(props: AnnouncementEmailProps) {
  return renderEmail(AnnouncementEmail(props));
}
