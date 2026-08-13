export type FixtureBuilder<T extends object> = (patch?: Partial<T>) => T;

export const createFixture = <T extends object>(
  defaults: () => T,
): FixtureBuilder<T> => (patch = {}) => ({ ...defaults(), ...patch });
