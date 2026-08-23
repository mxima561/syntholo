# Graph Report - production-platform  (2026-08-16)

## Corpus Check
- Large corpus: 498 files · ~507,942 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 4421 nodes · 8481 edges · 281 communities (238 shown, 43 thin omitted)
- Extraction: 97% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 210 edges (avg confidence: 0.82)
- Token cost: 504,202 input · 0 output

## Community Hubs (Navigation)
- Domain Contracts & Entitlement Rules
- Entitlements Migration 0005
- Entitlements Repository
- Commerce Catalog Migration 0014
- API App Composition
- Learning Schema Attestation
- Certificate & Content Schema
- Mux Media Contracts
- Staff Session Crypto
- Commerce Repository
- API Package Manifest
- Worker Package Manifest
- Content & Operations Plan Docs
- Worker Handler Registry
- Foundation Gate Scripts
- Certificates Migration Attestation
- Database Schema Index
- Member Read Deadlines
- Audit & Outbox Mutation
- Commerce Contracts
- API Authorization
- Root Workspace Config
- Commerce Catalog Attestation
- Certificate Worker Repository
- Implementation Migration 0012
- Certificates Migration 0013
- Certificates Integration Tests
- Job Payload Policy
- Admin Web Surfaces
- Member Learn Surfaces
- Database Client & Roles
- API Routing & Errors
- Learning Progress Contracts
- Audit & Jobs Migration 0004
- Commerce Database Schema
- Staff Authentication
- Content Block Contracts
- Certificate Contracts
- API Configuration
- Learning & Community Plans
- Learning Migration 0011
- Demo Support SLA & Access
- Worker Config & Cron
- Database Package Manifest
- Release Gate Evaluation
- Implementation Artifact Contracts
- Content Migration 0009
- Certificate Generation Handler
- Certificate PDF Rendering
- Certificate Authority Rules
- Commerce Domain Rules
- Demo Feature Surfaces
- Integrations Package Manifest
- Stripe Adapter
- Outbox Repository
- Content Assets Migration 0010
- Catalog Readiness Fingerprints
- Mux Webhook Ingestion
- Implementation Integration Tests
- Entitlements Integration Tests
- Database Repositories
- Integrations Blob
- Integrations Workos
- Web Features
- Web Components
- Contracts Member
- SQL Migration 0005
- SQL Migration 0012
- Integrations Stripe
- Web App
- Web Components
- Web Components
- Domain Implementation
- Misc Packages
- SQL Migration 0014
- Database Migrations
- Misc Packages
- Contracts Content
- Database Repositories
- Contracts Learning
- Integrations Stripe
- Misc Packages
- Testing Stripe
- Misc Apps
- Misc Apps
- Database Repositories
- Database Repositories
- SQL Migration 0005
- Database Repositories
- Database Rls
- Web Components
- Contracts Learning
- SQL Migration 0003
- Misc Tsconfig
- Infra Scripts Foundation
- Database Repositories
- Misc
- API Modules
- Web Features
- Misc Docs
- Integrations Stripe
- API Routes
- Web App
- Infra Scripts Foundation
- Misc Apps
- Misc Apps
- Operations Docs Foundation
- SQL Migration 0001
- Misc
- Misc
- Web Lib
- Web Lib
- Misc Apps
- Misc Design
- Docs Plans
- Infra Scripts Production
- SQL Migration 0008
- Contracts Entitlements
- Database Commerce
- Domain Learning
- Architecture Docs Identity
- API Modules
- Misc Apps
- Web Features
- Web Components
- Web Features
- Worker Handlers
- Misc Apps
- Architecture Docs Http
- Operations Docs Entitlement
- Contracts Learning
- Misc
- Misc
- Misc Apps
- Web Components
- Architecture Docs Member
- Architecture Docs Member
- Docs Plans
- Docs Plans
- SQL Migration 0013
- Database Learning
- API Auth
- API Modules
- API Routes
- API Routes
- Web Features
- Misc Apps
- Database Repositories
- Architecture Docs Database
- Operations Docs Foundation
- Misc Packages
- API Modules
- Web Components
- Web Components
- Misc Design
- Architecture Docs Database
- Docs Plans
- Database Member
- API Routes
- Misc Apps
- Web Features
- Operations Docs Foundation
- Docs Plans
- Docs Plans
- SQL Migration 0005
- SQL Migration 0013
- SQL Migration 0014
- Misc
- Misc
- Web Components
- Web Features
- Web Features
- Testing Gate
- Misc Packages
- SQL Migration 0007
- Misc Packages
- Misc Packages
- Misc Packages
- Web Components
- Misc Apps
- Docs Plans
- Docs Plans
- Docs Plans
- Docs Plans
- Infra Scripts Inspect
- Contracts Implementation
- SQL Migration 0005
- Database Drizzle
- Misc
- Misc Apps
- Web App
- Web Components
- Web Components
- Docs Plans
- Docs Plans
- Infra Scripts Emit
- SQL Migration 0011
- SQL Migration 0014
- SQL Migration 0014
- Database Schema
- Database Vitest
- Web Features
- Docs Plans
- Docs Plans
- Infra Scripts Assert
- Infra Scripts Foundation
- Infra Scripts Proxy
- SQL Migration 0006
- SQL Migration 0012
- Web Components
- Misc Apps
- Docs Plans
- Docs Plans
- Docs Plans
- Docs Plans
- SQL Migration 0011
- SQL Migration 0014
- Database Member
- Database Schema
- Database Schema
- Misc Apps
- Misc Apps
- Misc Apps
- Misc Apps
- Misc Apps
- Misc Apps
- Misc Apps
- Misc Apps
- Misc Apps
- Misc Apps
- Web Styles
- Misc Apps
- Misc Docs
- Misc Docs
- Docs Plans
- Docs Plans
- Docs Plans
- Docs Plans
- Docs Plans
- Docs Specs
- Docs Specs
- Docs Specs
- Docs Plans
- Docs Plans
- SQL Migration 0008
- SQL Migration 0010
- SQL Migration 0011
- SQL Migration 0013
- SQL Migration 0013
- Misc Public
- Misc Public
- Misc Public
- Misc Public
- Misc Public

## God Nodes (most connected - your core abstractions)
1. `public.syntholo_content_lesson_issues_v1()` - 74 edges
2. `Database` - 55 edges
3. `TransactionEntitlementRepository` - 48 edges
4. `public.syntholo_certificate_storage_retry_candidates_v1()` - 47 edges
5. `public.syntholo_certificates_readiness_v1()` - 47 edges
6. `AuthRouteDependencies` - 41 edges
7. `public.syntholo_implementation_list_v1()` - 40 edges
8. `public.syntholo_implementation_readiness_v1()` - 40 edges
9. `public.syntholo_implementation_readiness_v1()` - 40 edges
10. `MemberActor` - 37 edges

## Surprising Connections (you probably didn't know these)
- `records()` --indirect_call--> `accountId()`  [INFERRED]
  apps/api/src/modules/foundation/mutate-with-event.integration.test.ts → packages/database/src/schema/commerce.ts
- `Private Vercel Blob boundary` --semantically_similar_to--> `Missing/malformed config fails closed with fixed tokens`  [INFERRED] [semantically similar]
  .superpowers/sdd/2026-08-13-content-learning-certificates/task-8-brief.md → .github/workflows/ci.yml
- `Minimized receipt payload nonleakage` --semantically_similar_to--> `Secret-free runtime log assertion`  [INFERRED] [semantically similar]
  .superpowers/sdd/commerce-stripe-vertical-design/task-5-report.md → .github/workflows/ci.yml
- `Web App Next.js Agent Rules Block` --semantically_similar_to--> `Next.js Agent Rules Block`  [INFERRED] [semantically similar]
  apps/web/AGENTS.md → AGENTS.md
- `unitOfWork()` --indirect_call--> `accountId()`  [INFERRED]
  apps/api/src/modules/foundation/mutate-with-event.integration.test.ts → packages/database/src/schema/commerce.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Frozen migration and handshake authority chain (0012 -> 0013 -> 0014)** — _superpowers_sdd_2026_08_13_content_learning_certificates_task_7_report_migration_0012_implementation, _superpowers_sdd_2026_08_13_content_learning_certificates_task_7_report_implementation_handshake, _superpowers_sdd_2026_08_13_content_learning_certificates_task_8_report_migration_0013_certificates, _superpowers_sdd_2026_08_13_content_learning_certificates_task_8_report_certificates_handshake, _superpowers_sdd_commerce_stripe_vertical_design_task_4_report_migration_0014_commerce_catalog, _superpowers_sdd_commerce_stripe_vertical_design_task_4_report_commerce_catalog_handshake [EXTRACTED 1.00]
