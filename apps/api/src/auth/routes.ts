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
import { staffContentAuthoringRoutes } from "../routes/staff/content-authoring.js";
import { staffMediaUploadsRoutes } from "../routes/staff/media-uploads.js";
import { staffLearningAdminRoutes } from "../routes/staff/learning-admin.js";
import { staffAccountsRoutes } from "../routes/staff/accounts.js";
import { memberCertificateRoutes } from "../routes/member/certificates.js";
import { staffCertificateRoutes } from "../routes/staff/certificates.js";

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
  if (dependencies.member.certificates !== undefined && dependencies.member.certificateBlob !== undefined) {
    await app.register(memberCertificateRoutes, {
      member: dependencies.member,
      certificates: dependencies.member.certificates,
      blob: dependencies.member.certificateBlob,
    });
  }
  if (dependencies.staff.content !== undefined) {
    await app.register(staffContentRoutes, {
      staff: dependencies.staff,
      content: dependencies.staff.content,
    });
  }
  if (dependencies.staff.certificates !== undefined) {
    await app.register(staffCertificateRoutes, {
      staff: dependencies.staff,
      certificates: dependencies.staff.certificates,
    });
  }
  if (dependencies.staff.contentAuthoring !== undefined) {
    await app.register(staffContentAuthoringRoutes, {
      staff: dependencies.staff,
      contentAuthoring: dependencies.staff.contentAuthoring,
    });
  }
  if (dependencies.staff.mediaUploads !== undefined) {
    await app.register(staffMediaUploadsRoutes, {
      staff: dependencies.staff,
      mediaUploads: dependencies.staff.mediaUploads,
    });
  }
  if (dependencies.staff.learningAdmin !== undefined) {
    await app.register(staffLearningAdminRoutes, {
      staff: dependencies.staff,
      learningAdmin: dependencies.staff.learningAdmin,
    });
  }
  if (dependencies.staff.accounts !== undefined) {
    await app.register(staffAccountsRoutes, {
      staff: dependencies.staff,
      accounts: dependencies.staff.accounts,
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
