import type { ComponentType } from "react";

/** One email template: its component, subject and preview agree on the data P it renders. */
export interface TemplateEntry<P extends object = Record<string, unknown>> {
  component: ComponentType<P>;
  subject: string | ((data: P) => string);
  displayName?: string;
  previewData?: P;
  /** Fixed recipient — overrides caller-provided recipientEmail when set. */
  to?: string;
}

/**
 * A template checked against its own props, as the registry holds it (R345).
 * The registry's callers render from data they put together (a form, a budget
 * row) as Record<string, unknown>; each template's props say what it reads,
 * and its subject treats every field as possibly missing.
 */
export function defineTemplate<P extends object>(template: TemplateEntry<P>): TemplateEntry {
  return template as unknown as TemplateEntry;
}

import { template as contactAdminNotification } from "./contact-admin-notification";
import { template as contactConfirmation } from "./contact-confirmation";
import { template as welcome } from "./welcome";
import { template as budgetAlert } from "./budget-alert";

/**
 * Template registry — maps template names to their React Email components.
 * Import and register new templates here after creating them in this directory.
 */
export const TEMPLATES: Record<string, TemplateEntry> = {
  "contact-admin-notification": contactAdminNotification,
  "contact-confirmation": contactConfirmation,
  welcome: welcome,
  "budget-alert": budgetAlert,
};
