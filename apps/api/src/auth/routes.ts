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
import { memberDashboardRoutes } from "../routes/member/dashboard.js";
import { memberLearningRoutes } from "../routes/member/learning.js";
import { memberLessonPlaybackRoutes } from "../routes/member/lesson-playback.js";
import { memberProgressRoutes } from "../routes/member/progress.js";
import { memberImplementationRoutes } from "../routes/member/implementation.js";
import { staffContentRoutes } from "../routes/staff/content.js";

export const authRoutes: FastifyPluginAsync<AuthRouteDependencies> = async (
  app,
  dependencies,
) => {
  await app.register(memberAccessRoutes, { member: dependencies.member });
  await app.register(memberDashboardRoutes, { member: dependencies.member });
  if (dependencies.member.learning !== undefined) {
    await app.register(memberLearningRoutes, {
      member: dependencies.member,
      learning: dependencies.member.learning,
    });
    await app.register(memberProgressRoutes, {
      member: dependencies.member,
      learning: dependencies.member.learning,
    });
    await app.register(memberLessonPlaybackRoutes, {
      member: dependencies.member,
      learning: dependencies.member.learning,
    });
  }
  if (dependencies.member.implementation !== undefined) {
    await app.register(memberImplementationRoutes, {
      member: dependencies.member,
      implementation: dependencies.member.implementation,
    });
  }
  if (dependencies.staff.content !== undefined) {
    await app.register(staffContentRoutes, {
      staff: dependencies.staff,
      content: dependencies.staff.content,
    });
  }

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
