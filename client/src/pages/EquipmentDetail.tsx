import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, FileUp, HeartPulse, MapPin, Paperclip, Wrench } from 'lucide-react';
import { api, download } from '../lib/api';
import { date, dateTime, hours, statusClass } from '../lib/format';
import type { Equipment, EquipmentOilMapping, EquipmentServiceRecord, EquipmentTransfer, HealthNarrative, MaterialMasterRecord } from '../lib/types';
import { Empty, ErrorBox, PageHeader, Spinner, Tabs } from '../components/ui';
import { CheckupModal, ServiceModal } from './EquipmentDirectory';
import { NarrativeCard } from './Healthcheckup';
import { useAuth } from '../lib/auth';

interface Detail {
  equipment: Equipment;
  history: {
    id: string; date: string; runningHours: number | null; addedHours: number | null;
    runningSinceLastService: number | null; remainingServiceHours: number | null;
    remarks: string | null; updatedBy: string | null;
  }[];
  documents: {
    id: string; docType: string; title: string; fileName: string; uploadDate: string;
    version: number; uploadedBy: string | null;
  }[];
  serviceRecords: EquipmentServiceRecord[];
  linkedEngine: MaterialMasterRecord[];
  linkedTransmission: MaterialMasterRecord[];
  assignedOils: EquipmentOilMapping[];
  recentRows: Record<string, unknown>[];
}

const DOC_TYPES = ['Certificate', 'Manual', 'Service Report', 'Inspection', 'Other'];

