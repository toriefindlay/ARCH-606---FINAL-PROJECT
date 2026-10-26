const assert=require('node:assert/strict');
const {Simulation,hits,inside,R}=require('./model.js');
const wall={type:'wall',p:[10,10,10],size:[.5,20,20]};
assert.ok(hits([1,10,10],[19,10,10],wall),'swept collision catches tunnelling');
assert.ok(!hits([1,1,1],[2,1,1],wall));
const a=new Simulation({count:24}),b=new Simulation({count:24});
for(let i=0;i<600;i++){a.step();b.step();}
assert.deepEqual(a.boids,b.boids,'fixed seed reproduces identical run');
assert.ok(Math.abs(a.density.reduce((x,y)=>x+y,0)-24*10)<1e-7,'occupancy conserves agent-seconds');
a.reset();assert.equal(a.time,0);assert.equal(a.arrivals,0);assert.equal(Math.max(...a.density),0);
const closed=new Simulation({count:20,modifiers:[wall]});const sides=closed.boids.map(b=>b.p[0]<10);
for(let i=0;i<1200;i++){closed.step();closed.boids.forEach((b,j)=>{assert.ok(b.p.every(v=>Number.isFinite(v)&&v>=R&&v<=20-R));assert.ok(!inside(b.p,wall));assert.equal(b.p[0]<10,sides[j],'cannot cross full-height partition');assert.ok(b.trail.length<=90);});}
const portal=new Simulation({count:1,modifiers:[{type:'portal',mode:'entrance',p:[1,1,1],radius:.5},{type:'portal',mode:'exit',p:[19,1,1],radius:1}]});portal.boids[0].p=[19,1,1];portal.step();assert.equal(portal.arrivals,1);assert.ok(portal.boids[0].p[0]<2);assert.equal(portal.boids[0].trail.length,1);
const gather=new Simulation({count:1,modifiers:[{type:'gather',p:[10,10,10],radius:3}]});gather.boids[0].p=[10.1,10,10];gather.step();assert.ok(gather.boids[0].dwell>0);const p=[...gather.boids[0].p];gather.step();assert.deepEqual(gather.boids[0].p,p);
for(const [type,sign] of [['attract',1],['repel',-1]]){const s=new Simulation({count:1,modifiers:[{type,p:[12,10,10],radius:5}]});s.boids[0].p=[10,10,10];s.boids[0].v=[0,0,0];s.step(1/60,{wander:0,flock:0});assert.ok(s.boids[0].v[0]*sign>0);}
console.log('Passed: deterministic replay, density conservation, reset, cube bounds, wall containment and tunnelling, trail cap, portals, gathering dwell, attraction and repulsion.');