- **SHA-bound foundation CI evidence pipeline** — _github_workflows_ci_images, _github_workflows_ci_foundation, _github_workflows_ci_sha_bound_image_evidence, _github_workflows_ci_release_sha_binding, _github_workflows_ci_trivy_vulnerability_gate, _github_workflows_ci_secret_free_log_assertion, _superpowers_sdd_2026_08_13_production_foundation_task_9_report_foundation_gate [EXTRACTED 1.00]
- **Certificate issuance flow from name confirmation to private download** — _superpowers_sdd_2026_08_13_content_learning_certificates_task_8_brief_certificate_recipient_name_v1, _superpowers_sdd_2026_08_13_content_learning_certificates_task_8_brief_certificate_records, _superpowers_sdd_2026_08_13_content_learning_certificates_task_8_brief_deterministic_pdf, _superpowers_sdd_2026_08_13_content_learning_certificates_task_8_brief_private_blob_boundary, _superpowers_sdd_2026_08_13_content_learning_certificates_task_8_brief_certificate_files, _superpowers_sdd_2026_08_13_content_learning_certificates_task_8_brief_certificate_download_route, _superpowers_sdd_2026_08_13_content_learning_certificates_task_8_brief_certificate_storage_recovery [EXTRACTED 1.00]
- **Five Capability Roles Enforcing the Database Access Boundary** — docs_architecture_database_access_syntholo_migrator, docs_architecture_database_access_syntholo_member_api, docs_architecture_database_access_syntholo_staff_api, docs_architecture_database_access_syntholo_system_api, docs_architecture_database_access_syntholo_worker, docs_architecture_database_access_pool_selection_boundary [EXTRACTED 1.00]
- **Cross-Runtime Account-Name Canonicalization Agreement** — docs_architecture_member_dashboard_canonicalizeaccountname, docs_architecture_member_dashboard_iscanonicalaccountname, docs_architecture_member_dashboard_forbiddenaccountnamecodepoint, docs_architecture_member_dashboard_syntholo_account_name_is_canonical, docs_architecture_database_access_migration_0008_account_name [EXTRACTED 1.00]
- **Member Request Authorization Flow** — docs_architecture_identity_and_sessions_clerk_member_authentication, docs_architecture_database_access_member_actor_for_clerk_user, docs_architecture_database_access_pool_selection_boundary, docs_architecture_database_access_effective_access_reader, docs_architecture_member_dashboard_getmemberdashboard, docs_architecture_identity_and_sessions_browser_topology [INFERRED 0.95]
- **Foundation release and evidence gate flow** — docs_operations_foundation_deploy_release_identity, docs_operations_foundation_deploy_five_service_topology, docs_operations_foundation_deploy_release_order, docs_operations_foundation_deploy_foundation_gate, docs_operations_foundation_deploy_deployed_proxy_evidence [EXTRACTED 1.00]
- **Business OS isolation and activation lifecycle** — docs_product_prd_business_os, docs_superpowers_plans_2026_08_13_business_os_observability_seven_check_activation, docs_superpowers_plans_2026_08_13_business_os_observability_monthly_verification, docs_superpowers_plans_2026_08_13_business_os_observability_highlevel_isolation_checker, docs_superpowers_plans_2026_08_13_business_os_observability_external_login_url, docs_operations_demo_and_production_highlevel_isolation [INFERRED 0.85]
- **Purchase-to-access enrollment flow** — docs_product_prd_checkout_and_claim, docs_superpowers_plans_2026_08_13_commerce_enrollment_stripe_checkout, docs_superpowers_plans_2026_08_13_commerce_enrollment_webhook_fulfillment, docs_superpowers_plans_2026_08_13_commerce_enrollment_account_claim, docs_superpowers_plans_2026_08_13_commerce_enrollment_seat_management, docs_operations_entitlement_reconciliation_commerce_reconciliations [INFERRED 0.85]
- **Six ordered release gates** — docs_superpowers_plans_2026_08_13_production_program_gate_1_foundation, docs_superpowers_plans_2026_08_13_production_program_gate_2_production_workflows, docs_superpowers_plans_2026_08_13_production_program_gate_3_complete_curriculum, docs_superpowers_plans_2026_08_13_production_program_gate_4_staging_rehearsal, docs_superpowers_plans_2026_08_13_production_program_gate_5_controlled_production_validation, docs_superpowers_plans_2026_08_13_production_program_gate_6_public_acquisition, docs_superpowers_plans_2026_08_13_launch_acquisition_hardening_evaluatereleasecapabilities [EXTRACTED 1.00]
- **18-lesson completion to certificate chain** — docs_superpowers_plans_2026_08_13_content_learning_certificates_completelesson, docs_superpowers_plans_2026_08_13_content_learning_certificates_iscoursecomplete, docs_superpowers_plans_2026_08_13_content_learning_certificates_rendercertificatepdf, docs_superpowers_plans_2026_08_13_content_learning_certificates_createcertificatedownload, docs_superpowers_plans_2026_08_13_content_learning_certificates_certificate_independence [EXTRACTED 1.00]
- **Dual-issuer identity and authorization flow** — docs_superpowers_plans_2026_08_13_production_foundation_verifymember, docs_superpowers_plans_2026_08_13_production_foundation_verifystaff, docs_superpowers_plans_2026_08_13_production_foundation_workoscallback, docs_superpowers_plans_2026_08_13_production_foundation_staff_sessions, docs_superpowers_plans_2026_08_13_launch_acquisition_hardening_routesecurity, docs_superpowers_plans_2026_08_13_production_program_actor [INFERRED 0.85]

## Communities (281 total, 43 thin omitted)

### Community 0 - "Domain Contracts & Entitlement Rules"
Cohesion: 0.05
Nodes (87): access(), dashboard(), dashboardV2(), empty, implementationArtifacts, unavailable, ConstructorIsPrivate, RegistryIsPrivate (+79 more)

### Community 1 - "Entitlements Migration 0005"
Cohesion: 0.03
Nodes (59): access_decision_audit_append_only_rows, access_decision_audit_append_only_truncate, account_hold_sources_append_only_delete, account_holds_append_only_delete, account_holds_transition, accounts_owner_established_insert_guard, accounts_owner_established_update_guard, accounts_owner_valid (+51 more)

### Community 2 - "Entitlements Repository"
Cohesion: 0.07
Nodes (36): administrativeGrantOutcome(), canonicalEntitlementSnapshotHashV1(), commandApplied(), commandDenied(), commandResultDate(), commandResultNumber(), commandResultOptionalDate(), commandResultOptionalText() (+28 more)

### Community 3 - "Commerce Catalog Migration 0014"
Cohesion: 0.04
Nodes (56): account_onboarding_guard, account_onboarding_priorities_guard, account_onboarding_priorities_truncate_guard, account_onboarding_truncate_guard, business_os_setup_epochs_guard, business_os_setup_epochs_truncate_guard, checkout_authorizations_guard, checkout_authorizations_truncate_guard (+48 more)

### Community 4 - "API App Composition"
Cohesion: 0.05
Nodes (50): ApiDependencies, ApiDependenciesSchema, buildApp(), buildRouteTestApp(), execFileAsync, RegisterTestRoutes, RequestWithRawBody, AuthComposition (+42 more)

### Community 5 - "Learning Schema Attestation"
Cohesion: 0.03
Nodes (71): actual_immutable_triggers, actual_learning_checks, actual_learning_columns, actual_learning_fks, actual_learning_function_acl, actual_learning_indexes, actual_learning_policies, actual_learning_primary_keys (+63 more)

### Community 6 - "Certificate & Content Schema"
Cohesion: 0.05
Nodes (50): ReleaseRule, ArtifactContent, ArtifactKind, certificateDeliveryRequests, certificateFiles, certificateRecipientNameHeads, certificateRecipientNameVersions, certificateRecords (+42 more)

### Community 7 - "Mux Media Contracts"
Cohesion: 0.06
Nodes (44): canonicalTimestamp, ContentMediaAsset, ContentMediaAssetSchema, ContentMediaStateSchema, ContentMediaTrack, ContentMediaTrackSchema, ContentMediaTrackStateSchema, identifier (+36 more)

### Community 8 - "Staff Session Crypto"
Cohesion: 0.04
Nodes (15): MemoryLoginAttempts, EncryptedValue, invalidKeys(), StaffSessionCrypto, StaffSessionKeyRing, StaffTokenBinding, StaffTokenBundle, AuthEnvironment (+7 more)

### Community 9 - "Commerce Repository"
Cohesion: 0.11
Nodes (25): canonicalizeAccountName(), CommerceEnvironment, CommerceOfferCode, CommercePriceRole, exactInstant(), exactKeys(), inputHash(), nullableText() (+17 more)

### Community 10 - "API Package Manifest"
Cohesion: 0.04
Nodes (48): dependencies, fastify, fastify-plugin, fastify-raw-body, @syntholo/contracts, @syntholo/database, @syntholo/domain, @syntholo/integrations (+40 more)

### Community 11 - "Worker Package Manifest"
Cohesion: 0.04
Nodes (48): dependencies, pdf-lib, @pdf-lib/fontkit, @syntholo/database, @syntholo/domain, @syntholo/integrations, zod, devDependencies (+40 more)

### Community 12 - "Content & Operations Plan Docs"
Cohesion: 0.04
Nodes (49): applyMuxEvent, Certificate independence from entitlements, completeLesson, createCertificateDownload, getLesson (member scoped), getLessonPlayback, isCourseComplete, LearningApi client contract (+41 more)

