import { currentAcademyLaunchReadiness, formatContentGateReport } from "./index";

const { report, readiness } = currentAcademyLaunchReadiness();
process.stdout.write(`${formatContentGateReport(readiness, report.issues)}\n`);
process.exit(readiness.canSellAcademy ? 0 : 2);
