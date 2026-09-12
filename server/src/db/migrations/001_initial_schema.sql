-- GTC PMS Portal — PostgreSQL schema
-- Generated from the live SQLite database (final state, all migrations applied).
-- Table/column names are preserved exactly, including camelCase, so every
-- existing query keeps working — which is why identifiers are quoted.

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" TEXT PRIMARY KEY,
  "user" TEXT,
  "time" TEXT NOT NULL,
  "ip" TEXT,
  "action" TEXT NOT NULL,
  "entity" TEXT,
  "entityId" TEXT,
  "field" TEXT,
  "oldValue" TEXT,
  "newValue" TEXT,
  "detail" TEXT
);

CREATE TABLE IF NOT EXISTS "companies" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "code" TEXT,
  "gstNumber" TEXT,
  "pan" TEXT,
  "contactPerson" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "demo_data_log" (
  "id" TEXT PRIMARY KEY,
  "entityTable" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "departments" (
  "id" TEXT PRIMARY KEY,
  "moduleCode" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameKey" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "document_files" (
  "id" TEXT PRIMARY KEY,
  "equipmentId" TEXT NOT NULL,
  "docType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "storedFileName" TEXT NOT NULL,
  "uploadDate" TEXT NOT NULL,
  "version" INTEGER DEFAULT 1 NOT NULL,
  "uploadedBy" TEXT
);

CREATE TABLE IF NOT EXISTS "dpr_import_batches" (
  "id" TEXT PRIMARY KEY,
  "fileName" TEXT NOT NULL,
  "storedFileName" TEXT,
  "rigId" TEXT NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "uploadedAt" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "recordCount" INTEGER DEFAULT 0 NOT NULL,
  "errorCount" INTEGER DEFAULT 0 NOT NULL,
  "errorDetail" TEXT
);

CREATE TABLE IF NOT EXISTS "dpr_line_items" (
  "id" TEXT PRIMARY KEY,
  "reportId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "wellName" TEXT,
  "operationCode" TEXT,
  "workType" TEXT,
  "startTime" TEXT,
  "endTime" TEXT,
  "totalHours" DOUBLE PRECISION,
  "description" TEXT,
  "breakdownEquipment" TEXT,
  "drillingSection" TEXT,
  "drillingFrom" DOUBLE PRECISION,
  "drillingTo" DOUBLE PRECISION,
  "drillingTotal" DOUBLE PRECISION,
  "casingSection" TEXT,
  "casingFrom" DOUBLE PRECISION,
  "casingTo" DOUBLE PRECISION,
  "casingTotal" DOUBLE PRECISION,
  "breakdownReason" TEXT,
  "breakdownEquipmentId" TEXT,
  "otherActivityDescription" TEXT
);

CREATE TABLE IF NOT EXISTS "dpr_reports" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "dprDate" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "importBatchId" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "dpr_rigs" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "rigNumber" TEXT NOT NULL,
  "rigKey" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "drr_approval_history" (
  "id" TEXT PRIMARY KEY,
  "reportId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "byUser" TEXT NOT NULL,
  "atTime" TEXT NOT NULL,
  "reason" TEXT
);

CREATE TABLE IF NOT EXISTS "drr_attendance_lines" (
  "id" TEXT PRIMARY KEY,
  "reportId" TEXT NOT NULL,
  "employeeId" TEXT,
  "employeeName" TEXT NOT NULL,
  "designation" TEXT,
  "rosterStatus" TEXT,
  "attendanceStatus" TEXT NOT NULL,
  "isTemporary" BOOLEAN DEFAULT FALSE NOT NULL,
  "remarks" TEXT,
  "employeeCode" TEXT,
  "shift" TEXT,
  "inTime" TEXT,
  "outTime" TEXT
);

CREATE TABLE IF NOT EXISTS "drr_hydraulic_lines" (
  "id" TEXT PRIMARY KEY,
  "reportId" TEXT NOT NULL,
  "tankName" TEXT NOT NULL,
  "openingLevel" DOUBLE PRECISION,
  "topUp" DOUBLE PRECISION,
  "loss" DOUBLE PRECISION,
  "closingLevel" DOUBLE PRECISION,
  "remark" TEXT
);

CREATE TABLE IF NOT EXISTS "drr_import_batches" (
  "id" TEXT PRIMARY KEY,
  "fileName" TEXT NOT NULL,
  "storedFileName" TEXT,
  "rigId" TEXT NOT NULL,
  "reportDate" TEXT,
  "uploadedBy" TEXT NOT NULL,
  "uploadedAt" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "templateVersion" TEXT,
  "recordCount" INTEGER DEFAULT 0 NOT NULL,
  "errorCount" INTEGER DEFAULT 0 NOT NULL,
  "errorDetail" TEXT
);

CREATE TABLE IF NOT EXISTS "drr_oil_lines" (
  "id" TEXT PRIMARY KEY,
  "reportId" TEXT NOT NULL,
  "equipmentId" TEXT,
  "oilType" TEXT NOT NULL,
  "openingBalance" DOUBLE PRECISION,
  "oilAdded" DOUBLE PRECISION,
  "oilConsumed" DOUBLE PRECISION,
  "closingBalance" DOUBLE PRECISION,
  "remark" TEXT
);

CREATE TABLE IF NOT EXISTS "drr_reports" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "reportDate" TEXT NOT NULL,
  "wellNo" TEXT,
  "shift" TEXT NOT NULL,
  "fieldLocation" TEXT,
  "status" TEXT DEFAULT 'Draft' NOT NULL,
  "dprReportId" TEXT,
  "hsdReportId" TEXT,
  "mechLogUploadId" TEXT,
  "draftPayload" TEXT,
  "submittedBy" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TEXT NOT NULL,
  "submittedAt" TEXT,
  "approvedBy" TEXT,
  "approvedAt" TEXT,
  "rejectedBy" TEXT,
  "rejectedAt" TEXT,
  "rejectionReason" TEXT
);