### Community 13 - "Worker Handler Registry"
Cohesion: 0.08
Nodes (33): ContentReadinessRepositoryPort, createContentReadinessRecomputeHandler(), createImplementationCompletionRecomputeHandler(), ImplementationCompletionRepositoryPort, createHandlerRegistry(), FatalWorkerConsistencyError, HandlerFailure, createWorkerHealth() (+25 more)

### Community 14 - "Foundation Gate Scripts"
Cohesion: 0.07
Nodes (46): configuredProvider, releaseSha, addUnique(), artifactHash(), dereferenceLockPath(), environmentKeysIn(), evaluateProviderReleaseSha(), exportTarget() (+38 more)

### Community 15 - "Certificates Migration Attestation"
Cohesion: 0.07
Nodes (48): public.syntholo_certificate_storage_retry_candidates_v1(), public.syntholo_implementation_readiness_v1(), actual_checks, actual_column_acl, actual_columns, actual_columns_raw, actual_defaults, actual_fks (+40 more)

### Community 16 - "Database Schema Index"
Cohesion: 0.10
Nodes (34): AccountRecord, AccountScope, CertificateRepositoryErrorCode, LearningPlaybackTarget, bytea, staffLoginAttempts, staffSessions, accessDecisionAudit (+26 more)

### Community 17 - "Member Read Deadlines"
Cohesion: 0.14
Nodes (25): acquireMemberReadClient(), boundedAcknowledgement(), delayUntil(), destroyMemberReadLease(), earlierDeadlineError(), pools, isMemberReadDeadlineError(), MEMBER_READ_DEADLINES (+17 more)

### Community 18 - "Audit & Outbox Mutation"
Cohesion: 0.09
Nodes (25): now, records(), unitOfWork(), mutateWithEvent(), MutationRecords, AuditEventInput, AuditRepository, state (+17 more)

### Community 19 - "Commerce Contracts"
Cohesion: 0.06
Nodes (42): AcceptedPolicyVersionsSchema, BillingPortalSelectionSchema, BusinessOsSubscriptionSelectionSchema, CheckoutPendingResponseSchema, ClaimInitiateSelectionSchema, COMMERCE_ERROR_CODES, CommerceErrorCode, CommerceErrorCodeSchema (+34 more)

### Community 20 - "API Authorization"
Cohesion: 0.10
Nodes (35): authFakes(), key, now, sessionCrypto, workosClaims(), authorizationError(), AuthorizationRequirement, authorize() (+27 more)

### Community 21 - "Root Workspace Config"
Cohesion: 0.05
Nodes (40): @eslint/js, devDependencies, eslint, @eslint/js, railway, typescript, typescript-eslint, vitest (+32 more)

### Community 22 - "Commerce Catalog Attestation"
Cohesion: 0.08
Nodes (40): public.syntholo_certificates_readiness_v1(), public.syntholo_implementation_readiness_v1(), actual_checks, actual_column_acl, actual_columns, actual_columns_raw, actual_defaults, actual_fks (+32 more)

### Community 23 - "Certificate Worker Repository"
Cohesion: 0.07
Nodes (24): runCertificateRecovery(), CanonicalEtagSchema, CertificateFile, CertificateGeneration, CertificateGenerationFence, CertificateGenerationRepositoryError, CertificateObjectKeySchema, CertificateStorageRecoveryPriorDecisionError (+16 more)

### Community 24 - "Implementation Migration 0012"
Cohesion: 0.05
Nodes (39): public.syntholo_implementation_list_v1(), actual_checks, actual_columns, actual_columns_raw, actual_defaults, actual_fks, actual_function_acl, actual_function_inventory (+31 more)

### Community 25 - "Certificates Migration 0013"
Cohesion: 0.05
Nodes (9): certificate_delivery_requests_immutable, certificate_files_immutable, certificate_name_heads_guard, certificate_name_versions_immutable, certificate_records_guard, public.certificate_files, public.syntholo_certificate_head_guard_v1, public.syntholo_certificate_immutable_row_v1 (+1 more)

### Community 26 - "Certificates Integration Tests"
Cohesion: 0.07
Nodes (24): Actor, BaseFixture, CertificateRecord, ClaimedJob, CompletionFixture, contextualQuery(), databaseUrl(), deliveryRequestHash() (+16 more)

### Community 27 - "Job Payload Policy"
Cohesion: 0.09
Nodes (21): now, allowedKeys, assertSafeAuditPayload(), assertSafeOperationalPayload(), assertSafePayload(), invalidPayload(), prototypeKeys, validateValue() (+13 more)

### Community 28 - "Admin Web Surfaces"
Cohesion: 0.11
Nodes (24): AdminCertificatesPage(), AdminContentPage(), AdminLayout(), AdminOverviewPage(), attentionItems, metrics, cookies, redirect (+16 more)

### Community 29 - "Member Learn Surfaces"
Cohesion: 0.15
Nodes (20): BusinessOsPage(), CommunityPage(), CourseMapPage(), LivePage(), LearnDashboardPage(), PlanPage(), routes, useAuth (+12 more)

### Community 30 - "Database Client & Roles"
Cohesion: 0.10
Nodes (17): createDatabase(), DatabaseConfig, reservedConnectionQueryKeys, validateApplicationName(), validateDatabaseUrl(), databasePackageRoot, dropTestDatabase(), execFileAsync (+9 more)

### Community 31 - "API Routing & Errors"
Cohesion: 0.19
Nodes (26): authRoutes(), queryIsEmpty(), requestHasBody(), canonicalCorrelationId(), AppError, CertificateParametersSchema, headers(), key() (+18 more)

### Community 32 - "Learning Progress Contracts"
Cohesion: 0.12
Nodes (23): AuthRouteDependencies, SaveArtifactVersionRequest, SaveArtifactVersionResponse, MemberCourseResponse, MemberLessonProgressSchema, MemberLessonResponse, CompleteLessonRequest, CompleteLessonRequestSchema (+15 more)

### Community 33 - "Audit & Jobs Migration 0004"
Cohesion: 0.08
Nodes (23): attempts, claimed, eligible, exhausted, expired, audit_events_append_only_rows, audit_events_append_only_truncate, event_handler_receipts_parent_account (+15 more)

### Community 34 - "Commerce Database Schema"
Cohesion: 0.08
Nodes (32): accountOnboarding, accountOnboardingPriorities, boundedText(), businessOsSetupEpochs, bytea, checkoutAuthorizations, checkoutProviderActions, checkoutSessions (+24 more)

### Community 35 - "Staff Authentication"
Cohesion: 0.17
Nodes (30): generateOpaqueSessionId(), hashOpaqueSessionId(), binding, keyOne, keyTwo, authenticateStaff(), beginStaffSignIn(), callbackParameters() (+22 more)

### Community 36 - "Content Block Contracts"
Cohesion: 0.07
Nodes (30): ActionBlockSchema, BlockIdSchema, BlockquoteNodeSchema, BulletListNodeSchema, CalloutBlockSchema, ChecklistBlockSchema, CodeBlockNodeSchema, DisclosureBlockSchema (+22 more)

### Community 37 - "Certificate Contracts"
Cohesion: 0.09
Nodes (22): CertificateDeliveryResponse, CertificateListResponse, CertificateRecipientNameResponse, ConfirmCertificateRecipientNameRequest, CreateCertificateDeliveryRequest, CertificateCursorBinding, CertificateCursorValue, CursorEnvelopeSchema (+14 more)

### Community 38 - "API Configuration"
Cohesion: 0.12
Nodes (24): createStaffSessionCrypto(), parseStaffSessionKeyRing(), ApiConfig, ApiEnvironmentSchema, exactUrl(), optionalNonemptyString, parseApiConfig(), RuntimeEnvironment (+16 more)

### Community 39 - "Learning & Community Plans"
Cohesion: 0.07
Nodes (31): evaluateContentReadiness, Immutable published lesson version, LessonBlockSchema, publishLesson, toContentLaunchReadiness, validateLessonForPublication, ValidationPanel admin component, Account-shared support thread (+23 more)

### Community 40 - "Learning Migration 0011"
Cohesion: 0.07
Nodes (5): account_course_accesses_identity_immutable, enrollments_identity_immutable, lesson_progress_identity_immutable, public.enrollments, public.syntholo_learning_immutable_row

### Community 41 - "Demo Support SLA & Access"
Cohesion: 0.10
Nodes (21): addBusinessHours(), getSlaState(), isBusinessDay(), canAccess(), now, getNextAction(), NextActionInput, ArtifactKind (+13 more)

### Community 42 - "Worker Config & Cron"
Cohesion: 0.11
Nodes (22): parseWorkerConfig(), RuntimeEnvironment, WorkerConfig, WorkerEnvironmentSchema, closeCronDatabase(), CRON_TIMEOUTS, CronClient, CronDatabase (+14 more)

### Community 43 - "Database Package Manifest"
Cohesion: 0.07
Nodes (28): drizzle-kit, dependencies, drizzle-orm, pg, @syntholo/contracts, @syntholo/domain, devDependencies, drizzle-kit (+20 more)

### Community 44 - "Release Gate Evaluation"
Cohesion: 0.15
Nodes (25): activeYamlRunBlocks(), evaluateFoundationGate(), evaluateReleaseSha(), execFileAsync, foundationExitCode(), inspectRepositoryIdentity(), productionDependencyPolicyPass(), runIndependentChecks() (+17 more)

