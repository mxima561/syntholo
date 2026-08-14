import { expect, test } from "@playwright/test";

test("same-origin proxy preserves status, body, cookies, location, and auth headers", async ({ request }) => {
  const response = await request.fetch("/v1/proxy-evidence", {
    headers: {
      authorization: "Bearer proxy-member-token",
      cookie: "syntholo_staff_session=proxy-staff-cookie",
    },
    maxRedirects: 0,
  });

  expect(response.status()).toBe(207);
  await expect(response.json()).resolves.toEqual({
    authorization: "Bearer proxy-member-token",
    cookie: "syntholo_staff_session=proxy-staff-cookie",
    method: "GET",
    path: "/v1/proxy-evidence",
  });
  expect(response.headers().location).toBe("/v1/proxy-target");
  expect(response.headersArray().filter(({ name }) => name.toLowerCase() === "set-cookie"))
    .toEqual([
      { name: "set-cookie", value: "proxy_a=one; Path=/; HttpOnly; SameSite=Lax" },
      { name: "set-cookie", value: "proxy_b=two; Path=/; Secure; SameSite=None" },
    ]);
});
