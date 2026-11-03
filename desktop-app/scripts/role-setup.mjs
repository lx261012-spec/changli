import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const foundation='D:/GPT/背景项目通用功能/智能底基/底基1.0';
const env=parseEnv(readFileSync(join(foundation,'.env'),'utf8'));
const token=readFileSync(join(foundation,env.FOUNDATION_DATA_DIR||'data','access-token'),'utf8').trim();
const base=`http://127.0.0.1:${env.PORT||4317}`;
const get=async()=>{
 const r=await fetch(base+'/api/state?character=changli',{headers:{Authorization:'Bearer '+token}});
 if(!r.ok)throw Error('Cannot read role state');return r.json();
};
const state=await get();const instructions=state.characters.find(c=>c.id==='changli').instructions;
const report={existingCharacters:instructions.length,changed:false,existingWasEmpty:!instructions.trim()};
if(process.argv.includes('--apply-if-empty')&&!instructions.trim()){
 const source=join(resolve(root,'..'),'work/character-expression-package-2026-10-26/package/01_长离角色设定.txt');
 const text=readFileSync(source,'utf8');
 const r=await fetch(base+'/api/characters/changli',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({instructions:text})});
 if(!r.ok)throw Error('Role import failed');
 if((await get()).characters.find(c=>c.id==='changli').instructions!==text)throw Error('Role import mismatch');
 report.changed=true;report.source='长离角色表达包_v1_2026-10-26/01_长离角色设定.txt';report.sha256=createHash('sha256').update(text).digest('hex');
 copyFileSync(source,join(root,'assets/character-instructions.txt'));
}
writeFileSync(join(root,'qa/role-setup.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
