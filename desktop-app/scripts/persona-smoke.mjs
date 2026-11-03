import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {CodexAccountClient} from '../../foundation/src/codex-account.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const env=parseEnv(readFileSync('D:/GPT/背景项目通用功能/智能底基/底基1.0/.env','utf8'));
for(const name of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY'])if(env[name])process.env[name]=env[name];
const working=mkdtempSync(join(root,'qa/role-check-'));
const client=new CodexAccountClient({executable:env.CODEX_EXECUTABLE,model:'gpt-6.1-sol',cwd:working,timeoutMs:120000});
const start=Date.now();let firstDelta;
try{
 const instructions=readFileSync(join(root,'assets/character-instructions.txt'),'utf8');
 const result=await client.stream(instructions,[{role:'user',content:'今天有点累，想在这里安静坐一会儿。'}],{onDelta:()=>{firstDelta??=Date.now()-start;}});
 if(!result.text?.trim())throw Error('No role reply');
 const report={passed:true,model:'gpt-6.1-sol',auth:'official-codex-account',fixture:'explicit-neutral-fictional-prompt',response:result.text,firstResponseMs:firstDelta,durationMs:Date.now()-start,productionHistoryWritten:false,latencyGoalMet:firstDelta<=6000,voiceOrFullQualityAccepted:false};
 writeFileSync(join(root,'qa/persona-real-model.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:true,firstResponseMs:firstDelta,productionHistoryWritten:false}));
}catch(error){
 writeFileSync(join(root,'qa/persona-real-model.json'),JSON.stringify({passed:false,code:error.code||'model_unavailable',productionHistoryWritten:false},null,2));
 console.log(JSON.stringify({passed:false,code:error.code||'model_unavailable'}));process.exitCode=1;
}finally{try{rmSync(working,{recursive:true,force:true,maxRetries:6,retryDelay:500});}catch{}}
