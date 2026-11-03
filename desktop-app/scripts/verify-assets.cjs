const assert = require('node:assert/strict');
const {readFileSync,writeFileSync,readdirSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {createHash}=require('node:crypto');
const root=resolve(__dirname,'..'),workspace=resolve(root,'..');
const {PNG}=require(join(workspace,'foundation/node_modules/pngjs'));
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const checks=[],images=[];
for(const name of ['pet.png','pet-smile.png','pet-wink.png','title-snow.png','title-courtyard.png']){
 const png=PNG.sync.read(readFileSync(join(root,'assets',name)));let transparent=0,opaque=0;
 for(let i=3;i<png.data.length;i+=4){transparent+=png.data[i]===0;opaque+=png.data[i]===255;}
 assert(transparent>png.width*png.height*.05&&opaque>100, name+' must have real alpha and visible artwork');
 images.push({name,width:png.width,height:png.height,transparentPixels:transparent,opaquePixels:opaque});
}
checks.push('5张标题/桌宠图具有真实透明alpha');
const original=join(workspace,'output/changli-wallpaper-interaction-preview-20261027');
for(const name of ['wallpaper-clean.mp4','poster-clean.jpg','T01.wav','T02.wav','T03.wav','T04.wav','T05.wav','T06.wav','T07.wav','T08.wav','T09.wav'])assert.equal(hash(join(root,'wallpaper/media',name)),hash(join(original,'media',name)),name+' source preserved');
checks.push('原v5视频/首帧及9条点触音频复制哈希一致');
const sourceEyes=readFileSync(join(original,'app.js'),'utf8').split("  const eyes = $('eyes')")[1];
const desktopEyes=readFileSync(join(root,'wallpaper/app.js'),'utf8').split("  const eyes = $('eyes')")[1];
assert.equal(desktopEyes,sourceEyes);checks.push('v5原眼神/跟随/眨眼核心代码逐字保持');
const click=readFileSync(join(root,'assets/click.wav'));assert.equal(click.toString('ascii',0,4),'RIFF');assert.equal(click.readUInt32LE(24),44100);checks.push('清脆落板点击声WAV格式有效');
const manifest=JSON.parse(readFileSync(join(root,'assets/manifest.json'),'utf8'));
for(const file of manifest.files)assert.equal(hash(join(root,'assets',file.name)),file.sha256);
checks.push('全部素材清单SHA256一致');
writeFileSync(join(root,'qa/asset-verification.json'),JSON.stringify({passed:checks.length,checks,images},null,2));
console.log(JSON.stringify({passed:checks.length,images:images.length}));
