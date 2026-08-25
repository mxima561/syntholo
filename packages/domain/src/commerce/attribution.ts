const FIELD_MAX = 160;

export type AttributionTouch = Readonly<{
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  landingPath?: string;
}>;

export type Attribution = Readonly<{
  firstTouch?: AttributionTouch;
  lastTouch?: AttributionTouch;
  consentedAt?: string;
}>;

function clip(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, FIELD_MAX);
}

function normalizeTouch(touch: AttributionTouch | undefined): AttributionTouch | undefined {
  if (!touch) return undefined;
  const next = {
    source: clip(touch.source),
    medium: clip(touch.medium),
    campaign: clip(touch.campaign),
    content: clip(touch.content),
    landingPath: clip(touch.landingPath),
  };
  return Object.values(next).some(Boolean) ? next : undefined;
}

export function normalizeAttribution(input: Attribution | null | undefined): Attribution {
  if (!input) return {};
  return {
    firstTouch: normalizeTouch(input.firstTouch),
    lastTouch: normalizeTouch(input.lastTouch),
    consentedAt: clip(input.consentedAt),
  };
}
