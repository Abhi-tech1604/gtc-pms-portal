const Database=require('better-sqlite3');const db=new Database('data/pms.db',{readonly:true});
const PMS='rig_cce0f93eca9a4d4b9216', MOD='rig_d893ada702ab40109499';
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name);
const hits=[];
for(const t of tables){
  const cols=db.prepare(`PRAGMA table_info('${t}')`).all().map(c=>c.name);
  for(const c of cols){
    if(!/rig/i.test(c)) continue;
    if(c==='rigNumber'||c==='rigKey'||c==='rigType'||c==='rigName') continue;
    for(const [label,id] of [['PMS',PMS],['MODULE',MOD]]){
      const n=db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE "${c}" = ?`).get(id).n;
      if(n>0) hits.push(`${t}.${c} -> ${label} id : ${n} row(s)`);
    }
  }
}
console.log('references found:'); console.log(hits.length?hits.join('\n'):'  NONE anywhere');
console.log('\nrows themselves:');
console.log(' rigs      :',JSON.stringify(db.prepare("SELECT id,rigNumber,name FROM rigs WHERE id=?").get(PMS)));
console.log(' dpr_rigs  :',JSON.stringify(db.prepare("SELECT id,rigNumber,name FROM dpr_rigs WHERE id=?").get(MOD)));
console.log(' ilm_rigs  :',JSON.stringify(db.prepare("SELECT id,rigNumber,name FROM ilm_rigs WHERE id=?").get(MOD)));
console.log(' users scoped to it:',db.prepare("SELECT COUNT(*) n FROM users WHERE rigId=?").get(PMS).n);
