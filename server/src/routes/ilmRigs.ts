import { createModuleRigMasterRouter } from './moduleRigMaster.js';
import { getIlmRigScope } from '../services/rigScope.js';

/** ILM's own independent Rig Master — see moduleRigMaster.ts for the shared CRUD logic. */
export const ilmRigsRouter = createModuleRigMasterRouter({
  table: 'ilm_rigs',
  idPrefix: 'ilmrig',
  auditEntity: 'ilm_rigs',
  dependents: [
    { table: 'ilm_transactions', label: 'ILM movement(s)' },
    { table: 'ilm_import_batches', label: 'import batch(es)' },
  ],
  getScope: getIlmRigScope,
});
