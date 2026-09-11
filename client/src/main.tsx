import React, { type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import type { ModuleAction, ModuleCode, PermissionFlag } from './lib/types';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import ModuleSelect from './pages/ModuleSelect';
import DprDashboard from './pages/dpr/DprDashboard';
import DprImportCenter from './pages/dpr/DprImportCenter';
import DprProgressReport from './pages/dpr/DprProgressReport';
import DprOperationalData from './pages/dpr/DprOperationalData';
import DprEntry from './pages/dpr/DprEntry';
import DprRigMaster from './pages/dpr/DprRigMaster';
import DprRigDetail from './pages/dpr/DprRigDetail';
import HsdReport from './pages/dpr/HsdReport';
import IlmDashboard from './pages/ilm/IlmDashboard';
import IlmCraneSummary from './pages/ilm/IlmCraneSummary';
import IlmTrailerSummary from './pages/ilm/IlmTrailerSummary';
import IlmImportCenter from './pages/ilm/IlmImportCenter';
import IlmProgressReport from './pages/ilm/IlmProgressReport';
import IlmEntry from './pages/ilm/IlmEntry';
import IlmRigMaster from './pages/ilm/IlmRigMaster';
import DrrDashboard from './pages/drr/DrrDashboard';
import DrrReportList from './pages/drr/DrrReportList';
import DrrReportForm from './pages/drr/DrrReportForm';
import Dashboard from './pages/Dashboard';
import Status from './pages/Status';
import RigMaster from './pages/RigMaster';
import EquipmentMaster from './pages/EquipmentMaster';
import EquipmentDirectory from './pages/EquipmentDirectory';
import EquipmentDetail from './pages/EquipmentDetail';
import MechanicalLogs from './pages/MechanicalLogs';
import Healthcheckup from './pages/Healthcheckup';
import ServiceHistory from './pages/ServiceHistory';
import Reports from './pages/Reports';
import AuditRegisters from './pages/AuditRegisters';
import UsersPage from './pages/Users';
import Notifications from './pages/Notifications';
import UserRights from './pages/UserRights';
import Companies from './pages/Companies';
import Transfers from './pages/Transfers';
import Holidays from './pages/Holidays';
import NoAccess from './pages/NoAccess';
import UploadsPending from './pages/UploadsPending';
import UploadsToday from './pages/UploadsToday';
import UploadDetail from './pages/UploadDetail';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminModules from './pages/admin/AdminModules';
import OilLubricantMaster from './pages/admin/OilLubricantMaster';
import ManpowerRoster from './pages/admin/ManpowerRoster';
import MaterialMaster from './pages/admin/MaterialMaster';
import DrrExcelImport from './pages/admin/DrrExcelImport';
import DrrRigResponsibility from './pages/admin/DrrRigResponsibility';
import DemoData from './pages/admin/DemoData';
import NotificationSettingsPage from './pages/admin/NotificationSettings';
import SmtpSettingsPage from './pages/admin/SmtpSettings';
import TransferEquipment from './pages/admin/TransferEquipment';
import IlmContractDurationRules from './pages/admin/IlmContractDurationRules';
import InternalFollowupDashboard from './pages/admin/InternalFollowupDashboard';
import NewInternalFollowup from './pages/admin/NewInternalFollowup';
import InternalFollowupHistory from './pages/admin/InternalFollowupHistory';
import InvoiceDashboard from './pages/admin/InvoiceDashboard';
import CreateInvoice from './pages/admin/CreateInvoice';
import InvoiceHistory from './pages/admin/InvoiceHistory';
import InvoiceDetail from './pages/admin/InvoiceDetail';
import InvoiceSettingsPage from './pages/admin/InvoiceSettingsPage';

function Protected() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-10"><Spinner label="Restoring your session..." /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout />;
}

