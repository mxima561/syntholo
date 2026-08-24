type Fetch = typeof fetch;

function canonicalPath(path: string): void {
  if (!/^\/v1(?:\/|$)/u.test(path) || path.startsWith("//") || path.includes("\\")) {
    throw new Error("WEB_API_PATH_INVALID");
  }
}

export function createMemberApiClient(input: {
  getToken(): Promise<string | null>;
  fetch?: Fetch;
}) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    canonicalPath(path);
    const token = await input.getToken();
    if (!token) throw new Error("MEMBER_SESSION_REQUIRED");
    return (input.fetch ?? fetch)(path, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${token}` },
    });
  };
}

export function createStaffApiClient(input: { fetch?: Fetch } = {}) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    canonicalPath(path);
    return (input.fetch ?? fetch)(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      ...(init.headers === undefined
        ? {}
        : { headers: Object.fromEntries(new Headers(init.headers)) }),
    });
  };
}

async function serverStaffApiRequest(
  path: string,
  input: {
    apiUpstreamOrigin: string;
    cookieName: string;
    cookieValue: string;
    fetch?: Fetch;
  },
): Promise<Response> {
  canonicalPath(path);
  if (!/^[A-Za-z0-9_-]+$/u.test(input.cookieName) || /[\r\n;]/u.test(input.cookieValue)) {
    throw new Error("WEB_STAFF_COOKIE_INVALID");
  }
  return (input.fetch ?? fetch)(`${input.apiUpstreamOrigin}${path}`, {
    cache: "no-store",
    credentials: "omit",
    headers: { cookie: `${input.cookieName}=${input.cookieValue}` },
  });
}

export function createServerStaffApiClient(input: {
  apiUpstreamOrigin: string;
  cookieName: string;
  fetch?: Fetch;
}) {
  const origin = new URL(input.apiUpstreamOrigin);
  const productionCookie = input.cookieName === "__Host-syntholo_staff_session";
  if (
    (productionCookie
      ? origin.protocol !== "https:"
      : origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.username !== "" ||
    origin.password !== "" ||
    !/^(?:__Host-syntholo_staff_session|syntholo_local_staff_session)$/u.test(
      input.cookieName,
    )
  ) {
    throw new Error("WEB_SERVER_API_CONFIG_INVALID");
  }
  return async (
    path: string,
    cookies: { getAll(name: string): readonly { value: string }[] },
  ): Promise<Response> => {
    const values = cookies.getAll(input.cookieName);
    if (
      values.length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/u.test(values[0]?.value ?? "")
    ) {
      throw new Error("WEB_STAFF_COOKIE_INVALID");
    }
    return serverStaffApiRequest(path, {
      apiUpstreamOrigin: origin.origin,
      cookieName: input.cookieName,
      cookieValue: values[0]!.value,
      fetch: input.fetch,
    });
  };
}

export function createPublicApiClient(input: { fetch?: Fetch } = {}) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    canonicalPath(path);
    return (input.fetch ?? fetch)(path, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      ...(init.headers === undefined
        ? {}
        : { headers: Object.fromEntries(new Headers(init.headers)) }),
    });
  };
}
