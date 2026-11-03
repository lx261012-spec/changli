const ACTIVE = new Set(['running', 'awaiting_approval']);
function validPage(value) { return ['home','chat','tasks','settings','memory','sessions'].includes(value) ? value : 'chat'; }
function clampSize(value, area) {
  return {width:Math.max(Math.min(860,area.width),Math.min(Number(value?.width)||1180,area.width)),height:Math.max(Math.min(650,area.height),Math.min(Number(value?.height)||820,area.height))};
}
function safeShortcut(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 100 || !/^(?:(?:CommandOrControl|Control|Ctrl|Alt|Shift|Super|Meta)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Backspace|Tab|Up|Down|Left|Right)$/i.test(value)) throw new Error('录音快捷键格式无效，请在设置中重新选择。');
  return value.replace(/Ctrl/gi,'Control');
}
function activeTasks(tasks) { return tasks.filter(task => ACTIVE.has(task.status)); }
function petSettings(value, current={scale:1,opacity:1}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['scale','opacity'].includes(key)))throw new Error('桌宠显示设置无效');
  const next={...current,...value};
  if(!Number.isFinite(next.scale)||next.scale<.5||next.scale>2||!Number.isFinite(next.opacity)||next.opacity<.2||next.opacity>1)throw new Error('桌宠大小须在50%—200%，透明度须在0%—80%之间');
  return {scale:next.scale,opacity:next.opacity};
}
function petSize(settings) { return {width:250*settings.scale,height:190*settings.scale}; }
function petPlacement(point, area, desktop, size={width:250,height:190}) {
  const x=Math.round(Math.max(area.x,Math.min(area.x+area.width-size.width,point.x)));
  const y=Math.round(Math.max(area.y,Math.min(area.y+area.height-size.height,point.y)));
  return {x:x-desktop.x,y:y-desktop.y,below:y-area.y<250,alignLeft:x-area.x<90};
}
module.exports = {validPage,clampSize,safeShortcut,activeTasks,petPlacement,petSettings,petSize};
