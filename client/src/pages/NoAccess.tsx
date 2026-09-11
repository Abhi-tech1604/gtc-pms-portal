import { ShieldAlert } from 'lucide-react';

export default function NoAccess() {
  return (
    <div className="card p-10 text-center">
      <ShieldAlert size={32} className="mx-auto text-slate-400 mb-3" />
      <h1 className="text-lg font-semibold text-slate-800">You do not have access to this screen</h1>
      <p className="text-sm text-slate-500 mt-1">
        Ask an administrator to grant the permission in User Rights Option.
      </p>
    </div>
  );
}