### Community 45 - "Implementation Artifact Contracts"
Cohesion: 0.08
Nodes (26): AiPolicyContentSchema, ArtifactContentSchema, ArtifactKindSchema, ArtifactStateSchema, ArtifactSummary, ArtifactSummarySchema, ArtifactVersionMetadataSchema, ArtifactVersionsQuerySchema (+18 more)

### Community 46 - "Content Migration 0009"
Cohesion: 0.19
Nodes (24): public.api_command_receipts, public.content_archives, public.content_previews, public.content_readiness_approvals, public.content_readiness_evaluations, public.content_resource_drafts, public.content_schedules, public.course_drafts (+16 more)

### Community 47 - "Certificate Generation Handler"
Cohesion: 0.13
Nodes (21): acknowledgeTerminal(), CertificateGenerationBlobPort, CertificateGenerationRepositoryPort, classifyRepositoryError(), createCertificateGenerationHandler(), dependencyUnavailable(), JobSchema, markFailed() (+13 more)

### Community 48 - "Certificate PDF Rendering"
Cohesion: 0.13
Nodes (25): assertCertificateRendererReadiness(), assetsUrl, authoritativeFont(), canonicalJson(), certificateApprovedCopy(), CertificateAuthorityAssets, CertificateLayoutLine, CertificateRenderInput (+17 more)

### Community 49 - "Certificate Authority Rules"
Cohesion: 0.11
Nodes (22): CertificateRenderInputSchema, assertCertificateEligibility(), AuthorityTuple, canonicalizeCertificateRecipientName(), canonicalUuid(), CERTIFICATE_FONT_REPERTOIRE, CERTIFICATE_FONT_REPERTOIRE_MANIFEST_SHA256, CertificateAuthoritySnapshot (+14 more)

### Community 50 - "Commerce Domain Rules"
Cohesion: 0.11
Nodes (25): catalog, fingerprintBinding, BusinessOsPurchaseEvent, BusinessOsPurchaseState, canonicalJson(), CanonicalObject, CanonicalScalar, CanonicalValue (+17 more)

### Community 51 - "Demo Feature Surfaces"
Cohesion: 0.14
Nodes (15): LiveSchedule(), completedIds, demoArtifacts, demoCommunityPosts, demoEntitlements, demoMembers, demoOrganization, demoProgress (+7 more)

### Community 52 - "Integrations Package Manifest"
Cohesion: 0.08
Nodes (25): @clerk/backend, jose, dependencies, @clerk/backend, jose, stripe, @syntholo/contracts, @syntholo/domain (+17 more)

### Community 53 - "Stripe Adapter"
Cohesion: 0.14
Nodes (24): NormalizedStripeCheckoutSessionSchema, NormalizedStripeInvoiceSchema, NormalizedStripeSetupIntentSchema, NormalizedStripeSubscriptionSchema, checkoutParameters(), CommonCheckout, commonKeys, createStripeAdapter() (+16 more)

### Community 54 - "Outbox Repository"
Cohesion: 0.17
Nodes (18): outboxConflict(), OutboxRepository, postgresCode(), state, assertEventInput(), assertRegisteredPayload(), cloneJsonValue(), copyJsonObject() (+10 more)

### Community 55 - "Content Assets Migration 0010"
Cohesion: 0.10
Nodes (17): actual_journal, public.content_media_assets, public.content_media_tracks, public.syntholo_content_import_mux_asset_v1(), public.syntholo_mux_apply_event_v1(), drizzle.__drizzle_migrations, pg_auth_members, pg_class (+9 more)

### Community 56 - "Catalog Readiness Fingerprints"
Cohesion: 0.08
Nodes (25): actual_offers, actual_upstream_readiness_functions, certificate_state, cleanup, expected_offers, function_acl_fingerprint, function_fingerprint, NOT (+17 more)

### Community 57 - "Mux Webhook Ingestion"
Cohesion: 0.10
Nodes (14): MuxEventApplyPort, MuxWebhookEvent, ApplyMuxEventInput, ImportedMuxAsset, ImportMuxAssetInput, MuxEventApplyResult, MuxReconcileTarget, MuxReconciliationSnapshot (+6 more)

### Community 58 - "Implementation Integration Tests"
Cohesion: 0.08
Nodes (18): ArtifactState, Actor, actorA, actorB, aiDraft, aiFinal, checklistFinal, ids (+10 more)

### Community 59 - "Entitlements Integration Tests"
Cohesion: 0.10
Nodes (13): AppliedValue, BusinessOsSetupValue, dropLogin(), formatSql(), inTransaction(), loginUrl(), now, RuntimeLogin (+5 more)

### Community 60 - "Database Repositories"
Cohesion: 0.09
Nodes (12): DatabaseLoginAttempt, DatabaseStaffIdentity, DatabaseStaffSession, DatabaseWorkosClaims, EncryptedDatabaseValue, LoginRow, mapLogin(), mapSession() (+4 more)

### Community 61 - "Integrations Blob"
Cohesion: 0.12
Nodes (21): beginBestEffortCancel(), bestEffortCancel(), boundedOperation(), cancelLateGetResult(), createPrivateCertificateBlobStore(), fail(), GetOptions, inputAuthority() (+13 more)

### Community 62 - "Integrations Workos"
Cohesion: 0.13
Nodes (15): createClerkSessionAuthenticator(), authenticateRequest, StripeCheckoutInput, createWorkosStaffClient(), workos, createRemoteWorkosJwks(), createWorkosJwks(), requiredString() (+7 more)

### Community 63 - "Web Features"
Cohesion: 0.14
Nodes (14): metadata, ScorecardQuestion, scorecardQuestions, ScoreDimension, scoreOptions, AssessmentStage, ScorecardClient(), calculateScore() (+6 more)

### Community 64 - "Web Components"
Cohesion: 0.13
Nodes (20): byteSize(), degradedPlayback(), DocumentNode, LessonContentBlock(), lockedAvailableAt(), parseJson(), PlaybackDependencyUnavailable, ProductionLessonWorkspace() (+12 more)

### Community 65 - "Contracts Member"
Cohesion: 0.09
Nodes (22): DashboardProjections, firstUnavailableProjection(), forbiddenAccountNameCodePoint(), LearningProjectionSchema, MemberDashboardNextBestStep, MemberDashboardNextBestStepSchema, MemberDashboardProjections, MemberDashboardProjectionsSchema (+14 more)

### Community 66 - "SQL Migration 0005"
Cohesion: 0.20
Nodes (24): "accounts", "member_identities", "memberships", access_decision_audit, entitlement_commands, seat_invitation_token_generations, seat_invitations, seat_reservations (+16 more)

### Community 67 - "SQL Migration 0012"
Cohesion: 0.09
Nodes (6): implementation_artifacts_delete_immutable, implementation_artifacts_head_guard, implementation_artifacts_identity_immutable, public.implementation_artifact_versions, public.syntholo_implementation_immutable_row_v1, public.syntholo_implementation_root_head_guard_v1

### Community 68 - "Integrations Stripe"
Cohesion: 0.14
Nodes (21): attestStripeCredentialFingerprints(), canonicalAppUrls(), credential(), Environment, exact(), exactHttpsUrl(), livemode(), Options (+13 more)

### Community 69 - "Web App"
Cohesion: 0.13
Nodes (8): offers, HomePage(), outcomes, plans, PricingPage(), Button(), ButtonProps, ButtonVariant

### Community 70 - "Web Components"
Cohesion: 0.14
Nodes (16): ProductionCourseMap(), Resolution, response, useAuth, availableLabel(), dashboardRequestVersion(), parseApiError(), parseMemberDashboardResponse() (+8 more)

### Community 71 - "Web Components"
Cohesion: 0.13
Nodes (21): canonicalContent(), Draft, emptyContent(), implementationKey(), ImplementationWorkspaceSession(), incompleteFinalPaths(), isJsonResponse(), liveWorkflowPaths() (+13 more)

### Community 72 - "Domain Implementation"
Cohesion: 0.11
Nodes (14): save(), actor, content, loadRepository(), assertArtifactFinalizable(), canonicalizeArtifactContent(), canonicalJson(), completeWorkflow() (+6 more)

### Community 73 - "Misc Packages"
Cohesion: 0.09
Nodes (22): dependencies, @syntholo/domain, zod, exports, ./commerce, ./content, ./entitlements, ./health (+14 more)

### Community 74 - "SQL Migration 0014"
Cohesion: 0.19
Nodes (23): public.business_os_setup_epochs, public.claim_tokens, public.invoice_line_allocations, public.invoices, public.offer_price_bindings, public.pending_claim_sessions, public.public_business_os_setup_fulfillments, public.public_business_os_setup_intents (+15 more)

### Community 75 - "Database Migrations"
Cohesion: 0.14
Nodes (13): DatabaseCapability, main(), MigrationEnvironment, selectMigrationDatabaseUrl(), assertPublishedMigrationInventory(), Journal, migrateDatabase(), MIGRATION_ADVISORY_LOCK (+5 more)

### Community 76 - "Misc Packages"
Cohesion: 0.09
Nodes (21): fast-check, devDependencies, fast-check, exports, ./certificates, ./commerce, ./content, ./entitlements (+13 more)

