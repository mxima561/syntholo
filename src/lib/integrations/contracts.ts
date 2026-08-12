export type HealthState = "configured" | "demo" | "degraded";

export interface IdentityAdapter {
  getSignInUrl(returnTo: string): Promise<string>;
  getSignOutUrl(): Promise<string>;
}

export interface BillingAdapter {
  createCheckout(input: { offerId: string; organizationId: string; email: string }): Promise<{ url: string }>;
  createPortal(organizationId: string): Promise<{ url: string }>;
}

export interface VideoAdapter {
  getPlayback(input: { playbackId: string }): Promise<{ playbackId: string; posterUrl: string }>;
}

export interface NotificationAdapter {
  send(input: { to: string; subject: string; html: string }): Promise<{ id: string }>;
}

export interface AnalyticsAdapter {
  capture(input: { event: string; distinctId: string; properties?: Record<string, unknown> }): Promise<void>;
}

export interface WebhookReceiptStore {
  has(eventId: string): Promise<boolean>;
  record(input: { eventId: string; eventType: string; receivedAt: string }): Promise<void>;
}

export type IntegrationHealth = { name: string; state: HealthState };
