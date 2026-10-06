const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../diagnostics.js'),'utf8');
function setup() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {textContent:'',innerHTML:'',disabled:false,
      classList:{contains:()=>true,add(){},remove(){}},replaceChildren(){this.innerHTML='';},querySelectorAll:()=>[],addEventListener(){}});
    return nodes.get(id);
  };
  const calls=[];
  const context=vm.createContext({document:{hidden:false,getElementById:node,addEventListener(){}},
    state:{activeAthleteId:'a',currentRole:'coach',auth:{coachId:'c',enabled:true,authenticated:true}},
    API_BASE_URL:'',escapeHtml:s=>s.replaceAll('<','&lt;'),AbortController,TypeError,Error,Date,
    setTimeout:()=>0,clearTimeout(){},setInterval(){},
    fetch:(url,options)=>new Promise(resolve=>calls.push({url,options,resolve}))});
  vm.runInContext(source,context);
  return {context,node,calls,api:context.Diagnostics};
}
function response(id='a',events=[]) {
  return {ok:true,json:async()=>({athleteName:id,checkedAt:1,server:{worker:{},uptimeSeconds:60,database:'ok',logging:true,journalAvailable:true},providers:[{provider:'polar',enabled:true,connected:true,backgroundEnabled:true,events}]})};
}
test('diagnostics GET is scoped and never issues provider sync',async()=>{
  const h=setup(), done=h.api.refresh();
  assert.equal(h.calls[0].url,'/api/diagnostics?athleteId=a');
  assert.equal(h.calls[0].options.cache,'no-store');
  h.calls[0].resolve(response()); await done;
  assert.equal(h.node('diagnosticScope').textContent,'a');
  assert.equal(h.node('refreshDiagnostics').disabled,false);
});
test('switching athletes discards delayed responses and aborts previous request',async()=>{
  const h=setup(), old=h.api.refresh();
  h.context.state.activeAthleteId='b';
  const next=h.api.refresh();
  assert.equal(h.calls[0].options.signal.aborted,true);
  h.calls[1].resolve(response('b')); await next;
  h.calls[0].resolve(response('a')); await old;
  assert.equal(h.node('diagnosticScope').textContent,'b');
});
test('no polling for hidden view or logged out session',async()=>{
  const h=setup(); h.context.document.hidden=true;
  await h.api.refresh(); assert.equal(h.calls.length,0);
  h.context.document.hidden=false; h.context.state.auth.authenticated=false;
  await h.api.refresh(); assert.equal(h.calls.length,0);
});
test('failed refresh clears stale data and can be retried',async()=>{
  const h=setup(); let done=h.api.refresh();
  h.calls[0].resolve(response()); await done;
  done=h.api.refresh(); h.calls[1].resolve({ok:false,status:503}); await done;
  assert.equal(h.node('diagnosticSources').innerHTML,'');
  assert.match(h.node('diagnosticStatus').textContent,/недоступна/);
  done=h.api.refresh(); h.calls[2].resolve(response()); await done;
  assert.equal(h.node('diagnosticScope').textContent,'a');
});
test('concurrent refresh uses a single request; clear invalidates it',async()=>{
  const h=setup(), done=h.api.refresh(); await h.api.refresh();
  assert.equal(h.calls.length,1); h.api.clear();
  h.calls[0].resolve(response()); await done;
  assert.equal(h.node('diagnosticSources').innerHTML,'');
});
test('zero records, partial and running outcomes stay distinct',async()=>{
  for(const [event,text] of [[{state:'success',received:0},'Источник не вернул'],[{state:'partial',message:'TCX недоступны'},'TCX недоступны'],[{state:'running',durationSeconds:130},'дольше обычного']]) {
    const h=setup(),done=h.api.refresh();h.calls[0].resolve(response('a',[event]));await done;
    assert.ok(h.node('diagnosticSources').innerHTML.includes(text));
  }
});