### Community 77 - "Contracts Content"
Cohesion: 0.12
Nodes (20): ContentPublicationConflictCodeSchema, ContentPublicationIssueSchema, ContentPublicationIssuesSchema, CreateCourseRequestSchema, CreateLessonRequestSchema, CreatePreviewRequestSchema, CreateStageRequestSchema, DerivedCoursePreviewResponseSchema (+12 more)

### Community 78 - "Database Repositories"
Cohesion: 0.13
Nodes (16): ArtifactDetailResponse, ArtifactListResponse, ArtifactVersionsResponse, CursorBinding, CursorEnvelopeSchema, CursorPayloadSchema, cursorSecret(), CursorValue (+8 more)

### Community 79 - "Contracts Learning"
Cohesion: 0.10
Nodes (20): CERTIFICATE_FONT_REPERTOIRE_MANIFEST_SHA256, CertificateBusinessNameSnapshotSchema, CertificateCourseTitleSnapshotSchema, CertificateFailureCodeSchema, CertificateListItemBase, CertificateListItemSchema, CertificateListQuery, CertificateListQuerySchema (+12 more)

### Community 80 - "Integrations Stripe"
Cohesion: 0.42
Nodes (22): boolean(), createStripeReadAdapterWithClient(), enumValue(), idOf(), instant(), integer(), isRecord(), list() (+14 more)

### Community 81 - "Misc Packages"
Cohesion: 0.09
Nodes (21): dependencies, @syntholo/database, @syntholo/domain, @syntholo/integrations, exports, ./clock, ./database, ./factories/actors (+13 more)

### Community 82 - "Testing Stripe"
Cohesion: 0.19
Nodes (15): day(), hour(), minute(), TEST_EPOCH, memberActor(), staffActor(), createFixture(), FixtureBuilder (+7 more)

### Community 83 - "Misc Apps"
Cohesion: 0.10
Nodes (21): dependencies, @clerk/react, lucide-react, @mux/mux-player-react, next, posthog-js, react, react-dom (+13 more)

### Community 84 - "Misc Apps"
Cohesion: 0.10
Nodes (21): devDependencies, eslint-config-next, @eslint/eslintrc, jsdom, tailwindcss, @tailwindcss/postcss, @testing-library/user-event, @types/node (+13 more)

### Community 85 - "Database Repositories"
Cohesion: 0.14
Nodes (11): createDomainEventJobHandler(), ClaimedJob, assertFence(), assertTime(), ClaimedOutboxEvent, HandlerReceiptClaim, HandlerReceiptRepository, OutboxRow (+3 more)

### Community 86 - "Database Repositories"
Cohesion: 0.11
Nodes (7): Database, AccountRepository, MemberIdentityRepository, SystemImplementationRepository, raceAbort(), WorkerLearningRepository, OutboxProcessorRepository

### Community 87 - "SQL Migration 0005"
Cohesion: 0.32
Nodes (20): account_hold_sources, account_holds, administrative_grant_restorations, business_os_setup_receipts, business_os_subscription_cancellations, club_subscription_cancellations, commerce_fulfillment_receipts, commerce_reconciliations (+12 more)

### Community 88 - "Database Repositories"
Cohesion: 0.13
Nodes (17): ContentPublicationConflictCode, ContentPublicationIssue, ContentCommandConflictError, ContentPreviewRecord, CreateContentPreviewInput, DerivedContentPreviewRecord, GetContentPreviewInput, JsonObject (+9 more)

### Community 89 - "Database Rls"
Cohesion: 0.13
Nodes (13): capabilityRoles, createRuntimeLogin(), customerTables, dropDatabase(), dropRuntimeLogin(), errorChain(), expectProvisioningFailure(), formatSql() (+5 more)

### Community 90 - "Web Components"
Cohesion: 0.18
Nodes (14): Intent, intentKey(), ProductionCertificateDelivery(), run(), submit(), responseCode(), State, canonicalPath() (+6 more)

### Community 91 - "Contracts Learning"
Cohesion: 0.13
Nodes (16): CompletedWithoutResumeSchema, CourseLessonSummarySchema, DegradedPlaybackSchema, IdSchema, LessonPlaybackResponse, LessonPlaybackResponseSchema, MemberCourseResponseSchema, MemberLessonProgress (+8 more)

### Community 92 - "SQL Migration 0003"
Cohesion: 0.11
Nodes (10): public.cleanup_staff_auth(), public.member_actor_for_clerk_user(), public.accounts, public.memberships, "public"."staff_identities", "staff_login_attempts", "staff_sessions", public.member_identities (+2 more)

### Community 93 - "Misc Tsconfig"
Cohesion: 0.11
Nodes (17): dom, dom.iterable, esnext, compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules (+9 more)

### Community 94 - "Infra Scripts Foundation"
Cohesion: 0.23
Nodes (17): addBindingNames(), addRuntimeDeclaration(), classScope(), collectFunctionVarBindings(), declarationProvenance(), functionHandler(), functionScope(), importProvenance() (+9 more)

### Community 95 - "Database Repositories"
Cohesion: 0.29
Nodes (13): throwMemberReadLockDeadlineExceeded(), array(), date(), mapGrant(), mapHold(), mapSeat(), MemberEntitlementReadRepository, nullableDate() (+5 more)

### Community 96 - "Misc"
Cohesion: 0.14
Nodes (16): RELEASE_SHA build-arg and readiness binding, member/staff/worker runtime role grants in CI, Migration, readiness, and graceful drain smoke test, Secret-free runtime log assertion, preserve() secret rendering on config pull, railway config apply, Railway infrastructure as code (.railway/railway.ts), railway config plan (+8 more)

### Community 97 - "API Modules"
Cohesion: 0.17
Nodes (14): AccountSummary, blockedProjection(), composeFoundationDashboard(), foundationProjections, getMemberDashboard(), getMemberDashboardV3(), MemberDashboardActorUnavailableError, MemberDashboardDependencies (+6 more)

### Community 98 - "Web Features"
Cohesion: 0.18
Nodes (10): DashboardContinueCard(), DashboardContinueCardProps, DashboardIllustration(), DashboardRecommendationCard(), DashboardRecommendationCardProps, DashboardRightRail(), DashboardRightRailProps, MemberDashboard() (+2 more)

### Community 99 - "Misc Docs"
Cohesion: 0.12
Nodes (16): Unaccredited completion certificate, Six-stage 18-lesson curriculum, V1 non-goals, Quality and release gates, Manual assistive-technology launch checks, 390px mobile reflow contract, Global reduced-motion guarantee, 11px meaningful and 15px body type floors (+8 more)

### Community 100 - "Integrations Stripe"
Cohesion: 0.12
Nodes (11): STRIPE_API_VERSION, StripeAdapterError, adapterConfig, binding, checkoutResult, common, metadata, oneTimeCommon (+3 more)

### Community 101 - "API Routes"
Cohesion: 0.27
Nodes (11): authenticateMember(), containsStaffCookie(), rawHeaderValues(), unauthenticated(), getMemberDashboardV2(), memberAccessRoutes(), memberDashboardRoutes(), rawHeaderValues() (+3 more)

### Community 102 - "Web App"
Cohesion: 0.20
Nodes (6): metadata, PublicAuthProvider(), PublicSignIn(), PublicSignUp(), inter, manrope

### Community 103 - "Infra Scripts Foundation"
Cohesion: 0.22
Nodes (15): arrayIntrinsicTrusted(), assertionCallInfo(), expectInvocation(), expectMatcherName(), expectMatcherNegated(), expectSubjectCall(), expressionProvenance(), fastCheckMethod() (+7 more)

### Community 104 - "Misc Apps"
Cohesion: 0.14
Nodes (13): compilerOptions, paths, plugins, exclude, extends, include, node_modules, ../../tsconfig.base.json (+5 more)

### Community 105 - "Misc Apps"
Cohesion: 0.14
Nodes (11): assetOutput, assetRoot, authority, codePoints, domainOutput, fontNames, fonts, manifest (+3 more)

### Community 106 - "Operations Docs Foundation"
Cohesion: 0.14
Nodes (14): RELEASE_SHA process requirement, cleanup_staff_auth maintenance function, Five independent service topology, Migration release job, One-shot advisory-locked cron, Pinned foundation toolchain, Release identity and SHA binding, Immutable accountId with row-level security (+6 more)

### Community 107 - "SQL Migration 0001"
Cohesion: 0.21
Nodes (13): "audit_events", "audit_events_account_id_immutable", "jobs", "jobs_account_id_immutable", "member_identities_account_id_immutable", "memberships_account_id_immutable", "outbox_events", "outbox_events_account_id_immutable" (+5 more)

### Community 108 - "Misc"
Cohesion: 0.21
Nodes (13): Missing/malformed config fails closed with fixed tokens, foundation gate job, foundation-ci workflow, npm run gate:foundation step, clean runtime images job, SHA-bound image evidence artifact, Trivy SBOM and HIGH/CRITICAL blocking scans, Private Vercel Blob boundary (+5 more)