export default function EquipmentDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [data, setData] = useState<Detail | null>(null);
  const [narratives, setNarratives] = useState<HealthNarrative[]>([]);
  const [transfers, setTransfers] = useState<EquipmentTransfer[]>([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'history' | 'logs' | 'health' | 'service' | 'transfers' | 'docs'>('history');
  const [checkup, setCheckup] = useState<Equipment | null>(null);
  const [servicing, setServicing] = useState<Equipment | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    const [detail, narrativeData, transferData] = await Promise.all([
      api.get<Detail>(`/equipment/${id}`),
      api.get<{ narratives: HealthNarrative[] }>(`/health-narratives?equipmentId=${id}`),
      api.get<{ transfers: EquipmentTransfer[] }>(`/equipment-transfers?equipmentId=${id}`),
    ]);
    setData(detail);
    setNarratives(narrativeData.narratives);
    setTransfers(transferData.transfers);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [id]);

  async function uploadDoc(file: File) {
    const form = new FormData();
    form.append('file', file);
    form.append('equipmentId', String(id));
    form.append('title', file.name);
    form.append('docType', DOC_TYPES[0]);
    try { await api.form('/documents', form); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Spinner />;

  const e = data.equipment;

  return (
    <div>
      <Link to="/equipment" className="inline-flex items-center gap-1 text-sm text-rig-700 hover:underline mb-3">
        <ArrowLeft size={14} /> Equipment Directory
      </Link>

      <PageHeader
        title={e.name}
        subtitle={
          <>
            {e.rigName} ({e.rigNumber}) · {e.category}{e.model ? ` · ${e.model}` : ''}
            {e.currentPlace && (
              <span className="pill-place inline-flex items-center gap-1 ml-2">
                <MapPin size={10} /> {e.currentPlace}
              </span>
            )}
          </>
        }
        actions={(
          <div className="flex gap-2">
            {can('canManageHealthcheckup') && (
              <button className="btn-primary" onClick={() => setCheckup(e)}>
                <HeartPulse size={14} /> Log health checkup
              </button>
            )}
            {can('canManageEquipment') && (
              <button className="btn-ghost" onClick={() => setServicing(e)}>
                <Wrench size={14} /> Log service
              </button>
            )}
          </div>
        )}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mb-5">
        <Stat label="Current hours" value={hours(e.currentRunningHours)} />
        <Stat label="Last service at" value={hours(e.lastServiceHours)} />
        <Stat label="Hours since service" value={hours(e.runningSinceLastService)} />
        <Stat label="Service interval" value={hours(e.serviceInterval)} />
        <Stat
          label="Hours remaining"
          value={hours(e.remainingServiceHours)}
          tone={e.remainingServiceHours <= 0 ? 'red' : e.remainingServiceHours <= 200 ? 'amber' : undefined}
        />
        <div className="card p-3">
          <div className="text-[11px] text-slate-500">Status</div>
          <div className="mt-1"><span className={statusClass(e.status)}>{e.status}</span></div>
          <div className="text-[11px] text-slate-500 mt-2">
            Health: <span className={statusClass(e.healthStatus)}>{e.healthStatus}</span>
          </div>
        </div>
      </div>

      <div className="card p-4 mb-5 grid grid-cols-2 md:grid-cols-4 gap-y-3 gap-x-6 text-sm">
        <Detailed label="Serial number" value={e.serialNumber} />
        <Detailed label="Manufacturer" value={e.manufacturer} />
        <Detailed label="Asset number" value={e.assetNumber} />
        <Detailed label="Engine number" value={e.engineNumber} />
        <Detailed label="Installed" value={date(e.installationDate)} />
        <Detailed label="Last health check" value={date(e.lastHealthCheckDate)} />
        <Detailed label="Health check interval" value={`${e.healthCheckInterval} days`} />
        <Detailed label="Last reported" value={date(e.lastReportedDate)} />
      </div>

      {(data.linkedEngine.length > 0 || data.linkedTransmission.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
          {data.linkedEngine.map((m) => <MachineLinkCard key={m.id} label="Engine" record={m} />)}
          {data.linkedTransmission.map((m) => <MachineLinkCard key={m.id} label="Transmission" record={m} />)}
        </div>
      )}

      {data.assignedOils.length > 0 && (
        <div className="card p-4 mb-5">
          <h3 className="text-sm font-semibold text-slate-800 mb-2">Assigned Lubricants</h3>
          <div className="flex flex-wrap gap-2">
            {data.assignedOils.map((o) => (
              <span key={o.id} className={o.status === 'Active' ? 'pill-normal' : 'pill-place'}>{o.name}</span>
            ))}
          </div>
        </div>
      )}

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'history', label: `History (${data.history.length})` },
          { key: 'logs', label: `Log rows (${data.recentRows.length})` },
          { key: 'health', label: `Health checks (${narratives.length})` },
          { key: 'service', label: `Service History (${data.serviceRecords.length})` },
          { key: 'transfers', label: `Transfers (${transfers.length})` },
          { key: 'docs', label: `Documents (${data.documents.length})` },
        ]}
      />

      {tab === 'history' && (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="text-right">Running hrs</th>
                <th className="text-right">Added</th>
                <th className="text-right">Since service</th>
                <th className="text-right">Remaining</th>
                <th>Remarks</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((h) => (
                <tr key={h.id}>
                  <td className="whitespace-nowrap">{date(h.date)}</td>
                  <td className="num">{hours(h.runningHours)}</td>
                  <td className="num">{hours(h.addedHours)}</td>
                  <td className="num">{hours(h.runningSinceLastService)}</td>
                  <td className="num">{hours(h.remainingServiceHours)}</td>
                  <td className="text-xs">{h.remarks ?? '-'}</td>
                  <td className="text-xs">{h.updatedBy ?? '-'}</td>
                </tr>
              ))}
              {data.history.length === 0 && <tr><td colSpan={7}><Empty message="No history yet." /></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'logs' && (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th><th>Day</th><th>In use</th>
                <th className="text-right">Day</th><th className="text-right">Night</th>
                <th className="text-right">Opening</th><th className="text-right">Total</th>
                <th className="text-right">Closing</th><th className="text-right">Last service</th>
                <th className="text-right">Since</th><th className="text-right">Interval</th>
                <th className="text-right">Remaining</th><th>File</th>
              </tr>
            </thead>
            <tbody>
              {data.recentRows.map((r) => (
                <tr key={String(r.id)}>
                  <td className="whitespace-nowrap">{date(String(r.logDate))}</td>
                  <td className="num">{String(r.sheetDay)}</td>
                  <td>{(r.isInUse as string) ?? '-'}</td>
                  <td className="num">{hours(r.hoursRunDay as number)}</td>
                  <td className="num">{hours(r.hoursRunNight as number)}</td>
                  <td className="num">{hours(r.openingRunningHours as number)}</td>
                  <td className="num">{hours(r.totalRunHours as number)}</td>
                  <td className="num">{hours(r.closingHours as number)}</td>
                  <td className="num">{hours(r.lastServiceHours as number)}</td>
                  <td className="num">{hours(r.runningHoursAfterLastService as number)}</td>
                  <td className="num">{hours(r.defineHours as number)}</td>
                  <td className="num">{hours(r.hoursRemainingForNextService as number)}</td>
                  <td className="text-xs truncate max-w-[160px]">{String(r.fileName ?? '')}</td>
                </tr>
              ))}
              {data.recentRows.length === 0 && <tr><td colSpan={13}><Empty message="No log rows yet." /></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'health' && (
        narratives.length === 0 ? (
          <Empty message="No health checkups recorded for this machine yet." />
        ) : (
          <div className="space-y-3">
            {narratives.map((n) => <NarrativeCard key={n.id} n={n} />)}
          </div>
        )
      )}

      {tab === 'service' && (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>Date</th><th className="text-right">Service Hours</th><th>Method</th><th>Remarks</th><th>Recorded By</th></tr>
            </thead>
            <tbody>
              {data.serviceRecords.map((s) => (
                <tr key={s.id}>
                  <td className="whitespace-nowrap">{date(s.date)}</td>
                  <td className="num">{hours(s.serviceHours)}</td>
                  <td><span className={s.method === 'Manual' ? 'pill-place' : 'pill-normal'}>{s.method}</span></td>
                  <td className="text-xs max-w-[260px] truncate">{s.remarks ?? '-'}</td>
                  <td className="text-xs">{s.recordedBy}</td>
                </tr>
              ))}
              {data.serviceRecords.length === 0 && <tr><td colSpan={5}><Empty message="No service recorded for this machine yet." /></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'transfers' && (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>Date</th><th>From</th><th>To</th><th>Type</th><th>Expected return</th><th>Remarks</th><th>By</th></tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap">{date(t.date)}</td>
                  <td className="text-xs">{t.fromPlace ?? t.fromRigNumber ?? '-'}</td>
                  <td className="text-xs font-medium">{t.toPlace ?? t.toRigNumber ?? '-'}</td>
                  <td><span className={t.transferType === 'Temporary' ? 'pill-upcoming' : 'pill-normal'}>{t.transferType}</span></td>
                  <td className="whitespace-nowrap text-xs">{date(t.expectedReturnDate)}</td>
                  <td className="text-xs max-w-[220px] truncate">{t.remarks ?? '-'}</td>
                  <td className="text-xs">{t.createdBy ?? '-'}</td>
                </tr>
              ))}
              {transfers.length === 0 && <tr><td colSpan={7}><Empty message="This machine has never been transferred." /></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'docs' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Attached documents</h2>
            {can('canManageEquipment') && (
              <>
                <input
                  ref={fileRef} type="file" className="hidden"
                  onChange={(ev) => { const f = ev.target.files?.[0]; if (f) void uploadDoc(f); ev.target.value = ''; }}
                />
                <button className="btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
                  <FileUp size={12} /> Attach a file
                </button>
              </>
            )}
          </div>
          <table className="table">
            <thead>
              <tr><th>Title</th><th>Type</th><th>Version</th><th>Uploaded</th><th>By</th><th /></tr>
            </thead>
            <tbody>
              {data.documents.map((d) => (
                <tr key={d.id}>
                  <td>{d.title}</td>
                  <td>{d.docType}</td>
                  <td className="num">v{d.version}</td>
                  <td className="whitespace-nowrap text-xs">{dateTime(d.uploadDate)}</td>
                  <td className="text-xs">{d.uploadedBy ?? '-'}</td>
                  <td className="text-right">
                    <button className="btn-ghost btn-sm" onClick={() => void download(`/documents/${d.id}/file`, d.fileName)}>
                      <Paperclip size={12} /> Download
                    </button>
                  </td>
                </tr>
              ))}
              {data.documents.length === 0 && <tr><td colSpan={6}><Empty message="No documents attached." /></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <CheckupModal
        equipment={checkup}
        onClose={() => setCheckup(null)}
        onSaved={() => { setCheckup(null); void load(); }}
        onError={setError}
      />

      <ServiceModal
        equipment={servicing}
        onClose={() => setServicing(null)}
        onSaved={() => { setServicing(null); void load(); }}
        onError={setError}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'red' | 'amber' }) {
  const color = tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : 'text-slate-900';
  return (
    <div className="card p-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-xl font-semibold mt-1 tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function Detailed({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-slate-800">{value || '-'}</div>
    </div>
  );
}

/** Read-only summary of a linked Engine/Transmission Master record — the fan-out from Engine/Transmission Master into Equipment Detail. */
function MachineLinkCard({ label, record }: { label: 'Engine' | 'Transmission'; record: MaterialMasterRecord }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-800">{label}: {record.name}</h3>
        <span className={record.status === 'Active' ? 'pill-normal' : 'pill-place'}>{record.status}</span>
      </div>
      <div className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
        <Detailed label="Make" value={record.make} />
        <Detailed label="Model" value={record.model} />
        <Detailed label="Serial No." value={record.serialNumber} />
      </div>
    </div>
  );
}
