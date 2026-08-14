export interface AnalyticsAdapter {
  capture(input: Readonly<{
    distinctId: string;
    event: string;
    properties?: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
}
