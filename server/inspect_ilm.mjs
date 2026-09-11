import Database from 'better-sqlite3';
const db = new Database('data/pms.db', { readonly: true });
const rigs = db.prepare("SELECT * FROM ilm_rigs WHERE rigNumber LIKE 'DEMO%'").all();
console.log('RIGS', rigs);
for (const rig of rigs) {
  const txns = db.prepare('SELECT * FROM ilm_transactions WHERE rigId = ?').all(rig.id);
  console.log('--- txns for', rig.rigNumber, txns.length);
  for (const t of txns) {
    console.log(JSON.stringify(t));
    const lines = db.prepare('SELECT * FROM ilm_individual_lines WHERE transactionId=?').all(t.id);
    console.log(' lines:', JSON.stringify(lines));
    const cranes = db.prepare('SELECT * FROM ilm_cranes WHERE transactionId=?').all(t.id);
    console.log(' cranes:', JSON.stringify(cranes));
    const trailers = db.prepare('SELECT * FROM ilm_trailer_loads WHERE transactionId=?').all(t.id);
    console.log(' trailers:', JSON.stringify(trailers));
  }
}