CREATE TABLE IF NOT EXISTS "drr_rig_responsibility" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "roleType" TEXT NOT NULL,
  "tier" TEXT DEFAULT 'Primary' NOT NULL,
  "userId" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "employees" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "employeeCode" TEXT,
  "defaultDesignation" TEXT,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "engine_master" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "equipmentId" TEXT,
  "application" TEXT NOT NULL,
  "make" TEXT,
  "model" TEXT,
  "serialNumber" TEXT,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "source" TEXT DEFAULT 'Manual' NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "equipment" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameKey" TEXT NOT NULL,
  "category" TEXT DEFAULT 'Others' NOT NULL,
  "manufacturer" TEXT,
  "model" TEXT,
  "serialNumber" TEXT,
  "serialKey" TEXT,
  "assetNumber" TEXT,
  "engineNumber" TEXT,
  "installationDate" TEXT,
  "currentRunningHours" INTEGER DEFAULT 0 NOT NULL,
  "lastServiceHours" INTEGER DEFAULT 0 NOT NULL,
  "serviceInterval" INTEGER DEFAULT 500 NOT NULL,
  "lastHealthCheckDate" TEXT,
  "healthCheckInterval" INTEGER DEFAULT 90 NOT NULL,
  "isBreakdown" BOOLEAN DEFAULT FALSE NOT NULL,
  "isActive" BOOLEAN DEFAULT TRUE NOT NULL,
  "status" TEXT DEFAULT 'Normal' NOT NULL,
  "section" TEXT DEFAULT 'diesel' NOT NULL,
  "currentPlace" TEXT,
  "currentPlaceSince" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "ecmPresent" BOOLEAN,
  "etToolApplicable" BOOLEAN,
  "linkedEngineId" TEXT,
  "linkedTransmissionId" TEXT
);

CREATE TABLE IF NOT EXISTS "equipment_history" (
  "id" TEXT PRIMARY KEY,
  "equipmentId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "runningHours" INTEGER,
  "addedHours" INTEGER,
  "runningSinceLastService" INTEGER,
  "remainingServiceHours" INTEGER,
  "remarks" TEXT,
  "uploadId" TEXT,
  "updatedBy" TEXT
);

