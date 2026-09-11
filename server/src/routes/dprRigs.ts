import { createModuleRigMasterRouter } from './moduleRigMaster.js';
import { getDprRigScope } from '../services/rigScope.js';

/** DPR's own independent Rig Master — see moduleRigMaster.ts for the shared CRUD logic. */
export const dprRigsRouter = createModuleRigMasterRouter({
  table: 'dpr_rigs',
  idPrefix: 'dprrig',
  auditEntity: 'dpr_rigs',
  dependents: [
    { table: 'dpr_reports', label: 'DPR report(s)' },
    { table: 'dpr_import_batches', label: 'import batch(es)' },
  ],
  getScope: getDprRigScope,
});
