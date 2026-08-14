import type { FastifyPluginAsync } from "fastify";
import { authenticateMember } from "./member.js";
import {
  authenticateStaff,
  beginStaffSignIn,
  completeStaffSignIn,
  signOutStaff,
} from "./staff.js";
import type { AuthRouteDependencies } from "./types.js";
import { memberAccessRoutes } from "../routes/member/access.js";

export const authRoutes: FastifyPluginAsync<AuthRouteDependencies> = async (
  app,
  dependencies,
) => {
  await app.register(memberAccessRoutes, { member: dependencies.member });

  app.get("/member/whoami", { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Authorization");
    return authenticateMember(request, dependencies.member);
  });

  app.get("/staff/whoami", { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Cookie");
    return authenticateStaff(request, dependencies.staff);
  });

  app.get("/staff/auth/sign-in", { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Cookie");
    return beginStaffSignIn(request, reply, dependencies.staff);
  });

  app.get("/staff/auth/callback", { exposeHeadRoute: false }, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Cookie");
    void reply.header("referrer-policy", "no-referrer");
    return completeStaffSignIn(request, reply, dependencies.staff);
  });

  app.post("/staff/auth/sign-out", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    void reply.header("vary", "Cookie");
    return signOutStaff(request, reply, dependencies.staff);
  });
};
