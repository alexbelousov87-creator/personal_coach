const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function setup(){
 const elements=new Map(),radios=['day','week','month'].map(value=>({value,checked:false})),saved=[];
 const el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',querySelectorAll:()=>[]});return elements.get(id);};
 const c=vm.createContext({state:{workouts:[],loadChartPeriod:'day'},LOAD_CHART_PERIOD_KEY:'load-period',
  document:{querySelector:el,querySelectorAll:()=>radios},saveJson:(...args)=>saved.push(args),
  escapeHtml:value=>String(value ?? '').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')});
 for(const name of ['startOfDay','startOfTrainingWeek','round','buildLoadChartData','handleLoadChartPeriodChange','renderBars','renderMetricChart']){
  const start=source.indexOf(`function ${name}(`),end=source.indexOf('\nfunction ',start+1);assert.ok(start>=0,name);
  vm.runInContext(source.slice(start,end<0?undefined:end),c);
 }
 return {c,el,radios,saved};
}
const workout=(date,extra={})=>({date,load:60,distanceKm:10,durationMin:50,...extra});
const totals=rows=>['load','distanceKm','minutes'].map(k=>rows.reduce((sum,row)=>sum+row[k],0));
test('daily chart retains 14 consecutive local calendar days and sums multiple activities',()=>{
 const {c}=setup(),now=new Date(2026,10,13,12);
 const values=[workout(new Date(2026,9,31,0)),workout(new Date(2026,10,13,8)),workout(new Date(2026,10,13,9),{sport:'SKIERG',distanceKm:0}),
  workout(new Date(2026,9,30,23,59)),workout(new Date(2026,10,13,13))];
 const rows=c.buildLoadChartData(values,'day',now);
 assert.equal(rows.length,14);assert.equal(rows[0].start.getDate(),31);assert.equal(rows[0].start.getMonth(),9);
 assert.equal(rows.at(-1).count,2);assert.equal(rows.at(-1).load,120);assert.equal(rows.at(-1).distanceKm,10);assert.equal(rows.at(-1).minutes,100);
 assert.deepEqual(totals(Array.from(rows)),[180,20,150]);assert.equal(rows.at(-1).current,true);
});
test('weeks start Monday at midnight and Sunday never leaks into the next week',()=>{
 const {c}=setup(),now=new Date(2026,10,13,12);
 const rows=c.buildLoadChartData([workout(new Date(2026,10,8,23,59)),workout(new Date(2026,10,9,0)),workout(new Date(2026,10,9,8))],'week',now);
 assert.equal(rows.length,12);assert.equal(rows.at(-1).start.getDay(),1);assert.equal(rows.at(-1).start.getHours(),0);
 assert.equal(rows.at(-1).start.getDate(),9);assert.equal(rows.at(-2).count,1);assert.equal(rows.at(-1).count,2);
 assert.match(rows.at(-1).rangeLabel,/9.*15/);assert.equal(rows.at(-1).secondaryLabel,'– 15.11');
 const sunday=c.buildLoadChartData([],'week',new Date(2026,10,15,23));assert.equal(sunday.at(-1).start.getDate(),9);
});
test('months use calendar boundaries across years instead of fixed 30-day windows',()=>{
 const {c}=setup(),now=new Date(2027,0,31,12);
 const rows=c.buildLoadChartData([workout(new Date(2026,11,31,23,59)),workout(new Date(2027,0,1,0)),workout(new Date(2027,0,31,8))],'month',now);
 assert.equal(rows.length,12);assert.equal(rows[0].start.getFullYear(),2026);assert.equal(rows[0].start.getMonth(),1);
 assert.equal(rows.at(-1).start.getDate(),1);assert.equal(rows.at(-1).end.getMonth(),1);assert.equal(rows.at(-1).end.getDate(),1);
 assert.equal(rows.at(-2).count,1);assert.equal(rows.at(-1).count,2);assert.equal(rows.at(-2).secondaryLabel,'2026');assert.equal(rows.at(-1).secondaryLabel,'2027');
});
test('leap February and missing months remain explicit calendar buckets',()=>{
 const {c}=setup(),rows=c.buildLoadChartData([workout(new Date(2028,1,29,8))],'month',new Date(2028,2,1,12));
 const feb=rows.at(-2);assert.equal(feb.start.getMonth(),1);assert.equal(feb.end.getMonth(),2);assert.equal(feb.count,1);
 assert.equal(rows.at(-1).count,0);assert.equal(rows.filter(r=>r.count===0).length,11);
});
test('invalid records and future workouts cannot create NaN, negative or infinite totals',()=>{
 const {c}=setup(),now=new Date(2026,10,13,12);
 const rows=c.buildLoadChartData([null,{},workout('bad'),workout(new Date(2026,10,14)),workout(new Date(2026,10,13,8),{load:Infinity,distanceKm:-3,durationMin:'bad'})],'day',now);
 assert.deepEqual(totals(Array.from(rows)),[0,0,0]);
 assert.equal(c.buildLoadChartData(null,'invalid',now).length,14);
});
test('day, week and month totals reconcile and selection never modifies workouts',()=>{
 const {c}=setup(),now=new Date(2026,10,13,12),values=[workout(new Date(2026,10,1,8)),workout(new Date(2026,10,5,8)),workout(new Date(2026,10,13,8))];
 const original=JSON.stringify(values);
 for(const mode of ['day','week','month'])assert.deepEqual(totals(Array.from(c.buildLoadChartData(values,mode,now))),[180,30,150]);
 assert.equal(JSON.stringify(values),original);
});
test('period switch is local only, updates all three charts and normalizes invalid saved settings',()=>{
 const h=setup();h.c.state.loadChartPeriod='bad';h.c.renderBars();assert.equal(h.radios[0].checked,true);
 assert.equal((h.el('#loadBars').innerHTML.match(/class="load-chart"/g)||[]).length,3);
 assert.match(h.el('#loadBars').innerHTML,/--bar-count:14/);
 assert.equal(h.el('#loadLabel').textContent,'нет данных за выбранный период');
 h.c.handleLoadChartPeriodChange({target:{closest:()=>({value:'month'})}});
 assert.equal(h.c.state.loadChartPeriod,'month');assert.equal(h.radios[2].checked,true);
 assert.deepEqual(h.saved,[['load-period','month']]);assert.match(h.el('#loadBars').innerHTML,/--bar-count:12/);
 assert.match(h.el('#loadRange').textContent,/текущий месяц не завершён/);
 h.c.handleLoadChartPeriodChange({target:{closest:()=>({value:'bad'})}});assert.equal(h.saved.length,1);
});
