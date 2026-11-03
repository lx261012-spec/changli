import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexAccountClient} from '../../foundation/src/codex-account.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const env=parseEnv(readFileSync('D:/GPT/背景项目通用功能/智能底基/底基1.0/.env','utf8'));
for(const name of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY'])if(env[name])process.env[name]=env[name];
const cwd=mkdtempSync(join(root,'qa/account-diagnostic-'));let diagnostics='',stdout='',code;
const spawnCapture=(...args)=>{const child=spawn(...args);child.stderr.on('data',c=>diagnostics+=c);child.stdout.on('data',c=>stdout+=c);child.on('close',n=>code=n);return child;};
const client=new CodexAccountClient({executable:env.CODEX_EXECUTABLE,model:'gpt-6.1-sol',cwd,timeoutMs:120000},spawnCapture);
const start=Date.now();let result;
try {const response=await client.stream('只回复四个汉字：连接成功。',[{role:'user',content:'请确认连接。'}],{onDelta(){}});result={passed:true,reply:response.text};}
catch(error){result={passed:false,code:error.code};}
const combined=diagnostics+'\n'+stdout;
result.exitCode=code;result.ms=Date.now()-start;
result.classification=Object.fromEntries(Object.entries({usageLimit:/usage limit|rate limit|quota_exhausted/i,capacity:/at capacity|overloaded|high demand/i,unknownFeature:/unknown feature|unrecognized feature/i,unknownArgument:/unexpected argument|unrecognized option|unknown argument/i,configError:/error.*(?:config|configuration)|failed.*(?:config|configuration)/i,sandboxFailure:/sandbox.*(?:failed|denied)|(?:failed|denied).*sandbox/i,permission:/permission denied|access is denied|operation not permitted|os error 5/i,network:/connection|network|timed out|tls|certificate/i}).map(([k,re])=>[k,re.test(combined)]));
result.productionHistoryWritten=false;
writeFileSync(join(root,'qa/account-diagnostic.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
try{rmSync(cwd,{recursive:true,force:true,maxRetries:6,retryDelay:500});}catch{}