CREATE TABLE IF NOT EXISTS "equipment_master_imports" (
  "id" TEXT PRIMARY KEY,
  "fileName" TEXT NOT NULL,
  "importedBy" TEXT NOT NULL,
  "importedAt" TEXT NOT NULL,
  "rigsMatched" INTEGER NOT NULL,
  "rigsUnmatched" INTEGER NOT NULL,
  "equipmentCreated" INTEGER NOT NULL,
  "equipmentUpdated" INTEGER NOT NULL,
  "equipmentDeactivated" INTEGER NOT NULL,
  "oilLubricantsCreated" INTEGER NOT NULL,
  "unmatchedRigNames" TEXT DEFAULT '[]' NOT NULL,
  "oilLubricantsRemoved" INTEGER DEFAULT 0 NOT NULL,
  "materialsCreated" INTEGER DEFAULT 0 NOT NULL,
  "materialsUpdated" INTEGER DEFAULT 0 NOT NULL,
  "materialsRemoved" INTEGER DEFAULT 0 NOT NULL,
  "oilMappingsRemoved" INTEGER DEFAULT 0 NOT NULL,
  "materialsRelinked" INTEGER DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "equipment_oil_lubricants" (
  "id" TEXT PRIMARY KEY,
  "equipmentId" TEXT NOT NULL,
  "oilLubricantId" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "equipment_service_records" (
  "id" TEXT PRIMARY KEY,
  "equipmentId" TEXT NOT NULL,
  "rigId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "serviceHours" INTEGER NOT NULL,
  "remarks" TEXT,
  "method" TEXT NOT NULL,
  "recordedBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "equipment_transfers" (
  "id" TEXT PRIMARY KEY,
  "equipmentId" TEXT NOT NULL,
  "fromRigId" TEXT,
  "fromPlace" TEXT,
  "toRigId" TEXT,
  "toPlace" TEXT,
  "transferType" TEXT NOT NULL,
  "expectedReturnDate" TEXT,
  "date" TEXT NOT NULL,
  "remarks" TEXT,
  "createdBy" TEXT,
  "createdAt" TEXT NOT NULL,
  "destinationType" TEXT
);

CREATE TABLE IF NOT EXISTS "health_check_records" (
  "id" TEXT PRIMARY KEY,
  "equipmentId" TEXT NOT NULL,
  "rigId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "remarks" TEXT,
  "inspector" TEXT,
  "method" TEXT NOT NULL,
  "uploadId" TEXT,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "health_check_uploads" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "storedFileName" TEXT,
  "uploadDate" TEXT NOT NULL,
  "checkDate" TEXT,
  "uploadedBy" TEXT NOT NULL,
  "recordsImported" INTEGER DEFAULT 0 NOT NULL,
  "status" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "health_narrative_uploads" (
  "id" TEXT PRIMARY KEY,
  "fileName" TEXT NOT NULL,
  "storedFileName" TEXT,
  "uploadDate" TEXT NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "recordsImported" INTEGER DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "health_narratives" (
  "id" TEXT PRIMARY KEY,
  "uploadId" TEXT NOT NULL,
  "equipmentId" TEXT,
  "sourceSheet" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "rigId" TEXT,
  "rigText" TEXT,
  "place" TEXT,
  "application" TEXT,
  "make" TEXT,
  "details" TEXT,
  "serialNumber" TEXT,
  "previousDate" TEXT,
  "previousDateRaw" TEXT,
  "lastDate" TEXT,
  "lastDateRaw" TEXT,
  "problem" TEXT,
  "action" TEXT,
  "outcomeNotes" TEXT,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "hsd_equipment_lines" (
  "id" TEXT PRIMARY KEY,
  "reportId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "equipment" TEXT,
  "openingStock" DOUBLE PRECISION,
  "topUp" DOUBLE PRECISION,
  "totalHsd" DOUBLE PRECISION,
  "consumedHsd" DOUBLE PRECISION,
  "consumedHours" DOUBLE PRECISION,
  "openingRunningHours" DOUBLE PRECISION,
  "closingHours" DOUBLE PRECISION,
  "closingStock" DOUBLE PRECISION,
  "average" DOUBLE PRECISION,
  "remark" TEXT,
  "equipmentId" TEXT
);

CREATE TABLE IF NOT EXISTS "hsd_import_batches" (
  "id" TEXT PRIMARY KEY,
  "fileName" TEXT NOT NULL,
  "storedFileName" TEXT,
  "rigId" TEXT NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "uploadedAt" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "recordCount" INTEGER DEFAULT 0 NOT NULL,
  "errorCount" INTEGER DEFAULT 0 NOT NULL,
  "errorDetail" TEXT
);

CREATE TABLE IF NOT EXISTS "hsd_reports" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "hsdDate" TEXT NOT NULL,
  "wellName" TEXT,
  "r1Hours" DOUBLE PRECISION,
  "r2Hours" DOUBLE PRECISION,
  "r3Hours" DOUBLE PRECISION,
  "ilmHours" DOUBLE PRECISION,
  "totalHours" DOUBLE PRECISION,
  "importBatchId" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "hsd_site_lines" (
  "id" TEXT PRIMARY KEY,
  "reportId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "label" TEXT,
  "openingBalance" DOUBLE PRECISION,
  "received" DOUBLE PRECISION,
  "totalBalance" DOUBLE PRECISION,
  "topUp" DOUBLE PRECISION,
  "totalConsumption" DOUBLE PRECISION,
  "closingBalance" DOUBLE PRECISION,
  "remark" TEXT
);

CREATE TABLE IF NOT EXISTS "ilm_contract_duration_rules" (
  "id" TEXT PRIMARY KEY,
  "ilmRigId" TEXT NOT NULL,
  "fromDistanceKm" DOUBLE PRECISION NOT NULL,
  "toDistanceKm" DOUBLE PRECISION,
  "baseHours" DOUBLE PRECISION NOT NULL,
  "extraHoursPerKm" DOUBLE PRECISION DEFAULT 0 NOT NULL,
  "roundPerKm" INTEGER DEFAULT 1 NOT NULL,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ilm_crane_rounds" (
  "id" TEXT PRIMARY KEY,
  "transactionId" TEXT NOT NULL,
  "roundNo" INTEGER NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "oldLocation" TEXT,
  "newLocation" TEXT,
  "locationType" TEXT
);

CREATE TABLE IF NOT EXISTS "ilm_cranes" (
  "id" TEXT PRIMARY KEY,
  "transactionId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "craneNo" TEXT,
  "capacityTon" DOUBLE PRECISION,
  "reportingDate" TEXT,
  "rigOrHired" TEXT,
  "registrationNo" TEXT,
  "arrivedDate" TEXT,
  "arrivedTime" TEXT,
  "transporterName" TEXT,
  "dayNo" INTEGER,
  "shiftDate" TEXT,
  "dayShiftHrs" DOUBLE PRECISION,
  "detailsJobDay" TEXT,
  "nightShiftHrs" DOUBLE PRECISION,
  "detailsJobNight" TEXT,
  "breakdownHrs" DOUBLE PRECISION,
  "cumulativeHrs" DOUBLE PRECISION,
  "issuedHsdLtrs" DOUBLE PRECISION,
  "totalWorkingHrs" DOUBLE PRECISION,
  "releaseDate" TEXT,
  "releaseTime" TEXT,
  "roundId" TEXT,
  "equipmentId" TEXT
);

CREATE TABLE IF NOT EXISTS "ilm_delay_records" (
  "id" TEXT PRIMARY KEY,
  "transactionId" TEXT NOT NULL,
  "reasonForDelay" TEXT NOT NULL,
  "otherReason" TEXT,
  "delayHours" DOUBLE PRECISION,
  "remarks" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ilm_import_batches" (
  "id" TEXT PRIMARY KEY,
  "fileName" TEXT NOT NULL,
  "storedFileName" TEXT,
  "rigId" TEXT NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "uploadedAt" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "templateVersion" TEXT,
  "recordCount" INTEGER DEFAULT 0 NOT NULL,
  "errorCount" INTEGER DEFAULT 0 NOT NULL,
  "errorDetail" TEXT,
  "transactionId" TEXT
);

CREATE TABLE IF NOT EXISTS "ilm_individual" (
  "transactionId" TEXT PRIMARY KEY,
  "area" TEXT,
  "movementFromWell" TEXT,
  "movementToWell" TEXT,
  "releaseDate" TEXT,
  "releaseTime" TEXT,
  "spudDate" TEXT,
  "spudTime" TEXT,
  "operatorName" TEXT,
  "wellNo" TEXT,
  "ilmRatePerDay" DOUBLE PRECISION,
  "ilmExpenses" DOUBLE PRECISION,
  "contractDateFrom" TEXT,
  "contractDateTo" TEXT,
  "movementDistanceKm" DOUBLE PRECISION,
  "contractAllowedHours" DOUBLE PRECISION,
  "contractAllowedDays" DOUBLE PRECISION,
  "contractRuleId" TEXT
);

CREATE TABLE IF NOT EXISTS "ilm_individual_lines" (
  "id" TEXT PRIMARY KEY,
  "transactionId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "reasonForDelay" TEXT,
  "totalDelayHours" DOUBLE PRECISION,
  "hsdStockAccession" DOUBLE PRECISION,
  "receivedQtyDuringIlm" DOUBLE PRECISION,
  "hsdStockShiftEnd" DOUBLE PRECISION,
  "totalHsdConsumption" DOUBLE PRECISION,
  "ilmDistanceKm" DOUBLE PRECISION,
  "totalLoadsMoved" DOUBLE PRECISION,
  "cumulativeTrailerKm" DOUBLE PRECISION,
  "avgConsumptionPerKm" DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS "ilm_rigs" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "rigNumber" TEXT NOT NULL,
  "rigKey" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "ilm_trailer_header" (
  "transactionId" TEXT PRIMARY KEY,
  "rigName" TEXT,
  "oldLocation" TEXT,
  "newLocation" TEXT,
  "leadDistanceKm" DOUBLE PRECISION,
  "rigReleaseAt" TEXT,
  "fleetReportAt" TEXT,
  "allowedDurationHrs" DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS "ilm_trailer_loads" (
  "id" TEXT PRIMARY KEY,
  "transactionId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "srNo" TEXT,
  "mtGatePassNo" TEXT,
  "trailerNo" TEXT,
  "trailerType" TEXT,
  "loadingDate" TEXT,
  "loadingTime" TEXT,
  "loadDescription" TEXT,
  "totalPackages" DOUBLE PRECISION,
  "unloadingDate" TEXT,
  "unloadingTime" TEXT,
  "driverName" TEXT,
  "driverContact" TEXT,
  "arrivalDate" TEXT,
  "arrivalTime" TEXT,
  "capacityTon" DOUBLE PRECISION,
  "movementId" TEXT,
  "equipmentId" TEXT
);

CREATE TABLE IF NOT EXISTS "ilm_trailer_movements" (
  "id" TEXT PRIMARY KEY,
  "transactionId" TEXT NOT NULL,
  "movementNo" INTEGER NOT NULL,
  "rigName" TEXT,
  "oldLocation" TEXT,
  "newLocation" TEXT,
  "leadDistanceKm" DOUBLE PRECISION,
  "rigReleaseAt" TEXT,
  "fleetReportAt" TEXT,
  "allowedDurationHrs" DOUBLE PRECISION,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "contractDays" DOUBLE PRECISION,
  "contractRuleId" TEXT
);

CREATE TABLE IF NOT EXISTS "ilm_transactions" (
  "id" TEXT PRIMARY KEY,
  "ilmNumber" TEXT NOT NULL,
  "rigId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Completed' NOT NULL,
  "importBatchId" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TEXT NOT NULL,
  "endDate" TEXT,
  "endTime" TEXT,
  "completedBy" TEXT,
  "completedAt" TEXT,
  "durationHours" DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS "internal_followups" (
  "id" TEXT PRIMARY KEY,
  "meetingDate" TEXT NOT NULL,
  "rigId" TEXT NOT NULL,
  "equipmentId" TEXT NOT NULL,
  "equipmentName" TEXT NOT NULL,
  "equipmentMake" TEXT,
  "equipmentModel" TEXT,
  "equipmentSerial" TEXT,
  "equipmentStatus" TEXT NOT NULL,
  "issue" TEXT,
  "discussionNote" TEXT,
  "requiredAction" TEXT,
  "responsiblePersonId" TEXT,
  "responsiblePerson" TEXT,
  "priority" TEXT DEFAULT 'Medium' NOT NULL,
  "targetDate" TEXT,
  "status" TEXT DEFAULT 'Open' NOT NULL,
  "remarks" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TEXT NOT NULL,
  "closedAt" TEXT
);

CREATE TABLE IF NOT EXISTS "invoice_settings" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "contractNo" TEXT,
  "accountingCode" TEXT,
  "clientAddressBlock" TEXT,
  "contractorAddress" TEXT,
  "contractorGstin" TEXT,
  "operatingDayRate" DOUBLE PRECISION,
  "standbyRatePct" DOUBLE PRECISION DEFAULT 70 NOT NULL,
  "repairRatePct" DOUBLE PRECISION DEFAULT 60 NOT NULL,
  "forceMajeureRate" DOUBLE PRECISION DEFAULT 0 NOT NULL,
  "ilmChargeRate" DOUBLE PRECISION,
  "sgstPercent" DOUBLE PRECISION DEFAULT 9 NOT NULL,
  "cgstPercent" DOUBLE PRECISION DEFAULT 9 NOT NULL,
  "bankAccountName" TEXT,
  "bankName" TEXT,
  "bankAccountType" TEXT,
  "bankAccountNumber" TEXT,
  "bankIfsc" TEXT,
  "pan" TEXT,
  "authorisedEmail" TEXT,
  "signatoryCompanyName" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "invoices" (
  "id" TEXT PRIMARY KEY,
  "invoiceNumber" TEXT NOT NULL,
  "rigId" TEXT NOT NULL,
  "invoiceDate" TEXT NOT NULL,
  "periodFrom" TEXT NOT NULL,
  "periodTo" TEXT NOT NULL,
  "periodLabel" TEXT NOT NULL,
  "clientName" TEXT,
  "clientAddressBlock" TEXT,
  "clientGstin" TEXT,
  "rigName" TEXT NOT NULL,
  "rigNumber" TEXT NOT NULL,
  "contractNo" TEXT,
  "accountingCode" TEXT,
  "wellLocation" TEXT,
  "contractorAddress" TEXT,
  "contractorGstin" TEXT,
  "priceLines" TEXT NOT NULL,
  "totalAmount" DOUBLE PRECISION NOT NULL,
  "sgstPercent" DOUBLE PRECISION NOT NULL,
  "sgstAmount" DOUBLE PRECISION NOT NULL,
  "cgstPercent" DOUBLE PRECISION NOT NULL,
  "cgstAmount" DOUBLE PRECISION NOT NULL,
  "netAmount" DOUBLE PRECISION NOT NULL,
  "amountInWords" TEXT NOT NULL,
  "bankAccountName" TEXT,
  "bankName" TEXT,
  "bankAccountType" TEXT,
  "bankAccountNumber" TEXT,
  "bankIfsc" TEXT,
  "pan" TEXT,
  "authorisedEmail" TEXT,
  "signatoryCompanyName" TEXT,
  "status" TEXT DEFAULT 'Final' NOT NULL,
  "remarks" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "login_history" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT,
  "username" TEXT NOT NULL,
  "time" TEXT NOT NULL,
  "ip" TEXT,
  "success" INTEGER NOT NULL,
  "userAgent" TEXT,
  "reason" TEXT
);

CREATE TABLE IF NOT EXISTS "manpower_roster" (
  "id" TEXT PRIMARY KEY,
  "employeeId" TEXT NOT NULL,
  "rigId" TEXT NOT NULL,
  "designation" TEXT NOT NULL,
  "rotationType" TEXT NOT NULL,
  "onDays" INTEGER NOT NULL,
  "offDays" INTEGER NOT NULL,
  "rotationStartDate" TEXT NOT NULL,
  "shift" TEXT NOT NULL,
  "effectiveFrom" TEXT NOT NULL,
  "effectiveTo" TEXT,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "material_master" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT,
  "equipmentId" TEXT,
  "materialType" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "make" TEXT,
  "model" TEXT,
  "serialNumber" TEXT,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "source" TEXT DEFAULT 'Manual' NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "manualLocation" TEXT
);

CREATE TABLE IF NOT EXISTS "material_transfers" (
  "id" TEXT PRIMARY KEY,
  "transferNumber" TEXT NOT NULL,
  "materialName" TEXT NOT NULL,
  "quantity" INTEGER DEFAULT 1 NOT NULL,
  "unit" TEXT,
  "source" TEXT,
  "destination" TEXT,
  "transferType" TEXT,
  "status" TEXT DEFAULT 'Pending' NOT NULL,
  "date" TEXT NOT NULL,
  "remarks" TEXT,
  "createdBy" TEXT,
  "approvedBy" TEXT,
  "approvedAt" TEXT
);

CREATE TABLE IF NOT EXISTS "mechanical_log_rows" (
  "id" TEXT PRIMARY KEY,
  "uploadId" TEXT NOT NULL,
  "equipmentId" TEXT NOT NULL,
  "rigId" TEXT NOT NULL,
  "sheetDay" INTEGER NOT NULL,
  "logDate" TEXT NOT NULL,
  "isInUse" TEXT,
  "hoursRunDay" INTEGER,
  "hoursRunNight" INTEGER,
  "lubeOilPressure" TEXT,
  "lubeOilAdded" INTEGER,
  "openingRunningHours" INTEGER,
  "totalRunHours" INTEGER,
  "closingHours" INTEGER,
  "lastServiceHours" INTEGER,
  "runningHoursAfterLastService" INTEGER,
  "defineHours" INTEGER,
  "hoursRemainingForNextService" INTEGER,
  "preventiveMaintenanceDetails" TEXT,
  "remarks" TEXT,
  "lastServiceDate" TEXT,
  "makeModel" TEXT,
  "serialNumber" TEXT,
  "source" TEXT DEFAULT 'excel' NOT NULL,
  "status" TEXT,
  "hsdConsumptionLiters" DOUBLE PRECISION,
  "breakdownAt" TEXT,
  "breakdownDescription" TEXT,
  "actionTaken" TEXT,
  "partsRequired" TEXT,
  "expectedRestoration" TEXT,
  "breakdownRemark" TEXT
);

CREATE TABLE IF NOT EXISTS "mechanical_log_uploads" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "storedFileName" TEXT,
  "uploadDate" TEXT NOT NULL,
  "logMonth" TEXT NOT NULL,
  "coverageStartDate" TEXT,
  "coverageEndDate" TEXT,
  "uploadedBy" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "recordsImported" INTEGER DEFAULT 0 NOT NULL,
  "validationErrorsCount" INTEGER DEFAULT 0 NOT NULL,
  "notes" TEXT
);

CREATE TABLE IF NOT EXISTS "modules" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN DEFAULT TRUE NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "notification_settings" (
  "type" TEXT PRIMARY KEY,
  "enabled" BOOLEAN DEFAULT TRUE NOT NULL,
  "warningThreshold" DOUBLE PRECISION,
  "criticalThreshold" DOUBLE PRECISION,
  "escalationHours" DOUBLE PRECISION,
  "reminderHours" DOUBLE PRECISION,
  "inApp" BOOLEAN DEFAULT TRUE NOT NULL,
  "email" BOOLEAN DEFAULT FALSE NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TEXT
);

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "equipmentId" TEXT,
  "rigId" TEXT,
  "date" TEXT NOT NULL,
  "isRead" BOOLEAN DEFAULT FALSE NOT NULL,
  "severity" TEXT DEFAULT 'info' NOT NULL,
  "userId" TEXT,
  "title" TEXT,
  "referenceDate" TEXT,
  "dedupeKey" TEXT,
  "createdAt" TEXT,
  "readAt" TEXT,
  "resolvedAt" TEXT,
  "entityId" TEXT
);

CREATE TABLE IF NOT EXISTS "oil_lubricants" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "nameKey" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "createdAt" TEXT NOT NULL,
  "equipmentName" TEXT
);

CREATE TABLE IF NOT EXISTS "rig_holidays" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "type" TEXT,
  "description" TEXT,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "rigs" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "rigNumber" TEXT NOT NULL,
  "rigKey" TEXT NOT NULL,
  "companyId" TEXT,
  "location" TEXT,
  "rigType" TEXT,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "commissionDate" TEXT,
  "createdAt" TEXT NOT NULL,
  "client" TEXT,
  "startDate" TEXT,
  "completionDate" TEXT,
  "remarksStatus" TEXT,
  "projectCoordinator" TEXT
);

CREATE TABLE IF NOT EXISTS "smtp_settings" (
  "id" TEXT DEFAULT 'default' PRIMARY KEY,
  "enabled" BOOLEAN DEFAULT FALSE NOT NULL,
  "host" TEXT,
  "port" INTEGER,
  "secure" BOOLEAN DEFAULT FALSE NOT NULL,
  "username" TEXT,
  "password" TEXT,
  "fromEmail" TEXT,
  "fromName" TEXT,
  "updatedBy" TEXT,
  "updatedAt" TEXT
);

CREATE TABLE IF NOT EXISTS "transmission_master" (
  "id" TEXT PRIMARY KEY,
  "rigId" TEXT NOT NULL,
  "equipmentId" TEXT,
  "application" TEXT NOT NULL,
  "make" TEXT,
  "model" TEXT,
  "serialNumber" TEXT,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "source" TEXT DEFAULT 'Manual' NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "user_rig_access" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "rigId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "rigId" TEXT,
  "departmentId" TEXT,
  "status" TEXT DEFAULT 'Active' NOT NULL,
  "rights" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "moduleAccess" TEXT
);

-- Foreign keys (added after all tables exist, so creation order is irrelevant).
-- Wrapped so re-running the schema is a no-op rather than an error.
DO $$ BEGIN
  ALTER TABLE "document_files" ADD CONSTRAINT "fk_document_files_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "dpr_import_batches" ADD CONSTRAINT "fk_dpr_import_batches_rigId" FOREIGN KEY ("rigId") REFERENCES "dpr_rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "dpr_line_items" ADD CONSTRAINT "fk_dpr_line_items_breakdownEquipmentId" FOREIGN KEY ("breakdownEquipmentId") REFERENCES "equipment" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "dpr_line_items" ADD CONSTRAINT "fk_dpr_line_items_reportId" FOREIGN KEY ("reportId") REFERENCES "dpr_reports" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "dpr_reports" ADD CONSTRAINT "fk_dpr_reports_importBatchId" FOREIGN KEY ("importBatchId") REFERENCES "dpr_import_batches" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "dpr_reports" ADD CONSTRAINT "fk_dpr_reports_rigId" FOREIGN KEY ("rigId") REFERENCES "dpr_rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_approval_history" ADD CONSTRAINT "fk_drr_approval_history_reportId" FOREIGN KEY ("reportId") REFERENCES "drr_reports" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_attendance_lines" ADD CONSTRAINT "fk_drr_attendance_lines_employeeId" FOREIGN KEY ("employeeId") REFERENCES "employees" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_attendance_lines" ADD CONSTRAINT "fk_drr_attendance_lines_reportId" FOREIGN KEY ("reportId") REFERENCES "drr_reports" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_hydraulic_lines" ADD CONSTRAINT "fk_drr_hydraulic_lines_reportId" FOREIGN KEY ("reportId") REFERENCES "drr_reports" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_import_batches" ADD CONSTRAINT "fk_drr_import_batches_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_oil_lines" ADD CONSTRAINT "fk_drr_oil_lines_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_oil_lines" ADD CONSTRAINT "fk_drr_oil_lines_reportId" FOREIGN KEY ("reportId") REFERENCES "drr_reports" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_reports" ADD CONSTRAINT "fk_drr_reports_mechLogUploadId" FOREIGN KEY ("mechLogUploadId") REFERENCES "mechanical_log_uploads" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_reports" ADD CONSTRAINT "fk_drr_reports_hsdReportId" FOREIGN KEY ("hsdReportId") REFERENCES "hsd_reports" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_reports" ADD CONSTRAINT "fk_drr_reports_dprReportId" FOREIGN KEY ("dprReportId") REFERENCES "dpr_reports" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_reports" ADD CONSTRAINT "fk_drr_reports_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_rig_responsibility" ADD CONSTRAINT "fk_drr_rig_responsibility_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "drr_rig_responsibility" ADD CONSTRAINT "fk_drr_rig_responsibility_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "engine_master" ADD CONSTRAINT "fk_engine_master_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "engine_master" ADD CONSTRAINT "fk_engine_master_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment" ADD CONSTRAINT "fk_equipment_linkedTransmissionId" FOREIGN KEY ("linkedTransmissionId") REFERENCES "material_master" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment" ADD CONSTRAINT "fk_equipment_linkedEngineId" FOREIGN KEY ("linkedEngineId") REFERENCES "material_master" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment" ADD CONSTRAINT "fk_equipment_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment_history" ADD CONSTRAINT "fk_equipment_history_uploadId" FOREIGN KEY ("uploadId") REFERENCES "mechanical_log_uploads" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment_history" ADD CONSTRAINT "fk_equipment_history_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment_oil_lubricants" ADD CONSTRAINT "fk_equipment_oil_lubricants_oilLubricantId" FOREIGN KEY ("oilLubricantId") REFERENCES "oil_lubricants" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment_oil_lubricants" ADD CONSTRAINT "fk_equipment_oil_lubricants_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment_service_records" ADD CONSTRAINT "fk_equipment_service_records_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment_service_records" ADD CONSTRAINT "fk_equipment_service_records_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment_transfers" ADD CONSTRAINT "fk_equipment_transfers_toRigId" FOREIGN KEY ("toRigId") REFERENCES "rigs" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment_transfers" ADD CONSTRAINT "fk_equipment_transfers_fromRigId" FOREIGN KEY ("fromRigId") REFERENCES "rigs" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "equipment_transfers" ADD CONSTRAINT "fk_equipment_transfers_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "health_check_records" ADD CONSTRAINT "fk_health_check_records_uploadId" FOREIGN KEY ("uploadId") REFERENCES "health_check_uploads" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "health_check_records" ADD CONSTRAINT "fk_health_check_records_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "health_check_records" ADD CONSTRAINT "fk_health_check_records_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "health_check_uploads" ADD CONSTRAINT "fk_health_check_uploads_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "health_narratives" ADD CONSTRAINT "fk_health_narratives_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "health_narratives" ADD CONSTRAINT "fk_health_narratives_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "health_narratives" ADD CONSTRAINT "fk_health_narratives_uploadId" FOREIGN KEY ("uploadId") REFERENCES "health_narrative_uploads" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "hsd_equipment_lines" ADD CONSTRAINT "fk_hsd_equipment_lines_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "hsd_equipment_lines" ADD CONSTRAINT "fk_hsd_equipment_lines_reportId" FOREIGN KEY ("reportId") REFERENCES "hsd_reports" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "hsd_import_batches" ADD CONSTRAINT "fk_hsd_import_batches_rigId" FOREIGN KEY ("rigId") REFERENCES "dpr_rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "hsd_reports" ADD CONSTRAINT "fk_hsd_reports_importBatchId" FOREIGN KEY ("importBatchId") REFERENCES "hsd_import_batches" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "hsd_reports" ADD CONSTRAINT "fk_hsd_reports_rigId" FOREIGN KEY ("rigId") REFERENCES "dpr_rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "hsd_site_lines" ADD CONSTRAINT "fk_hsd_site_lines_reportId" FOREIGN KEY ("reportId") REFERENCES "hsd_reports" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_contract_duration_rules" ADD CONSTRAINT "fk_ilm_contract_duration_rules_ilmRigId" FOREIGN KEY ("ilmRigId") REFERENCES "ilm_rigs" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_crane_rounds" ADD CONSTRAINT "fk_ilm_crane_rounds_transactionId" FOREIGN KEY ("transactionId") REFERENCES "ilm_transactions" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_cranes" ADD CONSTRAINT "fk_ilm_cranes_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_cranes" ADD CONSTRAINT "fk_ilm_cranes_roundId" FOREIGN KEY ("roundId") REFERENCES "ilm_crane_rounds" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_cranes" ADD CONSTRAINT "fk_ilm_cranes_transactionId" FOREIGN KEY ("transactionId") REFERENCES "ilm_transactions" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_delay_records" ADD CONSTRAINT "fk_ilm_delay_records_transactionId" FOREIGN KEY ("transactionId") REFERENCES "ilm_transactions" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_import_batches" ADD CONSTRAINT "fk_ilm_import_batches_transactionId" FOREIGN KEY ("transactionId") REFERENCES "ilm_transactions" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_import_batches" ADD CONSTRAINT "fk_ilm_import_batches_rigId" FOREIGN KEY ("rigId") REFERENCES "ilm_rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_individual" ADD CONSTRAINT "fk_ilm_individual_contractRuleId" FOREIGN KEY ("contractRuleId") REFERENCES "ilm_contract_duration_rules" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_individual" ADD CONSTRAINT "fk_ilm_individual_transactionId" FOREIGN KEY ("transactionId") REFERENCES "ilm_transactions" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_individual_lines" ADD CONSTRAINT "fk_ilm_individual_lines_transactionId" FOREIGN KEY ("transactionId") REFERENCES "ilm_transactions" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_trailer_header" ADD CONSTRAINT "fk_ilm_trailer_header_transactionId" FOREIGN KEY ("transactionId") REFERENCES "ilm_transactions" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_trailer_loads" ADD CONSTRAINT "fk_ilm_trailer_loads_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_trailer_loads" ADD CONSTRAINT "fk_ilm_trailer_loads_movementId" FOREIGN KEY ("movementId") REFERENCES "ilm_trailer_movements" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_trailer_loads" ADD CONSTRAINT "fk_ilm_trailer_loads_transactionId" FOREIGN KEY ("transactionId") REFERENCES "ilm_transactions" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_trailer_movements" ADD CONSTRAINT "fk_ilm_trailer_movements_contractRuleId" FOREIGN KEY ("contractRuleId") REFERENCES "ilm_contract_duration_rules" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_trailer_movements" ADD CONSTRAINT "fk_ilm_trailer_movements_transactionId" FOREIGN KEY ("transactionId") REFERENCES "ilm_transactions" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_transactions" ADD CONSTRAINT "fk_ilm_transactions_importBatchId" FOREIGN KEY ("importBatchId") REFERENCES "ilm_import_batches" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ilm_transactions" ADD CONSTRAINT "fk_ilm_transactions_rigId" FOREIGN KEY ("rigId") REFERENCES "ilm_rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "internal_followups" ADD CONSTRAINT "fk_internal_followups_responsiblePersonId" FOREIGN KEY ("responsiblePersonId") REFERENCES "users" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "internal_followups" ADD CONSTRAINT "fk_internal_followups_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "internal_followups" ADD CONSTRAINT "fk_internal_followups_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "invoice_settings" ADD CONSTRAINT "fk_invoice_settings_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "fk_invoices_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "manpower_roster" ADD CONSTRAINT "fk_manpower_roster_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "manpower_roster" ADD CONSTRAINT "fk_manpower_roster_employeeId" FOREIGN KEY ("employeeId") REFERENCES "employees" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "material_master" ADD CONSTRAINT "fk_material_master_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "material_master" ADD CONSTRAINT "fk_material_master_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "mechanical_log_rows" ADD CONSTRAINT "fk_mechanical_log_rows_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "mechanical_log_rows" ADD CONSTRAINT "fk_mechanical_log_rows_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "mechanical_log_rows" ADD CONSTRAINT "fk_mechanical_log_rows_uploadId" FOREIGN KEY ("uploadId") REFERENCES "mechanical_log_uploads" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "mechanical_log_uploads" ADD CONSTRAINT "fk_mechanical_log_uploads_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "fk_notifications_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "fk_notifications_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "rigs" ADD CONSTRAINT "fk_rigs_companyId" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "transmission_master" ADD CONSTRAINT "fk_transmission_master_equipmentId" FOREIGN KEY ("equipmentId") REFERENCES "equipment" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "transmission_master" ADD CONSTRAINT "fk_transmission_master_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "user_rig_access" ADD CONSTRAINT "fk_user_rig_access_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "user_rig_access" ADD CONSTRAINT "fk_user_rig_access_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "fk_users_departmentId" FOREIGN KEY ("departmentId") REFERENCES "departments" ("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "fk_users_rigId" FOREIGN KEY ("rigId") REFERENCES "rigs" ("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_audit_user" ON "audit_logs" ("user");
CREATE INDEX IF NOT EXISTS "idx_audit_time" ON "audit_logs" ("time");
CREATE INDEX IF NOT EXISTS "idx_demo_data_log_table" ON "demo_data_log" ("entityTable");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_dept_module_namekey" ON "departments" ("moduleCode", "nameKey");
CREATE INDEX IF NOT EXISTS "idx_docs_equipment" ON "document_files" ("equipmentId");
CREATE INDEX IF NOT EXISTS "idx_dpr_batch_rig" ON "dpr_import_batches" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_dpr_line_report" ON "dpr_line_items" ("reportId");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_dpr_report_rig_date" ON "dpr_reports" ("rigId", "dprDate");
DO $$ BEGIN
  ALTER TABLE "dpr_rigs" ADD CONSTRAINT "uq_dpr_rigs_rigKey" UNIQUE ("rigKey");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_drr_approval_history_report" ON "drr_approval_history" ("reportId");
CREATE INDEX IF NOT EXISTS "idx_drr_attendance_report" ON "drr_attendance_lines" ("reportId");
CREATE INDEX IF NOT EXISTS "idx_drr_hydraulic_report" ON "drr_hydraulic_lines" ("reportId");
CREATE INDEX IF NOT EXISTS "idx_drr_import_batch_rig" ON "drr_import_batches" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_drr_oil_report" ON "drr_oil_lines" ("reportId");
CREATE INDEX IF NOT EXISTS "idx_drr_report_rig" ON "drr_reports" ("rigId");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_drr_report_rig_date_shift" ON "drr_reports" ("rigId", "reportDate", "shift");
CREATE INDEX IF NOT EXISTS "idx_drr_rig_resp_user" ON "drr_rig_responsibility" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_drr_rig_resp_slot" ON "drr_rig_responsibility" ("rigId", "roleType", "tier");
CREATE INDEX IF NOT EXISTS "idx_engine_master_equipment" ON "engine_master" ("equipmentId");
CREATE INDEX IF NOT EXISTS "idx_engine_master_rig" ON "engine_master" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_equipment_rig_name" ON "equipment" ("rigId", "nameKey");
CREATE INDEX IF NOT EXISTS "idx_equipment_rig_serial" ON "equipment" ("rigId", "serialKey");
CREATE INDEX IF NOT EXISTS "idx_equipment_rig" ON "equipment" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_history_equipment" ON "equipment_history" ("equipmentId", "date");
CREATE INDEX IF NOT EXISTS "idx_equipment_oil_equipment" ON "equipment_oil_lubricants" ("equipmentId");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_equipment_oil_unique" ON "equipment_oil_lubricants" ("equipmentId", "oilLubricantId");
CREATE INDEX IF NOT EXISTS "idx_service_rig" ON "equipment_service_records" ("rigId", "date");
CREATE INDEX IF NOT EXISTS "idx_service_equipment" ON "equipment_service_records" ("equipmentId", "date");
CREATE INDEX IF NOT EXISTS "idx_transfers_equipment" ON "equipment_transfers" ("equipmentId", "date");
CREATE INDEX IF NOT EXISTS "idx_hc_rig" ON "health_check_records" ("rigId", "date");
CREATE INDEX IF NOT EXISTS "idx_hc_equipment" ON "health_check_records" ("equipmentId", "date");
CREATE INDEX IF NOT EXISTS "idx_hcuploads_rig" ON "health_check_uploads" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_narrative_upload" ON "health_narratives" ("uploadId");
CREATE INDEX IF NOT EXISTS "idx_narrative_rig" ON "health_narratives" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_hsd_equip_report" ON "hsd_equipment_lines" ("reportId");
CREATE INDEX IF NOT EXISTS "idx_hsd_batch_rig" ON "hsd_import_batches" ("rigId");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_hsd_report_rig_date" ON "hsd_reports" ("rigId", "hsdDate");
CREATE INDEX IF NOT EXISTS "idx_hsd_site_report" ON "hsd_site_lines" ("reportId");
CREATE INDEX IF NOT EXISTS "idx_ilm_contract_rules_rig" ON "ilm_contract_duration_rules" ("ilmRigId");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ilm_crane_round_no" ON "ilm_crane_rounds" ("transactionId", "roundNo");
CREATE INDEX IF NOT EXISTS "idx_ilm_crane_round_txn" ON "ilm_crane_rounds" ("transactionId");
CREATE INDEX IF NOT EXISTS "idx_ilm_crane_round" ON "ilm_cranes" ("roundId");
CREATE INDEX IF NOT EXISTS "idx_ilm_crane_txn" ON "ilm_cranes" ("transactionId");
CREATE INDEX IF NOT EXISTS "idx_ilm_delay_txn" ON "ilm_delay_records" ("transactionId");
CREATE INDEX IF NOT EXISTS "idx_ilm_batch_rig" ON "ilm_import_batches" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_ilm_ind_line_txn" ON "ilm_individual_lines" ("transactionId");
DO $$ BEGIN
  ALTER TABLE "ilm_rigs" ADD CONSTRAINT "uq_ilm_rigs_rigKey" UNIQUE ("rigKey");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_ilm_trailer_movement" ON "ilm_trailer_loads" ("movementId");
CREATE INDEX IF NOT EXISTS "idx_ilm_trailer_txn" ON "ilm_trailer_loads" ("transactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ilm_trailer_mvmt_no" ON "ilm_trailer_movements" ("transactionId", "movementNo");
CREATE INDEX IF NOT EXISTS "idx_ilm_trailer_mvmt_txn" ON "ilm_trailer_movements" ("transactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ilm_txn_active_rig" ON "ilm_transactions" ("rigId");
DO $$ BEGIN
  ALTER TABLE "ilm_transactions" ADD CONSTRAINT "uq_ilm_transactions_ilmNumber" UNIQUE ("ilmNumber");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_ifu_meeting_date" ON "internal_followups" ("meetingDate");
CREATE INDEX IF NOT EXISTS "idx_ifu_status" ON "internal_followups" ("status");
CREATE INDEX IF NOT EXISTS "idx_ifu_equipment" ON "internal_followups" ("equipmentId");
CREATE INDEX IF NOT EXISTS "idx_ifu_rig" ON "internal_followups" ("rigId");
DO $$ BEGIN
  ALTER TABLE "invoice_settings" ADD CONSTRAINT "uq_invoice_settings_rigId" UNIQUE ("rigId");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_invoices_rig_period_active" ON "invoices" ("rigId", "periodFrom", "periodTo");
CREATE INDEX IF NOT EXISTS "idx_invoices_period" ON "invoices" ("periodFrom");
CREATE INDEX IF NOT EXISTS "idx_invoices_rig" ON "invoices" ("rigId");
DO $$ BEGIN
  ALTER TABLE "invoices" ADD CONSTRAINT "uq_invoices_invoiceNumber" UNIQUE ("invoiceNumber");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_login_user" ON "login_history" ("username", "time");
CREATE INDEX IF NOT EXISTS "idx_roster_employee" ON "manpower_roster" ("employeeId");
CREATE INDEX IF NOT EXISTS "idx_roster_rig" ON "manpower_roster" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_material_master_equipment" ON "material_master" ("equipmentId");
CREATE INDEX IF NOT EXISTS "idx_material_master_rig" ON "material_master" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_rows_rig_date" ON "mechanical_log_rows" ("rigId", "logDate");
CREATE INDEX IF NOT EXISTS "idx_rows_equipment" ON "mechanical_log_rows" ("equipmentId");
CREATE INDEX IF NOT EXISTS "idx_rows_upload" ON "mechanical_log_rows" ("uploadId");
CREATE INDEX IF NOT EXISTS "idx_uploads_month" ON "mechanical_log_uploads" ("rigId", "logMonth");
CREATE INDEX IF NOT EXISTS "idx_uploads_rig" ON "mechanical_log_uploads" ("rigId");
DO $$ BEGIN
  ALTER TABLE "modules" ADD CONSTRAINT "uq_modules_code" UNIQUE ("code");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_notifications_user" ON "notifications" ("userId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_notifications_dedupe" ON "notifications" ("dedupeKey");
DO $$ BEGIN
  ALTER TABLE "oil_lubricants" ADD CONSTRAINT "uq_oil_lubricants_nameKey" UNIQUE ("nameKey");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_holiday_unique" ON "rig_holidays" ("rigId", "date");
DO $$ BEGIN
  ALTER TABLE "rigs" ADD CONSTRAINT "uq_rigs_rigKey" UNIQUE ("rigKey");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "idx_transmission_master_equipment" ON "transmission_master" ("equipmentId");
CREATE INDEX IF NOT EXISTS "idx_transmission_master_rig" ON "transmission_master" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_user_rig_access_rig" ON "user_rig_access" ("rigId");
CREATE INDEX IF NOT EXISTS "idx_user_rig_access_user" ON "user_rig_access" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_rig_access_unique" ON "user_rig_access" ("userId", "rigId");
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "uq_users_username" UNIQUE ("username");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
