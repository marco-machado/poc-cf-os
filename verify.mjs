import assert from 'node:assert/strict';
import { mf } from './local-verify.mjs';
try {
 async function scenario(prompt){
  const sid=crypto.randomUUID();const cookie='lab_session='+sid;const requestId=crypto.randomUUID();const headers={'Content-Type':'application/json',Cookie:cookie,Origin:'http://localhost'};
  const res=await mf.dispatchFetch('http://localhost/api/run',{method:'POST',headers,body:JSON.stringify({prompt,requestId})});assert.equal(res.status,202,await res.text());
  let state;
  for(let i=0;i<100;i++){state=await(await mf.dispatchFetch('http://localhost/api/session',{headers:{Cookie:cookie}})).json();if(!state.active)break;await new Promise(r=>setTimeout(r,50));}
  const run=state.runs.at(-1);assert.equal(run.status,'complete',JSON.stringify(run));return {run,cookie,requestId,headers};
 }
 const normal=await scenario('Compare customer tickets');
 assert.deepEqual(normal.run.steps[0].result,[{customer:'Juniper',urgent:3},{customer:'Acme',urgent:2},{customer:'Northstar',urgent:1},{customer:'Orbit',urgent:0}]);
 console.log('PASS: chained tools and aggregation in Dynamic Worker');
 const persisted=await(await mf.dispatchFetch('http://localhost/api/session',{headers:{Cookie:normal.cookie}})).json();assert.equal(persisted.runs[0].id,normal.requestId);console.log('PASS: persisted session');
 const isolated=await(await mf.dispatchFetch('http://localhost/api/session')).json();assert.equal(isolated.runs.length,0);console.log('PASS: session isolation');
 const retry=await mf.dispatchFetch('http://localhost/api/run',{method:'POST',headers:normal.headers,body:JSON.stringify({prompt:'Compare customer tickets',requestId:normal.requestId})});assert.equal(retry.status,202);
 const replay=await(await mf.dispatchFetch('http://localhost/api/session',{headers:{Cookie:normal.cookie}})).json();assert.equal(replay.runs.length,1);console.log('PASS: duplicate request deduplication');
 const recover=await scenario('recover');assert.equal(recover.run.steps[0].ok,false);assert.deepEqual(recover.run.steps[1].result,{total:16});console.log('PASS: execution-error recovery');
 const network=await scenario('network');assert.equal(network.run.steps[0].ok,false);console.log('PASS: outbound network blocked:',network.run.steps[0].error);
 const secrets=await scenario('secrets');assert.deepEqual(secrets.run.steps[0].result,['TICKETS']);console.log('PASS: sandbox receives only ticket capability');
 const csrf=await mf.dispatchFetch('http://localhost/api/run',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(csrf.status,403);console.log('PASS: cross-origin writes rejected');
}finally{await mf.dispose();}
