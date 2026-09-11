export const PERMISSION_FLAGS = [
  'canViewDashboard',
  'canManageRigs',
  'canManageEquipment',
  'canUploadMechanicalLogs',
  'canManageHolidays',
  'canManageHealthcheckup',
  'canManageTransfers',
  'canManageReports',
  'canViewAuditLogs',
  'canManageUserRights',
] as const;

export type PermissionFlag = (typeof PERMISSION_FLAGS)[number];
export type Rights = Record<PermissionFlag, boolean>;

/** Plain-English labels for the rights matrix (spec 5.2). */
export const PERMISSION_LABELS: Record<PermissionFlag, string> = {
  canViewDashboard: 'View the PMS Dashboard',
  canManageRigs: 'Create, edit and delete rigs',
  canManageEquipment: 'Create, edit and delete equipment',
  canUploadMechanicalLogs: 'Upload and delete mechanical log workbooks',
  canManageHolidays: 'Define rig holidays and non-reporting days',
  canManageHealthcheckup: 'Log health checkups',
  canManageTransfers: 'Create and approve material transfers',
  canManageReports: 'Generate and export reports',
  canViewAuditLogs: 'Access the Audit Registers',
  canManageUserRights: 'Create users and modify permissions',
};

export const ROLES = [
  'Admin', 'Operational Manager', 'Storekeeper', 'PMS User', 'Rig Supervisor', 'Field Manager', 'Auditor',
] as const;
export type Role = (typeof ROLES)[number];

/**
 * The application modules sharing one login, plus FOLLOWUP/INVOICE/ADMIN —
 * added purely so Admin > User Rights' page-permission matrix can govern the
 * Follow-up module, the Invoice module and the Admin Panel's own screens the
 * same way it governs PMS/DPR/ILM/DRR. FOLLOWUP/INVOICE/ADMIN are never
 * offered on the module-select landing page (ModuleSelect.tsx keeps its own
 * literal ['PMS','DPR','ILM','DRR'] list) — they exist purely as permission
 * buckets. PMS's own real permissions still live primarily in `Rights` above;
 * this module's PMS entry mainly carries the access switch, and PMS's pages
 * in MODULE_PAGES fall back to those same flags as their default until an
 * Admin sets an explicit per-page override.
 */
export const MODULE_CODES = ['PMS', 'DPR', 'ILM', 'DRR', 'FOLLOWUP', 'INVOICE', 'ADMIN'] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];

export const MODULE_LABELS: Record<ModuleCode, string> = {
  PMS: 'PMS Portal',
  DPR: 'DPR Module',
  ILM: 'ILM Module',
  DRR: 'Daily Rig Report',
  FOLLOWUP: 'Follow-up',
  INVOICE: 'Invoice',
  ADMIN: 'Admin Panel',
};

export interface ModulePermission {
  access: boolean;
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export type ModuleAccess = Record<ModuleCode, ModulePermission>;
export type ModuleAction = 'view' | 'create' | 'edit' | 'delete';

/**
 * Admin > User Rights' page-level matrix — Module -> Page -> {view, create,
 * edit, delete}. Mirrors server/src/services/pagePermissions.ts's MODULE_PAGES
 * registry exactly; keep the two in sync when a page is added or renamed.
 */
export interface PagePermission { view: boolean; create: boolean; edit: boolean; delete: boolean }
export type PageAction = 'view' | 'create' | 'edit' | 'delete';
export interface PageDef { key: string; label: string }
export type PagePermissionsByModule = Partial<Record<ModuleCode, Record<string, Partial<PagePermission>>>>;

export const MODULE_PAGES: Record<ModuleCode, PageDef[]> = {
  PMS: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'equipment', label: 'Equipment Directory' },
    { key: 'healthcheckup', label: 'Health Checkup' },
    { key: 'service', label: 'Service History' },
    { key: 'reports', label: 'Reports' },
    { key: 'rig_master', label: 'Rig Master' },
  ],
  DPR: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'progress_report', label: 'Progress Report' },
    { key: 'hsd_report', label: 'HSD Report' },
    { key: 'import', label: 'Excel Import' },
  ],
  ILM: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'ilm_add', label: 'ILM Add' },
    { key: 'trailer_dashboard', label: 'Trailer Dashboard' },
    { key: 'crane_dashboard', label: 'Crane Dashboard' },
    { key: 'import', label: 'Excel Import' },
  ],
  DRR: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'new_report', label: 'New Daily Report' },
    { key: 'reports', label: 'All Reports' },
  ],
  FOLLOWUP: [
    { key: 'dashboard', label: 'Follow-up Dashboard' },
    { key: 'new', label: 'New Follow-up' },
    { key: 'history', label: 'Follow-up History' },
  ],
  INVOICE: [
    { key: 'dashboard', label: 'Invoice Dashboard' },
    { key: 'create', label: 'Create Invoice' },
    { key: 'history', label: 'Invoice History' },
    { key: 'settings', label: 'Invoice Settings' },
  ],
  ADMIN: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'users', label: 'Users' },
    { key: 'user_rights', label: 'User Rights' },
    { key: 'rig_master', label: 'Rig Master' },
    { key: 'equipment_master', label: 'Equipment Master' },
    { key: 'material_master', label: 'Material Master' },
    { key: 'oil_lubricant_master', label: 'Oil & Lubricant Master' },
    { key: 'transfer_equipment', label: 'Transfer Equipment' },
    { key: 'modules', label: 'Modules' },
    { key: 'notification_settings', label: 'Notification Settings' },
    { key: 'smtp_settings', label: 'SMTP Configuration' },
    { key: 'logs', label: 'Logs' },
    { key: 'reports', label: 'Reports' },
  ],
};

export interface User {
  id: string;
  username: string;
  name: string;
  email: string | null;
  role: Role;
  rigId: string | null;
  /** Multi-rig assignment ("Assigned Rigs") — drives PMS/DPR/ILM visibility and, for Storekeeper/Operational Manager, DRR approval routing. `rigId` above is only the legacy single-rig fallback. */
  rigIds: string[];
  departmentId: string | null;
  departmentName?: string | null;
  departmentModule?: ModuleCode | null;
  status: string;
  rights: Rights;
  moduleAccess: ModuleAccess;
  pagePermissions: PagePermissionsByModule;
}

/** Module -> Department -> User -> (future) rig-wise rights. */
export interface Department {
  id: string;
  moduleCode: ModuleCode;
  name: string;
  status: string;
  createdAt: string;
}

export interface Rig {
  id: string;
  name: string;
  rigNumber: string;
  companyId: string | null;
  companyName?: string | null;
  location: string | null;
  rigType: string | null;
  status: string;
  commissionDate: string | null;
  /** "Client": ONGC | OIL | free text. */
  client: string | null;
  startDate: string | null;
  /** Nullable — blank while the project is ongoing. */
  completionDate: string | null;
  /** "Remarks": 'On Going Project' | 'Rig Under Commissioning' | 'Project will start further'. */
  remarksStatus: string | null;
  projectCoordinator: string | null;
  equipmentCount?: number;
  uploadCount?: number;
  lastReportedDate?: string | null;
}

