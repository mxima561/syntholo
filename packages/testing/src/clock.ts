const TEST_EPOCH = new Date("2026-01-01T12:00:00.000Z");

export const minute = (offset: number): Date =>
  new Date(TEST_EPOCH.getTime() + offset * 60_000);

export const hour = (offset: number): Date => minute(offset * 60);

export const day = (offset: number): Date => hour(offset * 24);
