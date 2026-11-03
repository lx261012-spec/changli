import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/29436/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.connectOverCDP('http://127.0.0.1:9354');
const pet=browser.contexts()[0].pages().find(p=>p.url().includes('/pet.html'));
assert.ok(pet);
const checks=[],errors=[];pet.on('pageerror',e=>errors.push(e.message));
let touchRequests=0;pet.on('request',r=>{if(/wallpaper\/media\/T0[1-9]\.wav/.test(r.url()))touchRequests++;});
await pet.reload();await pet.waitForFunction(()=>document.querySelector('#pet-canvas').width!==1280);
await pet.mouse.move(10,10);
assert.equal(await pet.locator('#pet-record').isVisible(),false);
await pet.locator('#pet-canvas').hover();assert.equal(await pet.locator('#pet-record').isVisible(),true);
assert.equal(await pet.locator('.pet-tools button').count(),2);checks.push('native hover two icons');
await pet.locator('#pet-canvas').click();await pet.waitForTimeout(250);assert.equal(touchRequests,0);checks.push('native pet click no wallpaper audio');
await pet.locator('#pet-canvas').click({button:'right'});assert.equal(await pet.locator('#pet-settings').isVisible(),true);checks.push('native right click settings');
await pet.locator('#pet-canvas').click();
for(const [dx,dy] of [[-10000,-10000],[10000,10000],[-10000,10000],[10000,-10000]]){
 const position=await pet.evaluate(async({dx,dy})=>{const p=await window.desktop.movePet({dx,dy});window.__shellPosition=p;return p;},{dx,dy});
 // Exercise the same renderer update used after a real pointer delta.
 await pet.evaluate(p=>{document.querySelector('.pet-stage').style.left=p.x+'px';document.querySelector('.pet-stage').style.top=p.y+'px';},position);
 const rect=await pet.locator('#pet-canvas').boundingBox(),viewport=await pet.evaluate(()=>({w:innerWidth,h:innerHeight}));
 assert.ok(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=viewport.w+1 && rect.y+rect.height<=viewport.h+1,JSON.stringify({rect,viewport}));
 checks.push({corner:[dx,dy],position,rect});
}
const before=await pet.locator('#pet-canvas').boundingBox();
await pet.mouse.move(before.x+before.width/2,before.y+before.height/2);await pet.mouse.down();
await pet.mouse.move(before.x+before.width/2-160,before.y+before.height/2+160,{steps:8});await pet.mouse.up();
await pet.waitForTimeout(250);const after=await pet.locator('#pet-canvas').boundingBox();assert.ok(after.x<before.x-100&&after.y>before.y+100);checks.push('native pointer drag moves character');
await pet.screenshot({path:'desktop-app/qa/pet-revision-native.png'});
assert.deepEqual(errors,[]);
writeFileSync('desktop-app/qa/pet-revision-native.json',JSON.stringify({checks,errors,touchRequests},null,2));
// Close only the isolated QA app, keeping the user's production instance intact.
await pet.evaluate(()=>window.desktop.quit()).catch(error=>{if(!/closed/.test(error.message))throw error;});
await browser.close();console.log(JSON.stringify({checks:checks.length,errors}));