### Community 109 - "Misc"
Cohesion: 0.23
Nodes (13): implementation-handshake.json, Migration 0012_implementation, certificates-handshake.json, Frozen 0013_certificates migration tuple, Ruling: syntholo_cleanup_public_bos_intents_v1 stays ungranted until 0016, Commerce Stripe vertical SDD ledger, Preflight interface scan matrix, Two-stage public Business OS pre-account intent (+5 more)

### Community 110 - "Web Lib"
Cohesion: 0.24
Nodes (7): AnalyticsAdapter, allowedKeys, exactOrigin(), getRuntimeEnv(), parseRuntimeEnv(), WebEnvironmentSchema, PostHogAnalyticsAdapter

### Community 111 - "Web Lib"
Cohesion: 0.27
Nodes (9): allowedKeys, exactOrigin(), parseWebApiConfig(), schema, CanonicalHostConfig, canonicalRedirectTarget(), vercelCanonicalRequestUrl(), config (+1 more)

### Community 112 - "Misc Apps"
Cohesion: 0.19
Nodes (8): currentReadiness(), detailFor(), emptyContent, kinds, readinessSummary(), savedReadiness(), summaries, Summary

### Community 113 - "Misc Design"
Cohesion: 0.17
Nodes (13): GNU Unifont 15.0.04 Certificate Fonts, SIL Open Font License 1.1, Business OS Seven-Check Activation Standard, Unaccredited PDF Certificates, Commercial Offers, Refunds and Disputes, Syntholo Product Design Specification, V1 Exclusions, No Public Certificate Verification Surface (+5 more)

### Community 114 - "Docs Plans"
Cohesion: 0.19
Nodes (13): entitlements.reconciliation_required.v1 event, Checkout-before-account claim flow, Offer and entitlement matrix, Operator Club membership, Three-seat customer business model, externalLoginUrl origin validation, redeemClaim account claim flow, evaluateOfferAvailability evaluator (+5 more)

### Community 115 - "Infra Scripts Production"
Cohesion: 0.15
Nodes (10): apiFixture, certificate, certificateRoot, child, key, proxy, publicRoot, runtimeEnvironment (+2 more)

### Community 116 - "SQL Migration 0008"
Cohesion: 0.15
Nodes (9): LATERAL, accounts_normalize_name_write, public.syntholo_account_name_readiness_v1(), drizzle.__drizzle_migrations, pg_class, pg_constraint, pg_proc, pg_trigger (+1 more)

### Community 117 - "Contracts Entitlements"
Cohesion: 0.19
Nodes (11): CAPABILITIES, CapabilitySchema, ExplanationSchema, HOLD_KINDS, HoldKindSchema, isCanonicalSequence(), MemberAccessQuerySchema, MemberAccessResponse (+3 more)

### Community 118 - "Database Commerce"
Cohesion: 0.18
Nodes (6): databaseUrl(), hasTestDatabase, migrationNames, seedReadyAcademyCourse(), sha256(), withDisposableDatabase()

### Community 119 - "Domain Learning"
Cohesion: 0.21
Nodes (8): canonicalRequiredLessonSetHash(), availableAtForReleaseRule(), courseIsComplete(), nextProgressProjection(), ReleaseRule, Resume, ResumePosition, ResumeUpdate

### Community 120 - "Architecture Docs Identity"
Cohesion: 0.18
Nodes (12): Next.js Agent Rules Block, Web App Next.js Agent Rules Block, Web App CLAUDE.md AGENTS.md Import, Root CLAUDE.md AGENTS.md Import, Database Access Boundary, Route-Module Ownership and Composition, Identity and Session Boundary, Same-Origin /v1 Rewrite Facade (+4 more)

### Community 121 - "API Modules"
Cohesion: 0.21
Nodes (8): binding, createSystemLogin(), dropSystemLogin(), formatted(), loginUrl(), now, RuntimeLogin, timestamp

### Community 122 - "Misc Apps"
Cohesion: 0.17
Nodes (11): compilerOptions, types, exclude, extends, include, dist, node, node_modules (+3 more)

### Community 123 - "Web Features"
Cohesion: 0.23
Nodes (6): LessonPage(), LessonWorkspace(), LessonWorkspaceProps, allLessons, Course, Lesson

### Community 124 - "Web Components"
Cohesion: 0.21
Nodes (11): CertificateCard(), completedDate(), failureCopy(), NameIntent, NameStatus, Ready, statusLabel(), Workspace (+3 more)

### Community 125 - "Web Features"
Cohesion: 0.24
Nodes (8): BusinessOsOnboarding(), submit(), capabilities, getProvisioningDueAt(), ProvisioningAction, transitionProvisioning(), SoftwareAccount, SoftwareAccountStatus

### Community 126 - "Worker Handlers"
Cohesion: 0.21
Nodes (9): createMuxReconcileJobHandler(), MuxReconcileRepositoryPort, Snapshot, Target, TerminalTarget, job, JobHandler, MuxAssetManagementPort (+1 more)

### Community 127 - "Misc Apps"
Cohesion: 0.17
Nodes (11): compilerOptions, types, exclude, extends, include, dist, node, node_modules (+3 more)

### Community 128 - "Architecture Docs Http"
Cohesion: 0.18
Nodes (12): createDatabase, Pool Selection Boundary, ADR: Canonical v1 REST Route Contract, Anonymous Principal Cookie, Opaque Cursor Pagination, Idempotency-Key Contract, R5 Recent-Authentication Requirement, Raw Webhook Signature Rules (+4 more)

### Community 129 - "Operations Docs Entitlement"
Cohesion: 0.20
Nodes (12): Atomic applied reconciliation mutations, commerce_reconciliations work queue, linked_academy_refund incident kind, linked_club_cancellation incident kind, parked_paid_receipt incident kind, Immutable provider event fingerprint, provider_source_collision incident kind, WorkOS admin reconciliation authority (+4 more)

### Community 130 - "Contracts Learning"
Cohesion: 0.20
Nodes (12): CanonicalDisplayNameSchema, canonicalizeCertificateRecipientNameInput(), canonicalText(), certificateBusinessNameSnapshotRenderable(), certificateCourseTitleSnapshotRenderable(), certificateFontSupportsScalar(), DisplayNameInputSchema, invalidRecipientScalar() (+4 more)

### Community 131 - "Misc"
Cohesion: 0.18
Nodes (11): certificate_delivery_requests (delivery_pending), certificate-font-repertoire.v1 manifest, certificate_recipient_name_heads and versions, certificate-recipient-name.v1 canonicalization, certificate_records table and closed transitions, Deterministic byte-identical certificate PDF, PUT /v1/member/certificate-recipient-name, snapshotRenderable redaction rule (+3 more)

### Community 132 - "Misc"
Cohesion: 0.22
Nodes (11): Ruling: pin stripe 22.3.2 / API 2026-06-24.dahlia, @syntholo/contracts commerce schemas, @syntholo/domain commerce catalog rules, Test-only deterministic Stripe fake, Stripe integration adapter (@syntholo/integrations), verifyAndNormalizeStripeWebhook, syntholo_commerce_record_provider_event_v1, Raw-body-only webhook route boundary (+3 more)

### Community 133 - "Misc Apps"
Cohesion: 0.18
Nodes (11): scripts, build, dev, lint, start, test, test:e2e, test:e2e:production (+3 more)

### Community 134 - "Web Components"
Cohesion: 0.31
Nodes (10): CertificateWorkspace(), confirmName(), download(), loadMore(), parseName(), refreshName(), runNameIntent(), errorCode() (+2 more)

### Community 135 - "Architecture Docs Member"
Cohesion: 0.18
Nodes (11): Migration 0008_account_name, Migration Renumbering Decision, Identity Production Launch Gates, canonicalizeAccountName, Demo DashboardView Separation, forbiddenAccountNameCodePoint, isCanonicalAccountName, MemberDashboardResponse Contract (+3 more)

### Community 136 - "Architecture Docs Member"
Cohesion: 0.20
Nodes (11): Stable Error Envelope and Status Mapping, Two-Phase Encryption Key Rotation, Staff PKCE Login Attempt Flow, Refresh Lease and Compare-and-Swap Rotation, WorkOS Staff Session and Cookie, acquireMemberReadClient, DatabaseDependencyUnavailableError, MemberReadClientLease (+3 more)

### Community 137 - "Docs Plans"
Cohesion: 0.18
Nodes (11): Content, Learning, and Certificates Plan, Human Operations and Community Plan, Launch, Acquisition, and Hardening Plan, Production Foundation Plan, Plan dependency map, Syntholo Production Program Plan, Launch dependencies owned outside application code, Flow 3 — Human support and artifact review (+3 more)

### Community 138 - "Docs Plans"
Cohesion: 0.20
Nodes (11): Authorization matrix (deny-first), Client bundle and response data-leak check, RouteSecurity descriptor, Clerk/WorkOS issuer separation, verifyMember (Clerk), verifyStaff (WorkOS JWT), Actor union type, MemberActor (+3 more)

### Community 139 - "SQL Migration 0013"
Cohesion: 0.24
Nodes (11): public.certificate_delivery_requests, public.certificate_recipient_name_heads, public.certificate_recipient_name_versions, public.certificate_records, public.syntholo_certificate_enqueue_v1(), public, public.accounts, public.api_command_receipts (+3 more)