export type EquipmentStatus = 'Normal' | 'Upcoming' | 'Overdue' | 'Breakdown';

export interface Equipment {
  id: string;
  rigId: string;
  rigName: string;
  rigNumber: string;
  name: string;
  category: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  assetNumber: string | null;
  engineNumber: string | null;
  installationDate: string | null;
  section: string;
  currentRunningHours: number;
  lastServiceHours: number;
  serviceInterval: number;
  runningSinceLastService: number;
  remainingServiceHours: number;
  lastHealthCheckDate: string | null;
  healthCheckInterval: number;
  remainingHealthCheckDays: number | null;
  healthStatus: 'Normal' | 'Upcoming' | 'Overdue';
  isBreakdown: boolean;
  isActive: boolean;
  status: EquipmentStatus;
  lastReportedDate: string | null;
  currentPlace: string | null;
  currentPlaceSince: string | null;
  ecmPresent: boolean | null;
  etToolApplicable: boolean | null;
  linkedEngineId: string | null;
  linkedTransmissionId: string | null;
}

/** Engine Master / Transmission Master: a live, editable roster of the engines/transmissions fitted to each rig. Same shape backs both lists. */
export interface MaterialMasterRecord {
  id: string;
  materialType: 'Engine' | 'Transmission';
  name: string;
  make: string | null;
  model: string | null;
  serialNumber: string | null;
  status: 'Active' | 'Inactive';
  source: 'Manual' | 'Excel';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** What to display: derivedLocation when in use, else manualLocation. Null = "Not Assigned". */
  location: string | null;
  /** Current rig, derived server-side from Material -> Equipment -> Rig. Read-only, never stored. */
  derivedLocation: string | null;
  /** Admin-entered fallback, editable only while derivedLocation is null. */
  manualLocation: string | null;
}

/** Admin > Master > Equipment Master > Import Correct Master Data (services/rigMasterDataImport.ts). */
export interface MasterImportPreviewGroup {
  rigNameRaw: string;
  matchedRigId: string | null;
  matchedRigNumber: string | null;
  matchedRigName: string | null;
  equipmentCount: number;
  equipment: { equipmentName: string; make: string | null; model: string | null; serialNumber: string | null; oilName: string | null }[];
  issues: string[];
}
export interface MasterImportPreview {
  totalRows: number;
  matchedRigs: number;
  unmatchedRigs: number;
  groups: MasterImportPreviewGroup[];
}
export interface MasterImportResult {
  rigsMatched: number;
  rigsUnmatched: number;
  unmatchedRigNames: string[];
  equipmentCreated: number;
  equipmentUpdated: number;
  equipmentDeactivated: number;
  oilLubricantsCreated: number;
  oilLubricantsRemoved: number;
  oilMappingsRemoved: number;
  materialsCreated: number;
  materialsUpdated: number;
  materialsRemoved: number;
  materialsRelinked: number;
  /** Equipment pointed at their Material Master record — what Location derives through. */
  equipmentLinked: number;
}
export interface MasterImportHistoryRow {
  id: string; fileName: string; importedBy: string; importedAt: string;
  rigsMatched: number; rigsUnmatched: number;
  equipmentCreated: number; equipmentUpdated: number; equipmentDeactivated: number;
  oilLubricantsCreated: number; oilLubricantsRemoved: number; oilMappingsRemoved: number;
  materialsCreated: number; materialsUpdated: number; materialsRemoved: number; materialsRelinked: number;
  unmatchedRigNames: string[];
}

/** A simple named reference list (e.g. "Engine Oil 15W40"), shared by every module. */
export interface OilLubricant {
  id: string;
  name: string;
  /** Legacy free text, superseded by `usage` — the form now picks real equipment. */
  equipmentName: string | null;
  status: string;
  createdAt: string;
  /** Which equipment uses this oil and the rig each is currently on — derived live, never stored. */
  usage?: OilUsage[];
}

/** One equipment assignment of an oil, with the rig that equipment is on right now. */
export interface OilUsage {
  mappingId: string;
  equipmentId: string;
  equipmentName: string;
  rigId: string;
  rigName: string;
}

