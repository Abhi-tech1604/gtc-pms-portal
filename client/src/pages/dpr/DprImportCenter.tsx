import { useState } from 'react';
import { ArrowLeftRight, FileSpreadsheet, Fuel } from 'lucide-react';
import { Modal } from '../../components/ui';
import DprDataImport from './DprDataImport';
import HsdDataImport from './HsdDataImport';

/**
 * The Import Center is now a fork: opening it asks which kind of workbook is
 * being uploaded, then hands off to the matching pane. DPR Data is the
 * existing importer, moved into DprDataImport.tsx unchanged — its rig/month/
 * file flow, its API calls and its validation all behave exactly as before.
 * HSD Data is the new diesel-consumption stream in HsdDataImport.tsx.
 */
type ImportKind = 'DPR' | 'HSD';

export default function DprImportCenter() {
  const [kind, setKind] = useState<ImportKind | null>(null);

  return (
    <div>
      {kind === 'DPR' && <DprDataImport />}
      {kind === 'HSD' && <HsdDataImport />}

      {kind && (
        <div className="mt-4">
          <button className="btn-ghost btn-sm" onClick={() => setKind(null)}>
            <ArrowLeftRight size={14} /> Switch import type
          </button>
        </div>
      )}

      <Modal
        open={kind === null}
        title="Import Center — what are you uploading?"
        width="max-w-xl"
        // The chooser is the entry point, so there is nothing to fall back to
        // behind it; closing it simply re-opens the DPR pane, the prior default.
        onClose={() => setKind('DPR')}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ChoiceCard
            icon={FileSpreadsheet}
            title="DPR Data"
            description="Daily Progress Report workbook — activity lines, hours and drilling/casing depths."
            onClick={() => setKind('DPR')}
          />
          <ChoiceCard
            icon={Fuel}
            title="HSD Data"
            description="HSD diesel consumption workbook — per-equipment stock, top-up, running hours and rig-site diesel."
            onClick={() => setKind('HSD')}
          />
        </div>
      </Modal>
    </div>
  );
}

function ChoiceCard({ icon: Icon, title, description, onClick }: {
  icon: typeof Fuel; title: string; description: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left rounded-lg border border-slate-200 p-4 hover:border-rig-500 hover:bg-slate-50 transition"
    >
      <span className="h-9 w-9 rounded-lg bg-rig-50 text-rig-700 grid place-items-center mb-2">
        <Icon size={18} />
      </span>
      <div className="font-medium text-slate-900">{title}</div>
      <div className="text-xs text-slate-500 mt-1">{description}</div>
    </button>
  );
}
