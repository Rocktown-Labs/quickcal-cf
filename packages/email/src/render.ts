import type { ReactElement } from "react";
import { render } from "@react-email/render";

export interface RenderedEmail {
  html: string;
  text: string;
}

export async function renderEmail(element: ReactElement): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([
    render(element, { pretty: false }),
    render(element, { plainText: true, pretty: false }),
  ]);

  return { html, text };
}