/** One Rig -> Equipment -> Oil/Lubricant assignment: an oil from the global Oil & Lubricant Master mapped to a specific equipment row. */
export interface EquipmentOilMapping {
  id: string;
  equipmentId: string;
  oilLubricantId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface EquipmentTransfer {
  id: string;
  equipmentId: string;
  equipmentName?: string;
  fromRigId: string | null;
  fromRigNumber?: string | null;
  fromRigName?: string | null;
  fromPlace: string | null;
  toRigId: string | null;
  toRigNumber?: string | null;
  toRigName?: string | null;
  toPlace: string | null;
  /** Which picker the admin used — 'Rig' | 'Yard' | 'Other'. Null on rows recorded before this existed. */
  destinationType?: string | null;
  transferType: 'Permanent' | 'Temporary';
  expectedReturnDate: string | null;
  date: string;
  remarks: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Only present on the fleet-wide Transfer List (GET /equipment-transfers/list) — 'Current' = this machine's present location. */
  status?: 'Current' | 'Historical';
}

export interface Upload {
  id: string;
  rigId: string;
  rigName: string;
  rigNumber: string;
  fileName: string;
  uploadDate: string;
  logMonth: string;
  coverageStartDate: string | null;
  coverageEndDate: string | null;
  uploadedBy: string;
  status: string;
  recordsImported: number;
  validationErrorsCount: number;
  storedFileName: string | null;
}

/**
 * An engineering health check-up narrative: a free-form log entry per engine
 * or transmission, not the simple per-machine Normal/Breakdown reading that
 * Equipment/Healthcheckup already track. See server/src/excel/parseHealthNarrative.ts.
 */
export interface HealthNarrative {
  id: string;
  uploadId: string;
  equipmentId: string | null;
  sourceSheet: string;
  category: string;
  rigId: string | null;
  rigText: string | null;
  rigNumber?: string | null;
  rigName?: string | null;
  place: string | null;
  application: string | null;
  make: string | null;
  details: string | null;
  serialNumber: string | null;
  previousDate: string | null;
  previousDateRaw: string | null;
  lastDate: string | null;
  lastDateRaw: string | null;
  problem: string | null;
  action: string | null;
  outcomeNotes: string | null;
  createdAt: string;
}

export interface HealthNarrativePreview {
  planId: string;
  fileName: string;
  sheetsFound: string[];
  totalRows: number;
  matchedToRig: number;
  matchedToEquipment: number;
  toCreateEquipment: number;
  withPlace: number;
  issues: { level: 'warning'; message: string }[];
  rows: HealthNarrative[];
}

export interface Gate {
  kind: 'rigMismatch' | 'lastFilledDay' | 'duplicateUpload';
  message: string;
  details: Record<string, unknown>;
  supersedesUploadId?: string;
}

export interface PreviewRow {
  groupKey: string;
  machine: string;
  serial: string | null;
  section: string;
  isNew: boolean;
  matchedBy: string;
  sheetDay: number;
  logDate: string;
  isInUse: string | null;
  hoursRunDay: number | null;
  hoursRunNight: number | null;
  lubeOilPressure: string | null;
  lubeOilAdded: number | null;
  openingRunningHours: number | null;
  totalRunHours: number | null;
  closingHours: number | null;
  lastServiceHours: number | null;
  runningHoursAfterLastService: number | null;
  defineHours: number | null;
  hoursRemainingForNextService: number | null;
  preventiveMaintenanceDetails: string | null;
  remarks: string | null;
  lastServiceDate: string | null;
  makeModel: string | null;
}

export interface Preview {
  planId: string;
  fileName: string;
  rig: { id: string; name: string; rigNumber: string } | null;
  rigResolvedFrom: 'workbook' | 'user' | 'unresolved';
  rigNumberInFile: string | null;
  logMonth: string | null;
  lastFilledDay: number | null;
  lastFilledDate: string | null;
  availableDays: number[];
  lastFilledDayOverride: number | null;
  totals: { machines: number; newMachines: number; rows: number; days: number[] };
  gates: Gate[];
  issues: { level: 'fatal' | 'warning'; message: string; machine?: string; sheet?: string }[];
  machines: {
    groupKey: string;
    name: string; serial: string | null; makeModel: string | null; section: string;
    isNew: boolean; matchedBy: string; dayCount: number;
    update: { currentRunningHours: number | null; lastServiceHours: number | null;
              serviceInterval: number | null; latestDay: number; latestDate: string } | null;
  }[];
  days: { day: number; rows: PreviewRow[] }[];
}

export interface RigCompliance {
  rigId: string;
  rigName: string;
  rigNumber: string;
  lastDataDate: string | null;
  lastUploadAt: string | null;
  status: 'Uploaded' | 'Pending' | 'Exempt';
  holidayDescription: string | null;
}

export type NotificationType =
  | 'RIG_SHEET_PENDING' | 'EQUIPMENT_HEALTH_CHECKUP_PENDING'
  | 'DRR_PENDING_APPROVAL' | 'DRR_APPROVAL_ESCALATION' | 'DRR_APPROVED' | 'DRR_REJECTED'
  | 'SERVICE_DUE_SOON' | 'SERVICE_OVERDUE' | 'SERVICE_OVERDUE_ESCALATION'
  | 'HEALTH_CHECK_DUE_SOON' | 'HEALTH_CHECK_OVERDUE_ESCALATION'
  | string;

export interface Notification {
  id: string;
  type: NotificationType;
  title: string | null;
  message: string;
  userId: string | null;
  equipmentId: string | null;
  rigId: string | null;
  /** Generic reference beyond equipmentId/rigId — a DRR report id for DRR_* types, so the bell can deep-link to the exact report. */
  entityId: string | null;
  referenceDate: string | null;
  severity: 'info' | 'warning' | 'critical' | string;
  isRead: number;
  resolvedAt: string | null;
  createdAt: string | null;
  readAt: string | null;
}

export interface NotificationSettings {
  type: string;
  enabled: boolean;
  warningThreshold: number | null;
  criticalThreshold: number | null;
  escalationHours: number | null;
  reminderHours: number | null;
  inApp: boolean;
  email: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface DashboardData {
  asOf: string;
  complianceDate: string;
  kpis: {
    totalRigs: number; totalEquipment: number; overdueServices: number;
    upcomingServices: number; overdueHealthChecks: number; upcomingHealthChecks: number;
    pendingYesterdayUploads: number; uploadsToday: number;
    totalEngines: number; totalTransmissions: number;
  };
  compliance: RigCompliance[];
  byStatus: Record<string, number>;
  byCategory: { category: string; count: number }[];
  trend: { date: string; hours: number; rowCount: number }[];
  attention: Equipment[];
  healthAttention: Equipment[];
}

/** GET /dashboard/uploads-today — "Uploads Today" card's click-through: every Excel workbook upload AND DRR submission for today, same rig scope as the dashboard itself. */
export interface TodaysExcelUpload {
  id: string; fileName: string; rigId: string; rigNumber: string; rigName: string;
  logMonth: string; coverageEndDate: string | null; uploadDate: string; uploadedBy: string;
  recordsImported: number; storedFileName: string | null;
}

export interface TodaysDrrSubmission {
  id: string; rigId: string; rigNumber: string; rigName: string;
  reportDate: string; shift: string; status: string; submittedBy: string; updatedAt: string;
}

export interface TodaysUploadsResponse {
  date: string;
  excelUploads: TodaysExcelUpload[];
  drrSubmissions: TodaysDrrSubmission[];
}

/* ------------------------------------------------------------------ */
/* DPR (Daily Progress Report) module                                  */
/* ------------------------------------------------------------------ */

export interface DprLineItem {
  id?: string;
  lineNo: number;
  wellName: string | null;
  operationCode: string | null;
  workType: string | null;
  startTime: string | null;
  endTime: string | null;
  totalHours: number | null;
  description: string | null;
  breakdownEquipment: string | null;
  breakdownEquipmentId?: string | null;
  breakdownReason: string | null;
  drillingSection: string | null;
  drillingFrom: number | null;
  drillingTo: number | null;
  drillingTotal: number | null;
  casingSection: string | null;
  casingFrom: number | null;
  casingTo: number | null;
  /** Manual entry only, shown/editable only when operationCode = '23 - Other' (max 35 words). */
  otherActivityDescription?: string | null;
  casingTotal: number | null;
}

export interface DprReportSummary {
  id: string;
  rigId: string;
  rigNumber: string;
  rigName: string;
  dprDate: string;
  source: 'excel' | 'manual';
  importBatchId: string | null;
  /** Name of the Excel file this DPR came from; null for manual entries. */
  fileName: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  totalHours: number;
  lineCount: number;
}

export interface DprReport extends DprReportSummary {
  lines: DprLineItem[];
}

export interface DprIssue {
  level: 'fatal' | 'warning';
  day?: number;
  row?: number;
  message: string;
}

export interface DprImportBatch {
  id: string;
  fileName: string;
  storedFileName: string | null;
  rigId: string;
  rigNumber: string;
  rigName: string;
  uploadedBy: string;
  uploadedAt: string;
  status: 'Successful' | 'PartiallyFailed' | 'Failed';
  recordCount: number;
  errorCount: number;
  errorDetail: DprIssue[] | null;
}

/**
 * HSD (diesel consumption) is the DPR module's second import stream. Its
 * batches carry the same shape as DPR's — including DprIssue for validation
 * failures, which the HSD parser reuses — but come from their own tables.
 */
export interface HsdImportBatch {
  id: string;
  fileName: string;
  storedFileName: string | null;
  rigId: string;
  rigNumber: string;
  rigName: string;
  uploadedBy: string;
  uploadedAt: string;
  status: 'Successful' | 'Failed';
  recordCount: number;
  errorCount: number;
  errorDetail: DprIssue[] | null;
}

/** Admin-only DRR Excel Import — mirrors HsdImportBatch's shape. */
export interface DrrImportBatch {
  id: string;
  fileName: string;
  storedFileName: string | null;
  rigId: string;
  reportDate: string | null;
  rigNumber: string;
  rigName: string;
  uploadedBy: string;
  uploadedAt: string;
  status: 'Successful' | 'Failed';
  recordCount: number;
  errorCount: number;
  errorDetail: DprIssue[] | null;
}

export interface DrrImportPreview {
  planId: string | null;
  rig: { id: string; rigNumber: string; name: string };
  issues: DprIssue[];
  duplicate: { existingReportId: string; message: string } | null;
  preview: {
    rigId: string; reportDate: string; wellNo: string; shift: string; fieldLocation: string | null;
    hsdReceived: number; hsdRemarks: string | null;
    equipmentLines: { equipmentId: string; dayHours: number; nightHours: number; hsdConsumption: number; status: string; remarks: string | null; serviceDoneToday?: boolean; serviceHours?: number | null }[];
    oilLines: { oilType: string; openingBalance: number; oilAdded: number; oilConsumed: number; remark: string | null }[];
    hydraulicLines: { tankName: string; openingLevel: number; topUp: number; loss: number; remark: string | null }[];
    dprLines: { wellName: string | null; operationCode: string | null; workType: string | null; startTime: string | null; endTime: string | null; description: string | null }[];
  } | null;
}

export interface HsdReportSummary {
  id: string;
  rigId: string;
  rigNumber: string;
  rigName: string;
  hsdDate: string;
  wellName: string | null;
  r1Hours: number | null;
  r2Hours: number | null;
  r3Hours: number | null;
  ilmHours: number | null;
  totalHours: number | null;
  equipmentCount: number;
  totalConsumedHsd: number;
}

export type DprRigStatus = 'Pending' | 'Completed';

export interface DprDashboardRigRow {
  rigId: string;
  rigNumber: string;
  rigName: string;
  /** Derived server-side: 'Completed' once the rig has a DPR inside the active filter window. */
  dprStatus: DprRigStatus;
  lastReportDate: string | null;
  reportCount: number;
  totalHours: number;
  netDrillingMeters: number;
}

export interface DprDashboardData {
  /** Hours logged against each DPR work type (R1/R2/R3/ILM), within the active filters. */
  kpis: { r1Hours: number; r2Hours: number; r3Hours: number; ilmHours: number };
  rigWise: DprDashboardRigRow[];
}

/**
 * The upgraded dashboard's KPI set. Diesel figures are pulled from the
 * separate hsd_reports/hsd_equipment_lines tables, correlated by rig + date
 * (no FK to dpr_reports exists). Downtime = R3 work-type hours, the same
 * category the dashboard already tracked before this upgrade. Equipment
 * Utilization is fleet-wide: the share of hours logged against a named
 * "Breakdown Equipment" that were NOT R3 (i.e. productive rather than
 * breakdown time) — equipment names are free text, not FK'd, so this is a
 * best-effort figure grouped by trimmed/lowercased name.
 */
export interface DprDashboardKpis {
  r1Hours: number; r2Hours: number; r3Hours: number; ilmHours: number;
  totalDpr: number;
  totalProgress: number;
  totalRigHours: number;
  totalDiesel: number;
  avgDieselPerDay: number;
  dieselPerRigHour: number;
  downtimeHours: number;
  equipmentUtilizationPct: number;
}

export interface DprDashboardRigComparisonRow extends DprDashboardRigRow {
  totalProgress: number;
  downtimeHours: number;
  efficiencyPct: number;
  utilizationPct: number;
  totalDiesel: number;
}

export interface DprDashboardDataV2 {
  kpis: DprDashboardKpis;
  rigWise: DprDashboardRigComparisonRow[];
}

export interface DprTrendPoint {
  bucket: string;
  dprCount: number;
  totalHours: number;
  totalProgress: number;
  downtimeHours: number;
  totalDiesel: number;
}

export interface DprEquipmentPerformanceRow {
  equipmentName: string;
  activityCount: number;
  totalHours: number;
  downtimeHours: number;
  utilizationPct: number;
}

export interface DprDowntimeAnalysis {
  byRig: { rigNumber: string; downtimeHours: number }[];
  byOperationCode: { operationCode: string; hours: number; occurrences: number }[];
}

/** id is a real PMS Equipment Master id when linked, or a synthetic "name:N" id when falling back to free-text names. */
export interface DprEquipmentOption {
  id: string;
  name: string;
}

/** "Operational DPR": every activity line flattened with its date/rig context — one row per real dpr_line_items entry, not aggregated by rig. */
export interface OperationalLineRow {
  id: string;
  lineNo: number;
  dprDate: string;
  rigNumber: string;
  rigName: string;
  wellName: string | null;
  operationCode: string | null;
  workType: string | null;
  startTime: string | null;
  endTime: string | null;
  totalHours: number | null;
  breakdownEquipment: string | null;
  breakdownReason: string | null;
  drillingSection: string | null;
  drillingFrom: number | null;
  drillingTo: number | null;
  drillingTotal: number | null;
  casingSection: string | null;
  casingFrom: number | null;
  casingTo: number | null;
  casingTotal: number | null;
}

export interface OperationalDataResponse {
  rows: OperationalLineRow[];
  kpis: { r0Hours: number; r1Hours: number; r2Hours: number; r22Hours: number; r3Hours: number; ilmHours: number };
}

/** Rig-wise HSD consumption comparison chart on the DPR Dashboard — real per-rig totals, labelled with actual Rig Master names. */
export interface RigHsdComparisonRow {
  rigId: string;
  rigNumber: string;
  rigName: string;
  totalConsumption: number;
}

/**
 * DPR → HSD Report: the rig tank-level diesel account (hsd_site_lines,
 * label 'Rig Site Diesel'). opening/closing are point-in-time balances
 * (earliest/latest day in range per rig); received/transferredOut/used are
 * flows summed over the range.
 */
export interface HsdReportKpis {
  totalOpeningStock: number;
  totalReceived: number;
  totalTransferredOut: number;
  totalUsed: number;
  totalClosingBalance: number;
}

export interface HsdRigWiseBalance {
  rigId: string; rigNumber: string; rigName: string;
  opening: number; received: number; transferredOut: number; used: number; closing: number;
}

export interface HsdMonthlyTrendPoint {
  month: string; received: number; used: number; transferredOut: number;
}

export interface HsdTransferHistoryRow {
  rigId: string; rigNumber: string; rigName: string; date: string;
  opening: number; received: number; transferredOut: number; used: number; closing: number;
}

export interface HsdReportResult {
  kpis: HsdReportKpis;
  rigWise: HsdRigWiseBalance[];
  monthlyTrend: HsdMonthlyTrendPoint[];
  transferHistory: HsdTransferHistoryRow[];
}

/** DPR's own independent Rig Master — structurally separate from PMS's Rig. */
export interface DprRig {
  id: string;
  name: string;
  rigNumber: string;
  status: string;
  createdAt: string;
  /** Bridged from PMS's rigs.rigType by rigKey match; null when there is no matching PMS rig. */
  rigType?: string | null;
}

/** ILM's own independent Rig Master — structurally separate from PMS's Rig. */
export interface IlmRig {
  id: string;
  name: string;
  rigNumber: string;
  status: string;
  createdAt: string;
  /** Bridged from PMS's rigs.rigType by rigKey match; null when there is no matching PMS rig. */
  rigType?: string | null;
}

/** One audit_logs row, as returned by GET /dpr/rig-history/:rigId. */
export interface DprAuditEntry {
  id: string;
  user: string | null;
  time: string;
  action: string;
  entityId: string | null;
  detail: string | null;
}

/* ------------------------------------------------------------------ */
/* ILM (Inter Location Movement) module                                */
/* ------------------------------------------------------------------ */

export interface IlmIndividual {
  area: string | null;
  operatorName: string | null;
  wellNo: string | null;
  movementFromWell: string | null;
  movementToWell: string | null;
  releaseDate: string | null;
  releaseTime: string | null;
  spudDate: string | null;
  spudTime: string | null;
  ilmRatePerDay: number | null;
  ilmExpenses: number | null;
  /** Shown once Release Date & Time are both entered; Total Contract Days is derived from these two, never stored separately. */
  contractDateFrom: string | null;
  contractDateTo: string | null;
  /** ILM Contract Duration Rules preview (Admin > Master > ILM Contract Duration Rules) — frozen at the moment this header was last saved with a distance present. */
  movementDistanceKm: number | null;
  contractAllowedHours: number | null;
  contractAllowedDays: number | null;
  contractRuleId: string | null;
}

/**
 * One automatic Delay popup submission — logged when the ILM is saved past
 * its Contract Date To while still Active. Kept entirely separate from the
 * Delay/Fuel Log's HSD/consumption fields (ilm_individual_lines), which now
 * shows only Fuel Log data.
 */
export interface IlmDelayRecord {
  id: string;
  reasonForDelay: string;
  otherReason: string | null;
  delayHours: number | null;
  remarks: string | null;
  createdBy: string;
  createdAt: string;
}

export interface IlmIndividualLine {
  id?: string;
  lineNo: number;
  reasonForDelay: string | null;
  totalDelayHours: number | null;
  hsdStockAccession: number | null;
  receivedQtyDuringIlm: number | null;
  hsdStockShiftEnd: number | null;
  totalHsdConsumption: number | null;
  ilmDistanceKm: number | null;
  totalLoadsMoved: number | null;
  cumulativeTrailerKm: number | null;
  avgConsumptionPerKm: number | null;
}

export interface IlmTrailerHeader {
  rigName: string | null;
  oldLocation: string | null;
  newLocation: string | null;
  leadDistanceKm: number | null;
  rigReleaseAt: string | null;
  fleetReportAt: string | null;
  allowedDurationHrs: number | null;
  /** Both frozen at movement-creation time from the rig's matching ILM Contract Duration Rule — null when none matched (Allowed Duration was entered manually instead). */
  contractDays: number | null;
  contractRuleId: string | null;
}

/** Admin > Master > ILM Contract Duration Rules — one distance band for one ILM rig. */
export interface IlmContractDurationRule {
  id: string;
  ilmRigId: string;
  fromDistanceKm: number;
  toDistanceKm: number | null;
  baseHours: number;
  extraHoursPerKm: number;
  /** "Per KM or part thereof" — round the extra distance up to the next whole KM before multiplying. */
  roundPerKm: boolean;
  status: 'Active' | 'Inactive';
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface IlmContractDurationResolution {
  rule: IlmContractDurationRule | null;
  allowedHours: number | null;
  contractDays: number | null;
}

export interface IlmTrailerLoad {
  id?: string;
  lineNo: number;
  srNo: string | null;
  mtGatePassNo: string | null;
  trailerNo: string | null;
  equipmentId: string | null;
  trailerType: string | null;
  capacityTon: number | null;
  arrivalDate: string | null;
  arrivalTime: string | null;
  loadingDate: string | null;
  loadingTime: string | null;
  loadDescription: string | null;
  totalPackages: number | null;
  unloadingDate: string | null;
  unloadingTime: string | null;
  driverName: string | null;
  driverContact: string | null;
}

export interface IlmCrane {
  id?: string;
  lineNo: number;
  craneNo: string | null;
  equipmentId: string | null;
  capacityTon: number | null;
  reportingDate: string | null;
  rigOrHired: string | null;
  registrationNo: string | null;
  arrivedDate: string | null;
  arrivedTime: string | null;
  releaseDate: string | null;
  releaseTime: string | null;
  transporterName: string | null;
  dayNo: number | null;
  shiftDate: string | null;
  dayShiftHrs: number | null;
  detailsJobDay: string | null;
  nightShiftHrs: number | null;
  detailsJobNight: string | null;
  breakdownHrs: number | null;
  cumulativeHrs: number | null;
  issuedHsdLtrs: number | null;
  totalWorkingHrs: number | null;
}

export interface IlmTransactionSummary {
  id: string;
  ilmNumber: string;
  rigId: string;
  rigNumber: string;
  rigName: string;
  date: string;
  source: 'excel' | 'manual';
  /** 'Active' while the ILM is still running (accepting new rounds); 'Completed' once ended. */
  status: 'Active' | 'Completed' | string;
  importBatchId: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  endDate: string | null;
  endTime: string | null;
  completedBy: string | null;
  completedAt: string | null;
  durationHours: number | null;
  movementFromWell: string | null;
  movementToWell: string | null;
  totalDistanceKm: number;
  totalLoadsMoved: number;
  totalHsdConsumption: number;
  trailerCount: number;
  craneCount: number;
}

/** One Trailer Movement round under an ILM. oldLocation/newLocation/rigReleaseAt are a snapshot taken when the round was created — editing the ILM header later never changes it. */
export interface IlmTrailerMovement extends IlmTrailerHeader {
  id: string;
  movementNo: number;
  createdBy: string;
  createdAt: string;
  loads: IlmTrailerLoad[];
}

/** One Crane Round under an ILM — a crane can arrive, work, be released, and a later crane brought in as its own separate round. */
export interface IlmCraneRound {
  id: string;
  roundNo: number;
  oldLocation: string | null;
  newLocation: string | null;
  /** Which the Add Crane Round form's "Location" dropdown had selected — 'Old Location' | 'New Location' | null (rows predating the dropdown). */
  locationType: string | null;
  createdBy: string;
  createdAt: string;
  records: IlmCrane[];
}

export interface IlmTransaction extends IlmTransactionSummary {
  individual: IlmIndividual | null;
  individualLines: IlmIndividualLine[];
  /** Every Trailer Movement round, oldest first. */
  trailerMovements: IlmTrailerMovement[];
  /** Every Crane Round, oldest first. */
  craneRounds: IlmCraneRound[];
  /** All rounds' loads/cranes combined, flat. */
  trailerLoads: IlmTrailerLoad[];
  cranes: IlmCrane[];
  /** Every automatic Delay popup submission for this ILM, oldest first. */
  delayRecords: IlmDelayRecord[];
}

export interface IlmIssue {
  level: 'fatal' | 'warning';
  sheet?: string;
  row?: number;
  message: string;
}

export interface IlmImportBatch {
  id: string;
  fileName: string;
  storedFileName: string | null;
  rigId: string;
  rigNumber: string;
  rigName: string;
  uploadedBy: string;
  uploadedAt: string;
  status: 'Successful' | 'PartiallyFailed' | 'Failed';
  templateVersion: string | null;
  recordCount: number;
  errorCount: number;
  errorDetail: IlmIssue[] | null;
  transactionId: string | null;
}

export interface IlmDashboardData {
  kpis: {
    totalMovements: number; activeMovements: number; completedMovements: number;
    totalDistanceKm: number; totalTrailerLoads: number; totalCraneRecords: number;
    totalHsdConsumption: number; avgConsumptionPerKm: number;
  };
  rigWise: { rigId: string; rigNumber: string; rigName: string; lastMovementDate: string | null; movementCount: number }[];
  recent: {
    id: string; ilmNumber: string; date: string; source: string; status: string; rigNumber: string; rigName: string;
    createdBy: string; createdAt: string; movementFromWell: string | null; movementToWell: string | null; totalDistanceKm: number;
  }[];
  /** Real, already-entered fleet totals only — no cost/rate/operator/well-no fields, since none of that data exists in ILM yet. */
  trailerSummary: {
    totalTrailersDeployed: number; totalLoads: number; totalPackages: number; totalDistanceKm: number;
    byType: { trailerType: string; count: number }[];
  };
  craneSummary: {
    totalCranesDeployed: number; totalWorkingHours: number; totalBreakdownHours: number; totalHsdIssued: number;
    totalCapacityTon: number;
    byOwnership: { rigOrHired: string; count: number }[];
  };
}

/** ILM → Dashboard → Crane Summary: one card+table per physical crane, grouped from real ilm_cranes rows only. */
export interface CraneSummaryUnit {
  craneNo: string;
  capacityTon: number | null;
  reportingDate: string | null;
  rigOrHired: string | null;
  registrationNo: string | null;
  arrivedDate: string | null;
  arrivedTime: string | null;
  releaseDate: string | null;
  releaseTime: string | null;
  transporterName: string | null;
  rows: {
    dayNo: number | null; shiftDate: string | null; dayShiftHrs: number | null; detailsJobDay: string | null;
    nightShiftHrs: number | null; detailsJobNight: string | null; breakdownHrs: number | null;
    cumulativeHrs: number | null; issuedHsdLtrs: number | null; totalWorkingHrs: number | null;
  }[];
  totals: {
    dayShiftHrs: number; nightShiftHrs: number; breakdownHrs: number;
    cumulativeHrs: number | null; issuedHsdLtrs: number; totalWorkingHrs: number;
  };
}

export interface CraneSummaryResponse {
  kpis: { activeCranes: number; totalWorkingHours: number; totalHsdIssued: number; totalBreakdownHours: number };
  units: CraneSummaryUnit[];
}

/** ILM → Dashboard → Crane Summary's fully-automated view: KPIs, comparisons and the detailed table, all live aggregates over real ilm_cranes/ilm_crane_rounds rows (services/ilmCraneDashboard.ts). */
export interface CraneDashboardRow {
  key: string;
  transactionId: string; ilmNumber: string; status: 'Active' | 'Completed';
  craneNo: string; equipmentId: string | null;
  rigId: string; rigNumber: string; rigName: string;
  capacityTon: number | null; registrationNo: string | null; transporterName: string | null;
  oldLocation: string | null; newLocation: string | null;
  workingHours: number; fuelLtrs: number; breakdownHours: number; breakdownPct: number; trips: number;
}
export interface CraneWiseRow { craneNo: string; workingHours: number; fuelLtrs: number; breakdownHours: number; breakdownPct: number; trips: number }
export interface CraneRigWiseRow { rigId: string; rigNumber: string; rigName: string; totalCranes: number; workingHours: number; fuelLtrs: number; breakdownHours: number }
export interface CraneTransporterWiseRow { transporterName: string; craneCount: number; workingHours: number; breakdownHours: number; breakdownPct: number }
export interface CraneTrendPoint { date: string; workingHours: number; fuelLtrs: number; breakdownHours: number }

export interface CraneDashboardResponse {
  kpis: {
    totalCranes: number; activeCranes: number; totalWorkingHours: number;
    totalFuelConsumed: number; totalTrips: number; totalBreakdownHours: number;
  };
  rigWise: CraneRigWiseRow[];
  craneWise: CraneWiseRow[];
  transporterWise: CraneTransporterWiseRow[];
  trend: CraneTrendPoint[];
  rows: CraneDashboardRow[];
}

export interface CraneFilterOptions { cranes: string[]; transporters: string[] }

/** One trip = one ilm_trailer_loads row. Unlimited — a trailer can make as many trips as were actually logged. */
export interface TrailerTripDetail {
  tripNo: number;
  mtGatePassNo: string | null;
  loadingDate: string | null;
  loadingTime: string | null;
  unloadingDate: string | null;
  unloadingTime: string | null;
  totalPackages: number | null;
  loadDescription: string | null;
}

/** ILM → Dashboard → Trailer Summary: one merged row per physical trailer, from real ilm_trailer_loads rows only. */
export interface TrailerSummaryRow {
  trailerNo: string;
  tripCount: number;
  trailerType: string | null;
  loadingPoint: string | null;
  arrivalDate: string | null;
  arrivalTime: string | null;
  loadingDate: string | null;
  loadingTime: string | null;
  loadDescription: string | null;
  totalPackages: number;
  driverName: string | null;
  driverContact: string | null;
  /** Every trip this trailer made, oldest first — not just the first two. */
  trips: TrailerTripDetail[];
  loadDetails: string | null;
}

export interface TrailerSummaryResponse {
  kpis: {
    totalTrailers: number; totalTrips: number; completionRatePct: number;
    avgTripsPerTrailer: number; totalDays: number; totalPackages: number;
  };
  rows: TrailerSummaryRow[];
}

/** ILM → Dashboard's default view: a single rig+date movement report, real ilm_* data only. */
export const ILM_DELAY_REASON_CATEGORIES = [
  'Site Not Ready', 'Site Barricaded', 'Non-Availability of Trailers',
  'Non-Availability of Cranes', 'Weather Conditions', 'For Spares/Equipment', 'Others',
] as const;

export interface IlmSummaryReport {
  found: true;
  rigId: string;
  rigNumber: string;
  dateFrom: string;
  dateTo: string;
  movementCount: number;
  summary: {
    rigNumber: string;
    area: string | null;
    operatorName: string | null;
    wellNo: string | null;
    movementFromWell: string | null;
    movementToWell: string | null;
    releaseDate: string | null;
    releaseTime: string | null;
    spudDate: string | null;
    spudTime: string | null;
    totalDaysReleaseToSpud: number | null;
  };
  equipment: {
    craneCapacityTon: number | null;
    trailerCapacityTon: number | null;
    totalCranes: number;
    totalTrailers: number;
    delayReasonCounts: { reason: string; count: number }[];
    totalTimeForDelayHrs: number | null;
  };
  hsd: {
    hsdStockAccession: number | null;
    receivedQtyDuringIlm: number | null;
    hsdStockShiftEnd: number | null;
    totalHsdConsumption: number | null;
    ilmDistanceKm: number | null;
    totalLoadsMoved: number | null;
    cumulativeTrailerKm: number | null;
    avgConsumptionPerKm: number | null;
    cumulativeCraneHrs: number | null;
    avgConsumptionPerHr: number | null;
  };
  timeAndCosts: {
    totalHrsForIlm: number | null;
    totalDaysForIlm: number | null;
    ilmRatePerDay: number | null;
    ilmExpenses: number | null;
    averageDayRate: number | null;
    operatingDayRate: number | null;
    effectiveDayRatePct: number | null;
  };
  kpis: {
    totalHsdConsumption: number | null;
    ilmFleetCost: number | null;
    distanceCoveredKm: number | null;
    effectiveDayRatePct: number | null;
  };
  trailerAnalysis: {
    byType: { trailerType: string; tripCount: number; totalLoads: number }[];
  };
  craneAnalysis: {
    byUnit: {
      craneNo: string; transporterName: string | null; rigOrHired: string | null;
      totalWorkingHrs: number; totalBreakdownHrs: number; breakdownRatioPct: number;
    }[];
  };
}

export type IlmSummaryReportResult = IlmSummaryReport | { found: false };

/* ------------------------------------------------------------------ */
/* Daily Rig Report (DRR)                                              */
/* ------------------------------------------------------------------ */

export const DRR_SHIFT_OPTIONS = ['Day', 'Night', '24 Hour'] as const;
export type DrrShift = (typeof DRR_SHIFT_OPTIONS)[number];

export const DRR_EQUIPMENT_STATUS_OPTIONS = ['Running', 'Standby', 'Breakdown', 'Maintenance', 'Not Available'] as const;
export type DrrEquipmentStatus = (typeof DRR_EQUIPMENT_STATUS_OPTIONS)[number];

/**
 * 'Submitted' is the one terminal, distributed state — reached only via an
 * Operational Manager's Approve action on a PendingApproval report (or
 * directly, for Excel import / demo data). It is deliberately still the same
 * value that already meant "final" everywhere in the app before the approval
 * workflow existed.
 */
export type DrrReportStatus = 'Draft' | 'PendingApproval' | 'Submitted' | 'Rejected';

export interface DrrApprovalHistoryEntry {
  id: string;
  action: 'Submitted' | 'Approved' | 'Rejected';
  byUser: string;
  atTime: string;
  reason: string | null;
}

/** Admin > DRR > Rig Responsibility: one Primary/Backup Storekeeper/Operational Manager slot for a rig. */
export type DrrResponsibilityRoleType = 'Storekeeper' | 'OperationalManager';
export type DrrResponsibilityTier = 'Primary' | 'Backup';

export interface DrrRigResponsibility {
  id: string;
  rigId: string; rigNumber: string; rigName: string;
  roleType: DrrResponsibilityRoleType;
  tier: DrrResponsibilityTier;
  userId: string; userName: string; username: string;
  status: 'Active' | 'Inactive';
  createdBy: string; createdAt: string; updatedAt: string;
}

/** GET /drr/rig-responsibility/my — which rigs the current user may act on, and in what capacity. */
export interface DrrMyRigRoles {
  storekeeperRigIds: string[];
  managerRigIds: string[];
  isAdmin: boolean;
}

export interface DrrStatusCounts {
  Draft: number;
  PendingApproval: number;
  Submitted: number;
  Rejected: number;
}

export interface DrrEquipmentLine {
  equipmentId: string;
  openingRunningHours: number;
  dayHours: number;
  nightHours: number;
  hsdConsumption: number;
  status: DrrEquipmentStatus;
  remarks: string | null;
  breakdownAt?: string | null;
  breakdownDescription?: string | null;
  actionTaken?: string | null;
  partsRequired?: string | null;
  expectedRestoration?: string | null;
  breakdownRemark?: string | null;
  /** "Service Done Today" — locked/read-only by default; check it to unlock and enter serviceHours. */
  serviceDoneToday?: boolean;
  serviceHours?: number | null;
}

export interface DrrOilLine {
  equipmentId: string | null;
  oilType: string;
  openingBalance: number;
  oilAdded: number;
  oilConsumed: number;
  remark: string | null;
}

export interface DrrHydraulicLine {
  tankName: string;
  openingLevel: number;
  topUp: number;
  loss: number;
  remark: string | null;
}

/**
 * DRR Site Attendance — one row per employee actually recorded present/absent/
 * on leave at the rig for that day. employeeId is null for a temporary/onsite
 * "+ Add Employee" entry not in Employee Master. rosterStatus (if present) is
 * a reference-only snapshot of what the roster said for that day — it never
 * determines attendanceStatus, which the Rig User always enters directly.
 */
export interface DrrAttendanceLine {
  employeeId: string | null;
  employeeName: string;
  employeeCode: string | null;
  designation: string | null;
  rosterStatus: 'ON' | 'OFF' | null;
  attendanceStatus: 'Present' | 'Absent' | 'Leave' | '';
  shift: string | null;
  inTime: string | null;
  outTime: string | null;
  isTemporary: boolean;
  remarks: string | null;
}

/** Employee Master — a simple global reference list, same tier as Oil & Lubricant Master's global list. */
export interface Employee {
  id: string;
  name: string;
  employeeCode: string | null;
  defaultDesignation: string | null;
  status: 'Active' | 'Inactive';
  createdAt: string;
}

/** Manpower Roster: an Employee -> Rig rotation assignment (ON/OFF cycle). */
export interface ManpowerRosterEntry {
  id: string;
  employeeId: string;
  employeeName: string;
  rigId: string;
  designation: string;
  rotationType: string;
  onDays: number;
  offDays: number;
  rotationStartDate: string;
  shift: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: 'Active' | 'Inactive';
  createdAt: string;
  updatedAt: string;
}

/** One roster row's computed status for a specific rig+date — what DRR's prefill returns to seed Site Attendance. */
export interface ScheduledEmployee {
  rosterId: string;
  employeeId: string;
  employeeName: string;
  designation: string;
  shift: string;
  rosterStatus: 'ON' | 'OFF';
}

export const IFU_EQUIPMENT_STATUSES = ['Working', 'Stopped', 'Breakdown', 'Under Maintenance'] as const;
export const IFU_PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
export const IFU_STATUSES = ['Open', 'In Progress', 'Completed', 'On Hold'] as const;

export type IfuEquipmentStatus = (typeof IFU_EQUIPMENT_STATUSES)[number];
export type IfuPriority = (typeof IFU_PRIORITIES)[number];
export type IfuStatus = (typeof IFU_STATUSES)[number];

/**
 * Internal Follow-up: one Rig+Equipment issue discussed in a weekly office
 * review meeting. Equipment fields (name/make/model/serial) and
 * responsiblePerson are frozen snapshots taken at save time — editing
 * Equipment Master, transferring the equipment, or renaming a user later
 * never changes an already-saved entry's history.
 */
export interface InternalFollowup {
  id: string;
  meetingDate: string;
  rigId: string;
  rigName: string;
  rigNumber: string;
  equipmentId: string;
  equipmentName: string;
  equipmentMake: string | null;
  equipmentModel: string | null;
  equipmentSerial: string | null;
  equipmentStatus: IfuEquipmentStatus;
  issue: string | null;
  discussionNote: string | null;
  requiredAction: string | null;
  responsiblePersonId: string | null;
  responsiblePerson: string | null;
  priority: IfuPriority;
  targetDate: string | null;
  status: IfuStatus;
  remarks: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  closedAt: string | null;
  /** status !== 'Completed' && targetDate < today, computed server-side. */
  isOverdue: boolean;
}

export interface InternalFollowupDashboard {
  totalOpen: number;
  highCriticalOpen: number;
  inProgress: number;
  overdue: number;
  completed: number;
  equipmentBreakdown: number;
  equipmentStopped: number;
}

/** Admin > Invoice > Invoice Settings: per-rig contract/commercial terms — the fields nowhere else in this database, configured once and reused by every invoice for that rig. */
export interface InvoiceSettings {
  id: string;
  rigId: string;
  contractNo: string | null;
  accountingCode: string | null;
  clientAddressBlock: string | null;
  contractorAddress: string | null;
  contractorGstin: string | null;
  operatingDayRate: number | null;
  standbyRatePct: number;
  repairRatePct: number;
  forceMajeureRate: number;
  ilmChargeRate: number | null;
  sgstPercent: number;
  cgstPercent: number;
  bankAccountName: string | null;
  bankName: string | null;
  bankAccountType: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  pan: string | null;
  authorisedEmail: string | null;
  signatoryCompanyName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoicePriceLine {
  sNo: number;
  particulars: string;
  totalHrs: number;
  qty: number;
  uom: string;
  rate: number;
  grossAmount: number;
}

/** GET /invoices/preview — computed live from Rig Master/Companies/Invoice Settings/DPR/ILM, never saved. */
export interface InvoicePreview {
  rigId: string;
  rigName: string;
  rigNumber: string;
  invoiceDate: string;
  periodFrom: string;
  periodTo: string;
  periodLabel: string;
  clientName: string | null;
  clientAddressBlock: string | null;
  clientGstin: string | null;
  contractNo: string | null;
  accountingCode: string | null;
  wellLocation: string | null;
  contractorAddress: string | null;
  contractorGstin: string | null;
  priceLines: InvoicePriceLine[];
  totalAmount: number;
  sgstPercent: number;
  sgstAmount: number;
  cgstPercent: number;
  cgstAmount: number;
  netAmount: number;
  amountInWords: string;
  bankAccountName: string | null;
  bankName: string | null;
  bankAccountType: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  pan: string | null;
  authorisedEmail: string | null;
  signatoryCompanyName: string | null;
  settingsIncomplete: boolean;
}

/** A saved invoice — every field here is a frozen snapshot; correcting DRR/DPR/ILM/Settings/Rig Master afterwards never changes it. */
export interface Invoice extends Omit<InvoicePreview, 'settingsIncomplete'> {
  id: string;
  invoiceNumber: string;
  status: 'Final' | 'Cancelled';
  remarks: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface InvoiceDashboardData {
  totalInvoices: number;
  totalNetAmount: number;
  thisMonthCount: number;
  thisMonthNetAmount: number;
  cancelledCount: number;
  byRig: { rigId: string; rigName: string; count: number; netAmount: number }[];
}

export interface DrrPrefillEquipment {
  equipmentId: string; name: string; category: string;
  manufacturer: string | null; model: string | null; serialNumber: string | null;
  openingRunningHours: number; openingSource: 'previous-day' | 'equipment-master';
  lastServiceHours: number;
}

/** One equipment_service_records row — permanent history, never overwritten. */
export interface EquipmentServiceRecord {
  id: string;
  equipmentId: string;
  rigId: string;
  rigNumber: string;
  date: string;
  serviceHours: number;
  remarks: string | null;
  method: 'DRR' | 'Manual';
  recordedBy: string;
  createdAt: string;
}

/** Fleet-wide row for PMS > Service History — same shape as EquipmentServiceRecord plus the machine's name. */
export interface FleetServiceRecord extends EquipmentServiceRecord {
  equipmentName: string;
}

export interface DrrPrefill {
  rig: { id: string; rigNumber: string; name: string };
  dprRig: { id: string; rigNumber: string };
  equipment: DrrPrefillEquipment[];
  hsdOpeningStock: number;
  oilTypes: { oilType: string; openingBalance: number | null }[];
  hydraulicTanks: { tankName: string; openingLevel: number | null }[];
  /** Date of the most recent prior Submitted report for this rig, or null if this is the rig's first-ever Daily Rig Report — opening values are then master defaults, not carried-forward data. */
  previousReportDate: string | null;
  /** Active Employee Master rows — the "+ Add Employee" picker's source list. */
  employees: Employee[];
  /** Every Active roster row for this rig covering this date, with today's computed ON/OFF — reference-only display next to a manually-added attendance row, never used to auto-populate one. */
  manpower: ScheduledEmployee[];
  wellSuggestions: string[];
  shiftOptions: string[];
  equipmentStatusOptions: string[];
}

export interface DrrReportSummary {
  id: string; rigId: string; rigNumber: string; rigName: string;
  reportDate: string; wellNo: string | null; shift: string; fieldLocation: string | null;
  status: DrrReportStatus;
  submittedBy: string; submittedAt: string | null;
  approvedBy: string | null; approvedAt: string | null;
  rejectedBy: string | null; rejectedAt: string | null; rejectionReason: string | null;
  createdBy?: string; createdAt: string; updatedAt: string;
}

export interface DrrReportDetail extends DrrReportSummary {
  dprReportId: string | null; hsdReportId: string | null;
  hsdReceived: number; hsdRemarks: string | null;
  equipmentLines: DrrEquipmentLine[];
  oilLines: DrrOilLine[];
  hydraulicLines: DrrHydraulicLine[];
  attendanceLines?: DrrAttendanceLine[];
  dprLines: DprLineItem[];
  approvalHistory: DrrApprovalHistoryEntry[];
}