/** Same auth check as Protected, but without the sidebar shell — ModuleSelect is its own page. */
function RequireUser({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-10"><Spinner label="Restoring your session..." /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

/**
 * Navigating straight to a URL must respect the permission flags too, not only
 * the sidebar. The server enforces the same flag on every endpoint behind it.
 */
function Gated({ right, children }: { right: PermissionFlag; children: ReactElement }) {
  const { can } = useAuth();
  return can(right) ? children : <NoAccess />;
}

/** Every existing PMS route, plus a module-access check the server independently enforces (spec 5/20). */
function PmsGated() {
  const { hasModule } = useAuth();
  return hasModule('PMS') ? <Outlet /> : <NoAccess />;
}

/** Module access plus a specific action (spec 4's per-page DPR/ILM permission list). */
function ModulePermGated({ code, action, children }: { code: ModuleCode; action: ModuleAction; children: ReactElement }) {
  const { hasModuleAction } = useAuth();
  return hasModuleAction(code, action) ? children : <NoAccess />;
}

/** The Admin Panel is Admin-role-only, both here and on every /api/admin/* route (spec 6/7/20). */
function AdminGated({ children }: { children: ReactElement }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <NoAccess />;
}

/**
 * A specific Admin Panel / Follow-up / Invoice page, per Admin > User Rights'
 * page matrix — canPage() already lets an Admin role through unconditionally,
 * so this is AdminGated's replacement wherever a non-Admin account can now be
 * deliberately delegated that one page (spec: "Admin can assign different
 * permissions to every user individually"). Pages with no entry in the
 * matrix yet (Demo Data, Manpower Roster, ILM Contract Duration Rules, DRR's
 * own admin screens, the Admin dashboard itself) stay on AdminGated.
 */
function PageGated({ code, pageKey, children }: { code: ModuleCode; pageKey: string; children: ReactElement }) {
  const { canPage } = useAuth();
  return canPage(code, pageKey, 'view') ? children : <NoAccess />;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/select-module" element={<RequireUser><ModuleSelect /></RequireUser>} />
          <Route element={<Protected />}>
            <Route path="dpr" element={<ModulePermGated code="DPR" action="view"><DprDashboard /></ModulePermGated>} />
            <Route path="dpr/import" element={<ModulePermGated code="DPR" action="create"><DprImportCenter /></ModulePermGated>} />
            <Route path="dpr/progress-report" element={<ModulePermGated code="DPR" action="view"><DprProgressReport /></ModulePermGated>} />
            <Route path="dpr/operational-data" element={<ModulePermGated code="DPR" action="view"><DprOperationalData /></ModulePermGated>} />
            <Route path="dpr/hsd-report" element={<ModulePermGated code="DPR" action="view"><HsdReport /></ModulePermGated>} />
            {/* One route handles both "new" and an existing id — a literal "dpr/entry/new"
                route (no :id) would leave useParams().id undefined, not the string "new".
                Route-level gating only requires "view"; DprEntry itself computes the real
                create/edit requirement per isNew, and the server enforces it independently. */}
            <Route path="dpr/entry/:id" element={<ModulePermGated code="DPR" action="view"><DprEntry /></ModulePermGated>} />
            <Route path="dpr/rig/:rigId" element={<ModulePermGated code="DPR" action="view"><DprRigDetail /></ModulePermGated>} />
            {/* Each module's Rig Master is independent data (not PMS's /rigs), so it is
                gated the same way User Rights already is — admin-only, not by PMS's
                canManageRigs flag, which has no meaning for a module-specific rig list. */}
            <Route path="dpr/rigs" element={<AdminGated><DprRigMaster /></AdminGated>} />
            <Route path="ilm" element={<ModulePermGated code="ILM" action="view"><IlmDashboard /></ModulePermGated>} />
            <Route path="ilm/crane-summary" element={<ModulePermGated code="ILM" action="view"><IlmCraneSummary /></ModulePermGated>} />
            <Route path="ilm/trailer-summary" element={<ModulePermGated code="ILM" action="view"><IlmTrailerSummary /></ModulePermGated>} />
            <Route path="ilm/import" element={<ModulePermGated code="ILM" action="create"><IlmImportCenter /></ModulePermGated>} />
            <Route path="ilm/progress-report" element={<ModulePermGated code="ILM" action="view"><IlmProgressReport /></ModulePermGated>} />
            <Route path="ilm/entry/:id" element={<ModulePermGated code="ILM" action="view"><IlmEntry /></ModulePermGated>} />
            <Route path="ilm/rigs" element={<AdminGated><IlmRigMaster /></AdminGated>} />

            <Route path="drr" element={<ModulePermGated code="DRR" action="view"><DrrDashboard /></ModulePermGated>} />
            <Route path="drr/reports" element={<ModulePermGated code="DRR" action="view"><DrrReportList /></ModulePermGated>} />
            {/* Same "new" vs :id convention as dpr/entry/:id — a literal "drr/new"
                route so useParams().id is genuinely undefined, not the string "new". */}
            <Route path="drr/new" element={<ModulePermGated code="DRR" action="create"><DrrReportForm /></ModulePermGated>} />
            <Route path="drr/reports/:id" element={<ModulePermGated code="DRR" action="view"><DrrReportForm /></ModulePermGated>} />

            <Route path="admin" element={<AdminGated><AdminDashboard /></AdminGated>} />
            <Route path="admin/users" element={<PageGated code="ADMIN" pageKey="users"><UsersPage /></PageGated>} />
            <Route path="admin/modules" element={<PageGated code="ADMIN" pageKey="modules"><AdminModules /></PageGated>} />
            <Route path="admin/rigs" element={<PageGated code="ADMIN" pageKey="rig_master"><RigMaster /></PageGated>} />
            <Route path="admin/equipment-master" element={<PageGated code="ADMIN" pageKey="equipment_master"><EquipmentMaster /></PageGated>} />
            <Route path="admin/material-master" element={<PageGated code="ADMIN" pageKey="material_master"><MaterialMaster /></PageGated>} />
            <Route path="admin/transfer-equipment" element={<PageGated code="ADMIN" pageKey="transfer_equipment"><TransferEquipment /></PageGated>} />
            <Route path="admin/drr-import" element={<AdminGated><DrrExcelImport /></AdminGated>} />
            <Route path="admin/drr-rig-responsibility" element={<AdminGated><DrrRigResponsibility /></AdminGated>} />
            <Route path="admin/oil-lubricants" element={<PageGated code="ADMIN" pageKey="oil_lubricant_master"><OilLubricantMaster /></PageGated>} />
            <Route path="admin/manpower-roster" element={<AdminGated><ManpowerRoster /></AdminGated>} />
            <Route path="admin/ilm-contract-duration-rules" element={<AdminGated><IlmContractDurationRules /></AdminGated>} />
            <Route path="admin/followup" element={<PageGated code="FOLLOWUP" pageKey="dashboard"><InternalFollowupDashboard /></PageGated>} />
            <Route path="admin/followup/new" element={<PageGated code="FOLLOWUP" pageKey="new"><NewInternalFollowup /></PageGated>} />
            <Route path="admin/followup/history" element={<PageGated code="FOLLOWUP" pageKey="history"><InternalFollowupHistory /></PageGated>} />
            <Route path="admin/invoice" element={<PageGated code="INVOICE" pageKey="dashboard"><InvoiceDashboard /></PageGated>} />
            <Route path="admin/invoice/new" element={<PageGated code="INVOICE" pageKey="create"><CreateInvoice /></PageGated>} />
            <Route path="admin/invoice/history" element={<PageGated code="INVOICE" pageKey="history"><InvoiceHistory /></PageGated>} />
            <Route path="admin/invoice/history/:id" element={<PageGated code="INVOICE" pageKey="history"><InvoiceDetail /></PageGated>} />
            <Route path="admin/invoice/settings" element={<PageGated code="INVOICE" pageKey="settings"><InvoiceSettingsPage /></PageGated>} />
            <Route path="admin/demo-data" element={<AdminGated><DemoData /></AdminGated>} />
            <Route path="admin/user-rights" element={<PageGated code="ADMIN" pageKey="user_rights"><UserRights /></PageGated>} />
            <Route path="admin/notification-settings" element={<PageGated code="ADMIN" pageKey="notification_settings"><NotificationSettingsPage /></PageGated>} />
            <Route path="admin/smtp-settings" element={<PageGated code="ADMIN" pageKey="smtp_settings"><SmtpSettingsPage /></PageGated>} />

            {/* Shared, module-independent — mirrors /api/users having no PMS module gate. */}
            <Route path="users" element={<PageGated code="ADMIN" pageKey="users"><UsersPage /></PageGated>} />
            <Route path="user-rights" element={<PageGated code="ADMIN" pageKey="user_rights"><UserRights /></PageGated>} />
            {/* The Notification Center: any authenticated user, no module gate — the
                server already scopes GET /notifications to req.user.id, so there is
                nothing here for a module switch to protect. */}
            <Route path="notifications" element={<Notifications />} />

            <Route element={<PmsGated />}>
              <Route index element={<Gated right="canViewDashboard"><Dashboard /></Gated>} />
              <Route path="status" element={<Gated right="canViewDashboard"><Status /></Gated>} />
              <Route path="rigs" element={<Gated right="canManageRigs"><RigMaster /></Gated>} />
              <Route path="equipment-master" element={<Gated right="canManageEquipment"><EquipmentMaster /></Gated>} />
              <Route path="equipment" element={<EquipmentDirectory />} />
              <Route path="equipment/:id" element={<EquipmentDetail />} />
              <Route path="mechanical-logs" element={<MechanicalLogs />} />
              <Route path="uploads/pending" element={<UploadsPending />} />
              <Route path="uploads/today" element={<UploadsToday />} />
              <Route path="uploads/:rigId/:uploadDate" element={<UploadDetail />} />
              <Route path="healthcheckup" element={<Healthcheckup />} />
              <Route path="service-history" element={<ServiceHistory />} />
              <Route path="reports" element={<Gated right="canManageReports"><Reports /></Gated>} />
              <Route path="audit" element={<Gated right="canViewAuditLogs"><AuditRegisters /></Gated>} />
              <Route path="companies" element={<Companies />} />
              <Route path="transfers" element={<Gated right="canManageTransfers"><Transfers /></Gated>} />
              <Route path="holidays" element={<Gated right="canManageHolidays"><Holidays /></Gated>} />
            </Route>

            <Route path="no-access" element={<NoAccess />} />
            <Route path="*" element={<Navigate to="/select-module" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