### Community 140 - "Database Learning"
Cohesion: 0.20
Nodes (4): ids, materialize(), requiredLessons, setStaffContext()

### Community 141 - "API Auth"
Cohesion: 0.38
Nodes (4): createStoredSession(), MemoryStaffSessions, StaffSessionRecord, WorkosAccessClaims

### Community 142 - "API Modules"
Cohesion: 0.22
Nodes (8): StripeEnvelope, StripeVerification, StripeWebhookRecordPort, envelope, loadModule(), SystemDatabase, StripeEndpointBinding, StripeWebhookSecret

### Community 143 - "API Routes"
Cohesion: 0.22
Nodes (8): actor, content, dependencies(), detail, effectiveAccess(), emptyRoots, saved, ImplementationRepositoryError

### Community 144 - "API Routes"
Cohesion: 0.22
Nodes (7): actor, course, dependencies(), effectiveAccess(), lesson, LearningRepositoryError, MuxPlaybackDependencyUnavailableError

### Community 145 - "Web Features"
Cohesion: 0.27
Nodes (5): calculateProgramCompletion(), targets, ImplementationPlan(), weeks, Artifact

### Community 146 - "Misc Apps"
Cohesion: 0.20
Nodes (7): access, course, dashboard, degradedPlayback, implementationArtifacts, implementationKinds, lesson

### Community 147 - "Database Repositories"
Cohesion: 0.29
Nodes (4): CertificatePrerequisiteRepositoryPort, createCertificatePrerequisiteRecordHandler(), CertificateCandidateInputError, LearningPrerequisiteInputError

### Community 148 - "Architecture Docs Database"
Cohesion: 0.22
Nodes (10): Append-Only Audit Enforcement, attestSystemDatabase, Five PostgreSQL Capability Roles, createSystemUnitOfWork, Migration 0004 Durable Jobs and Outbox, syntholo_migrator Capability Role, syntholo_staff_api Capability Role, syntholo_system_api Capability Role (+2 more)

### Community 149 - "Operations Docs Foundation"
Cohesion: 0.22
Nodes (10): APP_MODE=demo deterministic mode, Fixed same-origin /v1/** proxy, Deployed same-origin proxy evidence, syntholo.foundation-gate.v1 engineering gate, Unrelated-histories main merge plan, Bounded vulnerability exception policy, Task 9: verification and handoff, gate:business-os evidence gate (+2 more)

### Community 150 - "Misc Packages"
Cohesion: 0.20
Nodes (9): exclude, extends, include, node_modules, src/**/*.ts, ../../tsconfig.base.json, vitest.config.ts, drizzle.config.ts (+1 more)

### Community 151 - "API Modules"
Cohesion: 0.33
Nodes (7): apiDependencies(), createMemberLogin(), dropMemberLogin(), formatted(), loginUrl(), RuntimeLogin, staffDependencies()

### Community 152 - "Web Components"
Cohesion: 0.28
Nodes (5): LearnLayout(), MemberShellProps, navGroups, links, ProductionMemberShell()

### Community 153 - "Web Components"
Cohesion: 0.22
Nodes (5): emptyReadiness, kinds, list, summaries, useAuth

### Community 154 - "Misc Design"
Cohesion: 0.25
Nodes (9): Accessibility and CSS-Only Motion Rules, Four-Surface Experience Architecture, Guided Command Center, Human Support Model, Semantic Action Color Tokens, Trusted Growth Visual System, External Support-State Union, Next-Best-Step Composer (+1 more)

### Community 155 - "Architecture Docs Database"
Cohesion: 0.25
Nodes (9): AccountRepository.getById, createUnitOfWork, Member Effective-Access Reader Lock Protocol, member_actor_for_clerk_user, syntholo_member_api Capability Role, withAccountScope and DatabaseTransaction Internals, expectedVersion Optimistic Concurrency, getMemberDashboard (+1 more)

### Community 156 - "Docs Plans"
Cohesion: 0.25
Nodes (9): Readiness Scorecard assessment, Ink-variant contrast treatment, Task 1: application foundation and design system, Task 3: public marketing and scorecard, Trusted Growth color palette, Semantic ButtonVariant set, Semantic color meaning system, Ordered CSS style layers (+1 more)

### Community 157 - "Database Member"
Cohesion: 0.22
Nodes (5): MemberReadDeadlineExceeded, MemberReadLockDeadlineExceeded, MemberReadParentDeadlineExceeded, MemberReadPoolAcquireDeadlineExceeded, MemberReadQueryDeadlineExceeded

### Community 158 - "API Routes"
Cohesion: 0.32
Nodes (7): access(), actor, dashboardCourse, dependencies(), now, MemberDashboardV2ResponseSchema, MemberDashboardV3ResponseSchema

### Community 159 - "Misc Apps"
Cohesion: 0.39
Nodes (5): api, nextConfig, releaseSha, parseWebBuildIdentity(), resolveWebDeploymentId()

### Community 160 - "Web Features"
Cohesion: 0.32
Nodes (7): nextStatus(), statusLabels, statusOrder, WorkflowBoard(), advance(), WorkflowRecord, WorkflowStatus

### Community 161 - "Operations Docs Foundation"
Cohesion: 0.29
Nodes (8): HighLevel external isolation boundary, APP_MODE=production configuration mode, Web service environment allowlist, API readiness journal projection, app.syntholo.com canonical origin, Ordered release and health sequence, Capability-first rollback procedure, readinessHealth dependency check

### Community 162 - "Docs Plans"
Cohesion: 0.36
Nodes (8): Business OS HighLevel offer, Business OS seven activation checks, Task 7: Business OS and administration, Monitoring automation trigger thresholds, Monthly Business OS verification, evaluateActivation seven-check gate, Business OS state machine, Business OS zero-grant setup receipt

### Community 163 - "Docs Plans"
Cohesion: 0.32
Nodes (8): Central entitlement authority, Next best step precedence, canAccess entitlement check, Deterministic demo repository, getNextAction precedence function, Task 2: domain model and demo repository, Task 4: member shell and course workspace, Uxcel-inspired member dashboard hierarchy

### Community 164 - "SQL Migration 0005"
Cohesion: 0.25
Nodes (8): pg_auth_members, pg_class, pg_database, pg_db_role_setting, pg_namespace, pg_proc, pg_roles, syntholo_attest_runtime_capability()

### Community 165 - "SQL Migration 0013"
Cohesion: 0.25
Nodes (8): public.syntholo_attest_runtime_capability(), pg_auth_members, pg_class, pg_database, pg_db_role_setting, pg_namespace, pg_proc, pg_roles

### Community 166 - "SQL Migration 0014"
Cohesion: 0.25
Nodes (8): public.syntholo_attest_runtime_capability(), pg_auth_members, pg_class, pg_database, pg_db_role_setting, pg_namespace, pg_proc, pg_roles

### Community 167 - "Misc"
Cohesion: 0.29
Nodes (7): implementationCompletionIsAuthority = false, Private personal completion certificate contract, Migration 0013_certificates contract, Pending real private Blob provider gate, Task 8 delivered certificate flow, Certificates immune to commerce and entitlement state, BLOCKED versus FAILED evidence policy

### Community 168 - "Misc"
Cohesion: 0.29
Nodes (7): Dashboard v3 API-first promotion, Account-shared implementation workspace, PostgreSQL JSONB as structured editable authority, Three-workflow portfolio and shared completion rule, Ruling: signed paid event is sole money authority, Signed-paid flow convergence proof, syntholo_commerce_redeem_claim_v1

### Community 169 - "Web Components"
Cohesion: 0.29
Nodes (4): dashboard, dashboardV2, dashboardV3, useAuth

### Community 170 - "Web Features"
Cohesion: 0.33
Nodes (5): CommunityFeed(), CurrentMember, relativeDay(), spaces, CommunityPost

### Community 171 - "Web Features"
Cohesion: 0.38
Nodes (4): formatMessageDate(), monthNames, SupportInbox(), SupportThread

### Community 172 - "Testing Gate"
Cohesion: 0.33
Nodes (6): FOUNDATION_CHECK_CATALOG, execFileAsync, GateResult, gateScript, repositoryRoot, runGate()

### Community 173 - "Misc Packages"
Cohesion: 0.29
Nodes (6): exclude, extends, include, node_modules, src/**/*.ts, ../../tsconfig.base.json

### Community 174 - "SQL Migration 0007"
Cohesion: 0.29
Nodes (6): public.syntholo_runtime_readiness(), drizzle.__drizzle_migrations, pg_class, pg_proc, pg_roles, readiness_owner

### Community 175 - "Misc Packages"
Cohesion: 0.29
Nodes (6): exclude, extends, include, node_modules, src/**/*.ts, ../../tsconfig.base.json

### Community 176 - "Misc Packages"
Cohesion: 0.29
Nodes (6): exclude, extends, include, node_modules, src/**/*.ts, ../../tsconfig.base.json

### Community 177 - "Misc Packages"
Cohesion: 0.29
Nodes (6): exclude, extends, include, node_modules, src/**/*.ts, ../../tsconfig.base.json

### Community 178 - "Web Components"
Cohesion: 0.33
Nodes (3): ProductionCertificateSettings(), issued, useAuth

