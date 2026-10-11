const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function setup() {
  const nodes = {'#aiStatus':{}, '#planSummaryDetails':{hidden:true,open:false}, '#planSummaryFull':{textContent:''}};
  const c = vm.createContext({document:{querySelector:id=>nodes[id]},raceGoalSummaryText:()=>'',planGoalSummaryText:()=>''});
  for(const name of ['currentPlanStatusText','cleanPlanSummaryForStatus','planSummaryText','setAiStatus']) {
    const start=source.indexOf('function '+name+'('), end=source.indexOf('\nfunction ',start+1);
    assert.ok(start>=0,name);vm.runInContext(source.slice(start,end<0?undefined:end),c);
  }
  return {c,nodes};
}
test('long persisted summary is compact without modifying stored text',()=>{
  const {c}=setup();
  const plan={source:'json',summary:'Цель недели: '+ 'Развитие скорости и аэробной базы '.repeat(8)+'. Фаза recovery завершена. Ограничения: проверить профиль.'};
  const before=JSON.stringify(plan),text=c.currentPlanStatusText(plan);
  assert.ok(text.length<170);assert.match(text,/^Представлен план из JSON\. Цель:/);
  assert.doesNotMatch(text,/Фаза|Ограничения/);assert.match(text,/\.\.\.$/);assert.equal(JSON.stringify(plan),before);
});
test('short goal remains readable; no arbitrary model explanation in banner',()=>{
  const {c}=setup();
  assert.equal(c.currentPlanStatusText({source:'ai',summary:{weekGoal:'Развитие скорости',loadDecision:'Long explanation'}}),'Представлен ИИ-план. Цель: Развитие скорости');
  assert.equal(c.currentPlanStatusText({source:'json',summary:'Some long model explanation'}),'Представлен план из JSON.');
  assert.equal(c.currentPlanStatusText({source:'local',summary:'Long'}),'Представлен локальный недельный план.');
});
test('details start collapsed and retain full plain text safely',()=>{
  const {c,nodes}=setup(),text='<img src=x onerror=alert(1)> full explanation';
  c.setAiStatus('Compact','ok',text);
  assert.equal(nodes['#aiStatus'].textContent,'Compact');
  assert.equal(nodes['#planSummaryFull'].textContent,text);
  assert.equal(nodes['#planSummaryDetails'].hidden,false);
  assert.equal(nodes['#planSummaryDetails'].open,false);
  assert.equal(nodes['#planSummaryFull'].innerHTML,undefined);
});
test('refresh preserves disclosure, switching plan or showing an error clears it',()=>{
  const {c,nodes}=setup();c.setAiStatus('Plan','ok','First');
  nodes['#planSummaryDetails'].open=true;c.setAiStatus('Plan','ok','First');
  assert.equal(nodes['#planSummaryDetails'].open,true);
  c.setAiStatus('Other','ok','Second');assert.equal(nodes['#planSummaryDetails'].open,false);
  nodes['#planSummaryDetails'].open=true;c.setAiStatus('Error','error');
  assert.equal(nodes['#planSummaryDetails'].open,false);assert.equal(nodes['#planSummaryDetails'].hidden,true);
  assert.equal(nodes['#planSummaryFull'].textContent,'');assert.equal(nodes['#aiStatus'].className,'ai-status error');
});