import type { ComponentType } from "react";

export interface TemplateEntry {
  component: ComponentType<any>;
  subject: string | ((data: Record<string, any>) => string);
  displayName?: string;
  previewData?: Record<string, any>;
  /** Fixed recipient — overrides caller-provided recipientEmail when set. */
  to?: string;
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