### Community 179 - "Misc Apps"
Cohesion: 0.33
Nodes (3): awaiting, issued, pending

### Community 180 - "Docs Plans"
Cohesion: 0.33
Nodes (6): BusinessCalendar, calculateSla, canJoin 15-minute join window, evaluateSlaJob, pilotOccurrences recurrence, Substantive coach response definition

### Community 181 - "Docs Plans"
Cohesion: 0.33
Nodes (6): reminderKey idempotency, Append-only audit and outbox, claimJobs (FOR UPDATE SKIP LOCKED), nextAttempt backoff, provider_event_receipts table, runWorker

### Community 182 - "Docs Plans"
Cohesion: 0.33
Nodes (6): checkProductionImports, Demo path removal from production surfaces, getAdminOverview, getMemberDashboard, DashboardContinueCard, Member dashboard hierarchy

### Community 183 - "Docs Plans"
Cohesion: 0.33
Nodes (6): Canonical web origin app.syntholo.com, Clerk DNS mode migration, No backend credential in Vercel, Relative /v1 Vercel-to-Railway rewrite, API as sole business-write authority, Four surfaces and identity boundaries

### Community 184 - "Infra Scripts Inspect"
Cohesion: 0.33
Nodes (5): validateImageMetadata(), execFileAsync, [image, service, releaseSha, outputPath], metadata, result

### Community 185 - "Contracts Implementation"
Cohesion: 0.33
Nodes (6): ArtifactDetailResponseSchema, finalContentComplete(), nonblank(), SaveArtifactVersionRequestSchema, SaveArtifactVersionResponseSchema, WorkflowContentSchema

### Community 186 - "SQL Migration 0005"
Cohesion: 0.33
Nodes (6): account_hold_sources_identity_immutable, account_holds_identity_immutable, entitlement_grants_identity_immutable, entitlement_sources_identity_immutable, seat_reservations_identity_immutable, syntholo_prevent_identity_update()

### Community 187 - "Database Drizzle"
Cohesion: 0.40
Nodes (5): execFileAsync, exportedSql(), exportEnvironment, packageRoot, repositoryRoot

### Community 188 - "Misc"
Cohesion: 0.40
Nodes (5): GET /v1/member/certificates/:certificateId/download, certificate_files deterministic private object, storage_failed recovery pump and retry authorization, Ruling: signature validity separate from signed context evaluation, Signed context/object mismatch is terminal evidence returning 200

### Community 189 - "Misc Apps"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 191 - "Web Components"
Cohesion: 0.40
Nodes (5): blankWorkflow(), invalidField(), Lines(), TextField(), WorkflowEditor()

### Community 192 - "Web Components"
Cohesion: 0.40
Nodes (3): memberAccess, memberActor, useAuth

### Community 194 - "Docs Plans"
Cohesion: 0.40
Nodes (5): Reconciliation PII redaction rule, AnalyticsEventSchema allowlist registry, scrubSentryEvent recursive redaction, Attribution and marketing consent capture, Guided Pilot application review

### Community 195 - "Docs Plans"
Cohesion: 0.40
Nodes (5): recordSupportEffort, captureAttribution first/last touch, Marketing consent separate from transactional fulfillment, NATIVE_FUNNEL_ROUTES, Acquisition and product analytics targets

### Community 196 - "Infra Scripts Emit"
Cohesion: 0.40
Nodes (4): evidenceFiles, hash, releaseSha, FOUNDATION_EVIDENCE_SCHEMA

### Community 197 - "SQL Migration 0011"
Cohesion: 0.40
Nodes (5): public.account_course_accesses, public.enrollment_version_transitions, public, public.accounts, public.courses

### Community 198 - "SQL Migration 0014"
Cohesion: 0.50
Nodes (5): public.account_onboarding, public.account_onboarding_priorities, public.syntholo_commerce_stage_checkout_action_v1(), public.syntholo_record_public_business_os_setup_reconciliation(), public.enrollments

### Community 199 - "SQL Migration 0014"
Cohesion: 0.50
Nodes (5): public.checkout_authorizations, public.checkout_provider_actions, public.checkout_sessions, public.controlled_payment_authorizations, "public"."staff_identities"

### Community 200 - "Database Schema"
Cohesion: 0.40
Nodes (4): certificatesMigrationUrl, fixtureUrl, implementationMigrationUrl, learningMigrationUrl

### Community 201 - "Database Vitest"
Cohesion: 0.50
Nodes (4): execFileAsync, listedFiles(), packageRoot, repositoryRoot

### Community 203 - "Docs Plans"
Cohesion: 0.67
Nodes (4): expectedVersion optimistic concurrency, saveArtifactVersion, one_active_review_per_account partial unique index, transitionReview state machine

### Community 204 - "Docs Plans"
Cohesion: 0.50
Nodes (4): evaluateZoomAutomationTrigger, Manual Zoom link policy in v1, Native scheduling with manual Zoom links, V1 exclusions

### Community 205 - "Infra Scripts Assert"
Cohesion: 0.50
Nodes (3): forbiddenValues, logPaths, requiredServices

### Community 208 - "SQL Migration 0006"
Cohesion: 0.50
Nodes (3): public.syntholo_runtime_readiness(), drizzle.__drizzle_migrations, pg_roles

### Community 209 - "SQL Migration 0012"
Cohesion: 0.50
Nodes (4): public.implementation_artifacts, public, public.accounts, public.courses

### Community 212 - "Docs Plans"
Cohesion: 0.67
Nodes (3): 18-lesson Academy payment gate, Gate 3 — Complete curriculum, Admin content system and lesson launch gate

### Community 213 - "Docs Plans"
Cohesion: 0.67
Nodes (3): DeploymentEnvironmentSchema, Staging/production environment isolation, Vendor and deployment topology

### Community 214 - "Docs Plans"
Cohesion: 0.67
Nodes (3): staff_sessions encrypted session store, workosCallback, WorkOS redirect URI update

### Community 215 - "Docs Plans"
Cohesion: 0.67
Nodes (3): Canonical monorepo repository map, Release branch and environment strategy, Immutable RELEASE_SHA binding

### Community 216 - "SQL Migration 0011"
Cohesion: 0.67
Nodes (3): public.syntholo_learning_get_lesson_v1(), public.lesson_drafts, public.content_resource_drafts

### Community 217 - "SQL Migration 0014"
Cohesion: 0.67
Nodes (3): provider_event_receipts_stripe_immutable, provider_event_receipts_truncate_denied, public.syntholo_provider_event_receipts_stripe_immutable_v1

## Ambiguous Edges - Review These
- `Railway infrastructure as code (.railway/railway.ts)` → `app.syntholo.com production domain cutover`  [AMBIGUOUS]
  .superpowers/sdd/2026-08-13-production-foundation/task-9-report.md · relation: conceptually_related_to
- `certificate-font-repertoire.v1 manifest` → `Required-contract test validator`  [AMBIGUOUS]
  .superpowers/sdd/2026-08-13-production-foundation/task-9-report.md · relation: semantically_similar_to
- `Web App Next.js Agent Rules Block` → `Account-Scoped Member Dashboard Slice`  [AMBIGUOUS]
  docs/architecture/member-dashboard.md · relation: conceptually_related_to
- `Monorepo vendor architecture` → `Task 8: production integration contracts`  [AMBIGUOUS]
  docs/superpowers/plans/2026-08-11-syntholo-platform.md · relation: conceptually_related_to
- `scanAttachment (ClamAV quarantine)` → `Disposable test PostgreSQL service`  [AMBIGUOUS]
  docs/superpowers/plans/2026-08-13-human-operations-community.md · relation: conceptually_related_to

## Knowledge Gaps
- **1139 isolated node(s):** `name`, `version`, `private`, `type`, `./config` (+1134 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **43 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Railway infrastructure as code (.railway/railway.ts)` and `app.syntholo.com production domain cutover`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `certificate-font-repertoire.v1 manifest` and `Required-contract test validator`?**
  _Edge tagged AMBIGUOUS (relation: semantically_similar_to) - confidence is low._
- **What is the exact relationship between `Web App Next.js Agent Rules Block` and `Account-Scoped Member Dashboard Slice`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Monorepo vendor architecture` and `Task 8: production integration contracts`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `scanAttachment (ClamAV quarantine)` and `Disposable test PostgreSQL service`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `MemberAccessResponseSchema` connect `Contracts Entitlements` to `API Modules`, `Contracts Member`, `API App Composition`, `API Routes`, `Member Learn Surfaces`, `API Routing & Errors`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Why does `Database` connect `Database Repositories` to `Database Learning`, `Database Schema Index`, `Member Read Deadlines`, `Audit & Outbox Mutation`, `Certificate Worker Repository`, `API Modules`, `Certificates Integration Tests`, `Job Payload Policy`, `Database Client & Roles`, `Learning Progress Contracts`, `Certificate Contracts`, `Worker Config & Cron`, `Mux Webhook Ingestion`, `Implementation Integration Tests`, `Entitlements Integration Tests`, `Database Repositories`, `Database Migrations`, `Database Repositories`, `Database Repositories`, `Database Repositories`, `Database Rls`, `Database Repositories`, `Database Commerce`, `API Modules`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._