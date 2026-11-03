import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

export async function pauseAfterCrash(request) {
  const state = await request('/api/state?character=changli');
  const tasks = (state.tasks || []).filter(task => ['running','awaiting_approval'].includes(task.status));
  for (const task of tasks) await request(`/api/characters/changli/tasks/${encodeURIComponent(task.id)}/interrupt`, { method:'POST', body:{} });
  return tasks.length;
}

async function productionRequest(foundationRoot, path, options = {}) {
  const values = parseEnv(readFileSync(join(foundationRoot,'.env'),'utf8'));
  const port = Number(values.PORT || 4317);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('invalid_port');
  const token=readFileSync(join(resolve(foundationRoot,values.FOUNDATION_DATA_DIR||'data'),'access-token'),'utf8').trim();
  if(!/^[a-f0-9]{64}$/i.test(token))throw new Error('invalid_token');
  const url=`http://127.0.0.1:${port}`;
  const response=await fetch(url+path,{method:options.method||'GET',headers:{Authorization:`Bearer ${token}`,Origin:url,'Content-Type':'application/json'},body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('backend_unavailable');return response.json();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const foundationRoot=process.argv[2],log=process.argv[3],recoveryPath=process.argv[4];
  let clean=false;
  process.on('message',value=>{if(value==='clean-exit')clean=true;});
  process.once('disconnect',async()=>{
    if(clean)process.exit(0);
    let paused=0,ok=false,code;
    try{paused=await pauseAfterCrash((path,options)=>productionRequest(foundationRoot,path,options));ok=true;}catch(error){code=error.code||error.cause?.code||error.name;}
    if(recoveryPath)writeFileSync(recoveryPath,JSON.stringify({time:new Date().toISOString(),ok,paused,code}));
    if(log&&existsSync(resolve(log,'..')))appendFileSync(log,JSON.stringify({time:new Date().toISOString(),event:'unexpected-exit-task-pause',ok,paused,code})+'\n');
    process.exit(ok?0:1);
  });
}
