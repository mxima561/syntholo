import { STRIPE_API_VERSION } from "@syntholo/contracts/commerce";

type Environment = Readonly<Record<string, string | undefined>>;
type Options = Readonly<{ nodeEnv: string | undefined }>;

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const restrictedKey = /^rk_(?:test|live)_[A-Za-z0-9]{16,}$/u;
const endpointSecret = /^whsec_[A-Za-z0-9]{16,}$/u;
const fakeCredential = /^syntholo_test_fake_[a-z_]+$/u;
const fingerprint = /^[0-9a-f]{64}$/u;

function exact(value: string | undefined): string {
  if (value === undefined || !identifier.test(value)) throw new Error("invalid");
  return value;
}

function providerConfigurationId(value: string | undefined, prefix: "acct" | "bpc"): string {
  if (value === undefined || !new RegExp(`^${prefix}_[A-Za-z0-9._:-]+$`, "u").test(value)) {
    throw new Error("invalid");
  }
  return value;
}

function credential(value: string | undefined, fake: boolean, expectedLivemode: boolean): string {
  if (value === undefined || !(fake ? fakeCredential : restrictedKey).test(value)) throw new Error("invalid");
  if (fake ? expectedLivemode : value.startsWith("rk_live_") !== expectedLivemode) throw new Error("invalid");
  return value;
}

function webhookSecret(value: string | undefined, fake: boolean): string {
  if (value === undefined || !(fake ? fakeCredential : endpointSecret).test(value)) throw new Error("invalid");
  return value;
}

function testFake(environment: Environment, options: Options): boolean {
  const requested = environment.STRIPE_TEST_FAKE === "1";
  if (requested && options.nodeEnv !== "test") throw new Error("invalid");
  return requested;
}

function version(environment: Environment): typeof STRIPE_API_VERSION {
  if (environment.STRIPE_API_VERSION !== STRIPE_API_VERSION) throw new Error("invalid");
  return STRIPE_API_VERSION;
}

function livemode(environment: Environment): boolean {
  if (environment.STRIPE_EXPECTED_LIVEMODE === "true") return true;
  if (environment.STRIPE_EXPECTED_LIVEMODE === "false") return false;
  throw new Error("invalid");
}

function exactHttpsUrl(value: string | undefined): string {
  if (value === undefined) throw new Error("invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
    || url.search !== "" || url.hash !== "" || url.pathname === "/") throw new Error("invalid");
  return url.toString();
}

function canonicalAppUrls(environment: Environment) {
  const checkoutSuccessUrl = exactHttpsUrl(environment.STRIPE_CHECKOUT_SUCCESS_URL);
  const checkoutCancelUrl = exactHttpsUrl(environment.STRIPE_CHECKOUT_CANCEL_URL);
  const portalReturnUrl = exactHttpsUrl(environment.STRIPE_PORTAL_RETURN_URL);
  const urls = [
    [checkoutSuccessUrl, "/claim"],
    [checkoutCancelUrl, "/programs"],
    [portalReturnUrl, "/settings/billing"],
  ] as const;
  if (urls.some(([value, path]) => new URL(value).pathname !== path)
    || new Set(urls.map(([value]) => new URL(value).origin)).size !== 1) throw new Error("invalid");
  return { checkoutSuccessUrl, checkoutCancelUrl, portalReturnUrl };
}

export function parseStripeApiEnvironment(environment: Environment, options: Options) {
  try {
    if (Object.keys(environment).some((key) => key.startsWith("STRIPE_WORKER_"))) throw new Error("invalid");
    const fake = testFake(environment, options);
    const expectedLivemode = livemode(environment);
    const appUrls = canonicalAppUrls(environment);
    const current = {
      keyId: exact(environment.STRIPE_WEBHOOK_CURRENT_KEY_ID),
      secret: webhookSecret(environment.STRIPE_WEBHOOK_CURRENT_SECRET, fake),
    };
    const previousId = environment.STRIPE_WEBHOOK_PREVIOUS_KEY_ID;
    const previousSecret = environment.STRIPE_WEBHOOK_PREVIOUS_SECRET;
    if ((previousId === undefined) !== (previousSecret === undefined)) throw new Error("invalid");
    const previous = previousId === undefined ? null : {
      keyId: exact(previousId),
      secret: webhookSecret(previousSecret, fake),
    };
    if (previous !== null && (previous.keyId === current.keyId || previous.secret === current.secret)) {
      throw new Error("invalid");
    }
    if (environment.STRIPE_EXPECTED_EVENT_ACCOUNT !== "null"
      || environment.STRIPE_EXPECTED_EVENT_CONTEXT !== "null") throw new Error("invalid");
    return Object.freeze({
      apiRestrictedKey: credential(environment.STRIPE_API_RESTRICTED_KEY, fake, expectedLivemode),
      checkoutSuccessUrl: appUrls.checkoutSuccessUrl,
      checkoutCancelUrl: appUrls.checkoutCancelUrl,
      portalConfigurationId: providerConfigurationId(environment.STRIPE_PORTAL_CONFIGURATION_ID, "bpc"),
      portalReturnUrl: appUrls.portalReturnUrl,
      endpointBinding: Object.freeze({
        receiverAccountId: providerConfigurationId(environment.STRIPE_RECEIVER_ACCOUNT_ID, "acct"),
        expectedLivemode,
        expectedApiVersion: version(environment),
        expectedEventAccount: null,
        expectedEventContext: null,
      }),
      webhookSecrets: Object.freeze(previous === null ? [Object.freeze(current)] : [
        Object.freeze(current),
        Object.freeze(previous),
      ]),
    });
  } catch {
    throw new Error("STRIPE_API_CONFIG_INVALID");
  }
}

export function parseStripeWorkerEnvironment(environment: Environment, options: Options) {
  try {
    if (Object.keys(environment).some((key) => key === "STRIPE_API_RESTRICTED_KEY"
      || key.startsWith("STRIPE_WEBHOOK_") || key.startsWith("STRIPE_PORTAL_")
      || key.startsWith("STRIPE_CHECKOUT_"))) throw new Error("invalid");
    const fake = testFake(environment, options);
    const expectedLivemode = livemode(environment);
    const workerReadRestrictedKey = credential(environment.STRIPE_WORKER_READ_RESTRICTED_KEY, fake, expectedLivemode);
    const workerActionRestrictedKey = credential(environment.STRIPE_WORKER_ACTION_RESTRICTED_KEY, fake, expectedLivemode);
    if (workerReadRestrictedKey === workerActionRestrictedKey) throw new Error("invalid");
    return Object.freeze({
      workerReadRestrictedKey,
      workerActionRestrictedKey,
      receiverAccountId: providerConfigurationId(environment.STRIPE_RECEIVER_ACCOUNT_ID, "acct"),
      expectedLivemode,
      apiVersion: version(environment),
    });
  } catch {
    throw new Error("STRIPE_WORKER_CONFIG_INVALID");
  }
}

export function attestStripeCredentialFingerprints(input: Readonly<{
  api: string;
  workerRead: string;
  workerAction: string;
}>) {
  const values = [input.api, input.workerRead, input.workerAction];
  if (values.some((value) => !fingerprint.test(value)) || new Set(values).size !== values.length) {
    throw new Error("STRIPE_CREDENTIAL_ISOLATION_INVALID");
  }
  return Object.freeze({ isolated: true as const });
}
